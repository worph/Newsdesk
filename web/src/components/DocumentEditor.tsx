import MarkdownIt from 'markdown-it'
import { useState, type ReactNode } from 'react'

/**
 * The one place a document is edited, and the one place markdown is rendered.
 *
 * Both surfaces that write prose use it — the review screen's primary slot and
 * the tip line — so the rule that matters lives here once rather than being
 * restated per page: a draft is markdown and is **never** injected as raw HTML.
 *
 * See ARCHITECTURE.md invariant 4.
 */

// html: false — raw HTML in a document is escaped rather than injected.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

export function DocumentEditor({
  value,
  onChange,
  label,
  max,
  rows = 14,
  placeholder,
  autoFocus,
  disabled,
  monospace = true,
  id,
  aside,
}: {
  value: string
  onChange: (next: string) => void
  /** Omitted on a surface that already has its own heading. */
  label?: string
  max?: number
  rows?: number
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  /** A draft is read as source; a tip is read as prose. */
  monospace?: boolean
  id?: string
  /** Extra controls beside the preview toggle. */
  aside?: ReactNode
}) {
  const [preview, setPreview] = useState(false)
  const over = max !== undefined && value.length > max

  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        {label ? (
          <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">{label}</h2>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3">
          {aside}
          {max !== undefined && (
            <span className={`font-mono text-[11px] ${over ? 'text-red-600' : 'text-desk-500'}`}>
              {value.length}/{max}
            </span>
          )}
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="text-xs text-desk-500 hover:text-desk-700"
          >
            {preview ? 'edit' : 'preview'}
          </button>
        </div>
      </div>

      {preview ? (
        <div
          className="prose-desk min-h-56 rounded-md border border-desk-200 px-3 py-2.5 text-sm dark:border-desk-800"
          // Rendered by markdown-it with html:false, so any raw HTML in the
          // document is escaped rather than injected.
          dangerouslySetInnerHTML={{ __html: md.render(value) }}
        />
      ) : (
        <textarea
          id={id}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          rows={rows}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full resize-y rounded-md border bg-transparent px-3 py-2.5 text-base outline-none disabled:opacity-50 md:text-sm ${
            monospace ? 'font-mono' : ''
          } ${over ? 'border-red-500' : 'border-desk-200 focus:border-desk-400 dark:border-desk-800'}`}
        />
      )}
    </section>
  )
}
