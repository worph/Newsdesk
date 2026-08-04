import { useMemo, useRef, useState } from 'react'
import type { Outlet } from '../api'

/**
 * Pick a destination by name.
 *
 * The field this replaces asked for an outlet *id* — a string you had to
 * remember, spelled exactly, with the only feedback a 422 after pressing the
 * button. The ids are still what crosses the wire, because that is what the
 * configuration is keyed by; nothing about them belongs on a screen.
 *
 * A combobox rather than a `<select>`: a desk with twenty destinations is a
 * scroll, and typing three letters of a name is faster than any list. It
 * matches on the description too, since "the Discord for self-hosters" is how
 * you think of a channel when you cannot recall what it was called.
 *
 * Destinations already placed on this story are filtered out rather than shown
 * disabled: the desk refuses a second placement to the same outlet, so offering
 * one would only be a 409 waiting to happen.
 */

export function OutletPicker({
  outlets,
  taken,
  value,
  onChange,
  disabled,
}: {
  outlets: Outlet[]
  /** Outlet ids this story already runs in. */
  taken: string[]
  value: string | null
  onChange: (outletId: string | null) => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const available = useMemo(
    () => outlets.filter((outlet) => outlet.enabled !== false && !taken.includes(outlet.id)),
    [outlets, taken],
  )

  const chosen = value ? (available.find((outlet) => outlet.id === value) ?? null) : null

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return available
    return available.filter((outlet) =>
      `${outlet.name} ${outlet.id} ${outlet.description}`.toLowerCase().includes(needle),
    )
  }, [available, query])

  function pick(outlet: Outlet) {
    onChange(outlet.id)
    setQuery('')
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setCursor((at) => {
        const next = event.key === 'ArrowDown' ? at + 1 : at - 1
        return Math.min(Math.max(next, 0), Math.max(matches.length - 1, 0))
      })
      return
    }
    if (event.key === 'Enter') {
      const match = matches[cursor]
      // Only swallow the Enter when it actually picked something — otherwise it
      // belongs to the form, which is how "type a name, press Enter, press
      // Enter" adds a placement without touching the mouse.
      if (open && match) {
        event.preventDefault()
        pick(match)
      }
    }
  }

  // Already chosen: the input has done its job, and what matters now is which
  // destination is about to be added and how to change your mind.
  if (chosen) {
    return (
      <span className="flex min-w-40 flex-1 items-center gap-2 rounded-md border border-desk-300 px-2.5 py-1 text-sm dark:border-desk-700">
        <span className="truncate font-medium">{chosen.name}</span>
        <span className="truncate text-xs text-desk-500">{chosen.description}</span>
        <button
          type="button"
          onClick={() => {
            onChange(null)
            setQuery('')
            inputRef.current?.focus()
          }}
          disabled={disabled}
          aria-label={`Choose a destination other than ${chosen.name}`}
          className="ml-auto shrink-0 text-desk-500 hover:text-desk-700 disabled:opacity-40"
        >
          ×
        </button>
      </span>
    )
  }

  return (
    <span
      className="relative min-w-40 flex-1"
      onBlur={(event) => {
        // A click on an option blurs the input before it fires, so the list can
        // only close once focus has actually left the whole control.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="outlet-options"
        value={query}
        disabled={disabled}
        onChange={(event) => {
          setQuery(event.target.value)
          setCursor(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={available.length === 0 ? 'every destination is already placed' : 'add a destination…'}
        className="w-full rounded-md border border-desk-200 bg-transparent px-2.5 py-1 text-sm outline-none focus:border-desk-400 disabled:opacity-40 dark:border-desk-800"
      />

      {open && available.length > 0 && (
        <ul
          id="outlet-options"
          role="listbox"
          className="absolute top-8 left-0 z-20 max-h-64 w-full min-w-64 overflow-y-auto rounded-lg border border-desk-200 bg-white py-1 shadow-lg dark:border-desk-800 dark:bg-desk-900"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-xs text-desk-500">No destination matches “{query}”.</li>
          ) : (
            matches.map((outlet, index) => (
              <li key={outlet.id} role="option" aria-selected={index === cursor}>
                <button
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  // Ahead of blur, so the click lands on an option that is still
                  // on screen rather than on a list that just closed.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(outlet)}
                  className={`block w-full px-3 py-1.5 text-left ${
                    index === cursor ? 'bg-desk-100 dark:bg-desk-800' : ''
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{outlet.name}</span>
                    {outlet.role === 'notify' && (
                      <span className="shrink-0 rounded bg-desk-200 px-1.5 py-0.5 font-mono text-[10px] text-desk-600 dark:bg-desk-800 dark:text-desk-300">
                        notify
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-desk-500">{outlet.description}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </span>
  )
}
