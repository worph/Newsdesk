import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * One shared MCP client serves both the inference port and `mcp`-driver
 * targets. Endpoints are rows, so a deployment can point at a Beacon
 * aggregator, several Beacons, or a standalone server, with no code change.
 *
 * Connections are made per call and closed after. A pooled session would save
 * a handshake, but the desk makes a handful of calls an hour and a stale
 * session that fails on the one call that mattered is a far worse trade.
 *
 * See IMPLEMENTATION.md section 5.2.
 */

export interface McpEndpointRef {
  id: string
  name: string
  url: string
  /** JSON blob from the row: `{ bearer }` or `{ headers }`. */
  auth?: string | null
}

export interface McpAuth {
  bearer?: string
  headers?: Record<string, string>
}

export function parseAuth(auth: string | null | undefined): McpAuth {
  if (!auth) return {}
  try {
    const parsed = JSON.parse(auth) as McpAuth
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function authHeaders(auth: McpAuth): Record<string, string> {
  return {
    ...(auth.headers ?? {}),
    ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
  }
}

/**
 * A failed tool call, classified so the queue knows whether waiting could
 * help. Anything transport-shaped — a busy upstream, a gateway, a timeout —
 * is worth retrying; a bad tool name or bad arguments never is.
 */
export class McpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

/** Statuses where the upstream is busy or broken rather than refusing us. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export function classifyError(err: unknown): McpError {
  if (err instanceof McpError) return err

  const message = err instanceof Error ? err.message : String(err)

  // The SDK surfaces HTTP failures in the message text rather than as a field.
  const status = Number(/\b(4\d\d|5\d\d)\b/.exec(message)?.[1] ?? Number.NaN)
  if (!Number.isNaN(status)) {
    return new McpError(message, RETRYABLE_STATUS.has(status), status)
  }

  const lowered = message.toLowerCase()
  const transport =
    lowered.includes('timed out') ||
    lowered.includes('timeout') ||
    lowered.includes('aborted') ||
    lowered.includes('econnreset') ||
    lowered.includes('econnrefused') ||
    lowered.includes('socket hang up') ||
    lowered.includes('fetch failed')

  return new McpError(message, transport)
}

async function withClient<T>(
  endpoint: McpEndpointRef,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const headers = authHeaders(parseAuth(endpoint.auth))
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
  })
  const client = new Client({ name: 'newsdesk', version: '0.1.0' })

  try {
    await client.connect(transport)
    return await fn(client)
  } catch (err) {
    throw classifyError(err)
  } finally {
    // A close failure must not mask the real error above.
    await client.close().catch(() => undefined)
  }
}

export interface ToolResult {
  /** All text content blocks, joined. */
  text: string
  isError: boolean
}

interface ContentBlock {
  type: string
  text?: string
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as ContentBlock[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

export interface CallOptions {
  /** Per-call ceiling. Publish-class calls are given 280s. */
  timeoutMs?: number
}

export async function callTool(
  endpoint: McpEndpointRef,
  tool: string,
  args: Record<string, unknown>,
  options: CallOptions = {},
): Promise<ToolResult> {
  return withClient(endpoint, async (client) => {
    const result = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: options.timeoutMs ?? 280_000 },
    )
    const text = textOf(result.content)
    // A tool-level error is the upstream refusing the work, not a broken
    // transport, so it is reported rather than retried blindly.
    if (result.isError) {
      throw new McpError(text || `tool "${tool}" reported an error`, false)
    }
    return { text, isError: false }
  })
}

export interface DiscoveredTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export async function discoverTools(endpoint: McpEndpointRef): Promise<DiscoveredTool[]> {
  return withClient(endpoint, async (client) => {
    const { tools } = await client.listTools()
    return tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }))
  })
}

/**
 * A Beacon aggregator does NOT advertise the tools it aggregates. Its
 * `tools/list` returns exactly four of its own — `overview`, `tool_doc`,
 * `server_doc`, `call` — while the aggregated tools stay behind them. Verified
 * against the live local Beacon 2026-07-30.
 *
 * It does, however, route a namespaced `server__tool` name called directly, so
 * only discovery needs the indirection; delivery and inference call the real
 * tool name as written in configuration.
 */
const BEACON_TOOLS = ['overview', 'server_doc', 'call']

export function looksLikeBeacon(tools: DiscoveredTool[]): boolean {
  const names = new Set(tools.map((t) => t.name))
  return BEACON_TOOLS.every((name) => names.has(name))
}

/**
 * Server names out of Beacon's `overview`, which is markdown rather than JSON:
 * a `## server-name` heading per aggregated server.
 */
export function parseOverviewServers(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const match = /^##\s+(\S+)\s*$/.exec(line)
    if (match?.[1]) names.push(match[1])
  }
  return names
}

interface ServerDocTool {
  name?: string
  description?: string
  inputSchema?: unknown
}

interface ServerDoc {
  server?: string
  tools?: ServerDocTool[]
}

export interface Catalogue {
  kind: 'beacon' | 'plain'
  servers: Array<{ name: string; tools: DiscoveredTool[] }>
  discoveredAt: string
}

/**
 * Enumerate what an endpoint actually offers, in the shape the target editor
 * needs: endpoint → server → tool → argument schema.
 *
 * Discovery quality varies by endpoint. One Beacon returns full `inputSchema`
 * objects; another returns descriptions with no schema at all. So a tool may
 * legitimately arrive with no schema, and the editor must fall back to manual
 * key entry rather than assume one exists. Discovered schemas are an authoring
 * aid, never an outbound validator.
 */
export async function discoverCatalogue(endpoint: McpEndpointRef): Promise<Catalogue> {
  const top = await discoverTools(endpoint)
  const discoveredAt = new Date().toISOString()

  if (!looksLikeBeacon(top)) {
    // A standalone server: its own tools are the catalogue. Group them by the
    // namespace prefix if it happens to use one, otherwise under its own id.
    const servers = new Map<string, DiscoveredTool[]>()
    for (const tool of top) {
      const key = serverOf(tool.name) ?? endpoint.id
      const list = servers.get(key) ?? []
      list.push(tool)
      servers.set(key, list)
    }
    return {
      kind: 'plain',
      servers: [...servers].map(([name, tools]) => ({ name, tools })),
      discoveredAt,
    }
  }

  const overview = await callTool(endpoint, 'overview', {}, { timeoutMs: 30_000 })
  const names = parseOverviewServers(overview.text)

  const servers = await Promise.all(
    names.map(async (name) => {
      try {
        const doc = await callTool(endpoint, 'server_doc', { server_name: name }, { timeoutMs: 30_000 })
        const parsed = JSON.parse(doc.text) as ServerDoc
        const tools = (parsed.tools ?? [])
          .filter((t): t is ServerDocTool & { name: string } => typeof t.name === 'string')
          .map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
          }))
        return { name, tools }
      } catch {
        // One unreachable or schema-less server must not lose the rest of the
        // catalogue — an endpoint that answers partially is still useful.
        return { name, tools: [] }
      }
    }),
  )

  return { kind: 'beacon', servers, discoveredAt }
}

/** `server__tool` → `server`, the Beacon namespacing convention. */
export function serverOf(toolName: string): string | undefined {
  const index = toolName.indexOf('__')
  return index > 0 ? toolName.slice(0, index) : undefined
}
