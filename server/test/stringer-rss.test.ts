import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS dev tooling, no types worth adding
import { parseFeed, stripTags, toTimeline } from '../../deploy/dev/stringers/rss.mjs'
import { trimTimeline } from '../src/ports/ingest/trim.js'

/**
 * The dev stringer and the desk's timeline trimmer have to agree on a format.
 * Nothing else checks that, and a silent disagreement would look like "korben
 * never files anything".
 */

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Korben</title>
  <item>
    <title><![CDATA[Moonshot met en ligne Kimi K3]]></title>
    <link>https://korben.info/kimi-k3.html</link>
    <pubDate>Tue, 28 Jul 2026 11:55:40 +0000</pubDate>
    <description><![CDATA[<p>2&nbsp;800 milliards de param&egrave;tres &amp; 1,4&nbsp;To.</p>]]></description>
  </item>
  <item>
    <title>Une Xbox 360 &amp; un Teensy</title>
    <link>https://korben.info/xbox-360.html</link>
    <pubDate>Mon, 27 Jul 2026 16:11:48 +0000</pubDate>
    <description>Question secr&egrave;te, code usine.</description>
  </item>
  <item>
    <title>Undated draft</title>
    <link>https://korben.info/nope.html</link>
  </item>
</channel></rss>`

describe('the dev stringer feed parser', () => {
  it('extracts dated items and drops undated ones', () => {
    const items = parseFeed(FEED)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: 'Moonshot met en ligne Kimi K3',
      link: 'https://korben.info/kimi-k3.html',
      at: '2026-07-28T11:55:40.000Z',
    })
  })

  it('unwraps CDATA, decodes entities and strips markup', () => {
    const items = parseFeed(FEED)
    expect(items[0]?.summary).toBe('2 800 milliards de paramètres & 1,4 To.')
    expect(items[1]?.title).toBe('Une Xbox 360 & un Teensy')
    expect(stripTags('<p>a <b>b</b></p>')).toBe('a b')
  })

  it('decodes &amp; last, so &amp;lt; does not become a tag', () => {
    expect(stripTags('5 &amp;lt; 6')).toBe('5 &lt; 6')
  })
})

describe('stringer output against the desk trimmer', () => {
  it('produces entries the watermark logic can read', () => {
    const filed = toTimeline(parseFeed(FEED))

    const baseline = trimTimeline(filed, null)
    expect(baseline.watermark).toBe('2026-07-28T11:55:40.000Z')
    expect(baseline.considered).toContain('Kimi K3')
    expect(baseline.considered).not.toContain('Xbox 360')

    // Re-filing the identical window is free, which is what lets the stringer
    // keep no state of its own.
    expect(trimTimeline(filed, baseline.watermark ?? null).considered).toBe('')
  })

  it('carries the link through, so the story keeps its source', () => {
    const filed = toTimeline(parseFeed(FEED))
    expect(trimTimeline(filed, null).considered).toContain('https://korben.info/kimi-k3.html')
  })
})
