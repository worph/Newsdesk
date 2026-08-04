import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/index.js'
import { schema } from '../../../db/index.js'
import { logEvent } from '../../../events.js'
import { Deferred, enqueue } from '../../../pipeline/queue.js'
import { notifyNeedsAuth, notifyPublished } from '../../../push.js'
import { REMINDERS_MS } from './handover.js'
import { BrowserBusy } from './lease.js'
import { commitAndVerify, SignedOut, stage } from './session.js'

/**
 * Publishing with nobody watching.
 *
 * The desk composes the page, proves the bytes are the ones that were approved,
 * presses the destination's own button and then goes and looks for the result.
 * No operator is involved at any point, which is the whole ask: a destination
 * that saves as you type, or one the desk is trusted to send to, should not
 * stop and request a confirmation that confirms nothing.
 *
 * Everything dangerous about that is handled in one of three places:
 *
 *   the compare   in `stage`, and the commit click only runs after it passes
 *   the freshness check below, so an unwatched send cannot fire stale
 *   the mode      in configuration, where `requires_human` can forbid this
 *                 outright for a destination whose terms need a person
 *
 * See docs/browser-publishing.md §4.1 and §4.5.
 */

type Publication = typeof schema.publications.$inferSelect
type Outlet = typeof schema.outlets.$inferSelect

/**
 * How stale is too stale, by the managing editor's read on how long it can wait.
 *
 * This is the only place expiry still lives. A hand-over row cannot go out
 * without a person looking at it, and a person can see the date — so evicting
 * one would only ever throw away work somebody was about to do. An `auto` row
 * has nobody to notice, which is exactly what a deadline is for.
 */
const FRESHNESS_MS: Record<string, number> = {
  breaking: 2 * 60 * 60_000,
  normal: 12 * 60 * 60_000,
}

/** Evergreen, or an urgency nobody set: age is not what makes it wrong. */
function freshnessWindow(urgency: string | null): number {
  return FRESHNESS_MS[urgency ?? ''] ?? Number.POSITIVE_INFINITY
}

/**
 * How long to wait out a browser somebody else is using.
 *
 * `Deferred` rather than a retry: waiting for a lane is not a failure and must
 * not spend an attempt against the ceiling, or a busy morning would park
 * publications `FAILED` for no reason but timing.
 */
const DEFER_MS = 5 * 60_000

/**
 * Long enough that a genuinely stuck lease stops being confused for a busy one.
 * Past this the row wants a person, not another wake-up.
 */
const DEFER_GIVE_UP_MS = 60 * 60_000

export async function publishAutonomously(
  db: Db,
  publication: Publication,
  outlet: Outlet,
  now = Date.now(),
): Promise<void> {
  const due = Date.parse(publication.scheduledFor ?? publication.approvedAt ?? '')
  const age = Number.isFinite(due) ? now - due : 0
  const window = freshnessWindow(publication.urgency)

  if (age > window) {
    /**
     * Not spiked, and not re-written: the payload is untouched and still
     * approved. What it has lost is its *slot*, and the judgement it wants back
     * — is this still news? — is one only a person can make.
     */
    db.update(schema.publications)
      .set({ status: 'EXPIRED', scheduledFor: null })
      .where(eq(schema.publications.id, publication.id))
      .run()

    logEvent(db, {
      level: 'warn',
      code: 'SEND_EXPIRED',
      storyId: publication.storyId,
      publicationId: publication.id,
      message: `this was due to go out on ${outlet.name} ${Math.round(age / 3_600_000)} hours ago — too stale to send unwatched, so it wants a fresh decision`,
      detail: {
        outletId: outlet.id,
        urgency: publication.urgency,
        waitedHours: Math.round(age / 3_600_000),
        allowedHours: Math.round(window / 3_600_000),
      },
    })
    return
  }

  try {
    await stage(db, publication.id)
  } catch (err) {
    /**
     * The browser is busy. Nothing has happened to the destination and nothing
     * is wrong — an operator is holding the lane, or another publish is mid
     * flight. Wait, without burning an attempt.
     */
    if (err instanceof BrowserBusy) {
      if (age > DEFER_GIVE_UP_MS) {
        db.update(schema.publications)
          .set({ status: 'FAILED', error: `the browser has been busy since this was due (${err.message})` })
          .where(eq(schema.publications.id, publication.id))
          .run()

        logEvent(db, {
          level: 'error',
          code: 'PUBLISH_FAILED',
          storyId: publication.storyId,
          publicationId: publication.id,
          message: `could not get the browser to publish this on ${outlet.name} — it has been in use the whole time`,
          detail: {
            outletId: outlet.id,
            heldBy: err.held.label,
            since: err.held.takenAt,
            error: err.message,
          },
        })
        return
      }
      throw new Deferred(`the browser is publishing ${err.held.label}`, DEFER_MS)
    }

    /**
     * Signed out. `stage` has already put the row in `NEEDS_AUTH` — rethrowing
     * would park the job `FAILED` on top of a state that is working exactly as
     * designed, so this returns cleanly and asks a person instead.
     */
    if (err instanceof SignedOut) {
      const story = db
        .select({ title: schema.stories.title })
        .from(schema.stories)
        .where(eq(schema.stories.id, publication.storyId))
        .get()

      await notifyNeedsAuth(db, publication.id, outlet.name, story?.title ?? 'A story is ready')
      enqueue(db, 'handover-followup', publication.id, new Date(now + REMINDERS_MS[0]))
      return
    }

    throw err
  }

  const result = await commitAndVerify(db, publication.id)

  const story = db
    .select({ title: schema.stories.title })
    .from(schema.stories)
    .where(eq(schema.stories.id, publication.storyId))
    .get()

  /**
   * Notified *after*, which is the one thing that separates this from every
   * other notification the desk sends. There was no decision to ask for; what
   * the operator wants is the fact and the link.
   */
  await notifyPublished(db, publication.id, outlet.name, story?.title ?? 'A story', result.externalUrl)
}
