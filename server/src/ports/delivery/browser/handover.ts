import type { PublishMode } from '@newsdesk/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/index.js'
import { schema } from '../../../db/index.js'
import { logEvent } from '../../../events.js'
import { Deferred, enqueue } from '../../../pipeline/queue.js'
import { notifyDraftFiled, notifyHandoverDue, notifyNeedsAuth } from '../../../push.js'
import { BrowserBusy } from './lease.js'
import { probeSignedIn, recordDraft, SignedOut, stage } from './session.js'

/**
 * A slot has come for an outlet only a person can finish.
 *
 * The desk stops, records that it is owed a publish, and asks. Nothing is
 * staged and no browser is touched — see `session.stage` for why that wait has
 * to be free.
 *
 * What follows is a small, finite conversation: two reminders, then silence,
 * then the slot is given up. A desk that nagged forever would be a desk whose
 * notifications get switched off, and a slot that never expired would fire
 * stale copy into tomorrow morning.
 */

/** Since the slot came. After the last one the desk falls back to a daily nudge. */
export const REMINDERS_MS = [30 * 60_000, 2 * 60 * 60_000] as const

/**
 * After the reminders, once a day.
 *
 * Two nudges and then silence was sized for someone who publishes as the slots
 * come. The desk is used in batches — approve a run in the morning, work through
 * the notifications that evening or the next day — and under that rhythm silence
 * at two hours means a batch approved on Friday is invisible by Monday.
 */
const DAILY_MS = 24 * 60 * 60_000

/**
 * Long enough that a row nobody has touched in a month is being ignored on
 * purpose. Waking daily forever would be the desk nagging into the void.
 */
const STOP_REMINDING_AFTER_MS = 30 * DAILY_MS

type Publication = typeof schema.publications.$inferSelect
type Outlet = typeof schema.outlets.$inferSelect

/**
 * When the desk started waiting.
 *
 * The committed slot, or the approval when there was none — approving with no
 * time means "now", so that is the moment the clock starts either way.
 */
function offeredAt(publication: Pick<Publication, 'scheduledFor' | 'approvedAt'>): number {
  const at = publication.scheduledFor ?? publication.approvedAt
  const parsed = at ? Date.parse(at) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** The next moment worth waking up for, or null when there is none left. */
function nextWake(elapsedMs: number): number | null {
  for (const at of REMINDERS_MS) if (elapsedMs < at) return at
  if (elapsedMs >= STOP_REMINDING_AFTER_MS) return null
  // Round up to the next daily tick rather than "a day from now", so the
  // schedule stays a pure function of how long the row has been waiting and a
  // job that ran late does not drift the whole chain.
  return (Math.floor(elapsedMs / DAILY_MS) + 1) * DAILY_MS
}

export async function offerHandover(
  db: Db,
  publication: Publication,
  outlet: Outlet,
  mode: Exclude<PublishMode, 'auto'> = 'tethered',
  now = Date.now(),
): Promise<void> {
  const story = db
    .select({ title: schema.stories.title })
    .from(schema.stories)
    .where(eq(schema.stories.id, publication.storyId))
    .get()
  const title = story?.title ?? 'A story is ready'

  db.update(schema.publications)
    .set({ status: 'AWAITING_SEND', stagedAt: null, error: null })
    .where(eq(schema.publications.id, publication.id))
    .run()

  /**
   * Ask the browser whether it can still get in, before asking a person to go
   * and publish something. Finding out at the moment they tap the notification
   * would make the desk look broken at exactly the wrong time, and an expired
   * session is a thing only a human can fix.
   *
   * Best effort: a browser that is down is not an authentication problem, and
   * the hand-over stands either way. The stage attempt will report it properly.
   */
  let signedIn = true
  try {
    signedIn = await probeSignedIn(db, publication.id)
  } catch (err) {
    logEvent(db, {
      level: 'warn',
      code: 'SIGNIN_CHECK_FAILED',
      storyId: publication.storyId,
      publicationId: publication.id,
      message: `could not check whether the browser is still signed in to ${outlet.name}`,
      detail: { outletId: outlet.id, error: err instanceof Error ? err.message : String(err) },
    })
  }

  if (!signedIn) {
    db.update(schema.publications)
      .set({ status: 'NEEDS_AUTH' })
      .where(eq(schema.publications.id, publication.id))
      .run()

    logEvent(db, {
      level: 'warn',
      code: 'NEEDS_AUTH',
      storyId: publication.storyId,
      publicationId: publication.id,
      message: `the browser is signed out of ${outlet.name} — someone has to sign it back in`,
      detail: { outletId: outlet.id },
    })

    await notifyNeedsAuth(db, publication.id, outlet.name, title)
    enqueue(db, 'handover-followup', publication.id, new Date(now + REMINDERS_MS[0]))
    return
  }

  /**
   * A `detached` outlet is staged **here**, at the slot, and this is the one
   * place the two hand-over modes genuinely diverge.
   *
   * Tethered waits because staging would hold the single lane from now until
   * whenever the operator arrives. Detached has the opposite property: what it
   * composes is durable at the destination, so once it is filed nothing needs
   * holding at all. Doing it now is what lets the notification carry a link
   * instead of an instruction.
   */
  if (mode === 'detached') {
    await fileDraft(db, publication, outlet, title, now)
    return
  }

  logEvent(db, {
    level: 'info',
    code: 'HANDOVER_DUE',
    storyId: publication.storyId,
    publicationId: publication.id,
    message: `waiting for someone to publish this on ${outlet.name}`,
    detail: { outletId: outlet.id, mode, scheduledFor: publication.scheduledFor },
  })

  await notifyHandoverDue(db, publication.id, outlet.name, title)

  enqueue(db, 'handover-followup', publication.id, new Date(now + REMINDERS_MS[0]))
}

/**
 * Compose the page, record where it landed, and hand back the link.
 *
 * The dangerous part is not the staging, it is doing it twice: this creates
 * something real at the destination, so a second run does not retry anything —
 * it files a duplicate. `stage` refuses outright once `draft_url` is set, and
 * this is the only function that sets it.
 */
async function fileDraft(
  db: Db,
  publication: Publication,
  outlet: Outlet,
  title: string,
  now: number,
): Promise<void> {
  try {
    await stage(db, publication.id)
  } catch (err) {
    if (err instanceof BrowserBusy) throw new Deferred(`the browser is publishing ${err.held.label}`, DEFER_MS)

    /**
     * Signed out, or the recipe broke. `stage` has already set the row's status
     * and written the trace; the one thing worth adding is where the browser was
     * standing when it stopped, because on a destination that autosaves there may
     * now be a half-made page nobody knows about.
     */
    if (err instanceof SignedOut) {
      await notifyNeedsAuth(db, publication.id, outlet.name, title)
      enqueue(db, 'handover-followup', publication.id, new Date(now + REMINDERS_MS[0]))
      return
    }
    throw err
  }

  const draftUrl = await recordDraft(db, publication.id)

  logEvent(db, {
    level: 'info',
    code: 'DRAFT_FILED',
    storyId: publication.storyId,
    publicationId: publication.id,
    message: draftUrl
      ? `filed on ${outlet.name} — it is yours to finish`
      : `filed on ${outlet.name}, but the desk could not read back where it landed`,
    detail: { outletId: outlet.id, draftUrl },
  })

  await notifyDraftFiled(db, publication.id, outlet.name, title)
  enqueue(db, 'handover-followup', publication.id, new Date(now + REMINDERS_MS[0]))
}

/** Matches the autonomous path: waiting for a lane is not a failure. */
const DEFER_MS = 5 * 60_000

/**
 * Remind, then give up.
 *
 * Self-rescheduling rather than a table of pending reminders: the queue already
 * knows how to run something at a time, and the schedule is a pure function of
 * how long the row has been waiting. A job that finds the row moved on is a
 * no-op, which is what makes withdrawing, sending, or spiking it safe from any
 * direction.
 */
export function handoverFollowupHandler(options: { now?: () => number } = {}) {
  const clock = options.now ?? Date.now

  return async (db: Db, publicationId: string): Promise<void> => {
    const publication = db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, publicationId))
      .get()

    // Both states are the desk owed a person: one wants a publish, the other
    // wants a sign-in. Neither resolves itself, so both keep being asked about.
    if (!publication || !['AWAITING_SEND', 'NEEDS_AUTH'].includes(publication.status)) return

    const outlet = db
      .select({ name: schema.outlets.name })
      .from(schema.outlets)
      .where(eq(schema.outlets.id, publication.outletId))
      .get()
    const story = db
      .select({ title: schema.stories.title })
      .from(schema.stories)
      .where(eq(schema.stories.id, publication.storyId))
      .get()

    const now = clock()
    const elapsed = now - offeredAt(publication)

    /**
     * Nothing expires here any more, and the reason is worth stating.
     *
     * Expiry exists to stop something being *sent* once it has gone stale — and
     * a row in this handler cannot be sent without a person looking at it, who
     * can see the date for themselves. Withdrawing it would only ever throw away
     * work somebody was about to do, which is the failure the batch workflow
     * runs into: approve a run in the morning, sit down at nine in the evening,
     * find the desk gave every slot up at nine. Unattended sending is the `auto`
     * path, and that is where the deadline now lives.
     *
     * What replaces it is visible staleness — the row says how long it has been
     * waiting — plus a nag that decays to daily rather than stopping.
     * See docs/browser-publishing.md §4.5.
     */
    const outletName = outlet?.name ?? publication.outletId
    const title = story?.title ?? 'A story is ready'

    if (publication.status === 'NEEDS_AUTH') {
      await notifyNeedsAuth(db, publicationId, outletName, title, { reminder: true })
    } else {
      await notifyHandoverDue(db, publicationId, outletName, title, { reminder: true })
    }

    const next = nextWake(elapsed)
    if (next !== null) {
      enqueue(db, 'handover-followup', publicationId, new Date(offeredAt(publication) + next))
    }
  }
}
