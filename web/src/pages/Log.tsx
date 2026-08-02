import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type EventCategory, type EventLevel, type EventRow } from '../api'
import { Assistant } from '../components/Assistant'

/**
 * Everything the desk did, in the order it did it.
 *
 * The rule the page is built around: an ordinary row is one sentence a human
 * reads, and the technical payload appears only where something went wrong.
 * A log that shows JSON on every line is a log nobody reads, and then the one
 * line that mattered goes past unnoticed.
 *
 * Nothing here derives meaning from a code. Category, severity and whether the
 * assistant has anything to offer all arrive on the row, decided by the server
 * — there are no tests on this side of the wire, so there is no logic here to
 * get wrong.
 */

const SEVERITIES: { key: string; label: string; minLevel?: EventLevel }[] = [
  { key: 'info', label: 'Everything', minLevel: 'info' },
  { key: 'warn', label: 'Warnings', minLevel: 'warn' },
  { key: 'error', label: 'Errors', minLevel: 'error' },
  { key: 'debug', label: 'Verbose', minLevel: 'debug' },
]

const CATEGORIES: { key: string; label: string; category?: EventCategory }[] = [
  { key: 'all', label: 'All' },
  { key: 'pipeline', label: 'Pipeline', category: 'pipeline' },
  { key: 'delivery', label: 'Delivery', category: 'delivery' },
  { key: 'editorial', label: 'Editorial', category: 'editorial' },
  { key: 'queue', label: 'Queue', category: 'queue' },
  { key: 'config', label: 'Config', category: 'config' },
  { key: 'ports', label: 'Ports', category: 'ports' },
  { key: 'system', label: 'System', category: 'system' },
]

const LEVEL_DOT: Record<EventLevel, string> = {
  debug: 'bg-desk-300 dark:bg-desk-700',
  info: 'bg-emerald-500/70',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
}

function when(iso: string): string {
  const date = new Date(iso)
  const mins = Math.round((Date.now() - date.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return date.toISOString().slice(0, 10)
}

/**
 * Where this row happened, as something clickable.
 *
 * A publication wins over a story when the row carries both: the placement is
 * the more specific thing, and it is where the review screen actually is.
 */
function EntityChip({ event }: { event: EventRow }) {
  if (event.publicationId) {
    return (
      <Link
        to={`/review/${event.publicationId}`}
        className="shrink-0 rounded bg-desk-100 px-1.5 py-0.5 text-[11px] text-desk-600 hover:bg-desk-200 dark:bg-desk-900 dark:text-desk-400 dark:hover:bg-desk-800"
      >
        {event.outletName ?? event.outletId ?? 'placement'}
      </Link>
    )
  }
  if (event.storyId) {
    return (
      <Link
        to={`/stories/${event.storyId}`}
        className="max-w-48 shrink-0 truncate rounded bg-desk-100 px-1.5 py-0.5 text-[11px] text-desk-600 hover:bg-desk-200 dark:bg-desk-900 dark:text-desk-400 dark:hover:bg-desk-800"
        // A story that has since been deleted still shows its id rather than
        // nothing: an event that renders blank is worse than one that renders
        // ugly.
        title={event.storyTitle ?? event.storyId}
      >
        {event.storyTitle ?? event.storyId}
      </Link>
    )
  }
  return null
}

function Detail({ event }: { event: EventRow }) {
  return (
    <div className="space-y-2 border-t border-desk-200 px-4 py-3 dark:border-desk-800">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-desk-500">code</dt>
        <dd className="font-mono">{event.code}</dd>
        <dt className="text-desk-500">at</dt>
        <dd className="font-mono">{event.at}</dd>
        <dt className="text-desk-500">actor</dt>
        <dd className="font-mono">{event.actor}</dd>
      </dl>
      {event.detail != null && (
        <pre className="max-h-72 overflow-auto rounded-md bg-desk-100 p-3 font-mono text-xs dark:bg-desk-900">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </div>
  )
}

function Expanded({ event }: { event: EventRow }) {
  return (
    <>
      <Detail event={event} />
      {/*
        Only where there is something to act on. `assistable` is a property of
        the code, decided on the server — "no device is registered" is a warning
        with no cause to fix, and a Fix button there teaches people to ignore
        the one that matters.
      */}
      {event.assistable && <Assistant eventId={event.id} />}
    </>
  )
}

function Row({ event }: { event: EventRow }) {
  const [open, setOpen] = useState(false)
  // Only where something went wrong. An info row has nothing a human needs
  // beyond the sentence, and offering a disclosure on every line is what turns
  // a readable log back into a dump.
  const expandable = event.level === 'warn' || event.level === 'error'

  return (
    <li className="rounded-lg border border-desk-200 dark:border-desk-800">
      <div className="flex items-start gap-3 px-4 py-2.5">
        <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${LEVEL_DOT[event.level]}`} />
        <span className="mt-0.5 w-16 shrink-0 font-mono text-[11px] text-desk-500">{when(event.at)}</span>
        <span className="min-w-0 flex-1 text-sm">{event.message}</span>
        <EntityChip event={event} />
        {expandable && (
          <button
            onClick={() => setOpen(!open)}
            className="shrink-0 text-[11px] text-desk-500 hover:text-desk-700 dark:hover:text-desk-300"
          >
            {open ? 'hide details' : 'details'}
          </button>
        )}
      </div>
      {open && <Expanded event={event} />}
    </li>
  )
}

export function Log() {
  // In the URL so a filtered log is a link someone can paste into a thread.
  const [params, setParams] = useSearchParams()
  const severity = params.get('severity') ?? 'info'
  const category = params.get('category') ?? 'all'
  const [query, setQuery] = useState('')

  const minLevel = SEVERITIES.find((s) => s.key === severity)?.minLevel ?? 'info'
  const categoryFilter = CATEGORIES.find((c) => c.key === category)?.category

  function setFilter(key: 'severity' | 'category', value: string) {
    const next = new URLSearchParams(params)
    next.set(key, value)
    setParams(next, { replace: true })
  }

  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['events', minLevel, categoryFilter, query],
    queryFn: ({ pageParam }) =>
      api.listEvents({
        minLevel,
        ...(categoryFilter ? { category: categoryFilter } : {}),
        ...(query ? { q: query } : {}),
        ...(pageParam ? { before: pageParam } : {}),
        limit: 50,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  })

  const events = data?.pages.flatMap((page) => page.events) ?? []

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Log</h1>
        <p className="text-sm text-desk-500">
          Everything the desk did, as it happened. This is the authoritative record — it is written
          here first and alerted about second, so it still answers when every port is broken.
        </p>
      </header>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {SEVERITIES.map((option) => (
            <button
              key={option.key}
              onClick={() => setFilter('severity', option.key)}
              className={`rounded-md px-2.5 py-1 text-sm ${
                severity === option.key
                  ? 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
                  : 'bg-desk-100 text-desk-600 dark:bg-desk-900 dark:text-desk-400'
              }`}
            >
              {option.label}
            </button>
          ))}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the log…"
            className="ml-auto min-w-48 flex-1 rounded-md border border-desk-200 bg-transparent px-2.5 py-1 text-sm outline-none focus:border-desk-400 dark:border-desk-800"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map((option) => (
            <button
              key={option.key}
              onClick={() => setFilter('category', option.key)}
              className={`rounded px-2 py-0.5 text-xs ${
                category === option.key
                  ? 'bg-desk-200 font-medium dark:bg-desk-800'
                  : 'text-desk-500 hover:bg-desk-100 dark:hover:bg-desk-900'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {isPending ? (
        <p className="text-sm text-desk-500">Loading…</p>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-desk-300 px-4 py-10 text-center text-sm text-desk-500 dark:border-desk-700">
          Nothing matches that filter.
        </div>
      ) : (
        <>
          <ul className="space-y-1.5">
            {events.map((event) => (
              <Row key={event.id} event={event} />
            ))}
          </ul>
          {hasNextPage && (
            <button
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full rounded-lg border border-dashed border-desk-300 px-3 py-2 text-xs text-desk-500 hover:border-desk-400 hover:text-desk-700 disabled:opacity-50 dark:border-desk-700"
            >
              {isFetchingNextPage ? 'Loading…' : 'Older entries'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
