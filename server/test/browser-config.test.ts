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

  it('will not let a non-browser outlet say how it finishes', () => {
    // The dangerous version of the previous test: an outlet meant to be
    // hand-finished, typed `mcp`, would send itself and still read as
    // configured — the mistake would only be visible after it had gone out.
    const issues = issuesFor(
      config({
        driver: 'mcp',
        endpoint: undefined,
        tool: 'discord-mcp__send_embed',
        engine: undefined,
        recipe: undefined,
        publish: 'tethered',
        args: {
          channelId: '123',
          body: { slot: 'markdown', label: 'Post', primary: true },
        },
      }),
    )
    expect(issues).toContain('`publish` only applies to a browser outlet — this one is "mcp"')
  })
})

/**
 * The mode says how a publish finishes; the recipe has to be capable of it.
 *
 * These replace the old blanket refusal of autonomous outlets. Each one is a
 * specific way the pair can be incoherent — an outlet that publishes by itself
 * with nothing able to confirm it landed, or a person being handed a page with
 * no instructions — rather than a house style.
 */
describe('how a browser outlet finishes', () => {
  const AUTO = `## Stage
fill: div.editor <- body

## Commit
click: button.send

## Verify
read: a.permalink -> url`

  it('defaults to tethered, which is what it did before the field existed', () => {
    // No `publish` anywhere in the fixture, and the hand-over rules apply — so
    // an old configuration keeps its behaviour rather than acquiring a new one.
    expect(issuesFor(config())).toEqual([])
    expect(issuesFor(config({ publish: 'tethered' }))).toEqual([])
  })

  it('lets an outlet publish by itself when it can prove it landed', () => {
    expect(issuesFor(config({ publish: 'auto', recipe: AUTO }))).toEqual([])
  })

  it('refuses to publish by itself with no way to confirm it', () => {
    // Nobody is watching, so a PUBLISHED row with no verify step is one the desk
    // cannot vouch for at all — and there is no honest evidence grade for that.
    expect(
      issuesFor(config({ publish: 'auto', recipe: '## Stage\nfill: div.editor <- body' })),
    ).toEqual([expect.stringContaining('needs a `## Verify` section')])
  })

  it('refuses hand-over prose on an outlet that finishes itself', () => {
    expect(
      issuesFor(config({ publish: 'auto', recipe: `${AUTO}\n## Hand over\nPress Post.` })),
    ).toEqual([expect.stringContaining('has nobody to talk to')])
  })

  it('wants hand-over prose whenever a person finishes it', () => {
    const noProse = '## Stage\nfill: div.editor <- body\n## Verify\nread: a.permalink -> url'
    expect(issuesFor(config({ publish: 'tethered', recipe: noProse }))).toEqual([
      expect.stringContaining('needs a `## Hand over` section'),
    ])
  })

  it('wants a detached outlet to record where it filed the draft', () => {
    // Without the link there is nothing to hand over and, worse, nothing for the
    // never-file-this-twice guard to key on.
    expect(issuesFor(config({ publish: 'detached' }))).toEqual([
      expect.stringContaining('cannot stop itself filing a second one'),
    ])
  })

  it('keeps a commit section legal, and inert, under a hand-over mode', () => {
    // This is what lets one Telegram recipe serve both cases: whether the desk
    // presses send is the outlet's `publish` field, not the recipe's shape.
    const both = `${AUTO}\n## Hand over\nRead it, then press the send arrow.`
    expect(issuesFor(config({ publish: 'tethered', recipe: both }))).toEqual([])
  })

  it('never lets a destination that requires a person publish by itself', () => {
    const issues = issuesFor(config({ publish: 'auto', requires_human: true, recipe: AUTO }))
    expect(issues).toEqual([expect.stringContaining('cannot publish by itself')])
  })

  it('leaves requires_human alone when a person does finish it', () => {
    expect(issuesFor(config({ publish: 'tethered', requires_human: true }))).toEqual([])
  })
})
