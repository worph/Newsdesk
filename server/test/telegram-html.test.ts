import { describe, expect, it } from 'vitest'
import { escapeTelegramHtml, markdownToTelegramHtml } from '../src/render/telegram-html.js'

const convert = markdownToTelegramHtml

describe('escaping', () => {
  it('neutralises every character Telegram could read as markup', () => {
    expect(convert('AT&T said <b>no</b> to 5 > 3')).toBe('AT&amp;T said &lt;b&gt;no&lt;/b&gt; to 5 &gt; 3')
  })

  it('leaves a lone underscore alone — the bug this exists for', () => {
    // `parseMode: Markdown` read this as an unterminated italic entity and
    // failed the send with "Can't find end of the entity".
    expect(convert('gated by the auth gateway (AUTH_HASH / OIDC)')).toBe(
      'gated by the auth gateway (AUTH_HASH / OIDC)',
    )
  })

  it('escapes rather than parses a non-markdown slot', () => {
    expect(escapeTelegramHtml('4 * 3 > 10 & rising')).toBe('4 * 3 &gt; 10 &amp; rising')
  })
})

describe('inline formatting', () => {
  it('maps emphasis to the tags Telegram documents', () => {
    expect(convert('**bold** and *italic* and ~~gone~~')).toBe('<b>bold</b> and <i>italic</i> and <s>gone</s>')
  })

  it('does not format inside a code span', () => {
    expect(convert('run `create-docusaurus@3.10.1 --template classic_js`')).toBe(
      'run <code>create-docusaurus@3.10.1 --template classic_js</code>',
    )
  })

  it('escapes inside a code span too', () => {
    expect(convert('`a < b && c`')).toBe('<code>a &lt; b &amp;&amp; c</code>')
  })

  it('renders a link', () => {
    expect(convert('see [the release](https://example.dev/r?a=1&b=2)')).toBe(
      'see <a href="https://example.dev/r?a=1&amp;b=2">the release</a>',
    )
  })

  it('keeps the words but never the link when the scheme is not one Telegram takes', () => {
    // markdown-it refuses to build the javascript: link at all; ftp: it builds
    // and this renderer declines. Either way the copy survives and no `a` tag
    // reaches Telegram, which would reject the send.
    expect(convert('[click](javascript:alert(1))')).not.toContain('<a')
    expect(convert('[click](javascript:alert(1))')).toContain('click')
    expect(convert('[archive](ftp://example.dev/x)')).toBe('archive')
  })

  it('leaves a bare url as text — Telegram links it itself, and previews it', () => {
    expect(convert('https://github.com/Yundera/AppStore/releases/tag/docusaurus-v3.10.1')).toBe(
      'https://github.com/Yundera/AppStore/releases/tag/docusaurus-v3.10.1',
    )
  })
})

describe('block constructs Telegram has no tag for', () => {
  it('renders a heading as bold', () => {
    expect(convert('## What is new\n\nA point release.')).toBe('<b>What is new</b>\n\nA point release.')
  })

  it('flattens a bullet list to marked lines', () => {
    expect(convert('- one\n- two `x`\n- three')).toBe('• one\n• two <code>x</code>\n• three')
  })

  it('numbers an ordered list from its own start', () => {
    expect(convert('3. third\n4. fourth')).toBe('3. third\n4. fourth')
  })

  it('indents a nested list', () => {
    expect(convert('- top\n    - under')).toBe('• top\n   • under')
  })

  it('keeps a fenced block as pre, with its language', () => {
    expect(convert('```yaml\nkey: <value>\n```')).toBe(
      '<pre><code class="language-yaml">key: &lt;value&gt;</code></pre>',
    )
  })

  it('keeps an unlabelled fence as plain pre', () => {
    expect(convert('```\nplain\n```')).toBe('<pre>plain</pre>')
  })

  it('renders a quote', () => {
    expect(convert('> quoted\n> still quoted')).toBe('<blockquote>quoted\nstill quoted</blockquote>')
  })

  it('flattens a table to legible lines', () => {
    expect(convert('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('a | b\n1 | 2')
  })

  it('keeps an image as its alt text and address', () => {
    expect(convert('![a chart](https://example.dev/c.png)')).toBe('a chart (https://example.dev/c.png)')
  })
})

describe('output hygiene', () => {
  it('drops an empty entity — Telegram rejects one', () => {
    expect(convert('****\n\ntext')).toBe('text')
  })

  it('collapses runs of blank lines and trims', () => {
    expect(convert('\n\na\n\n\n\n---\n\nb\n\n')).toBe('a\n\nb')
  })

  it('never emits an unbalanced tag on ordinary release copy', () => {
    const html = convert(
      '**Docusaurus v3.10.1 is in the AppStore** — Meta\'s doc generator.\n\n' +
        'Gated by the auth gateway (AUTH_HASH / OIDC via casaos-oidc-bridge).\n\n' +
        '- `src/docs/` — editable via the File Manager\n' +
        '- built site in `/DATA/AppData/docusaurus/build/`\n\n' +
        'https://example.dev/r',
    )
    const opened = [...html.matchAll(/<(\w+)[^>]*>/g)].map((m) => m[1])
    const closed = [...html.matchAll(/<\/(\w+)>/g)].map((m) => m[1])
    expect(opened.sort()).toEqual(closed.sort())
  })
})
