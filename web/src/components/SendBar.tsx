import { useState } from 'react'
import { browserTimezone, fromLocalInput, stamp, toLocalInput, until } from '../time'

/**
 * The decision, and the two things still on offer after it.
 *
 * Approving commits to a time: the proposal is already in the box, so the
 * normal path is one click, and "Send now" is the same approval with the time
 * left off — which is exactly what approval always meant. Everything else on a
 * review screen is material for this decision rather than part of it, which is
 * why this is a component and not a page.
 */

/**
 * A datetime-local can be blank or half-typed. Anything that is not a real
 * instant is treated as "no time chosen", which falls back to sending now
 * rather than throwing inside a formatter mid-render.
 */
function useSendAt(proposed: string | null) {
  /** Null until the editor touches it, so a fresh proposal is never overwritten by a stale one. */
  const [touched, setTouched] = useState<string | null>(null)
  const value = touched ?? (proposed ? toLocalInput(proposed) : '')
  const chosen = value && !Number.isNaN(new Date(value).getTime()) ? fromLocalInput(value) : null
  return { value, chosen, touched, set: setTouched, reset: () => setTouched(null) }
}

/** Only worth naming a zone when it is not the one the browser is already showing. */
function elsewhere(timezone: string): string | undefined {
  return timezone !== browserTimezone() ? timezone : undefined
}

function TimeInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <input
      type="datetime-local"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-md border border-desk-300 bg-transparent px-2 py-1 text-sm dark:border-desk-700"
    />
  )
}

export function SendBar({
  outletName,
  timezone,
  scheduleProposal,
  scheduledFor,
  settled,
  sending,
  dirty,
  approving,
  saving,
  rejecting,
  canRetry,
  retrying,
  error,
  onApprove,
  onSave,
  onSpike,
  onRetry,
  onShowPayload,
  onShowVersions,
}: {
  outletName: string
  timezone: string
  scheduleProposal: { at: string; reason: string } | null
  scheduledFor: string | null
  /** Nothing left to decide here: approved, scheduled, sent or spiked. */
  settled: boolean
  sending: boolean
  /** Unsaved edits. Approval freezes what is stored, so it must not run ahead of a save. */
  dirty: boolean
  approving: boolean
  saving: boolean
  rejecting: boolean
  canRetry: boolean
  retrying: boolean
  error: string | null
  /** Called with a time to schedule, or nothing to send immediately. */
  onApprove: (scheduledFor?: string) => void
  onSave: () => void
  onSpike: () => void
  onRetry: () => void
  onShowPayload: () => void
  onShowVersions: () => void
}) {
  // The desk's proposal until the editor moves it. Falls back to the committed
  // time on a scheduled row, which is what the "move it" control edits.
  const sendAt = useSendAt(scheduleProposal?.at ?? scheduledFor)
  const zone = elsewhere(timezone)

  return (
    <section className="space-y-2.5 rounded-lg border border-desk-200 px-3 py-3 dark:border-desk-800">
      {!settled && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium tracking-wide text-desk-500 uppercase">
              Send at
            </label>
            <TimeInput value={sendAt.value} onChange={sendAt.set} />
            {sendAt.chosen && (
              <span className="text-xs text-desk-500">
                {until(sendAt.chosen)}
                {zone && ` · ${stamp(sendAt.chosen, zone)} ${zone}`}
              </span>
            )}
          </div>
          {scheduleProposal && sendAt.touched === null && (
            <p className="text-xs text-desk-500">{scheduleProposal.reason}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onApprove(sendAt.chosen ?? undefined)}
          disabled={approving || settled || dirty}
          title={dirty ? 'Save your edits first — approval freezes what is sent' : undefined}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {approving || sending
            ? 'Sending…'
            : sendAt.chosen
              ? `Approve → ${stamp(sendAt.chosen)}`
              : `Approve for ${outletName}`}
        </button>

        <button
          onClick={() => onApprove(undefined)}
          disabled={approving || settled || dirty}
          title="Approve and send immediately, ignoring the schedule"
          className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
        >
          Send now
        </button>

        <button
          onClick={onSave}
          disabled={!dirty || saving || settled}
          className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
        >
          {saving ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
        </button>

        {/* Spiking a story is the one thing here that throws work away. */}
        <button
          onClick={onSpike}
          disabled={rejecting || settled}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          Spike
        </button>

        {canRetry && (
          <button
            onClick={onRetry}
            disabled={retrying}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Re-send
          </button>
        )}

        <button onClick={onShowPayload} className="ml-auto text-xs text-desk-500 hover:text-desk-700">
          what will be sent
        </button>
        <button onClick={onShowVersions} className="text-xs text-desk-500 hover:text-desk-700">
          history
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}

/**
 * A scheduled row is closed to editing but not to changing its mind. The copy
 * is frozen and the queue is holding it; the two things still on offer are
 * moving the time and calling it off.
 */
export function ScheduleBanner({
  scheduledFor,
  timezone,
  moving,
  withdrawing,
  error,
  onMove,
  onWithdraw,
}: {
  scheduledFor: string
  timezone: string
  moving: boolean
  withdrawing: boolean
  error: string | null
  onMove: (at: string) => void
  onWithdraw: () => void
}) {
  const sendAt = useSendAt(scheduledFor)
  const zone = elsewhere(timezone)

  return (
    <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-sm">
        <strong className="font-medium">Sending {stamp(scheduledFor, zone)}</strong>{' '}
        <span className="text-desk-600 dark:text-desk-400">
          {until(scheduledFor)}
          {zone && ` · ${zone}`}
        </span>
      </p>
      <p className="text-xs text-desk-600 dark:text-desk-400">
        The copy is frozen — exactly these bytes go out. Withdraw it to edit, which puts it back in
        the queue awaiting approval.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <TimeInput value={sendAt.value} onChange={sendAt.set} />
        <button
          onClick={() => sendAt.chosen && onMove(sendAt.chosen)}
          disabled={sendAt.touched === null || !sendAt.chosen || moving}
          className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
        >
          {moving ? 'Moving…' : 'Move'}
        </button>
        <button
          onClick={onWithdraw}
          disabled={withdrawing}
          className="ml-auto rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
        >
          {withdrawing ? 'Withdrawing…' : 'Withdraw'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}
