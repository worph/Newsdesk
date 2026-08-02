import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

/**
 * Markdown as the writer wrote it, converted to the narrow HTML subset the
 * Telegram Bot API parses under `parseMode: HTML`.
 *
 * Telegram's own `Markdown` and `MarkdownV2` modes cannot be used for
 * model-authored prose. They are not CommonMark — bold is `*bold*`, not
 * `**bold**` — and, worse, every `_ * ` [` in the message is a delimiter that
 * MUST be closed, so a body containing `AUTH_HASH` or `snake_case` fails the
 * whole send with `can't parse entities: Can't find end of the entity`. There
 * is no way to write "escape this text but keep that formatting" in those
 * grammars once the two are interleaved in one string.
 *
 * HTML has the property those modes lack: escaping is total and orthogonal.
 * Every `& < >` in prose becomes an entity and can never be read as markup, and
 * formatting is carried by tags the prose cannot accidentally spell. So the
 * desk parses the markdown itself and emits exactly the tags Telegram
 * documents — everything else degrades to escaped text rather than travelling
 * as a syntax the destination will choke on.
 *
 * Runs at merge time (see payload.ts), which is before approval freezes the
 * payload: the editor reviews the bytes that will actually be sent.
 */

/** What Telegram parses under parseMode: HTML. Anything else is escaped away. */
const md = MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false })

/** Schemes Telegram will accept in an `href`. Anything else keeps its text and loses the link. */
const SAFE_HREF = /^(?:https?|tg|mailto):/i

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeTelegramHtml(value).replace(/"/g, '&quot;')
}

function renderInline(tokens: Token[]): string {
  let out = ''
  // Whether each open link actually emitted a tag, so the close matches it.
  const links: boolean[] = []

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        out += escapeTelegramHtml(token.content)
        break
      case 'code_inline':
        out += `<code>${escapeTelegramHtml(token.content)}</code>`
        break
      case 'strong_open':
        out += '<b>'
        break
      case 'strong_close':
        out += '</b>'
        break
      case 'em_open':
        out += '<i>'
        break
      case 'em_close':
        out += '</i>'
        break
      case 's_open':
        out += '<s>'
        break
      case 's_close':
        out += '</s>'
        break
      case 'link_open': {
        const href = (token.attrGet('href') ?? '').trim()
        const safe = SAFE_HREF.test(href)
        // A link the destination would reject loses its tag, never its text:
        // dropping the words would silently delete part of an approved message.
        if (safe) out += `<a href="${escapeAttr(href)}">`
        links.push(safe)
        break
      }
      case 'link_close':
        if (links.pop()) out += '</a>'
        break
      case 'image': {
        // send_message shows no image, so the alt text and the address are all
        // that can survive — better than a silently empty line.
        const src = (token.attrGet('src') ?? '').trim()
        const alt = renderInline(token.children ?? []).trim()
        out += alt && src ? `${alt} (${escapeTelegramHtml(src)})` : escapeTelegramHtml(alt || src)
        break
      }
      case 'softbreak':
      case 'hardbreak':
        out += '\n'
        break
      default:
        // An unknown inline token still carries its text: escape it and move
        // on rather than dropping words out of an approved message.
        if (token.children) out += renderInline(token.children)
        else if (token.content) out += escapeTelegramHtml(token.content)
    }
  }

  return out
}

/** `• ` at the top level, indented and numbered as the source says. */
function listMarker(stack: Array<{ ordered: boolean; index: number }>): string {
  const current = stack[stack.length - 1]
  if (!current) return ''
  const indent = '   '.repeat(stack.length - 1)
  return current.ordered ? `${indent}${current.index}. ` : `${indent}• `
}

/**
 * Convert a markdown document to Telegram HTML.
 *
 * Constructs Telegram has no tag for — headings, lists, tables, rules — are
 * flattened into text that reads the way the markdown looked, because the
 * alternative is either sending the raw syntax or dropping the content.
 */
export function markdownToTelegramHtml(source: string): string {
  const tokens = md.parse(source, {})
  let out = ''
  const lists: Array<{ ordered: boolean; index: number }> = []
  let quoteDepth = 0
  let cellsInRow = 0

  const trimEnd = (): void => {
    out = out.replace(/\s+$/, '')
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'inline':
        out += renderInline(token.children ?? [])
        break

      case 'paragraph_open':
      case 'paragraph_close':
        // A tight list item's paragraph is marked hidden by markdown-it; its
        // own break comes from list_item_close, so adding one here would
        // double-space every list.
        if (!token.hidden && token.type === 'paragraph_close') out += '\n\n'
        break

      // Telegram has no headings. Bold is what a heading looks like there.
      case 'heading_open':
        out += '<b>'
        break
      case 'heading_close':
        out += '</b>\n\n'
        break

      case 'blockquote_open':
        // Telegram does not nest blockquotes: a nested one continues the outer.
        if (quoteDepth === 0) out += '<blockquote>'
        quoteDepth += 1
        break
      case 'blockquote_close':
        quoteDepth -= 1
        if (quoteDepth === 0) {
          trimEnd()
          out += '</blockquote>\n\n'
        }
        break

      case 'bullet_list_open':
      case 'ordered_list_open':
        // A nested list opens on the line its parent item just started; that
        // item's own break has not been emitted yet, so it is emitted here.
        if (lists.length > 0) {
          trimEnd()
          out += '\n'
        }
        lists.push(
          token.type === 'ordered_list_open'
            ? { ordered: true, index: Number(token.attrGet('start') ?? 1) }
            : { ordered: false, index: 1 },
        )
        break
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop()
        if (lists.length === 0) out += '\n'
        break
      case 'list_item_open':
        out += listMarker(lists)
        break
      case 'list_item_close': {
        trimEnd()
        out += '\n'
        const current = lists[lists.length - 1]
        if (current) current.index += 1
        break
      }

      case 'fence':
      case 'code_block': {
        const language = token.info.trim().split(/\s+/)[0]
        const body = escapeTelegramHtml(token.content.replace(/\n$/, ''))
        out +=
          language && token.type === 'fence'
            ? `<pre><code class="language-${escapeAttr(language)}">${body}</code></pre>\n\n`
            : `<pre>${body}</pre>\n\n`
        break
      }

      // No tag exists for a rule; the paragraph break it implies is the point.
      case 'hr':
        out += '\n\n'
        break

      // Tables flatten to `cell | cell` lines — unreadable as markup in a chat,
      // legible as text.
      case 'tr_open':
        cellsInRow = 0
        break
      case 'th_open':
      case 'td_open':
        if (cellsInRow > 0) out += ' | '
        cellsInRow += 1
        break
      case 'tr_close':
        out += '\n'
        break
      case 'table_close':
        out += '\n'
        break

      default:
        break
    }
  }

  return tidy(out)
}

/**
 * Telegram rejects an empty entity, and markdown that produced one — `**` on
 * its own, an empty heading — must not cost the send.
 */
const EMPTY_ENTITY = /<(b|i|s|u|code|pre|blockquote)>\s*<\/\1>|<a href="[^"]*">\s*<\/a>/g

function tidy(html: string): string {
  let out = html
  let previous: string
  do {
    previous = out
    out = out.replace(EMPTY_ENTITY, '')
  } while (out !== previous)

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
