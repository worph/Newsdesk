import { describe, expect, it } from 'vitest'
import {
  classifyError,
  looksLikeBeacon,
  McpError,
  parseAuth,
  parseOverviewServers,
  serverOf,
} from '../src/ports/mcp/client.js'

describe('endpoint auth', () => {
  it('reads a bearer token out of the row blob', () => {
    expect(parseAuth('{"bearer":"abc"}')).toEqual({ bearer: 'abc' })
  })

  it('treats absent or unparseable auth as none, rather than throwing', () => {
    // A malformed auth blob must not take the endpoint down at call time; it
    // fails as an unauthorized response, which /healthz can report.
    expect(parseAuth(null)).toEqual({})
    expect(parseAuth('not json')).toEqual({})
  })
})

describe('error classification', () => {
  it('marks a busy upstream retryable', () => {
    // 409 is claude-code refusing a concurrent session — waiting is exactly
    // the right response.
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      expect(classifyError(new Error(`HTTP ${status} from upstream`)).retryable).toBe(true)
    }
  })

  it('marks a refusal terminal, because waiting cannot fix it', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyError(new Error(`HTTP ${status}`)).retryable).toBe(false)
    }
  })

  it('treats transport failures as retryable', () => {
    for (const message of ['timed out after 280000ms', 'fetch failed', 'ECONNRESET', 'socket hang up']) {
      expect(classifyError(new Error(message)).retryable).toBe(true)
    }
  })

  it('defaults an unrecognised error to terminal', () => {
    // Retrying an error we do not understand burns the queue on a permanent
    // failure; surfacing it gets it fixed.
    expect(classifyError(new Error('tool "nope" not found')).retryable).toBe(false)
  })

  it('passes an already-classified error through unchanged', () => {
    const original = new McpError('busy', true, 409)
    expect(classifyError(original)).toBe(original)
  })
})

describe('beacon detection and discovery parsing', () => {
  const beaconTools = [
    { name: 'overview' },
    { name: 'tool_doc' },
    { name: 'server_doc' },
    { name: 'call' },
  ]

  it('recognises an aggregator by its four own tools', () => {
    // A Beacon hides what it aggregates: tools/list returns only these, so
    // discovery has to go through overview + server_doc.
    expect(looksLikeBeacon(beaconTools)).toBe(true)
  })

  it('does not mistake a standalone server for an aggregator', () => {
    expect(looksLikeBeacon([{ name: 'discord-mcp__send_embed' }, { name: 'overview' }])).toBe(false)
  })

  it('reads server names out of the markdown overview', () => {
    const overview = [
      '## claude-code',
      'Claude Code agent — send prompts and get responses',
      '- claude-code__query_claude — Send a prompt',
      '',
      '## chrome-devtools',
      'Chrome DevTools MCP — drive a real browser',
      '- chrome-devtools__click — Clicks on the provided element',
    ].join('\n')
    expect(parseOverviewServers(overview)).toEqual(['claude-code', 'chrome-devtools'])
  })

  it('ignores tool bullets and prose, taking only headings', () => {
    expect(parseOverviewServers('- not__a_server\nprose\n### too deep\n## real')).toEqual(['real'])
  })

  it('splits a namespaced tool name into its server', () => {
    expect(serverOf('discord-mcp__send_embed')).toBe('discord-mcp')
    expect(serverOf('overview')).toBeUndefined()
  })
})
