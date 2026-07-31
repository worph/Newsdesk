import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.js'
import { schema } from '../../db/index.js'
import { logEvent } from '../../events.js'
import { callTool, McpError } from '../mcp/client.js'
import { attachAuth } from '../mcp/oauth.js'

/**
 * The delivery port sends an already-approved payload. It performs no
 * inference, no templating and no assembly — everything it sends was frozen at
 * approval and is passed through verbatim.
 *
 * That is invariant 2 made structural: if this layer could change the payload,
 * the approval would not mean anything.
 */

export interface DeliveryOutlet {
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
  send(outlet: DeliveryOutlet, payload: Record<string, unknown>): Promise<DeliveryResult>
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
    async send(outlet, payload) {
      if (!outlet.tool) throw new McpError(`outlet "${outlet.id}" has no tool configured`, false)
      if (!outlet.endpointId) throw new McpError(`outlet "${outlet.id}" has no endpoint configured`, false)

      const endpoint = db
        .select()
        .from(schema.mcpEndpoints)
        .where(eq(schema.mcpEndpoints.id, outlet.endpointId))
        .get()
      if (!endpoint) {
        throw new McpError(`endpoint "${outlet.endpointId}" no longer exists`, false)
      }

      const result = await callTool(attachAuth(db, endpoint), outlet.tool, payload, {
        timeoutMs: 280_000,
      })
      return { detail: result.text.slice(0, 2000) }
    },
  }
}

/** A configured HTTP endpoint. Symmetry with stringers: no agent needed. */
export function createWebhookDriver(): DeliveryDriver {
  return {
    name: 'webhook',
    async send(outlet, payload) {
      const url = typeof payload.url === 'string' ? payload.url : undefined
      if (!url) throw new McpError(`webhook outlet "${outlet.id}" has no url in its payload`, false)

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
 * stack has no `discord-mcp`, and an outlet that silently did nothing would be
 * indistinguishable from one that worked.
 */
export function createSinkDriver(): DeliveryDriver {
  return {
    name: 'builtin',
    async send(outlet, payload) {
      return {
        externalId: `sink:${outlet.id}:${Date.now()}`,
        detail: `not sent — this is a local sink outlet. Payload:\n${JSON.stringify(payload, null, 2)}`,
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

  const outlet = db.select().from(schema.outlets).where(eq(schema.outlets.id, publication.outletId)).get()
  if (!outlet) throw new McpError(`outlet "${publication.outletId}" no longer exists`, false)

  const payload = JSON.parse(publication.payload) as Record<string, unknown>
  const driver = createDeliveryDriver(db, outlet.driver)

  try {
    const result = await driver.send(
      {
        id: outlet.id,
        name: outlet.name,
        driver: outlet.driver,
        tool: outlet.tool,
        endpointId: outlet.endpointId,
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
      message: `sent to ${outlet.name}`,
      detail: { driver: outlet.driver, result: result.detail },
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
      message: `could not send to ${outlet.name}: ${message}`,
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
