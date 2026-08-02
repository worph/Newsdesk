import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/index.js'
import { schema } from '../../../db/index.js'
import { McpError } from '../../mcp/client.js'

/**
 * The browser, over HTTP.
 *
 * A thin typed client for the container's REST surface — deliberately not its
 * MCP surface. MCP is what a *model* drives; everything here is the desk
 * driving the page itself with values it already holds, which is what keeps the
 * frozen payload out of a model's hands (docs/browser-publishing.md section 2).
 *
 * Every call is one request with its own timeout. There is no session to keep:
 * the container owns one browser and one tab, and the desk holds a lease over
 * it for the length of a publish rather than a connection.
 */

export interface BrowserEngineRef {
  id: string
  name: string
  apiBase: string
  viewer: string
}

/** Long enough for a heavy SPA to settle, short enough that a hang is visible. */
const DEFAULT_TIMEOUT_MS = 30_000

export function loadEngine(db: Db, engineId: string | null): BrowserEngineRef {
  if (!engineId) throw new McpError('this outlet has no browser engine configured', false)
  const row = db.select().from(schema.browserEngines).where(eq(schema.browserEngines.id, engineId)).get()
  if (!row) throw new McpError(`browser engine "${engineId}" no longer exists`, false)
  return { id: row.id, name: row.name, apiBase: row.apiBase.replace(/\/+$/, ''), viewer: row.viewer }
}

async function request(
  engine: BrowserEngineRef,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init
  let response: Response
  try {
    response = await fetch(`${engine.apiBase}${path}`, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // The container being down or slow is exactly the shape of failure waiting
    // can fix, so it is classified retryable like any other transport fault.
    const message = err instanceof Error ? err.message : String(err)
    throw new McpError(`browser "${engine.name}" is unreachable: ${message}`, true)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new McpError(
      `browser "${engine.name}" returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`,
      response.status >= 500,
      response.status,
    )
  }
  return response
}

async function post(
  engine: BrowserEngineRef,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  const response = await request(engine, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  })
  return response.json().catch(() => ({}))
}

export interface BrowserStatus {
  url?: string
  title?: string
}

export const browser = {
  async status(engine: BrowserEngineRef): Promise<BrowserStatus> {
    const response = await request(engine, '/api/status', { timeoutMs: 10_000 })
    return (await response.json().catch(() => ({}))) as BrowserStatus
  },

  async navigate(engine: BrowserEngineRef, url: string): Promise<void> {
    await post(engine, '/api/navigate', { url }, 60_000)
  },

  async waitFor(engine: BrowserEngineRef, selector: string, timeoutMs = 15_000): Promise<void> {
    await post(engine, '/api/action', { action: 'waitFor', selector, timeout: timeoutMs }, timeoutMs + 5_000)
  },

  async click(engine: BrowserEngineRef, selector: string): Promise<void> {
    await post(engine, '/api/action', { action: 'click', selector })
  },

  /**
   * Type a value into a field.
   *
   * The value comes from the frozen payload and is passed through untouched —
   * this function is the only place published copy enters the browser, and it
   * never looks at what it is carrying.
   */
  async fill(engine: BrowserEngineRef, selector: string, text: string): Promise<void> {
    await post(engine, '/api/action', { action: 'type', selector, text }, 60_000)
  },

  async getText(engine: BrowserEngineRef, selector: string): Promise<string> {
    const result = (await post(engine, '/api/action', { action: 'getText', selector })) as unknown
    return readString(result)
  },

  /**
   * What a field actually holds now.
   *
   * `getText` reads rendered text, which is not the same thing: an `<input>` or
   * `<textarea>` has no text content at all, and a contenteditable renders
   * newlines as elements. Reading the value the way the page itself would is
   * the only comparison worth making against the bytes we typed.
   */
  async readValue(engine: BrowserEngineRef, selector: string): Promise<string> {
    // An immediately-invoked expression, not a function declaration: the
    // container hands the string to `page.evaluate`, which evaluates a string
    // as an *expression*. A bare `() => {…}` therefore evaluates to a function
    // object rather than to the field, and comes back as nothing at all.
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      if ('value' in el && typeof el.value === 'string') return el.value
      return el.innerText ?? el.textContent ?? ''
    })()`
    const result = (await post(engine, '/api/evaluate', { script })) as { result?: unknown }
    const value = result?.result
    if (value === null || value === undefined) {
      throw new McpError(`nothing matches "${selector}" on the page`, false)
    }
    return String(value)
  },

  /**
   * Is anything matching this selector on the page right now?
   *
   * Deliberately not a wait: a sign-in marker is being tested for *absence* in
   * the normal case, and waiting for something that should not be there would
   * add its timeout to every healthy publish.
   */
  async exists(engine: BrowserEngineRef, selector: string): Promise<boolean> {
    const script = `(() => document.querySelector(${JSON.stringify(selector)}) !== null)()`
    const result = (await post(engine, '/api/evaluate', { script })) as { result?: unknown }
    return result?.result === true
  },

  /** An attribute of the first match, for a verify step reading a permalink. */
  async readAttribute(
    engine: BrowserEngineRef,
    selector: string,
    attribute: string,
  ): Promise<string | null> {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      return el.getAttribute(${JSON.stringify(attribute)})
    })()`
    const result = (await post(engine, '/api/evaluate', { script })) as { result?: unknown }
    const value = result?.result
    return value === null || value === undefined ? null : String(value)
  },

  async screenshot(engine: BrowserEngineRef): Promise<Buffer> {
    const response = await request(engine, '/api/screenshot', { timeoutMs: 30_000 })
    return Buffer.from(await response.arrayBuffer())
  },

  /**
   * The VNC password, which rotates every time the container boots.
   *
   * Fetched server-side and handed to the operator's browser only as part of an
   * already-authenticated viewer URL. The container's own port is never
   * reachable from outside the desk.
   */
  async vncPassword(engine: BrowserEngineRef): Promise<string> {
    const response = await request(engine, '/api/vnc-password', { timeoutMs: 10_000 })
    const body = (await response.json().catch(() => ({}))) as { password?: string }
    return body.password ?? ''
  },
}

/** The REST surface answers actions with varying shapes; take the first string. */
function readString(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    for (const key of ['text', 'value', 'result', 'content']) {
      const value = (result as Record<string, unknown>)[key]
      if (typeof value === 'string') return value
    }
  }
  return result === null || result === undefined ? '' : String(result)
}
