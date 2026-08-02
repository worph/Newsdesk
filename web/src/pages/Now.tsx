import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, type ActionKind, type DeskAction } from '../api'
import { when } from '../components/StoryCard'

/**
 * What to press, right now.
 *
 * This is where a notification lands, and it exists because the Queue is the
 * wrong screen for that moment: the Queue is a backlog you read when there is
 * time — two tabs, a preview of every draft, the reason each story was placed.
 * Arriving there from a phone at 09:04 you have to *find* the thing that just
 * chimed at you.
 *
 * So: one line per thing, one verb each, most overdue first, and nothing that
 * is not an action. Every decision about wording and order is made by the
 * server, so this list and the notification that sent you here can never
 * describe the same job differently.
 */

/** A shape, not a colour: the row still reads on a phone in sunlight. */
const MARK: Record<ActionKind, string> = {
  'sign-in': '🔑',
  publish: '📤',
  fix: '⚠️',
  approve: '📝',
  write: '✍️',
  answer: '❓',
  place: '📍',
}

function Row({ action, onOpen }: { action: DeskAction; onOpen: () => void }) {
  return (
    <li>
      <button
        onClick={onOpen}
        className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
          action.overdue
            ? 'border-amber-300 bg-amber-50 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/60 dark:hover:bg-amber-950'
            : 'border-desk-200 hover:bg-desk-50 dark:border-desk-800 dark:hover:bg-desk-900'
        }`}
      >
        <span aria-hidden className="text-base">
          {MARK[action.kind]}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{action.title}</span>
          <span className="block truncate text-xs text-desk-600 dark:text-desk-400">
            {action.because}
            {action.since && <span className="text-desk-500"> · {when(action.since)}</span>}
          </span>
        </span>

        {/*
          A span rather than a nested button: the whole row is the target,
          which is what makes this usable with one thumb.
        */}
        <span
          className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium ${
            action.overdue
              ? 'bg-amber-900 text-white dark:bg-amber-200 dark:text-amber-950'
              : 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
          }`}
        >
          {action.verb}
        </span>
      </button>
    </li>
  )
}

export function Now() {
  const navigate = useNavigate()
  const { data, isPending } = useQuery({
    queryKey: ['actions'],
    queryFn: api.listActions,
    refetchInterval: 20_000,
  })

  if (isPending) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>

  const actions = data?.actions ?? []
  const overdue = actions.filter((a) => a.overdue)
  const rest = actions.filter((a) => !a.overdue)

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 pb-16 md:px-6">
      <header className="space-y-1 pt-4">
        <h1 className="text-xl font-semibold tracking-tight">Needs you</h1>
        <p className="text-sm text-desk-500">
          Everything the desk cannot do without you, most urgent first. The{' '}
          <button
            onClick={() => navigate('/queue')}
            className="underline underline-offset-2 hover:text-desk-700"
          >
            Queue
          </button>{' '}
          has the same work with all its context, for when there is time.
        </p>
      </header>

      {actions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-desk-300 px-4 py-10 text-center text-sm text-desk-500 dark:border-desk-700">
          Nothing is waiting on you. The desk will send a notification when something is.
        </div>
      ) : (
        <>
          {overdue.length > 0 && (
            <section className="space-y-2">
              {/*
                Separated because the difference is real: these have a slot that
                has already passed or a send that broke, and the rest is work
                that has not gone wrong yet.
              */}
              <h2 className="text-xs font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400">
                The desk is held up
              </h2>
              <ul className="space-y-2">
                {overdue.map((action) => (
                  <Row
                    key={`${action.kind}:${action.id}`}
                    action={action}
                    onOpen={() => navigate(action.href)}
                  />
                ))}
              </ul>
            </section>
          )}

          {rest.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-desk-500 uppercase">
                Waiting on a decision
              </h2>
              <ul className="space-y-2">
                {rest.map((action) => (
                  <Row
                    key={`${action.kind}:${action.id}`}
                    action={action}
                    onOpen={() => navigate(action.href)}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
