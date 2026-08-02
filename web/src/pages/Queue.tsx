import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, type PublicationRow } from '../api'
import { Badge, STATUS_STYLE, StoryCard, when } from '../components/StoryCard'
import { useArticleQueue, usePlacementQueue } from '../queue'

/**
 * The gate: everything awaiting a decision, oldest first. This screen is just
 * the list of things standing at the gate — the gate itself is enforced at
 * review, where approve is the only path to the wire.
 *
 * The desk asks for two decisions and they are not the same question, so they
 * are two tabs rather than one stacked list: reading a draft and deciding where
 * a story runs are different sittings, and the counts stay visible on both so
 * nothing hides behind the tab you are not on. The choice lives in the URL, so
 * a reload — or a link to someone else — lands on the same half.
 */

type Tab = 'article' | 'placement'

function Tabs({
  tab,
  onTab,
  counts,
}: {
  tab: Tab
  onTab: (next: Tab) => void
  counts: Record<Tab, number>
}) {
  const tabs: { key: Tab; label: string }[] = [
    { key: 'article', label: 'Article approval' },
    { key: 'placement', label: 'Placement approval' },
  ]

  return (
    <div className="flex gap-1 border-b border-desk-200 dark:border-desk-800" role="tablist">
      {tabs.map(({ key, label }) => {
        const active = key === tab
        return (
          <button
            key={key}
            role="tab"
            aria-selected={active}
            onClick={() => onTab(key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${
              active
                ? 'border-desk-900 font-medium dark:border-desk-100'
                : 'border-transparent text-desk-500 hover:text-desk-700 dark:hover:text-desk-300'
            }`}
          >
            {label}
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${
                active
                  ? 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
                  : 'bg-desk-200 text-desk-600 dark:bg-desk-800 dark:text-desk-300'
              }`}
            >
              {counts[key]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * A placement row wears two chips that look alike and mean nothing alike: the
 * first is a decision the desk made, the second is a word it invented. That is
 * two lines of explanation — too little for the copy above the list, too much
 * to leave to guesswork — so it sits behind an "i".
 */
function ChipLegend() {
  const [open, setOpen] = useState(false)

  return (
    <span
      className="relative inline-block align-middle"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
    >
      <button
        type="button"
        aria-label="What the chips mean"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="grid size-4 place-items-center rounded-full border border-desk-300 font-mono text-[10px] leading-none text-desk-500 hover:border-desk-500 hover:text-desk-700 dark:border-desk-700 dark:hover:border-desk-500 dark:hover:text-desk-300"
      >
        i
      </button>

      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-6 z-10 block w-80 space-y-1.5 rounded-lg border border-desk-200 bg-white px-3 py-2 text-xs leading-relaxed text-desk-600 shadow-lg dark:border-desk-800 dark:bg-desk-900 dark:text-desk-400"
        >
          <span className="block">
            <Badge tone={STATUS_STYLE.PLACED}>placed</Badge> — the desk's call on the story itself:
            it picked destinations and is waiting on you. <Badge tone={STATUS_STYLE.HELD}>held</Badge>{' '}
            means it needs an answer first, <Badge tone={STATUS_STYLE.DROPPED}>dropped</Badge> means
            it was spiked.
          </span>
          <span className="block">
            <Badge>release</Badge> — a coarse label the desk gave the story so like things sort
            together. Cosmetic: it never decides where anything runs.
          </span>
        </span>
      )}
    </span>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-desk-300 px-4 py-6 text-center text-xs text-desk-500 dark:border-desk-700">
      {children}
    </div>
  )
}

/**
 * One draft awaiting approval, as a row. It carries the opening of what was
 * written, because "which of these three do I read first" is a question the
 * title alone cannot answer.
 */
function ArticleCard({ publication, onOpen }: { publication: PublicationRow; onOpen: () => void }) {
  const failed = publication.status === 'FAILED'
  /**
   * Already approved, already due, and the only thing left is a person opening
   * the page and pressing publish. It reads differently from a draft awaiting a
   * decision — the decision is made — so it says what it is owed rather than
   * sitting in the pile looking like more reading.
   */
  const awaitingSend = publication.status === 'AWAITING_SEND'
  // A piece you are writing yourself starts blank on purpose. Without saying so,
  // an empty row here is indistinguishable from a writer that failed silently.
  const mine = publication.storyOrigin === 'desk'

  return (
    <li className="rounded-lg border border-desk-200 dark:border-desk-800">
      <button onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full ${
            failed ? 'bg-red-500' : awaitingSend ? 'bg-emerald-500' : 'bg-amber-500'
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{publication.storyTitle ?? publication.storyId}</span>
            <Badge tone="bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900">
              {publication.outletName ?? publication.outletId}
            </Badge>
            {failed && (
              <Badge tone="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
                send failed
              </Badge>
            )}
            {awaitingSend && (
              <Badge tone="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                publish it yourself
              </Badge>
            )}
            {mine ? (
              <Badge>yours</Badge>
            ) : (
              publication.origin === 'human' && <Badge>added by you</Badge>
            )}
            {publication.storyCreatedAt && (
              <span className="text-xs text-desk-500">{when(publication.storyCreatedAt)}</span>
            )}
          </span>

          {publication.preview ? (
            <span className="mt-1 block text-sm text-desk-600 dark:text-desk-400">
              {publication.preview}
            </span>
          ) : (
            mine && (
              <span className="mt-1 block text-sm text-desk-500 italic">
                Not written yet — open it to write this destination.
              </span>
            )
          )}

          {/* A failed send is the one row here that is not simply waiting on you. */}
          {failed && publication.error && (
            <span className="mt-2 block rounded-md bg-desk-100 px-3 py-2 text-xs text-desk-600 dark:bg-desk-900 dark:text-desk-400">
              {publication.error}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

export function Queue() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const chosen = params.get('tab')

  const stories = usePlacementQueue()
  const articles = useArticleQueue()

  const { data: jobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.listJobs,
    refetchInterval: 10_000,
  })

  if (stories.isPending || articles.isPending) {
    return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>
  }

  // Oldest first: a queue is a backlog. The stories endpoint answers newest
  // first because the archive wants it that way; the publications endpoint
  // already sorts by when the story arrived.
  const placements = [...(stories.data?.stories ?? [])].reverse()
  const drafts = articles.data?.publications ?? []
  const working = (jobs?.stats.pending ?? 0) + (jobs?.stats.running ?? 0)

  // Drafts are the day's work, so that is where an unqualified /queue lands —
  // unless there are none and placements are waiting, which would open the
  // screen on an empty tab while the sidebar badge insists there is something
  // to do. A tab you clicked is in the URL and is never second-guessed.
  const tab: Tab =
    chosen === 'placement' || chosen === 'article'
      ? chosen
      : drafts.length === 0 && placements.length > 0
        ? 'placement'
        : 'article'

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Queue</h1>
        <p className="text-sm text-desk-500">
          Everything awaiting a decision, oldest first — where a story runs, then what it says.
        </p>
        {working > 0 && (
          <p className="text-xs text-desk-500">
            {working} filing{working === 1 ? '' : 's'} still with the desk…
          </p>
        )}
      </header>

      <Tabs
        tab={tab}
        onTab={(next) => setParams({ tab: next }, { replace: true })}
        counts={{ article: drafts.length, placement: placements.length }}
      />

      {tab === 'article' ? (
        <section className="space-y-2">
          <p className="text-xs text-desk-500">
            Drafts waiting on you, one per destination — what the writer finished, and what you
            started yourself. Approve is the only path to the wire.
          </p>
          {drafts.length === 0 ? (
            <Empty>No draft is waiting. One appears here as soon as the writer finishes a piece.</Empty>
          ) : (
            <ul className="space-y-2">
              {drafts.map((publication) => (
                <ArticleCard
                  key={publication.id}
                  publication={publication}
                  onOpen={() =>
                    navigate(
                      // Its decision is made; what it wants is the browser, not
                      // the editor.
                      publication.status === 'AWAITING_SEND'
                        ? `/review/${publication.id}/live`
                        : `/review/${publication.id}`,
                    )
                  }
                />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="space-y-2">
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-desk-500">
            <span>
              Where the managing editor proposed each story should run, and why. Each chip is one
              destination — approving one never ships the others.
            </span>
            <ChipLegend />
          </p>
          {placements.length === 0 ? (
            <Empty>
              Nothing placed. Stories the managing editor spiked are under Stories, with their
              reasons.
            </Empty>
          ) : (
            <ul className="space-y-2">
              {placements.map((story) => (
                <StoryCard
                  key={story.id}
                  story={story}
                  onOpen={() => navigate(`/stories/${story.id}`)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
