import type { ArgsSpec } from '@newsdesk/shared'
import { describe, expect, it } from 'vitest'
import {
  mergePayload,
  PayloadIncomplete,
  previewPayload,
  renderTemplate,
  type MergeContext,
} from '../src/render/payload.js'

const story = {
  id: 'story-1',
  title: 'Immich v1.142.0',
  summary: 'A point release.',
  url: 'https://example.dev/immich',
}

const context = (slots: Record<string, unknown>): MergeContext => ({
  story,
  slots,
  now: new Date('2026-07-30T12:00:00.000Z'),
})

const discordArgs: ArgsSpec = {
  channelId: '1514993197082742814',
  timestamp: true,
  footer: '{{story.url}}',
  title: { slot: 'text', label: 'Headline', max: 256, optional: false, primary: false },
  description: { slot: 'markdown', label: 'Body', max: 4096, optional: false, primary: true },
  image: { slot: 'image', label: 'Image', optional: true, primary: false },
}

describe('derived templates', () => {
  it('renders story facts', () => {
    expect(renderTemplate('{{story.title}} — {{story.url}}', context({}))).toBe(
      'Immich v1.142.0 — https://example.dev/immich',
    )
  })

  it('renders the current time', () => {
    expect(renderTemplate('{{now}}', context({}))).toBe('2026-07-30T12:00:00.000Z')
  })

  it('reads an authored slot', () => {
    expect(renderTemplate('re: {{slots.title}}', context({ title: 'Hello' }))).toBe('re: Hello')
  })

  it('substitutes an unresolvable expression with nothing, never the raw syntax', () => {
    // Leaking "{{story.nope}}" into a published Discord message is worse than
    // an absent value, and it is the kind of thing nobody notices in review.
    expect(renderTemplate('[{{story.nope}}]', context({}))).toBe('[]')
  })

  it('tolerates the spaced form', () => {
    expect(renderTemplate('{{ story.title }}', context({}))).toBe('Immich v1.142.0')
  })
})

describe('mergePayload', () => {
  it('combines literals, derived values and authored slots', () => {
    const payload = mergePayload(
      discordArgs,
      context({ title: 'Immich 1.142', description: 'Body text' }),
    )

    expect(payload).toEqual({
      channelId: '1514993197082742814',
      timestamp: true,
      footer: 'https://example.dev/immich',
      title: 'Immich 1.142',
      description: 'Body text',
    })
  })

  it('keeps the destination exactly as configured', () => {
    // Invariant 3: no authored value can reach a placement key. Even a slot
    // named channelId in the draft must not displace the literal.
    const payload = mergePayload(
      discordArgs,
      context({ title: 'T', description: 'B', channelId: 'attacker-channel' }),
    )
    expect(payload.channelId).toBe('1514993197082742814')
  })

  it('omits an empty optional slot', () => {
    const payload = mergePayload(discordArgs, context({ title: 'T', description: 'B', image: '' }))
    expect('image' in payload).toBe(false)
  })

  it('includes an optional slot that was filled', () => {
    const payload = mergePayload(
      discordArgs,
      context({ title: 'T', description: 'B', image: 'https://x.dev/a.png' }),
    )
    expect(payload.image).toBe('https://x.dev/a.png')
  })

  it('refuses to merge a draft missing a required slot', () => {
    expect(() => mergePayload(discordArgs, context({ title: 'T' }))).toThrow(PayloadIncomplete)
  })

  it('names every missing slot, not just the first', () => {
    try {
      mergePayload(discordArgs, context({}))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as PayloadIncomplete).missing).toEqual(['title', 'description'])
    }
  })

  it('trims authored whitespace', () => {
    const payload = mergePayload(discordArgs, context({ title: '  T  ', description: 'B' }))
    expect(payload.title).toBe('T')
  })

  it('omits a derived value that resolved to nothing', () => {
    const args: ArgsSpec = { ...discordArgs, footer: '{{story.missing}}' }
    const payload = mergePayload(args, context({ title: 'T', description: 'B' }))
    expect('footer' in payload).toBe(false)
  })

  it('is a pure function of its inputs — the same draft merges identically', () => {
    // This is what makes an approved payload safe to freeze and re-send: no
    // inference runs between approval and the wire.
    const draft = context({ title: 'T', description: 'B' })
    expect(mergePayload(discordArgs, draft)).toEqual(mergePayload(discordArgs, draft))
  })
})

describe('previewPayload', () => {
  it('separates what you authored from what configuration fixes', () => {
    const preview = previewPayload(discordArgs, context({ title: 'T', description: 'B' }))
    expect(preview.authored).toEqual(['title', 'description'])
    expect(preview.fixed).toEqual(['channelId', 'timestamp', 'footer'])
    expect(preview.missing).toEqual([])
  })

  it('still previews an incomplete draft, and says what is missing', () => {
    const preview = previewPayload(discordArgs, context({ title: 'T' }))
    expect(preview.missing).toEqual(['description'])
    expect(preview.payload.title).toBe('T')
    expect('description' in preview.payload).toBe(false)
  })
})

describe('slot format', () => {
  const telegramArgs: ArgsSpec = {
    chatId: '-5333649854',
    parseMode: 'HTML',
    text: {
      slot: 'markdown',
      label: 'Message',
      max: 4096,
      optional: false,
      primary: true,
      format: 'telegram-html',
    },
    caption: {
      slot: 'text',
      label: 'Caption',
      optional: true,
      primary: false,
      format: 'telegram-html',
    },
  }

  it('converts a markdown slot to the destination syntax', () => {
    const payload = mergePayload(telegramArgs, context({ text: '**Immich** is `1.142.0`' }))
    expect(payload.text).toBe('<b>Immich</b> is <code>1.142.0</code>')
  })

  it('escapes a text slot rather than parsing it — a headline is not markup', () => {
    const payload = mergePayload(telegramArgs, context({ text: 'x', caption: '4 * 3 > 10 & up' }))
    expect(payload.caption).toBe('4 * 3 &gt; 10 &amp; up')
  })

  it('carries a lone underscore through, which is the send that used to fail', () => {
    const payload = mergePayload(telegramArgs, context({ text: 'set AUTH_HASH / OIDC' }))
    expect(payload.text).toBe('set AUTH_HASH / OIDC')
  })

  it('leaves a slot with no format exactly as authored', () => {
    const payload = mergePayload(discordArgs, context({ title: 'T', description: '**bold** & <b>' }))
    expect(payload.description).toBe('**bold** & <b>')
  })

  it('shows the converted bytes at review, not the source — that is what gets sent', () => {
    // Approval freezes what mergePayload returns, so a preview of anything else
    // would be an approval of something that never goes out.
    const preview = previewPayload(telegramArgs, context({ text: '# Title' }))
    expect(preview.payload.text).toBe('<b>Title</b>')
  })
})
