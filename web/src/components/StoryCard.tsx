import type { StoryRow } from '../api'

/**
 * One story as it appears in a list, with its per-outlet placement chips. Shared
 * by the Queue and Stories screens because they are the same rows asked
 * different questions.
 */

export function when(iso: string): string {
  const date = new Date(iso)
  const mins = Math.round((Date.now() - date.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return date.toISOString().slice(0, 10)
}

export const STATUS_STYLE: Record<string, string> = {
  PLACED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  PROPOSED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  DROPPED: 'bg-desk-200 text-desk-600 dark:bg-desk-800 dark:text-desk-400',
  HELD: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  CLOSED: 'bg-desk-200 text-desk-600 dark:bg-desk-800 dark:text-desk-400',
}

export function Badge({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
        tone ?? 'bg-desk-200 text-desk-600 dark:bg-desk-800 dark:text-desk-300'
      }`}
    >
      {children}
    </span>
  )
}

export function StoryCard({ story, onOpen }: { story: StoryRow; onOpen?: () => void }) {
  const spiked = story.status === 'DROPPED'

  return (
    <li className="rounded-lg border border-desk-200 dark:border-desk-800">
      <button onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full ${
            spiked ? 'bg-desk-300 dark:bg-desk-700' : 'bg-emerald-500'
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{story.title}</span>
            <Badge tone={STATUS_STYLE[story.status]}>{story.status.toLowerCase()}</Badge>
            {story.dedupVerdict !== 'NEW' && <Badge>{story.dedupVerdict.toLowerCase()}</Badge>}
            {story.label && <Badge>{story.label}</Badge>}
            <span className="text-xs text-desk-500">{when(story.createdAt)}</span>
          </span>

          <span className="mt-1 block text-sm text-desk-600 dark:text-desk-400">{story.summary}</span>

          {/* Every drop carries its reason: silence and nothing-happened must never look alike. */}
          {spiked && story.dropReason && (
            <span className="mt-2 block rounded-md bg-desk-100 px-3 py-2 text-xs text-desk-600 dark:bg-desk-900 dark:text-desk-400">
              <strong className="font-medium">Spiked:</strong> {story.dropReason}
            </span>
          )}

          {/* A hold is a question, not a verdict — it is only actionable if you can read it. */}
          {story.holdReason && (
            <span className="mt-2 block rounded-md bg-desk-100 px-3 py-2 text-xs text-desk-600 dark:bg-desk-900 dark:text-desk-400">
              <strong className="font-medium">Held:</strong> {story.holdReason}
            </span>
          )}

          {story.relatedTitle && (
            <span className="mt-2 block text-xs text-desk-500">
              ↳ {story.dedupVerdict === 'UPDATE' ? 'follows' : 'matched'}{' '}
              <span className="text-desk-700 dark:text-desk-300">{story.relatedTitle}</span>
            </span>
          )}

          {story.placements.length > 0 && (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {story.placements.map((placement) => (
                <span
                  key={placement.id}
                  title={placement.placementReason ?? undefined}
                  className="rounded border border-desk-200 px-1.5 py-0.5 text-[11px] text-desk-600 dark:border-desk-700 dark:text-desk-400"
                >
                  {placement.outletName ?? placement.outletId}
                  {placement.origin === 'human' && ' ·  added'}
                </span>
              ))}
            </span>
          )}
        </span>

        <span className="shrink-0 text-right text-xs text-desk-500">
          {story.sourceCount > 1 && (
            <span className="block font-medium text-desk-700 dark:text-desk-300">
              {story.sourceCount} sources
            </span>
          )}
        </span>
      </button>
    </li>
  )
}
