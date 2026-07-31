import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type FilingRow } from '../api'

/**
 * Raw filings as filed, including the ones that yielded nothing. This is
 * the screen that answers "did the stringer even file?" — the question the
 * previous pipeline could never answer, because silence and nothing-happened
 * looked identical.
 */

function when(iso: string): string {
  const date = new Date(iso)
  const mins = Math.round((Date.now() - date.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return date.toISOString().slice(0, 10)
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="rounded bg-desk-200 px-1.5 py-0.5 font-mono text-[11px] text-desk-600 dark:bg-desk-800 dark:text-desk-300">
      {kind}
    </span>
  )
}

function Detail({ id }: { id: string }) {
  const { data, isPending } = useQuery({
    queryKey: ['filing', id],
    queryFn: () => api.getFiling(id),
  })

  if (isPending) return <p className="px-4 py-3 text-sm text-desk-500">Loading…</p>
  const filing = data!.filing

  return (
    <div className="space-y-4 border-t border-desk-200 px-4 py-4 dark:border-desk-800">
      <section className="space-y-1.5">
        <h3 className="text-xs font-medium tracking-wide text-desk-500 uppercase">Considered</h3>
        <p className="text-xs text-desk-500">
          The slice actually handed to the managing editor, after the watermark or snapshot diff.
        </p>
        {filing.considered ? (
          <pre className="max-h-72 overflow-auto rounded-md bg-desk-100 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-desk-900">
            {filing.considered}
          </pre>
        ) : (
          <p className="rounded-md bg-desk-100 px-3 py-2 text-sm text-desk-500 dark:bg-desk-900">
            Nothing — {filing.outcome}
          </p>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-medium tracking-wide text-desk-500 uppercase">As filed</h3>
        <pre className="max-h-72 overflow-auto rounded-md bg-desk-100 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-desk-900">
          {filing.text}
        </pre>
      </section>

      {filing.refs && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium tracking-wide text-desk-500 uppercase">Refs</h3>
          <pre className="overflow-auto rounded-md bg-desk-100 p-3 font-mono text-xs dark:bg-desk-900">
            {JSON.stringify(filing.refs, null, 2)}
          </pre>
        </section>
      )}
    </div>
  )
}

function Row({ row }: { row: FilingRow }) {
  const [open, setOpen] = useState(false)
  const yielded = row.consideredChars > 0

  return (
    <li className="rounded-lg border border-desk-200 dark:border-desk-800">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full ${yielded ? 'bg-emerald-500' : 'bg-desk-300 dark:bg-desk-700'}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.stringerName ?? row.stringerId}</span>
            <KindBadge kind={row.kind} />
            <span className="text-xs text-desk-500">{when(row.receivedAt)}</span>
          </span>
          <span className="mt-0.5 block text-sm text-desk-600 dark:text-desk-400">{row.outcome}</span>
        </span>
        <span className="shrink-0 text-xs text-desk-500">
          {row.consideredChars}/{row.textLength} chars
        </span>
      </button>
      {open && <Detail id={row.id} />}
    </li>
  )
}

export function Wire() {
  const { data, isPending } = useQuery({
    queryKey: ['filings'],
    queryFn: () => api.listFilings({ limit: 100 }),
    refetchInterval: 30_000,
  })

  if (isPending) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>

  const rows = data!.filings

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Wire</h1>
        <p className="text-sm text-desk-500">
          Everything filed by a stringer, whether or not it yielded anything. A green dot means part of it
          was new.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-desk-300 px-4 py-10 text-center dark:border-desk-700">
          <p className="text-sm text-desk-500">Nothing filed yet.</p>
          <p className="mt-1 text-xs text-desk-500">
            Point a stringer at <code className="font-mono">POST /api/v1/filings</code> with the ingest
            token from Configuration.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  )
}
