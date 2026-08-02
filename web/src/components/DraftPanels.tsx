import type { DraftVersion } from '../api'
import { Badge, when } from './StoryCard'

/**
 * The two disclosures under a draft: what will actually be sent, and how the
 * copy got to where it is. Both are opened when wanted rather than parked on
 * the screen — the decision above them is the screen's subject.
 */

export function PayloadPanel({
  payload,
  frozen,
}: {
  payload: Record<string, unknown> | undefined
  frozen: boolean | undefined
}) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">
        What will be sent {frozen && '(frozen at approval)'}
      </h2>
      <p className="text-xs text-desk-500">
        Keys you did not author come from configuration — the destination is pinned there and no
        draft can reach it.
      </p>
      <pre className="max-h-80 overflow-auto rounded-md bg-desk-100 p-3 font-mono text-xs dark:bg-desk-900">
        {JSON.stringify(payload ?? {}, null, 2)}
      </pre>
    </section>
  )
}

export function VersionsPanel({
  versions,
  disabled,
  onRevert,
}: {
  versions: DraftVersion[]
  disabled: boolean
  onRevert: (versionId: string) => void
}) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">History</h2>
      {versions.length === 0 ? (
        <p className="text-xs text-desk-500">Nothing saved yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex items-center gap-3 rounded-md border border-desk-200 px-3 py-2 text-sm dark:border-desk-800"
            >
              <Badge>{version.origin}</Badge>
              <span className="min-w-0 flex-1 truncate text-desk-600 dark:text-desk-400">
                {Object.values(version.slots)[0]}
              </span>
              <span className="shrink-0 text-xs text-desk-500">{when(version.createdAt)}</span>
              <button
                onClick={() => onRevert(version.id)}
                disabled={disabled}
                className="shrink-0 text-xs text-desk-500 hover:text-desk-700 disabled:opacity-40"
              >
                revert
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
