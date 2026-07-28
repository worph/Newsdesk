import { describe, expect, it } from 'vitest'
import { diffLines, parseTimeline, trim, trimSnapshot, trimTimeline } from '../src/ports/ingest/trim.js'

describe('parseTimeline', () => {
  it('splits on dated lines and keeps the preamble', () => {
    const { preamble, entries } = parseTimeline(
      [
        'Weekly digest from korben.info',
        '',
        '- 2026-07-20 Something about self-hosting',
        '  more detail on the same entry',
        '- 2026-07-22 A second thing',
      ].join('\n'),
    )
    expect(preamble).toBe('Weekly digest from korben.info')
    expect(entries).toHaveLength(2)
    expect(entries[0]?.at).toBe('2026-07-20T00:00:00.000Z')
    expect(entries[0]?.text).toContain('more detail on the same entry')
    expect(entries[1]?.at).toBe('2026-07-22T00:00:00.000Z')
  })

  it('reads dates behind common markdown decoration', () => {
    const { entries } = parseTimeline(
      ['## 2026-07-20 heading form', '* [2026-07-21] bracket form', '> 2026-07-22T09:12:00Z quote form'].join(
        '\n',
      ),
    )
    expect(entries.map((e) => e.at)).toEqual([
      '2026-07-20T00:00:00.000Z',
      '2026-07-21T00:00:00.000Z',
      '2026-07-22T09:12:00.000Z',
    ])
  })
})

describe('trimTimeline', () => {
  const feed = [
    '- 2026-07-20 oldest',
    '- 2026-07-21 middle',
    '- 2026-07-22 newest',
  ].join('\n')

  it('takes only the most recent entry on a fresh source', () => {
    // A new source must not flood the desk with its whole backlog.
    const result = trimTimeline(feed, null)
    expect(result.considered).toContain('newest')
    expect(result.considered).not.toContain('oldest')
    expect(result.watermark).toBe('2026-07-22T00:00:00.000Z')
    expect(result.note).toMatch(/baseline.*skipped 2 older/)
  })

  it('keeps only entries after the watermark', () => {
    const result = trimTimeline(feed, '2026-07-20T00:00:00.000Z')
    expect(result.considered).toContain('middle')
    expect(result.considered).toContain('newest')
    expect(result.considered).not.toContain('oldest')
    expect(result.watermark).toBe('2026-07-22T00:00:00.000Z')
  })

  it('considers nothing when the whole window is already seen', () => {
    const result = trimTimeline(feed, '2026-07-22T00:00:00.000Z')
    expect(result.considered).toBe('')
    expect(result.watermark).toBeUndefined()
    expect(result.note).toMatch(/nothing newer/)
  })

  it('re-filing the same window is safe — this is what lets stringers stay dumb', () => {
    const first = trimTimeline(feed, null)
    const second = trimTimeline(feed, first.watermark ?? null)
    expect(second.considered).toBe('')
  })

  it('falls back to the whole submission when no date is recognised, and says so', () => {
    // Silently dropping a source whose date format we cannot read would be the
    // worst outcome, so it is loud instead.
    const result = trimTimeline('just some prose with no dates at all', '2026-07-22T00:00:00.000Z')
    expect(result.considered).toBe('just some prose with no dates at all')
    expect(result.note).toMatch(/no dated entries recognised/)
  })
})

describe('diffLines', () => {
  it('reports additions and removals', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toBe('- b\n+ d')
  })

  it('is empty for identical input', () => {
    expect(diffLines('a\nb', 'a\nb')).toBe('')
  })

  it('gives up and returns the whole state above the size limit', () => {
    const big = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n')
    expect(diffLines('a', big)).toBe(big)
  })
})

describe('trimSnapshot', () => {
  it('records a baseline without reporting the whole state as news', () => {
    const result = trimSnapshot('v1\nv2', null)
    expect(result.considered).toBe('')
    expect(result.snapshot).toBe('v1\nv2')
    expect(result.note).toMatch(/baseline/)
  })

  it('considers only the change on a later snapshot', () => {
    const result = trimSnapshot('v1\nv3', 'v1\nv2')
    expect(result.considered).toBe('- v2\n+ v3')
    expect(result.snapshot).toBe('v1\nv3')
    expect(result.note).toMatch(/2 changed lines/)
  })

  it('considers nothing when the state has not moved', () => {
    const result = trimSnapshot('v1\nv2', 'v1\nv2')
    expect(result.considered).toBe('')
    expect(result.note).toBe('snapshot unchanged')
  })
})

describe('trim dispatch', () => {
  it('passes a report through whole — depth is the source’s business', () => {
    const result = trim({ kind: 'report', text: 'a written report', watermark: null, lastSnapshot: null })
    expect(result.considered).toBe('a written report')
    expect(result.note).toBe('considered whole')
  })

  it('treats an idea like a report', () => {
    const result = trim({ kind: 'idea', text: 'look at this', watermark: null, lastSnapshot: null })
    expect(result.considered).toBe('look at this')
  })
})
