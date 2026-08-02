import type { Sibling } from '../api'

/**
 * Every destination this story runs in, and which one you are looking at.
 *
 * It carries two jobs that are really the same job. On a story the managing
 * editor placed, it is the warning: approving one destination does not ship the
 * others. On a piece you are writing yourself, it is the navigation — you write
 * each destination separately, in its own voice and its own limits, so the
 * strip is how you move between them and how you see which ones are still
 * blank. A destination nobody has written yet has to look unwritten from here,
 * because otherwise the only way to find out is to open all of them.
 */

export function TargetStrip({
  siblings,
  currentId,
  manual,
  onOpen,
}: {
  siblings: Sibling[]
  currentId: string
  /** A story written at the desk: the strip is a tab bar rather than a caution. */
  manual: boolean
  onOpen: (id: string) => void
}) {
  if (siblings.length < 2) return null

  const unwritten = siblings.filter((sibling) => !sibling.written).length

  return (
    <div className="space-y-1.5 rounded-lg border border-desk-200 px-3 py-2.5 dark:border-desk-800">
      <p className="text-xs text-desk-500">
        {manual ? (
          <>
            You are writing this for {siblings.length} destinations, one at a time.{' '}
            {unwritten > 0
              ? `${unwritten} still blank — each is approved and sent on its own.`
              : 'All written. Each is approved and sent on its own.'}
          </>
        ) : (
          <>This story runs in {siblings.length} places. Approving one does not ship the others.</>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {siblings.map((sibling) => (
          <button
            key={sibling.id}
            onClick={() => onOpen(sibling.id)}
            className={`rounded px-2 py-0.5 text-xs ${
              sibling.id === currentId
                ? 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
                : 'bg-desk-100 text-desk-600 dark:bg-desk-900 dark:text-desk-400'
            }`}
          >
            {sibling.outletName ?? sibling.outletId} ·{' '}
            {sibling.written ? sibling.status.toLowerCase().replace(/_/g, ' ') : 'blank'}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Pull another destination's copy into this one.
 *
 * Deterministic and local: it copies the slots whose keys both outlets declare
 * and nothing else, with no inference anywhere near it. Two destinations often
 * do take nearly the same words, and this keeps that from being a retype
 * without pretending they are one document — what lands here is a starting
 * point you then cut to this outlet's limits.
 */
export function CopyFrom({
  siblings,
  currentId,
  busy,
  onCopy,
}: {
  siblings: Sibling[]
  currentId: string
  busy: boolean
  onCopy: (fromId: string) => void
}) {
  const sources = siblings.filter((sibling) => sibling.id !== currentId && sibling.written)
  if (sources.length === 0) return null

  return (
    <label className="flex items-center gap-1.5 text-xs text-desk-500">
      copy from
      <select
        value=""
        disabled={busy}
        onChange={(event) => event.target.value && onCopy(event.target.value)}
        className="rounded border border-desk-300 bg-transparent px-1.5 py-0.5 text-xs disabled:opacity-40 dark:border-desk-700"
      >
        <option value="">{busy ? 'copying…' : 'choose…'}</option>
        {sources.map((sibling) => (
          <option key={sibling.id} value={sibling.id}>
            {sibling.outletName ?? sibling.outletId}
          </option>
        ))}
      </select>
    </label>
  )
}
