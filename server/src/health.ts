import type { Db } from './db/index.js'
import { schema } from './db/index.js'
import { parseAuth } from './ports/mcp/client.js'
import { bearerFor } from './ports/mcp/oauth.js'

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
  endpoint: { id: string; name: string; url: string; auth?: string | null },
  timeoutMs = 4000,
): Promise<EndpointHealth> {
  // An OAuth endpoint we hold a token for must be probed WITH it, or a working
  // connection reports as unauthorized forever. The token is read but never
  // refreshed here: /healthz has to answer even when the authorization server
  // is down, so an expired token is allowed to surface as `unauthorized`,
  // which is exactly the state the operator needs to see.
  const bearer = endpoint.auth ? bearerFor(endpoint.auth) ?? parseAuth(endpoint.auth).bearer : undefined
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
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
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

    // Never spread `endpoint` itself into the reply — it carries the token.
    const { id, name, url } = endpoint
    const bare = { id, name, url }
    const latencyMs = Date.now() - started
    if (response.status === 401 || response.status === 403) {
      return { ...bare, status: 'unauthorized', detail: `HTTP ${response.status}`, latencyMs }
    }
    if (!response.ok) {
      return { ...bare, status: 'error', detail: `HTTP ${response.status}`, latencyMs }
    }
    return { ...bare, status: 'ok', latencyMs }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
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

export async function checkHealth(db: Db, version: string, probeTimeoutMs?: number): Promise<Health> {
  const endpoints = db.select().from(schema.mcpEndpoints).all()
  const results = await Promise.all(
    endpoints.map((e) =>
      // The timeout is injectable for the same reason it is on the assistant's
      // bundle: a screen with a human in front of it cannot spend four seconds
      // per dead endpoint, and a test suite cannot spend it at all.
      probeTimeoutMs === undefined
        ? probeEndpoint({ id: e.id, name: e.name, url: e.url, auth: e.auth })
        : probeEndpoint({ id: e.id, name: e.name, url: e.url, auth: e.auth }, probeTimeoutMs),
    ),
  )
  const configured = db.select().from(schema.charter).limit(1).get() !== undefined
  // Liveness is about this process. A dead port is reported, not fatal — the
  // app must stay diagnosable with every port broken.
  return { ok: true, version, configured, endpoints: results }
}
