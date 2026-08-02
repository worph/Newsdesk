import { describe, expect, it } from 'vitest'
import { parseConfig, validateConfig, type Config } from '../src/config.js'
import { isDerived, isSlot, primarySlotKey, slotsOf } from '../src/slots.js'

/** A minimal valid config; each test bends one thing out of shape. */
function baseConfig(): unknown {
  return {
    charter: 'AppStore releases go to the test channel for a general audience.',
    mcp_endpoints: [{ id: 'beacon', name: 'yunderalabs beacon', url: 'http://beacon-backend:9300/mcp' }],
    voices: [
      { id: 'alicia', name: 'Alicia', tone: 'concise, technical, anti-hype', audience: 'self-hosters' },
    ],
    stringers: [{ id: 'tip-line', name: 'Tip line', kind: 'tip' }],
    outlets: [
      {
        id: 'discord-test',
        name: 'Discord #news-test',
        description: 'test channel for a general audience',
        role: 'publish',
        driver: 'mcp',
        voice: 'alicia',
        endpoint: 'beacon',
        tool: 'discord-mcp__send_embed',
        args: {
          channelId: '1514993197082742814',
          timestamp: true,
          footer: '{{story.url}}',
          title: { slot: 'text', label: 'Headline', max: 256 },
          description: { slot: 'markdown', label: 'Body', max: 4096, primary: true },
        },
      },
    ],
  }
}

function issuesFor(mutate: (c: Record<string, any>) => void): string[] {
  const raw = baseConfig() as Record<string, any>
  mutate(raw)
  const { issues } = parseConfig(raw)
  return issues.map((i) => `${i.path}: ${i.message}`)
}

describe('config shape', () => {
  it('accepts a well-formed config with no issues', () => {
    const { config, issues } = parseConfig(baseConfig())
    expect(issues).toEqual([])
    expect(config.outlets[0]?.id).toBe('discord-test')
  })

  it('rejects an empty charter', () => {
    expect(() => parseConfig({ ...(baseConfig() as object), charter: '' })).toThrow()
  })

  it('rejects an id that is not a slug', () => {
    expect(() =>
      issuesFor((c) => {
        c.outlets[0].id = 'Discord Test'
      }),
    ).toThrow()
  })
})

describe('destination pinning', () => {
  // The trap: channelId and chatId are OPTIONAL in the live MCP schemas, so an
  // omitted destination posts to the bridge default instead of erroring.

  it('rejects a publish outlet with no destination pinned', () => {
    const issues = issuesFor((c) => {
      delete c.outlets[0].args.channelId
    })
    expect(issues).toContainEqual(expect.stringContaining('must pin its destination "channelId"'))
  })

  it('rejects a destination authored by a slot', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].args.channelId = { slot: 'text', label: 'Channel' }
    })
    expect(issues).toContainEqual(expect.stringContaining('a model must never write an address'))
  })

  it('rejects a destination built from a template', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].args.channelId = '{{story.url}}'
    })
    expect(issues).toContainEqual(expect.stringContaining('not a derived template'))
  })

  it('rejects an empty destination', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].args.channelId = '   '
    })
    expect(issues).toContainEqual(expect.stringContaining('non-empty string'))
  })

  it('demands an explicit destination_key for an unknown tool', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].tool = 'some-new-mcp__post'
    })
    expect(issues).toContainEqual(expect.stringContaining('declare `destination_key` explicitly'))
  })

  it('accepts an unknown tool once destination_key is declared and pinned', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].tool = 'some-new-mcp__post'
      c.outlets[0].destination_key = 'roomId'
      c.outlets[0].args.roomId = 'room-42'
    })
    expect(issues).toEqual([])
  })

  it('does not demand a destination for a notify outlet', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].role = 'notify'
      delete c.outlets[0].args.channelId
    })
    expect(issues).toEqual([])
  })
})

describe('slots', () => {
  it('requires exactly one primary slot', () => {
    const none = issuesFor((c) => {
      c.outlets[0].args.description.primary = false
    })
    expect(none).toContainEqual(expect.stringContaining('exactly one slot must be primary'))

    const two = issuesFor((c) => {
      c.outlets[0].args.title.primary = true
    })
    expect(two).toContainEqual(expect.stringContaining('at most one slot may be primary'))
  })

  it('requires a publish outlet to have something to write', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].args = { channelId: '1514993197082742814' }
    })
    expect(issues).toContainEqual(expect.stringContaining('at least one authoring slot'))
  })

  it('classifies literal, derived and slot values', () => {
    const { config } = parseConfig(baseConfig())
    const args = config.outlets[0]!.args
    expect(isSlot(args.description!)).toBe(true)
    expect(isDerived(args.footer!)).toBe(true)
    expect(isDerived(args.channelId!)).toBe(false)
    expect(isSlot(args.channelId!)).toBe(false)
    expect(slotsOf(args).map((s) => s.key).sort()).toEqual(['description', 'title'])
    expect(primarySlotKey(args)).toBe('description')
  })
})

describe('references and templates', () => {
  it('rejects an unknown voice', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].voice = 'nobody'
    })
    expect(issues).toContainEqual(expect.stringContaining('unknown voice "nobody"'))
  })

  it('requires a voice on a publish outlet', () => {
    const issues = issuesFor((c) => {
      delete c.outlets[0].voice
    })
    expect(issues).toContainEqual(expect.stringContaining('needs a voice'))
  })

  it('rejects an unknown endpoint', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].endpoint = 'elsewhere'
    })
    expect(issues).toContainEqual(expect.stringContaining('unknown endpoint "elsewhere"'))
  })

  it('rejects a template reading from an unknown root', () => {
    const issues = issuesFor((c) => {
      c.outlets[0].args.footer = '{{ secrets.token }}'
    })
    expect(issues).toContainEqual(expect.stringContaining('unknown template root "secrets"'))
  })

  it('rejects duplicate ids', () => {
    const issues = issuesFor((c) => {
      c.outlets.push({ ...c.outlets[0] })
    })
    expect(issues).toContainEqual(expect.stringContaining('duplicate id "discord-test"'))
  })
})

describe('validateConfig on an already-parsed config', () => {
  it('is callable directly', () => {
    const { config } = parseConfig(baseConfig())
    expect(validateConfig(config satisfies Config)).toEqual([])
  })
})

/**
 * Reporting tools are declared like outlets, so they get the outlet checks —
 * plus tighter ones, because the desk calls these unattended. Listing a tool is
 * the authorization to call it, and that is only safe while the model cannot
 * influence which tool or which arguments.
 */
describe('the reporting block', () => {
  const withReporting = (reporting: unknown) =>
    issuesFor((c) => {
      c.reporting = reporting
    })

  const valid = {
    search: [{ endpoint: 'beacon', tool: 'searxng__search', args: { query: '{{ call.query }}', count: 6 } }],
    fetch: [{ endpoint: 'beacon', tool: 'browser-mcp__get_page_text', args: { url: '{{ call.url }}' } }],
  }

  it('accepts a well-formed block', () => {
    expect(withReporting(valid)).toEqual([])
  })

  it('is optional — a desk with no reporting phase is a valid desk', () => {
    expect(parseConfig(baseConfig()).config.reporting).toBeUndefined()
  })

  it('applies its defaults so a minimal block still has bounds', () => {
    const { config } = parseConfig({ ...(baseConfig() as object), reporting: valid })
    expect(config.reporting).toMatchObject({ enabled: true, kinds: ['tip'], max_rounds: 3, max_fetches: 8 })
  })

  it('rejects a tool pointed at an endpoint that does not exist', () => {
    const issues = withReporting({
      ...valid,
      search: [{ endpoint: 'ghost', tool: 's', args: { query: '{{ call.query }}' } }],
    })
    expect(issues).toContainEqual(expect.stringContaining('unknown endpoint "ghost"'))
  })

  /**
   * A search tool that never interpolates the query would run the same constant
   * search forever and look like it was working — the worst kind of broken.
   */
  it('rejects a search tool that never uses the query', () => {
    const issues = withReporting({ ...valid, search: [{ endpoint: 'beacon', tool: 's', args: { q: 'immich' } }] })
    expect(issues).toContainEqual(expect.stringContaining('must interpolate "{{ call.query }}"'))
  })

  it('rejects a fetch tool that never uses the url', () => {
    const issues = withReporting({ ...valid, fetch: [{ endpoint: 'beacon', tool: 'f', args: { page: 1 } }] })
    expect(issues).toContainEqual(expect.stringContaining('must interpolate "{{ call.url }}"'))
  })

  it('refuses an authoring slot in a reporting argument', () => {
    const issues = withReporting({
      ...valid,
      search: [
        {
          endpoint: 'beacon',
          tool: 's',
          args: { query: '{{ call.query }}', extra: { slot: 'text', label: 'Anything' } },
        },
      ],
    })
    expect(issues).toContainEqual(expect.stringContaining('cannot be an authoring slot'))
  })

  it('refuses a story template — a reporting call knows nothing about a story', () => {
    const issues = withReporting({
      ...valid,
      search: [{ endpoint: 'beacon', tool: 's', args: { query: '{{ call.query }}', ref: '{{ story.url }}' } }],
    })
    expect(issues).toContainEqual(expect.stringContaining('unknown template root "story"'))
  })

  it('refuses an enabled phase that declares no tools at all', () => {
    const issues = withReporting({ enabled: true, search: [], fetch: [] })
    expect(issues).toContainEqual(expect.stringContaining('could do nothing'))
  })

  it('says nothing about a phase that is switched off', () => {
    expect(withReporting({ enabled: false, search: [], fetch: [] })).toEqual([])
  })
})

/**
 * The http driver: the address is the one thing a model must never be able to
 * influence, so it is a literal and only `args` may interpolate.
 */
describe('an http reporting tool', () => {
  const withReporting = (reporting: unknown) =>
    issuesFor((c) => {
      c.reporting = reporting
    })

  const httpSearch = {
    driver: 'http',
    url: 'http://searxng-backend:8080/search',
    args: { q: '{{ call.query }}', format: 'json' },
  }

  it('needs no endpoint — it is not going through a Beacon', () => {
    expect(withReporting({ search: [httpSearch], fetch: [] })).toEqual([])
  })

  it('rejects one with no url', () => {
    const issues = withReporting({ search: [{ driver: 'http', args: { q: '{{ call.query }}' } }], fetch: [] })
    expect(issues).toContainEqual(expect.stringContaining('needs a url'))
  })

  /**
   * The realistic version of this mistake is putting the query in the address
   * rather than in args. It parses as a url, so only the semantic check catches
   * it — and it must, because an address a model can shape is an address that
   * can be pointed somewhere else.
   */
  it('refuses a templated address, so nothing can redirect the desk', () => {
    const issues = withReporting({
      search: [{ ...httpSearch, url: 'http://searxng-backend:8080/search?q={{ call.query }}' }],
      fetch: [],
    })
    expect(issues).toContainEqual(expect.stringContaining('the url must be a literal'))
  })

  it('still insists the query is actually used', () => {
    const issues = withReporting({ search: [{ ...httpSearch, args: { q: 'immich' } }], fetch: [] })
    expect(issues).toContainEqual(expect.stringContaining('must interpolate "{{ call.query }}"'))
  })

  it('accepts a search-only phase — a reporter that cannot open pages still files leads', () => {
    expect(withReporting({ enabled: true, search: [httpSearch], fetch: [] })).toEqual([])
  })
})

/**
 * A cadence that cannot be satisfied is worse than no cadence: the proposer
 * walks its whole horizon and hands back a slot weeks out, which reads as a bug
 * rather than as the configuration doing what it was told.
 */
describe('an outlet cadence', () => {
  const withCadence = (cadence: unknown) =>
    issuesFor((c) => {
      c.outlets[0].cadence = cadence
    })

  it('accepts a complete, satisfiable rhythm', () => {
    expect(
      withCadence({
        timezone: 'Europe/Paris',
        days: [1, 2, 3, 4, 5],
        window: { from: '09:00', to: '18:00' },
        min_gap_minutes: 90,
        max_per_day: 3,
      }),
    ).toEqual([])
  })

  it('is entirely optional', () => {
    expect(issuesFor(() => {})).toEqual([])
  })

  it('rejects a timezone the runtime does not know', () => {
    expect(withCadence({ timezone: 'Europe/Atlantis' }).join()).toMatch(/not a timezone/)
  })

  it('rejects a window that never opens', () => {
    expect(withCadence({ window: { from: '18:00', to: '09:00' } }).join()).toMatch(/wraps midnight/)
  })

  it('rejects an empty day list, which could never post', () => {
    expect(withCadence({ days: [] }).join()).toMatch(/could never post/)
  })

  it('rejects a day listed twice', () => {
    expect(withCadence({ days: [1, 1, 2] }).join()).toMatch(/listed twice/)
  })

  it('rejects a gap that cannot fit twice in its own window', () => {
    expect(
      withCadence({ window: { from: '09:00', to: '12:00' }, min_gap_minutes: 240 }).join(),
    ).toMatch(/does not fit twice/)
  })

  it('allows a gap wider than the window when only one post a day is meant', () => {
    expect(
      withCadence({ window: { from: '09:00', to: '12:00' }, min_gap_minutes: 240, max_per_day: 1 }),
    ).toEqual([])
  })

  it('refuses a malformed time outright, at the shape check', () => {
    expect(() => parseConfig({ ...(baseConfig() as any), outlets: [
      { ...(baseConfig() as any).outlets[0], cadence: { window: { from: '9am', to: '18:00' } } },
    ] })).toThrow()
  })
})

describe('parseMode and slot format', () => {
  /** The live telegram-broadcast outlet, correctly paired. */
  function telegramOutlet(): Record<string, any> {
    return {
      id: 'telegram-broadcast',
      name: 'Telegram broadcast',
      description: 'the public Telegram channel',
      role: 'publish',
      driver: 'mcp',
      voice: 'alicia',
      endpoint: 'beacon',
      tool: 'telegram-mcp__send_message',
      args: {
        chatId: '-5333649854',
        parseMode: 'HTML',
        text: {
          slot: 'markdown',
          label: 'Message',
          max: 4096,
          primary: true,
          format: 'telegram-html',
        },
      },
    }
  }

  it('accepts HTML paired with telegram-html', () => {
    expect(issuesFor((c) => c.outlets.push(telegramOutlet()))).toEqual([])
  })

  it('refuses Markdown outright — written copy cannot survive its delimiters', () => {
    const issues = issuesFor((c) => {
      const outlet = telegramOutlet()
      outlet.args.parseMode = 'Markdown'
      delete outlet.args.text.format
      c.outlets.push(outlet)
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('outlets.telegram-broadcast.args.parseMode')
    expect(issues[0]).toContain('snake_case')
  })

  it('refuses MarkdownV2 for the same reason', () => {
    const issues = issuesFor((c) => {
      const outlet = telegramOutlet()
      outlet.args.parseMode = 'MarkdownV2'
      delete outlet.args.text.format
      c.outlets.push(outlet)
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('args.parseMode')
  })

  it('refuses HTML on a slot that is not converted to it', () => {
    const issues = issuesFor((c) => {
      const outlet = telegramOutlet()
      delete outlet.args.text.format
      c.outlets.push(outlet)
    })
    expect(issues).toEqual([
      expect.stringContaining('outlets.telegram-broadcast.args.text'),
    ])
  })

  it('refuses telegram-html without the parse mode that reads it', () => {
    const issues = issuesFor((c) => {
      const outlet = telegramOutlet()
      delete outlet.args.parseMode
      c.outlets.push(outlet)
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('needs `parseMode: HTML`')
  })

  it('leaves an outlet with no parse mode alone — Discord parses nothing', () => {
    expect(issuesFor(() => {})).toEqual([])
  })

  it('does not ask a url slot to be converted — only parsed text is at risk', () => {
    const issues = issuesFor((c) => {
      const outlet = telegramOutlet()
      outlet.args.photo = { slot: 'image', label: 'Photo', optional: true }
      c.outlets.push(outlet)
    })
    expect(issues).toEqual([])
  })
})
