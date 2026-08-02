import { useState } from 'react'
import type { SlotDef } from '../api'
import { DocumentEditor } from './DocumentEditor'

/**
 * The copy for one destination, as its outlet declares it: the furniture first
 * — headline, link, whatever this outlet wants — then the document itself.
 *
 * One toggle, one mode. A rendered headline over a raw body would be neither,
 * so the mode lives here rather than on the page: every surface that edits a
 * draft flips both halves together, and none of them can forget to.
 *
 * Reading is the default, because reading is what review is for and editing is
 * the exception you ask for. On a blank draft that would be an empty screen
 * with no way in, so a destination nobody has written yet opens in edit mode.
 */

function Field({
  slotKey,
  def,
  value,
  onChange,
  preview,
}: {
  slotKey: string
  def: SlotDef
  value: string
  onChange: (next: string) => void
  preview: boolean
}) {
  const over = def.max !== undefined && value.length > def.max

  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between">
        <span className="text-xs font-medium tracking-wide text-desk-500 uppercase">
          {def.label}
          {def.optional && <span className="ml-1 normal-case opacity-70">(optional)</span>}
        </span>
        {def.max !== undefined && (
          <span className={`font-mono text-[11px] ${over ? 'text-red-600' : 'text-desk-500'}`}>
            {value.length}/{def.max}
          </span>
        )}
      </span>
      {preview ? (
        <span className="block px-0.5 py-1 text-base font-medium">
          {value || <span className="font-normal text-desk-500">—</span>}
        </span>
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={def.hint}
          className={`w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none ${
            over ? 'border-red-500' : 'border-desk-200 focus:border-desk-400 dark:border-desk-800'
          }`}
        />
      )}
      <span className="sr-only">{slotKey}</span>
    </label>
  )
}

export function CopyFields({
  heading,
  slotSpec,
  slots,
  onChange,
  aside,
}: {
  heading: string
  slotSpec: Record<string, SlotDef>
  slots: Record<string, string>
  /**
   * One slot at a time, by key — never a whole rebuilt draft.
   *
   * A component that handed back `{ ...slots, [key]: next }` would be building
   * it from the slots it was last rendered with, so two fields changing in the
   * same tick — a paste that fills a headline and a body together — would have
   * the second overwrite the first from a stale copy. The controlled textarea
   * keeps showing the lost text, which makes it a silent one. Handing up the
   * key lets the owner merge with a functional update, where that cannot happen.
   */
  onChange: (key: string, value: string) => void
  /** Extra controls beside the mode toggle — "copy from", and the like. */
  aside?: React.ReactNode
}) {
  const blank = Object.values(slots).every((value) => !value?.trim())
  const [preview, setPreview] = useState(!blank)

  const primaryKey = Object.entries(slotSpec).find(([, def]) => def.primary)?.[0]
  const secondary = Object.entries(slotSpec).filter(([key]) => key !== primaryKey)
  const primary = primaryKey ? slotSpec[primaryKey] : undefined

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">{heading}</h2>
        <div className="flex items-center gap-3">
          {aside}
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="text-xs text-desk-500 hover:text-desk-700"
          >
            {preview ? 'edit' : 'preview'}
          </button>
        </div>
      </div>

      {secondary.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {secondary.map(([key, def]) => (
            <Field
              key={key}
              slotKey={key}
              def={def}
              value={slots[key] ?? ''}
              onChange={(next) => onChange(key, next)}
              preview={preview}
            />
          ))}
        </div>
      )}

      {primaryKey && primary && (
        <DocumentEditor
          label={primary.label}
          value={slots[primaryKey] ?? ''}
          onChange={(next) => onChange(primaryKey, next)}
          preview={preview}
          {...(primary.max !== undefined ? { max: primary.max } : {})}
        />
      )}
    </section>
  )
}
