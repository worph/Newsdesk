import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reportingSchema, type Reporting } from '@newsdesk/shared'
import { describe, expect, it, onTestFinished } from 'vitest'
import { openTestDb, schema } from './helpers.js'
import { McpError } from '../src/ports/mcp/client.js'
import {
  createMcpReportingTools,
  extractUrls,
  parseSearchHits,
  renderCallArgs,
  type ToolCaller,
} from '../src/ports/reporting/tools.js'

/**
 * The tool layer is the desk's hands. What matters here is that it reaches the
 * right tool with the right arguments, degrades to the next candidate when one
 * is merely unwell, and refuses to hide a configuration error behind a backup.
 */

function reporting(overrides: Partial<Reporting> = {}): Reporting {
  return reportingSchema.parse({
    search: [
      { endpoint: 'beacon', tool: 'searxng__search', args: { query: '{{ call.query }}', count: 6 } },
      { endpoint: 'beacon', tool: 'browser-mcp__search', args: { q: '{{ call.query }}' } },
    ],
    fetch: [{ endpoint: 'beacon', tool: 'browser-mcp__get_page_text', args: { url: '{{ call.url }}' } }],
    ...overrides,
  })
}

function deskWithEndpoint() {
  const { db } = openTestDb()
  db.insert(schema.mcpEndpoints).values({ id: 'beacon', name: 'beacon', url: 'http://beacon/mcp/' }).run()
  return db
}

describe('reading search results', () => {
  it('takes a bare JSON array', () => {
    const hits = parseSearchHits('[{"title":"Immich 1.142","url":"https://immich.app/blog"}]')
    expect(hits).toEqual([{ title: 'Immich 1.142', url: 'https://immich.app/blog' }])
  })

  it('finds the results inside whatever envelope the server chose', () => {
    for (const body of [
      '{"results":[{"title":"A","url":"https://a.example"}]}',
      '{"items":[{"name":"A","link":"https://a.example"}]}',
      '{"web":{"results":[{"heading":"A","href":"https://a.example"}]}}',
    ]) {
      expect(parseSearchHits(body)[0]?.url).toBe('https://a.example')
    }
  })

  it('keeps the snippet under whichever name it arrived with', () => {
    const hits = parseSearchHits('[{"url":"https://a.example","description":"  what happened  "}]')
    expect(hits[0]?.snippet).toBe('what happened')
  })

  it('scrapes markdown when the reply is prose, keeping the link text as the title', () => {
    const hits = parseSearchHits('Here is what I found:\n\n- [Immich blog](https://immich.app/blog)\n')
    expect(hits).toEqual([{ title: 'Immich blog', url: 'https://immich.app/blog' }])
  })

  it('falls back to bare urls in prose', () => {
    expect(parseSearchHits('see https://a.example/post for more.')[0]?.url).toBe('https://a.example/post')
  })

  it('deduplicates and refuses anything that is not http', () => {
    const hits = parseSearchHits(
      '[{"url":"https://a.example"},{"url":"https://a.example"},{"url":"file:///etc/passwd"},{"url":"javascript:alert(1)"}]',
    )
    expect(hits.map((h) => h.url)).toEqual(['https://a.example'])
  })

  // A search we cannot read is "nothing found", not a failure — the reporter's
  // job is to carry on with less.
  it('reports an unreadable reply as no hits rather than throwing', () => {
    expect(parseSearchHits('sorry, I could not search right now')).toEqual([])
  })
})

describe('links carried by a filing', () => {
  it('keeps written order and drops repeats', () => {
    expect(extractUrls('see https://b.example then https://a.example and https://b.example again')).toEqual([
      'https://b.example',
      'https://a.example',
    ])
  })

  it('does not swallow the sentence punctuation into the address', () => {
    expect(extractUrls('read https://a.example/post.')).toEqual(['https://a.example/post'])
  })

  it('ignores non-http schemes', () => {
    expect(extractUrls('mailto:a@b.c and ftp://x.example')).toEqual([])
  })
})

describe('filling a tool call', () => {
  it('passes literals through and interpolates only the call variable', () => {
    expect(renderCallArgs({ query: '{{ call.query }}', count: 6, safe: true }, { query: 'immich' })).toEqual({
      query: 'immich',
      count: 6,
      safe: true,
    })
  })

  // validateConfig rejects a slot here; this is the belt to that braces. A slot
  // reaching an outbound argument would mean a model authored part of the call.
  it('skips an authoring slot rather than trusting it', () => {
    const args = { url: '{{ call.url }}', evil: { slot: 'text' as const, label: 'x', optional: false, primary: false } }
    expect(renderCallArgs(args, { url: 'https://a.example' })).toEqual({ url: 'https://a.example' })
  })

  it('resolves an unknown root to nothing rather than leaking template syntax', () => {
    expect(renderCallArgs({ q: '{{ story.url }}' }, { query: 'x' })).toEqual({ q: '' })
  })
})

describe('the fallback chain', () => {
  it('moves to the next candidate when one is merely unwell', async () => {
    const db = deskWithEndpoint()
    const tried: string[] = []
    const call: ToolCaller = async (_endpoint, tool) => {
      tried.push(tool)
      if (tool === 'searxng__search') throw new McpError('fetch failed', true)
      return { text: '[{"title":"A","url":"https://a.example"}]' }
    }

    const hits = await createMcpReportingTools(db, reporting(), call).search('immich')

    expect(tried).toEqual(['searxng__search', 'browser-mcp__search'])
    expect(hits[0]?.url).toBe('https://a.example')
  })

  /**
   * A bad tool name is a configuration error. Falling through to the backup
   * would make it work by accident and hide it forever.
   */
  it('does not hide a terminal failure behind the backup', async () => {
    const db = deskWithEndpoint()
    const tried: string[] = []
    const call: ToolCaller = async (_endpoint, tool) => {
      tried.push(tool)
      throw new McpError('unknown tool "searxng__search"', false)
    }

    await expect(createMcpReportingTools(db, reporting(), call).search('immich')).rejects.toThrow('unknown tool')
    expect(tried).toEqual(['searxng__search'])
  })

  it('reports every candidate failing as no answer, naming the last error', async () => {
    const db = deskWithEndpoint()
    const call: ToolCaller = async () => {
      throw new McpError('socket hang up', true)
    }

    await expect(createMcpReportingTools(db, reporting(), call).search('immich')).rejects.toThrow(
      /all 2 search tool\(s\) failed: socket hang up/,
    )
  })

  /**
   * A dead page is a record, not an exception: the reporter needs to carry on
   * and the row still shows what was tried.
   */
  it('turns a failed fetch into an unsuccessful page rather than an error', async () => {
    const db = deskWithEndpoint()
    const call: ToolCaller = async () => {
      throw new McpError('timed out after 60000ms', true)
    }

    const page = await createMcpReportingTools(db, reporting(), call).fetch('https://a.example')

    expect(page.ok).toBe(false)
    expect(page.url).toBe('https://a.example')
    expect(page.error).toMatch(/timed out/)
  })

  it('knows which roles it can actually perform', () => {
    const db = deskWithEndpoint()
    const tools = createMcpReportingTools(db, reporting({ search: [] }), async () => ({ text: '' }))
    expect(tools.canSearch).toBe(false)
    expect(tools.canFetch).toBe(true)
  })
})

/**
 * The http driver exists because a search engine is an HTTP API, not an MCP
 * server. The fixture below is a real SearXNG 2026.7.31 reply, captured from
 * the holyhorse instance on 2026-07-31 — parsing is asserted against what a
 * server actually sends rather than what its docs say it sends.
 */
describe('the http driver', () => {
  const searxng = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/searxng-immich.json', import.meta.url)), 'utf8'),
  )

  it('reads a real SearXNG reply', () => {
    const hits = parseSearchHits(JSON.stringify(searxng))

    expect(hits).toHaveLength(3)
    expect(hits[0]).toMatchObject({
      title: 'Releases · immich-app/immich - GitHub',
      url: 'https://github.com/immich-app/immich/releases',
    })
    expect(hits[0]?.snippet).toContain('easier-to-use editor')
  })

  it('puts the arguments in the query string, encoded', async () => {
    const db = deskWithEndpoint()
    let seen: URL | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL) => {
      seen = new URL(String(input))
      return new Response(JSON.stringify(searxng), { status: 200 })
    }) as typeof fetch
    onTestFinished(() => {
      globalThis.fetch = originalFetch
    })

    const tools = createMcpReportingTools(
      db,
      reporting({
        search: [
          {
            driver: 'http',
            url: 'http://searxng-backend:8080/search',
            method: 'GET',
            args: { q: '{{ call.query }}', format: 'json' },
          },
        ],
      }),
    )
    const hits = await tools.search('sam altman & "the singularity"')

    expect(seen?.origin).toBe('http://searxng-backend:8080')
    expect(seen?.searchParams.get('q')).toBe('sam altman & "the singularity"')
    expect(seen?.searchParams.get('format')).toBe('json')
    expect(hits).toHaveLength(3)
  })

  /**
   * A 403 is what SearXNG answers when `json` is not in its `search.formats`.
   * That is a configuration error: falling through to a backup would hide it.
   */
  it('treats a 4xx as terminal and a 5xx as worth retrying', async () => {
    const db = deskWithEndpoint()
    const originalFetch = globalThis.fetch
    onTestFinished(() => {
      globalThis.fetch = originalFetch
    })

    const httpTool = (url: string) => ({
      driver: 'http' as const,
      url,
      method: 'GET' as const,
      args: { q: '{{ call.query }}' },
    })

    globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof fetch
    await expect(
      createMcpReportingTools(db, reporting({ search: [httpTool('http://a.example/search')] })).search('x'),
    ).rejects.toThrow(/answered 403/)

    // A 5xx falls through to the next candidate instead.
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return calls === 1
        ? new Response('boom', { status: 502 })
        : new Response(JSON.stringify(searxng), { status: 200 })
    }) as typeof fetch

    const hits = await createMcpReportingTools(
      db,
      reporting({ search: [httpTool('http://a.example/search'), httpTool('http://b.example/search')] }),
    ).search('x')

    expect(calls).toBe(2)
    expect(hits).toHaveLength(3)
  })
})
