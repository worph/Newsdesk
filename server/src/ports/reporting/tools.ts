import { isSlot, templateExpressions, type ArgsSpec, type Reporting, type ReportingTool } from '@newsdesk/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.js'
import { schema } from '../../db/index.js'
import { renderTemplate } from '../../render/payload.js'
import { callTool, McpError } from '../mcp/client.js'
import { attachAuth } from '../mcp/oauth.js'
import { extractJson } from '../inference/structured.js'

/**
 * The tools the reporter is allowed to use, held by the desk rather than by the
 * model.
 *
 * The inference driver has no web access and cannot be handed tools, so if
 * reporting is to be grounded somebody else has to hold them. Giving them to
 * the model instead would cost us two things we cannot afford: we would have no
 * record of what was actually consulted (a citation would be another model
 * claim), and a model reading attacker-controlled pages with a live fetch tool
 * sits inside a pipeline that ends at publishing.
 *
 * So the desk calls; the model only ever supplies a query string or an index
 * into results the desk produced. Which tool, which endpoint and which argument
 * shape are literals in configuration — invariant 3, extended from "the model
 * never authors a destination" to "the model never authors a call".
 *
 * See docs/pitch-and-reporting.md sections 3 and 5.
 */

export interface SearchHit {
  title: string
  url: string
  snippet?: string
}

export interface FetchedPage {
  url: string
  title?: string
  text: string
  ok: boolean
  error?: string
}

export interface ReportingTools {
  readonly canSearch: boolean
  readonly canFetch: boolean
  search(query: string): Promise<SearchHit[]>
  fetch(url: string): Promise<FetchedPage>
}

/** Every configured candidate for a role failed. The reporter degrades; it does not die. */
export class NoToolAnswered extends Error {
  constructor(
    readonly role: 'search' | 'fetch',
    readonly attempts: number,
    readonly lastError?: string,
  ) {
    super(
      attempts === 0
        ? `no ${role} tool is configured`
        : `all ${attempts} ${role} tool(s) failed: ${lastError ?? 'unknown error'}`,
    )
    this.name = 'NoToolAnswered'
  }
}

/**
 * Fill a tool's configured arguments for one call.
 *
 * A slot cannot appear here — validateConfig rejects one — but it is skipped
 * rather than trusted, because a slot reaching an outbound argument would mean
 * a model had authored part of the call.
 */
export function renderCallArgs(args: ArgsSpec, call: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(args)) {
    if (isSlot(spec)) continue
    out[key] =
      typeof spec === 'string' && templateExpressions(spec).length > 0
        ? renderTemplate(spec, { call })
        : spec
  }
  return out
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g

/** Trailing punctuation is far more often prose than part of the address. */
function tidyUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, '')
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Every link carried by a filing, in the order it was written, deduplicated.
 *
 * This is the reporter's first move and the only one that needs no model call:
 * a tip that arrived with a link is already half-reported, which is why the tip
 * line folds a shared url into the text rather than dropping it.
 */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? []
  const seen = new Set<string>()
  const urls: string[] = []
  for (const raw of found) {
    const url = tidyUrl(raw)
    if (!isHttpUrl(url) || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** Pull the result array out of whatever envelope a server chose to use. */
function resultArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const key of ['results', 'items', 'hits', 'data', 'organic', 'web']) {
      const value = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
      // SearXNG-ish nesting: { web: { results: [...] } }
      if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).results)) {
        return (value as { results: unknown[] }).results
      }
    }
  }
  return []
}

/**
 * Read search results out of a tool's reply.
 *
 * Every server answers differently — JSON in one shape or another, or a
 * markdown list — and the desk cannot require one, so this is deliberately
 * forgiving: try JSON first, then scrape links out of prose. A search that
 * returns something we cannot read is reported as no hits rather than as an
 * error, because the reporter's job is to carry on with less.
 */
export function parseSearchHits(text: string): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()

  const push = (url: string, title?: string, snippet?: string) => {
    const tidy = tidyUrl(url)
    if (!isHttpUrl(tidy) || seen.has(tidy)) return
    seen.add(tidy)
    hits.push({ url: tidy, title: title?.trim() || tidy, ...(snippet ? { snippet: snippet.trim() } : {}) })
  }

  const json = extractJson(text)
  if (json) {
    try {
      for (const entry of resultArray(JSON.parse(json))) {
        if (!entry || typeof entry !== 'object') continue
        const row = entry as Record<string, unknown>
        const url = firstString(row, ['url', 'link', 'href', 'source'])
        if (url) push(url, firstString(row, ['title', 'name', 'heading']), firstString(row, ['snippet', 'content', 'description', 'summary', 'excerpt']))
      }
    } catch {
      // Fall through to the prose scrape.
    }
  }

  if (hits.length > 0) return hits

  // Markdown links first, so a title survives when there is one to keep.
  for (const match of text.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) {
    push(match[2]!, match[1])
  }
  for (const url of extractUrls(text)) push(url)

  return hits
}

/** A page's title, if the reply volunteered one. */
function parseFetchedTitle(text: string): string | undefined {
  const json = extractJson(text)
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const title = firstString(parsed as Record<string, unknown>, ['title', 'heading', 'name'])
        if (title) return title
      }
    } catch {
      // Not JSON; fall through.
    }
  }
  const heading = /^#{1,3}\s+(.{1,200})$/m.exec(text)
  return heading?.[1]?.trim()
}

function endpointFor(db: Db, tool: ReportingTool) {
  const row = db
    .select()
    .from(schema.mcpEndpoints)
    .where(eq(schema.mcpEndpoints.id, tool.endpoint))
    .get()
  if (!row) throw new McpError(`endpoint "${tool.endpoint}" no longer exists`, false)
  return attachAuth(db, row)
}

export function createMcpReportingTools(db: Db, reporting: Reporting): ReportingTools {
  const timeoutMs = reporting.timeout_seconds * 1000

  /**
   * Walk the candidates in order and take the first answer.
   *
   * A retryable McpError — a busy upstream, a timeout, a dead socket — moves on
   * to the next candidate, which is what makes a slow-but-reliable browser tool
   * worth listing last. A terminal one does not: a bad tool name or bad
   * arguments is a configuration error, and quietly falling through to the
   * backup would hide it forever.
   */
  async function firstAnswer(
    role: 'search' | 'fetch',
    candidates: ReportingTool[],
    call: Record<string, string>,
  ): Promise<string> {
    let lastError: string | undefined
    for (const candidate of candidates) {
      try {
        const result = await callTool(
          endpointFor(db, candidate),
          candidate.tool,
          renderCallArgs(candidate.args, call),
          { timeoutMs },
        )
        return result.text
      } catch (err) {
        if (err instanceof McpError && !err.retryable) throw err
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    throw new NoToolAnswered(role, candidates.length, lastError)
  }

  return {
    canSearch: reporting.search.length > 0,
    canFetch: reporting.fetch.length > 0,

    async search(query) {
      return parseSearchHits(await firstAnswer('search', reporting.search, { query }))
    },

    /**
     * A dead page is a result, not an exception: it becomes a row with ok = 0
     * so the record shows what was tried, and the reporter carries on. Only a
     * configuration error escapes.
     */
    async fetch(url) {
      try {
        const text = await firstAnswer('fetch', reporting.fetch, { url })
        const title = parseFetchedTitle(text)
        return { url, text, ok: true, ...(title ? { title } : {}) }
      } catch (err) {
        if (err instanceof McpError && !err.retryable) throw err
        return { url, text: '', ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
