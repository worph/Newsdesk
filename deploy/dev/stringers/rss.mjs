/**
 * Minimal RSS/Atom parsing for the dev stringer. No dependency is worth adding
 * for this, and keeping it separate from the polling loop makes it testable.
 */

// Latin-1 accents and common punctuation. Feeds use these constantly and a
// French one is unreadable without them — a stray "&egrave;" reaching a draft
// is worse than a missing dependency.
const NAMED = (() => {
  const pairs =
    'agrave:à aacute:á acirc:â atilde:ã auml:ä aring:å aelig:æ ccedil:ç ' +
    'egrave:è eacute:é ecirc:ê euml:ë igrave:ì iacute:í icirc:î iuml:ï ' +
    'ntilde:ñ ograve:ò oacute:ó ocirc:ô otilde:õ ouml:ö oslash:ø ' +
    'ugrave:ù uacute:ú ucirc:û uuml:ü yacute:ý yuml:ÿ eth:ð thorn:þ szlig:ß'
  const map = {}
  for (const pair of pairs.split(' ')) {
    const [name, char] = pair.split(':')
    map[name] = char
    // Àgrave-style capitals follow mechanically.
    map[name.charAt(0).toUpperCase() + name.slice(1)] = char.toUpperCase()
  }
  return Object.assign(map, {
    nbsp: ' ', laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
    deg: '°', euro: '€', pound: '£', copy: '©', reg: '®', trade: '™',
    times: '×', divide: '÷', frac12: '½', sup2: '²', sup3: '³',
  })
})()

export function decode(text) {
  return (
    text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&([a-z]+[0-9]*);/gi, (whole, name) => NAMED[name] ?? whole)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Last, so that "&amp;lt;" decodes to "&lt;" and not to "<".
      .replace(/&amp;/g, '&')
  )
}

export const stripTags = (html) =>
  decode(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function tag(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return match?.[1] ? decode(match[1]).trim() : ''
}

export function parseFeed(xml) {
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? []
  return blocks
    .map((block) => {
      const link =
        tag(block, 'link') ||
        /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ||
        tag(block, 'guid')
      const published = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated')
      const at = published ? new Date(published) : null
      return {
        title: stripTags(tag(block, 'title')),
        link: (link ?? '').trim(),
        at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
        summary: stripTags(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')),
      }
    })
    .filter((item) => item.title && item.at)
}

/**
 * Each entry begins with an ISO date so the desk can trim the window against
 * its watermark. Everything in the window is filed — a stringer does not judge
 * newsworthiness, the charter does.
 */
export function toTimeline(items, { maxItems = 15, summaryChars = 600 } = {}) {
  return items
    .slice(0, maxItems)
    .map((item) => {
      const summary = item.summary ? `\n  ${item.summary.slice(0, summaryChars)}` : ''
      const link = item.link ? `\n  ${item.link}` : ''
      return `- ${item.at} ${item.title}${summary}${link}`
    })
    .join('\n')
}
