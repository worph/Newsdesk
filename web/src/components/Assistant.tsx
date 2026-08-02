import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type AssistSession, type Remedy } from '../api'

/**
 * The error assistant, attached to one log entry.
 *
 * It diagnoses and proposes; it never acts. Every remedy below is a stored row
 * the server validated, and applying one sends its id — not its contents — so
 * what happens is what the desk agreed to, not what the page says.
 *
 * The panel is an accelerant, never the only way through. If the Beacon is
 * down the assistant is down, and the entry's own technical detail is still
 * sitting open above this — which is the whole point of the log being
 * authoritative.
 */

function Confidence({ level }: { level: 'high' | 'medium' | 'low' | null }) {
  if (!level) return null
  const tone =
    level === 'high'
      ? 'text-emerald-700 dark:text-emerald-400'
      : level === 'medium'
        ? 'text-desk-500'
        : 'text-amber-700 dark:text-amber-500'
  return <span className={`text-[11px] ${tone}`}>{level} confidence</span>
}

function Payload({ remedy }: { remedy: Remedy }) {
  const changes = remedy.payload['changes']
  if (!Array.isArray(changes)) return null

  return (
    <ul className="space-y-0.5 font-mono text-[11px]">
      {(changes as { target: string; id: string | null; field: string; value: unknown }[]).map(
        (change, i) => (
          <li key={i}>
            {change.target}
            {change.id ? ` ${change.id}` : ''} · {change.field}: → {String(change.value)}
          </li>
        ),
      )}
    </ul>
  )
}

function RemedyCard({ remedy, onApplied }: { remedy: Remedy; onApplied: (message: string) => void }) {
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState('')

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['assist'] })
    void queryClient.invalidateQueries({ queryKey: ['events'] })
    void queryClient.invalidateQueries({ queryKey: ['config'] })
  }

  const apply = useMutation({
    mutationFn: () => api.applyRemedy(remedy.id, remedy.confirmWith ? confirm : undefined),
    onSuccess: (result) => {
      onApplied(result.outcome)
      invalidate()
      if (result.next?.action === 'authorize-endpoint') {
        onApplied(`${result.outcome} — open Configuration to connect it.`)
      }
    },
  })

  const dismiss = useMutation({
    mutationFn: () => api.dismissRemedy(remedy.id),
    onSuccess: invalidate,
  })

  if (remedy.status !== 'PROPOSED') {
    return (
      <li className="rounded-md border border-desk-200 px-3 py-2 text-xs text-desk-500 dark:border-desk-800">
        {remedy.title} — {remedy.status.toLowerCase()}
        {remedy.error && <span className="text-red-600"> ({remedy.error})</span>}
      </li>
    )
  }

  const highRisk = remedy.risk === 'high'
  const ready = !highRisk || confirm === remedy.confirmWith
  const busy = apply.isPending || dismiss.isPending

  return (
    <li
      className={`space-y-2 rounded-md border px-3 py-2.5 ${
        highRisk
          ? 'border-red-300 bg-red-50/50 dark:border-red-900 dark:bg-red-950/30'
          : 'border-desk-200 dark:border-desk-800'
      }`}
    >
      <div>
        <p className="text-sm font-medium">{remedy.title}</p>
        <p className="text-xs text-desk-600 dark:text-desk-400">{remedy.rationale}</p>
      </div>

      <Payload remedy={remedy} />

      {highRisk && (
        <div className="space-y-1.5 text-xs text-red-700 dark:text-red-300">
          <p className="font-medium">This changes where content goes, or restarts the desk.</p>
          {/*
            Said plainly rather than hidden: the proposal may have originated in
            text the desk fetched from somewhere else, and the operator reading
            the exact before/after is the only thing standing in that path.
          */}
          <p className="text-[11px] opacity-80">
            Read the change above. A proposal can originate in text the desk retrieved from
            elsewhere, so confirm only what you understand.
          </p>
          <label className="block">
            <span className="text-[11px]">
              Type <span className="font-mono">{remedy.confirmWith}</span> to confirm
            </span>
            <input
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="mt-1 w-full rounded border border-red-300 bg-transparent px-2 py-1 font-mono text-xs outline-none dark:border-red-900"
            />
          </label>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => apply.mutate()}
          disabled={!ready || busy}
          className="rounded-md bg-desk-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
        >
          {apply.isPending ? 'Applying…' : 'Apply'}
        </button>
        <button
          onClick={() => dismiss.mutate()}
          disabled={busy}
          className="text-xs text-desk-500 hover:text-desk-700 disabled:opacity-40 dark:hover:text-desk-300"
        >
          Dismiss
        </button>
        {apply.error && <span className="text-xs text-red-600">{(apply.error as Error).message}</span>}
      </div>
    </li>
  )
}

function Session({ session }: { session: AssistSession }) {
  const [outcome, setOutcome] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-medium tracking-wide text-desk-500 uppercase">Assistant</h4>
          <Confidence level={session.confidence} />
        </div>
        <p className="text-sm">{session.diagnosis}</p>
      </div>

      {session.remedies.length > 0 && (
        <ul className="space-y-2">
          {session.remedies.map((remedy) => (
            <RemedyCard key={remedy.id} remedy={remedy} onApplied={setOutcome} />
          ))}
        </ul>
      )}

      {outcome && <p className="text-xs text-emerald-700 dark:text-emerald-400">{outcome}</p>}

      {/*
        What the desk threw away. Shown rather than hidden: a proposal that
        named something nonexistent says something about how much to trust the
        rest of the diagnosis.
      */}
      {session.rejected.length > 0 && (
        <details className="text-xs text-desk-500">
          <summary className="cursor-pointer">
            {session.rejected.length} suggestion(s) were discarded
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {session.rejected.map((entry, i) => (
              <li key={i}>
                {entry.title} — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export function Assistant({ eventId }: { eventId: number }) {
  const queryClient = useQueryClient()

  const status = useQuery({ queryKey: ['assist-status'], queryFn: api.assistStatus })
  const existing = useQuery({
    queryKey: ['assist', eventId],
    queryFn: () => api.getAssist(eventId),
  })

  const run = useMutation({
    mutationFn: () => api.runAssist(eventId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assist', eventId] })
    },
  })

  const session = run.data?.session ?? existing.data?.session ?? null

  if (session) {
    return (
      <div className="border-t border-desk-200 px-4 py-3 dark:border-desk-800">
        <Session session={session} />
      </div>
    )
  }

  const unavailable = status.data && !status.data.available
  const disabled = Boolean(unavailable) || run.isPending

  return (
    <div className="border-t border-desk-200 px-4 py-3 dark:border-desk-800">
      <button
        onClick={() => run.mutate()}
        disabled={disabled}
        // The reason lives on the button rather than arriving as a failure
        // after a click — the desk being busy is not an error to discover.
        title={unavailable ? status.data?.reason : undefined}
        className="w-full rounded-lg border border-dashed border-desk-300 px-3 py-2 text-xs text-desk-500 hover:border-desk-400 hover:text-desk-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-desk-700"
      >
        {run.isPending
          ? 'Working out what happened…'
          : unavailable
            ? `Fix with assistant — unavailable: ${status.data?.reason}`
            : 'Fix with assistant'}
      </button>
      {run.error && (
        <p className="pt-2 text-xs text-red-600">{(run.error as Error).message}</p>
      )}
    </div>
  )
}
