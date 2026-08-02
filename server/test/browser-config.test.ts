import { parseConfig, type Config } from '@newsdesk/shared'
import { describe, expect, it } from 'vitest'

/**
 * What the desk refuses to save.
 *
 * Configuration is where a browser outlet's dangerous shapes are caught, and
 * every rule here has the same character as the destination-pinning rule for
 * MCP outlets: the failure it prevents is silent, so it has to be loud at save
 * time rather than surprising at publish time.
 */

const RECIPE = `## Stage
click: button.compose
fill:  div.editor <- body
## Hand over
Press Post.`

function config(outlet: Partial<Config['outlets'][number]> = {}): unknown {
  return {
    charter: 'Everything about self-hosting goes to LinkedIn.',
    browser_engines: [{ id: 'sidecar', name: 'browser', api_base: 'http://newsdesk-browser:9746' }],
    voices: [{ id: 'alicia', name: 'Alicia', tone: 'dry', audience: 'self-hosters' }],
    outlets: [
      {
        id: 'linkedin',
        name: 'LinkedIn',
        description: 'the company page',
        role: 'publish',
        driver: 'browser',
        voice: 'alicia',
        engine: 'sidecar',
        recipe: RECIPE,
        args: {
          url: 'https://www.linkedin.com/company/example/admin/',
          body: { slot: 'markdown', label: 'Post', primary: true },
        },
        ...outlet,
      },
    ],
  }
}

const issuesFor = (input: unknown): string[] => parseConfig(input).issues.map((issue) => issue.message)

describe('a browser outlet', () => {
  it('validates when it pins a page, names an engine and hands over', () => {
    expect(issuesFor(config())).toEqual([])
  })

  it('must pin the page it publishes to as a literal', () => {
    // The recipe is prose an assistant helps edit. A destination living there
    // is exactly what invariant 3 exists to prevent.
    expect(issuesFor(config({ args: { body: { slot: 'markdown', label: 'Post', primary: true } } }))).toEqual([
      expect.stringContaining('must pin the page it publishes to as a literal "url"'),
    ])
  })

  it('refuses a page that a model or a template could write', () => {
    expect(
      issuesFor(
        config({
          args: {
            url: '{{story.url}}',
            body: { slot: 'markdown', label: 'Post', primary: true },
          },
        }),
      ),
    ).toEqual([expect.stringContaining('must be a literal')])

    expect(
      issuesFor(
        config({
          args: {
            url: { slot: 'link', label: 'Where' },
            body: { slot: 'markdown', label: 'Post', primary: true },
          },
        }),
      ),
    ).toEqual([expect.stringContaining('must be a literal')])
  })

  it('wants an absolute address, not a path', () => {
    expect(
      issuesFor(
        config({
          args: {
            url: '/company/example/admin/',
            body: { slot: 'markdown', label: 'Post', primary: true },
          },
        }),
      ),
    ).toEqual([expect.stringContaining('absolute http(s) url')])
  })

  it('needs a browser that exists', () => {
    expect(issuesFor(config({ engine: undefined }))).toEqual([
      expect.stringContaining('needs an engine'),
    ])
    expect(issuesFor(config({ engine: 'nowhere' }))).toEqual([
      expect.stringContaining('unknown browser engine "nowhere"'),
    ])
  })

  it('needs a recipe, and one that parses', () => {
    expect(issuesFor(config({ recipe: undefined }))).toEqual([expect.stringContaining('needs a recipe')])
    // The malformed step is dropped, so the outlet is also left filling
    // nothing — both are true and both are said.
    expect(issuesFor(config({ recipe: '## Stage\nfill: div.editor\n## Hand over\nGo.' }))).toEqual([
      expect.stringContaining('line 2'),
      expect.stringContaining('at least one slot'),
    ])
  })

  it('refuses an autonomous outlet rather than half-supporting it', () => {
    // Phase 1 publishes only where a human presses the button. An outlet with no
    // hand over section would otherwise look configured and quietly do nothing.
    expect(issuesFor(config({ recipe: '## Stage\nfill: div.editor <- body' }))).toEqual([
      expect.stringContaining('autonomous browser outlets are not supported yet'),
    ])
  })

  it('will not type into a key that is not an authoring slot', () => {
    expect(
      issuesFor(config({ recipe: '## Stage\nfill: div.editor <- url\n## Hand over\nGo.' })),
    ).toEqual([expect.stringContaining('"url", which is not an authoring slot')])
  })

  it('refuses a verify step that stores something with nowhere to go', () => {
    expect(
      issuesFor(config({ recipe: `${RECIPE}\n## Verify\nread: a.link -> headline` })),
    ).toEqual([expect.stringContaining('nowhere to go')])
  })

  it('will not let a non-browser outlet carry a recipe', () => {
    // Silently ignoring it would make a mistyped driver look like it worked,
    // while the post went out through a completely different transport.
    const issues = issuesFor(
      config({
        driver: 'mcp',
        endpoint: undefined,
        tool: 'discord-mcp__send_embed',
        engine: undefined,
        args: {
          channelId: '123',
          body: { slot: 'markdown', label: 'Post', primary: true },
        },
      }),
    )
    expect(issues).toContain('`recipe` only applies to a browser outlet — this one is "mcp"')
  })
})
