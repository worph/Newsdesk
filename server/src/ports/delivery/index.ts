import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.js'
import { schema } from '../../db/index.js'
import { logEvent } from '../../events.js'
import { callTool, McpError } from '../mcp/client.js'

/**
 * The delivery port sends an already-approved payload. It performs no
 * inference, no templating and no assembly — everything it sends was frozen at
 * approval and is passed through verbatim.
 *
 * That is invariant 2 made structural: if this layer could change the payload,
 * the approval would not mean anything.
 */

export interface DeliveryTarget {
  id: string
  name: string
  driver: string
  tool: string | null
  endpointId: string | null
}

export interface DeliveryResult {
  externalId?: string
  externalUrl?: string
  detail?: string
}

export interface DeliveryDriver {
  readonly name: string
  send(target: DeliveryTarget, payload: Record<string, unknown>): Promise<DeliveryResult>
}

/**
 * Send through an MCP tool, exactly as configured.
 *
 * The tool name is called directly even against a Beacon aggregator: a Beacon
 * routes a namespaced `server__tool` name, so no wrapper is needed and the
 * `args_spec` reaches the bridge as written. Discovered schemas are never used
 * to validate outbound arguments — a Beacon may advertise a stale schema while
 * the argument still works.
 */
export function createMcpDriver(db: Db): DeliveryDriver {
  return {
    name: 'mcp',
    async send(target, payload) {
      if (!target.tool) throw new McpError(`target "${target.id}" has no tool configured`, false)
      if (!target.endpointId) throw new McpError(`target "${target.id}" has no endpoint configured`, false)

      const endpoint = db
        .select()
        .from(schema.mcpEndpoints)
        .where(eq(schema.mcpEndpoints.id, target.endpointId))
        .get()
      if (!endpoint) {
        throw new McpError(`endpoint "${target.endpointId}" no longer exists`, false)
      }

      const result = await callTool(endpoint, target.tool, payload, { timeoutMs: 280_000 })
      return { detail: result.text.slice(0, 2000) }
    },
  }
}

/** A configured HTTP endpoint. Symmetry with stringers: no agent needed. */
export function createWebhookDriver(): DeliveryDriver {
  return {
    name: 'webhook',
    async send(target, payload) {
      const url = typeof payload.url === 'string' ? payload.url : undefined
      if (!url) throw new McpError(`webhook target "${target.id}" has no url in its payload`, false)

      const { url: _omit, ...body } = payload
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })

      if (!response.ok) {
        throw new McpError(`webhook returned HTTP ${response.status}`, response.status >= 500)
      }
      return { detail: (await response.text()).slice(0, 2000) }
    },
  }
}

/**
 * A local sink: records the payload and sends nothing.
 *
 * This is what makes the whole path testable end to end without a real
 * destination — the approval, the freeze and the ledger all behave exactly as
 * they would against Discord, and the payload is kept for inspection. A dev
 * stack has no `discord-mcp`, and a target that silently did nothing would be
 * indistinguishable from one that worked.
 */
export function createSinkDriver(): DeliveryDriver {
  return {
    name: 'builtin',
    async send(target, payload) {
      return {
        externalId: `sink:${target.id}:${Date.now()}`,
        detail: `not sent — this is a local sink target. Payload:\n${JSON.stringify(payload, null, 2)}`,
      }
    },
  }
}

export function createDeliveryDriver(db: Db, driver: string): DeliveryDriver {
  switch (driver) {
    case 'mcp':
      return createMcpDriver(db)
    case 'webhook':
      return createWebhookDriver()
    case 'builtin':
      return createSinkDriver()
    default:
      throw new McpError(`unknown delivery driver "${driver}"`, false)
  }
}

/**
 * Send one approved publication.
 *
 * Reads `payload` from the row — never re-merges it — so a retry sends exactly
 * the bytes that were approved, however long ago and whatever has changed in
 * configuration since.
 */
export async function deliverPublication(db: Db, publicationId: string): Promise<void> {
  const publication = db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, publicationId))
    .get()
  if (!publication) throw new McpError(`publication "${publicationId}" not found`, false)

  if (publication.status === 'PUBLISHED') return // already sent; a retry must not double-post

  if (publication.status !== 'APPROVED' && publication.status !== 'FAILED') {
    throw new McpError(
      `publication ${publicationId} is ${publication.status} — only an approved payload may be sent`,
      false,
    )
  }
  if (!publication.payload) {
    throw new McpError(`publication ${publicationId} has no frozen payload`, false)
  }

  const target = db.select().from(schema.targets).where(eq(schema.targets.id, publication.targetId)).get()
  if (!target) throw new McpError(`target "${publication.targetId}" no longer exists`, false)

  const payload = JSON.parse(publication.payload) as Record<string, unknown>
  const driver = createDeliveryDriver(db, target.driver)

  try {
    const result = await driver.send(
      {
        id: target.id,
        name: target.name,
        driver: target.driver,
        tool: target.tool,
        endpointId: target.endpointId,
      },
      payload,
    )

    db.update(schema.publications)
      .set({
        status: 'PUBLISHED',
        publishedAt: new Date().toISOString(),
        externalId: result.externalId ?? null,
        externalUrl: result.externalUrl ?? null,
        error: null,
      })
      .where(eq(schema.publications.id, publicationId))
      .run()

    logEvent(db, {
      level: 'info',
      code: 'PUBLISHED',
      storyId: publication.storyId,
      publicationId,
      message: `sent to ${target.name}`,
      detail: { driver: target.driver, result: result.detail },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.update(schema.publications)
      .set({ status: 'FAILED', error: message })
      .where(eq(schema.publications.id, publicationId))
      .run()

    logEvent(db, {
      level: 'error',
      code: 'PUBLISH_FAILED',
      storyId: publication.storyId,
      publicationId,
      message: `could not send to ${target.name}: ${message}`,
    })
    throw err
  }
}

/** Registered against the queue's `publish` kind. */
export function publishHandler() {
  return async (db: Db, refId: string): Promise<void> => {
    await deliverPublication(db, refId)
  }
}
