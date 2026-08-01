/**
 * Times, for a screen that has to talk about the future.
 *
 * `when()` in StoryCard answers "how long ago", which is the only question the
 * rest of the desk asks. A schedule asks the opposite one, and it also has to
 * round-trip a value through an `<input type="datetime-local">`, which speaks
 * neither ISO nor UTC.
 *
 * Everything crossing the wire stays ISO-8601 UTC. These functions exist to
 * keep that true while showing a human their own clock.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO instant to the `YYYY-MM-DDTHH:MM` an input wants, in the browser's zone. */
export function toLocalInput(iso: string): string {
  const at = new Date(iso)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * Back again. A datetime-local value carries no zone, so the platform reads it
 * as the browser's local time — which is exactly what the person typing it
 * meant.
 */
export function fromLocalInput(value: string): string {
  return new Date(value).toISOString()
}

/** "Sat 1 Aug, 13:30", in a named zone or the browser's. */
export function stamp(iso: string, timezone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    ...(timezone ? { timeZone: timezone } : {}),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

/** How long until something happens. Past times read as "now" rather than negative. */
export function until(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins}m`
  if (mins < 60 * 24) return `in ${Math.round(mins / 60)}h`
  return `in ${Math.round(mins / (60 * 24))}d`
}

/** The zone the browser is in, for deciding whether to mention the desk's. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
