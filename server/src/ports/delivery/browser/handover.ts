import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/index.js'
import { schema } from '../../../db/index.js'
import { logEvent } from '../../../events.js'
import { withdrawPublication } from '../../../pipeline/approval.js'
import { enqueue } from '../../../pipeline/queue.js'
import { notifyHandoverDue, notifyNeedsAuth } from '../../../push.js'
import { probeSignedIn } from './session.js'

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

/** Since the slot came. The last entry is when the desk stops waiting. */
export const REMINDERS_MS = [30 * 60_000, 2 * 60 * 60_000] as const
export const EXPIRE_AFTER_MS = 12 * 60 * 60_000

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
  return elapsedMs < EXPIRE_AFTER_MS ? EXPIRE_AFTER_MS : null
}

export async function offerHandover(
  db: Db,
  publication: Publication,
  outlet: Outlet,
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

  logEvent(db, {
    level: 'info',
    code: 'HANDOVER_DUE',
    storyId: publication.storyId,
    publicationId: publication.id,
    message: `waiting for someone to publish this on ${outlet.name}`,
    detail: {
      outletId: outlet.id,
      scheduledFor: publication.scheduledFor,
      expiresAt: new Date(offeredAt(publication) + EXPIRE_AFTER_MS).toISOString(),
    },
  })

  await notifyHandoverDue(db, publication.id, outlet.name, title)

  enqueue(db, 'handover-followup', publication.id, new Date(now + REMINDERS_MS[0]))
}

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
    // wants a sign-in. Neither resolves itself, and both give the slot up.
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

    if (elapsed >= EXPIRE_AFTER_MS) {
      const result = withdrawPublication(db, publicationId)
      logEvent(db, {
        level: 'warn',
        code: 'SEND_EXPIRED',
        storyId: publication.storyId,
        publicationId,
        message: result.ok
          ? `nobody published this on ${outlet?.name ?? publication.outletId} — the slot was given up`
          : `this expired on ${outlet?.name ?? publication.outletId} but could not be withdrawn`,
        detail: {
          outletId: publication.outletId,
          waitedHours: Math.round(elapsed / 3_600_000),
          ...(result.ok ? {} : { error: result.error }),
        },
      })
      return
    }

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
