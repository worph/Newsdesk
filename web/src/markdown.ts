import MarkdownIt from 'markdown-it'

/**
 * The one markdown renderer, shared by every surface that shows prose.
 *
 * `html: false` is load-bearing rather than a preference: it is how invariant 4
 * holds on the way out. Everything rendered through here is either written by a
 * model or derived from text someone else filed, so raw HTML in it is escaped
 * and shown rather than injected. There is deliberately no option to turn that
 * off — a second renderer with different rules would be the first one to drift.
 *
 * `breaks: true` because people write chat and drafts with single newlines and
 * mean them.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/**
 * Links leave in a new tab, and cannot reach back through `window.opener`.
 *
 * They arrive from model output and from filings, which is exactly the material
 * that should not be able to navigate the desk it is being read in.
 */
const defaultLink =
  md.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))

md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('target', '_blank')
  tokens[index]!.attrSet('rel', 'noopener noreferrer')
  return defaultLink(tokens, index, options, env, self)
}

/** A whole document. */
export function renderMarkdown(text: string): string {
  return md.render(text)
}

/**
 * One line, without the wrapping paragraph.
 *
 * For places where the text sits inside something that already owns its block —
 * a chat turn is not a document, and a stray `<p>` there fights the spacing.
 */
export function renderMarkdownInline(text: string): string {
  return md.renderInline(text)
}
