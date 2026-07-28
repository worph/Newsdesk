import type { Db } from './db/index.js'
import { schema } from './db/index.js'

export interface EndpointHealth {
  id: string
  name: string
  url: string
  status: 'ok' | 'unauthorized' | 'unreachable' | 'error'
  detail?: string
  latencyMs?: number
}

/**
 * A cheap MCP handshake: POST an `initialize` request and see whether anything
 * sensible answers. Deliberately does not use the MCP SDK — /healthz must
 * report on a broken port, not fail with it.
 */
export async function probeEndpoint(
  endpoint: { id: string; name: string; url: string },
  timeoutMs = 4000,
): Promise<EndpointHealth> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'newsdesk-healthcheck', version: '0.1.0' },
        },
      }),
    })

    const latencyMs = Date.now() - started
    if (response.status === 401 || response.status === 403) {
      return { ...endpoint, status: 'unauthorized', detail: `HTTP ${response.status}`, latencyMs }
    }
    if (!response.ok) {
      return { ...endpoint, status: 'error', detail: `HTTP ${response.status}`, latencyMs }
    }
    return { ...endpoint, status: 'ok', latencyMs }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ...endpoint,
      status: 'unreachable',
      detail: controller.signal.aborted ? `timed out after ${timeoutMs}ms` : detail,
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface Health {
  ok: boolean
  version: string
  configured: boolean
  endpoints: EndpointHealth[]
}

export async function checkHealth(db: Db, version: string): Promise<Health> {
  const endpoints = db.select().from(schema.mcpEndpoints).all()
  const results = await Promise.all(
    endpoints.map((e) => probeEndpoint({ id: e.id, name: e.name, url: e.url })),
  )
  const configured = db.select().from(schema.charter).limit(1).get() !== undefined
  // Liveness is about this process. A dead port is reported, not fatal — the
  // app must stay diagnosable with every port broken.
  return { ok: true, version, configured, endpoints: results }
}
