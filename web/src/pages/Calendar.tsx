import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type CalendarEntry } from '../api'
import { browserTimezone, stamp, until } from '../time'

/**
 * The schedule, past and future, on one grid.
 *
 * Planned and published are the same question in two tenses, so they share a
 * surface: a month you can look at and see both what went out and what is
 * about to. Nothing is decided here — every entry is already approved, and the
 * way to change one is to open it, which is where the gate lives.
 *
 * Anything still awaiting a decision is deliberately absent. That is the Queue,
 * and a backlog with no time on it has no place on a calendar.
 */

const TONE: Record<string, string> = {
  SCHEDULED: 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-200',
  APPROVED: 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-200',
  // Its time has come and it is owed a person, not a poll: louder than a slot
  // still in the future, and not the green of something already out.
  AWAITING_SEND:
    'bg-emerald-100 text-emerald-900 ring-1 ring-emerald-400 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-700',
  PUBLISHED:
    'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-200',
  FAILED: 'bg-red-100 text-red-900 hover:bg-red-200 dark:bg-red-950 dark:text-red-200',
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Local calendar day as `YYYY-MM-DD`, which is how entries are bucketed. */
function dayKey(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The six-week block a month view draws, Monday-first. Always six rows so the
 * grid does not change height between months — a calendar that reflows as you
 * page through it is hard to read.
 */
function gridFor(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  // getDay() is Sunday-first; shift so Monday is column zero.
  const lead = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

function Chip({ entry, onOpen }: { entry: CalendarEntry; onOpen: () => void }) {
  const time = new Date(entry.at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  /**
   * What the time on a browser entry means, which is three things rather than
   * two. Under `auto` it is a send time like any other row on the grid. Under a
   * hand-over mode it is when the post is put in front of a person, and it goes
   * out whenever they get to it — which may be hours later, or tomorrow.
   *
   * `detached` is marked differently again: by its slot the page already exists
   * at the destination, so the outstanding work is finishing it rather than
   * publishing it. Showing three unlike things alike is the failure worth
   * avoiding here.
   */
  const pending = entry.status !== 'PUBLISHED'
  const mark = !pending || entry.mode === 'auto' ? null : entry.mode === 'detached' ? '📝' : '✋'
  const note =
    mark === '✋'
      ? ' — you publish this one by hand'
      : mark === '📝'
        ? ' — filed for you to finish'
        : ''

  return (
    <button
      onClick={onOpen}
      title={`${entry.storyTitle ?? entry.storyId} → ${entry.outletName ?? entry.outletId}${note}`}
      className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] ${
        TONE[entry.status] ?? 'bg-desk-200 text-desk-700 dark:bg-desk-800 dark:text-desk-300'
      }`}
    >
      <span className="font-mono opacity-70">{time}</span>
      {mark && <span aria-hidden> {mark}</span>} {entry.storyTitle ?? entry.storyId}
    </button>
  )
}

export function Calendar() {
  const navigate = useNavigate()
  const today = new Date()
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1))

  const days = useMemo(() => gridFor(month), [month])
  const from = days[0]!
  // Through the end of the last day drawn, so an entry at 23:59 is included.
  const to = new Date(days[41]!.getFullYear(), days[41]!.getMonth(), days[41]!.getDate(), 23, 59, 59)

  const { data, isPending } = useQuery({
    queryKey: ['calendar', from.toISOString(), to.toISOString()],
    queryFn: () => api.getCalendar(from.toISOString(), to.toISOString()),
    refetchInterval: 60_000,
  })

  const byDay = useMemo(() => {
    const buckets = new Map<string, CalendarEntry[]>()
    for (const entry of data?.entries ?? []) {
      const key = dayKey(new Date(entry.at))
      const bucket = buckets.get(key)
      if (bucket) bucket.push(entry)
      else buckets.set(key, [entry])
    }
    return buckets
  }, [data])

  const upcoming = (data?.entries ?? []).filter(
    (entry) => entry.status === 'SCHEDULED' && new Date(entry.at).getTime() >= Date.now(),
  )

  const elsewhere = data && data.timezone !== browserTimezone() ? data.timezone : undefined
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const step = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1))

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 pb-16 md:px-6">
      <header className="flex flex-wrap items-center gap-3 pt-4">
        <h1 className="text-xl font-semibold tracking-tight">{monthLabel}</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => step(-1)}
            aria-label="previous month"
            className="rounded-md bg-desk-100 px-2 py-1 text-sm text-desk-700 dark:bg-desk-900 dark:text-desk-300"
          >
            ←
          </button>
          <button
            onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
            className="rounded-md bg-desk-100 px-2 py-1 text-sm text-desk-700 dark:bg-desk-900 dark:text-desk-300"
          >
            Today
          </button>
          <button
            onClick={() => step(1)}
            aria-label="next month"
            className="rounded-md bg-desk-100 px-2 py-1 text-sm text-desk-700 dark:bg-desk-900 dark:text-desk-300"
          >
            →
          </button>
        </div>
        {elsewhere && (
          <span className="text-xs text-desk-500">
            times shown in your zone; the desk schedules in {elsewhere}
          </span>
        )}
        {isPending && <span className="text-xs text-desk-500">Loading…</span>}
      </header>

      {/* The grid is wide by nature; let it scroll rather than crushing a day
          to nothing on a phone. The agenda below is the narrow-screen answer. */}
      <div className="hidden overflow-x-auto sm:block">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-7 gap-px">
            {WEEKDAYS.map((label) => (
              <div key={label} className="px-2 py-1 text-xs font-medium text-desk-500">
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px bg-desk-200 dark:bg-desk-800">
            {days.map((day) => {
              const entries = byDay.get(dayKey(day)) ?? []
              const outside = day.getMonth() !== month.getMonth()
              const isToday = dayKey(day) === dayKey(today)

              return (
                <div
                  key={day.toISOString()}
                  className={`min-h-24 space-y-1 p-1.5 ${
                    outside ? 'bg-desk-50 dark:bg-desk-950' : 'bg-white dark:bg-desk-900/40'
                  }`}
                >
                  <div
                    className={`text-[11px] ${
                      isToday
                        ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                        : outside
                          ? 'text-desk-400'
                          : 'text-desk-500'
                    }`}
                  >
                    {day.getDate()}
                  </div>
                  {entries.map((entry) => (
                    <Chip key={entry.id} entry={entry} onOpen={() => navigate(`/review/${entry.id}`)} />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Still to go out</h2>
        {upcoming.length === 0 ? (
          <div className="rounded-lg border border-dashed border-desk-300 px-4 py-6 text-center text-xs text-desk-500 dark:border-desk-700">
            Nothing is scheduled. Approving a draft with a time puts it here.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {upcoming.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-desk-200 dark:border-desk-800">
                <button
                  onClick={() => navigate(`/review/${entry.id}`)}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-left"
                >
                  <span className="font-medium">{entry.storyTitle ?? entry.storyId}</span>
                  <span className="rounded bg-desk-100 px-1.5 py-0.5 font-mono text-[11px] text-desk-600 dark:bg-desk-800 dark:text-desk-300">
                    {entry.outletName ?? entry.outletId}
                  </span>
                  <span className="ml-auto text-xs text-desk-500">
                    {stamp(entry.at, elsewhere)} · {until(entry.at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
