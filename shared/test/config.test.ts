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
