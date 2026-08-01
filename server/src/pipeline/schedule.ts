import type { Cadence } from '@newsdesk/shared'

/**
 * When a piece runs.
 *
 * This is arithmetic, not judgement, so no inference happens here. The managing
 * editor already spent its judgement on whether a story runs and where; the
 * clock is a constraint problem — a window, a spacing, a daily cap — and code
 * can solve it deterministically, cheaply, and with tests. It also keeps the
 * single contended Beacon agent out of a question that never needed it.
 *
 * The one editorial input is `urgency`, which the managing editor sets per
 * placement: a security advisory and a blog roundup do not belong in the same
 * queue position, and only a reader of the story can say which is which.
 *
 * Nothing here is ever stored. A proposal is computed when a human opens the
 * review screen, because one computed at write-time would be measured against a
 * calendar that has since filled up. `publications.scheduled_for` only ever
 * holds a commitment.
 */

export const URGENCIES = ['breaking', 'normal', 'evergreen'] as const
export type Urgency = (typeof URGENCIES)[number]

export interface Slot {
  at: Date
  /** Shown under the time control at review, so the proposal can be argued with. */
  reason: string
}

export interface ProposeOptions {
  now: Date
  cadence?: Cadence | null
  urgency?: Urgency | null
  /** This outlet's committed and recently-sent times, in any order. */
  taken?: (Date | string)[]
  /** Desk-wide fallback when the cadence names no zone. */
  timezone?: string
}

/** An outlet that declares nothing behaves as it did before scheduling existed. */
const DEFAULTS = {
  window: { from: '00:00', to: '23:59' },
  minGapMinutes: 60,
} as const

/**
 * How far ahead to look before giving up. A month is well past the point where
 * a proposal is useful; the cap exists so a pathological cadence cannot spin.
 */
const HORIZON_DAYS = 30

const MINUTE = 60_000

function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
}

/**
 * To the next five minutes. A proposal of 13:32 reads as a bug rather than as a
 * decision, and rounding up can only ever move a slot later — never before the
 * "now" it was measured from.
 */
function roundUp(at: Date): Date {
  return new Date(Math.ceil(at.getTime() / (5 * MINUTE)) * (5 * MINUTE))
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Constructing an `Intl.DateTimeFormat` is expensive and a single proposal can
 * probe hundreds of candidate times, so formatters are built once per zone.
 * There are only ever a handful of zones — one per outlet — so the map does not
 * need eviction.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    })
    formatters.set(timezone, formatter)
  }
  return formatter
}

/** What clock and calendar a given instant shows in a given zone. */
export function localParts(at: Date, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(at)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Intl renders midnight as hour 24 in some zones; normalise it back to 0.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  }
}

/**
 * The UTC instant at which a given zone's clock reads a given local time.
 *
 * There is no built-in for this, and the naive `new Date(y, m, d, h, m)` reads
 * the *host* zone, which in a container is whatever the image shipped with.
 * So: guess that local time is UTC, ask what that instant actually looks like
 * in the target zone, and correct by the difference. Twice, because a
 * correction that crosses a DST boundary changes the offset it was correcting
 * for — the second pass settles it.
 *
 * On a spring-forward day the requested local time may not exist at all (02:30
 * in Europe/Paris on the last Sunday of March). The round trip then lands on
 * the following hour rather than throwing, which is the behaviour a posting
 * window wants: post as soon after the requested time as the clock allows.
 */
export function fromLocal(
  timezone: string,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): Date {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  let guess = new Date(wanted)

  for (let pass = 0; pass < 2; pass++) {
    const seen = localParts(guess, timezone)
    const asUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute)
    const drift = wanted - asUtc
    if (drift === 0) break
    guess = new Date(guess.getTime() + drift)
  }

  return guess
}

/** Advance a local calendar date by one day, ignoring clocks entirely. */
function nextDay(date: { year: number; month: number; day: number }) {
  const stepped = new Date(Date.UTC(date.year, date.month - 1, date.day + 1))
  return {
    year: stepped.getUTCFullYear(),
    month: stepped.getUTCMonth() + 1,
    day: stepped.getUTCDate(),
  }
}

function sameLocalDay(a: LocalParts, b: LocalParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
}

const labels = new Map<string, Intl.DateTimeFormat>()

function describe(at: Date, timezone: string): string {
  let label = labels.get(timezone)
  if (!label) {
    label = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    labels.set(timezone, label)
  }
  return label.format(at)
}

/**
 * The next time this outlet can post.
 *
 * Never throws and never returns nothing: a proposer that refuses to answer
 * would block approval, and the human can always overrule the time or send
 * immediately. When no slot fits inside the horizon it returns the horizon with
 * a reason saying so, which is legible rather than mysterious.
 */
export function proposeSlot(options: ProposeOptions): Slot {
  const cadence = options.cadence ?? {}
  const urgency: Urgency = options.urgency ?? 'normal'
  const timezone = cadence.timezone ?? options.timezone ?? 'UTC'

  if (urgency === 'breaking') {
    return { at: options.now, reason: 'breaking — sends as soon as you approve, ignoring the posting window' }
  }

  const window = cadence.window ?? DEFAULTS.window
  const from = minutesOf(window.from)
  const to = minutesOf(window.to)
  const gap = cadence.min_gap_minutes ?? DEFAULTS.minGapMinutes
  const days = cadence.days
  const maxPerDay = cadence.max_per_day

  const taken = (options.taken ?? [])
    .map((value) => (value instanceof Date ? value : new Date(value)))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())

  /**
   * Evergreen waits for the tail rather than jumping the queue: it starts
   * searching after everything already committed, so a piece that can wait does
   * wait, and the outlet's next free slot stays available for something that
   * cannot.
   */
  const last = taken.at(-1)
  const searchFrom =
    urgency === 'evergreen' && last && last.getTime() > options.now.getTime() ? last : options.now

  const start = roundUp(searchFrom)
  const startMs = start.getTime()
  const startLocal = localParts(start, timezone)

  let date = { year: startLocal.year, month: startLocal.month, day: startLocal.day }

  for (let dayOffset = 0; dayOffset <= HORIZON_DAYS; dayOffset++, date = nextDay(date)) {
    // Midday rather than midnight: on a spring-forward day midnight may not
    // exist locally, and all this instant is used for is naming the day.
    const noon = fromLocal(timezone, date, 12, 0)
    const dayLocal = localParts(noon, timezone)
    if (days && !days.includes(dayLocal.weekday)) continue

    const onThisDay = taken.filter((at) => sameLocalDay(localParts(at, timezone), dayLocal))
    if (maxPerDay !== undefined && onThisDay.length >= maxPerDay) continue

    // Open at the window, or wherever "now" already is if the day is underway.
    let minute = from
    if (sameLocalDay(startLocal, dayLocal)) minute = Math.max(from, startLocal.hour * 60 + startLocal.minute)

    // The gap is a distance from what is booked, not a grid to land on: when a
    // candidate clashes, jump to exactly `gap` past the booking that blocked it
    // rather than stepping. Each jump strictly increases the candidate, so the
    // loop advances; `probes` is a backstop against a zone doing something
    // unforeseen, not an expected limit.
    for (let probes = 0; minute <= to && probes < 64; probes++) {
      const candidate = fromLocal(timezone, date, Math.floor(minute / 60), minute % 60)

      // A spring-forward hour can push a candidate past the window's end, or
      // onto the next day entirely. Either way this day is exhausted.
      const local = localParts(candidate, timezone)
      if (!sameLocalDay(local, dayLocal) || local.hour * 60 + local.minute > to) break

      const clash = taken.find((at) => Math.abs(at.getTime() - candidate.getTime()) < gap * MINUTE)
      if (clash) {
        const cleared = roundUp(new Date(clash.getTime() + gap * MINUTE))
        const clearedLocal = localParts(cleared, timezone)
        if (!sameLocalDay(clearedLocal, dayLocal)) break
        minute = clearedLocal.hour * 60 + clearedLocal.minute
        continue
      }

      const reason = taken.length
        ? `${gap} minutes clear of everything else booked here`
        : cadence.window
          ? `first slot in this outlet's ${window.from}–${window.to} window`
          : 'the next round five minutes — this outlet declares no posting window'

      return { at: candidate, reason: `${describe(candidate, timezone)} · ${reason}` }
    }
  }

  /**
   * Nothing fits. Hand back a time that is at least defensible — clear of
   * everything already booked — rather than the first candidate we happened to
   * try, which by definition clashed. The reason says plainly that the cadence
   * could not be honoured, and the human picks or sends now.
   */
  const clear = last ? new Date(last.getTime() + gap * MINUTE) : start
  const fallback = new Date(Math.max(clear.getTime(), startMs))
  return {
    at: fallback,
    reason: `${describe(fallback, timezone)} · no slot fits this outlet's cadence within ${HORIZON_DAYS} days — pick a time, or send now`,
  }
}
