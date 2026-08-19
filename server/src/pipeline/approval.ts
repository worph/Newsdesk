import { and, eq, gte, inArray, or } from 'drizzle-orm'
import { type ArgsSpec, type Cadence } from '@newsdesk/shared'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import { mergePayload, PayloadIncomplete } from '../render/payload.js'
import { getTimezone } from '../settings.js'
import { proposeSlot, type Urgency } from './schedule.js'

/**
 * The gate, as domain rather than as routes.
 *
 * Approve is the only path to the wire: it freezes the merged payload onto the
 * row before anything is queued, so what is sent is exactly what was approved
 * and a retry re-sends those bytes rather than rebuilding them. Withdraw and
 * reschedule are the other two decisions that can move a row once it has
 * committed to a time, and they belong beside it — all three must agree about
 * what "closed" means, and about deleting the queued job when they change it.
 *
 * It lives here rather than in `api/publications.ts` so there is exactly one
 * implementation of the freeze for every caller to reach — a second one, added
 * for a second surface, would be the way this design actually breaks. Named for
 * the decision rather than the role: `src/gate.ts` is the SSO trust gate and
 * `ports/delivery` is already the press.
 */

/**
 * A minute of slack absorbs the round trip between the browser rendering a
 * proposal and the human clicking it; without it, approving the slot the desk
 * itself just offered could be rejected as already past.
 */
export const SCHEDULE_SLACK_MS = 60_000

export interface Loaded {
  publication: typeof schema.publications.$inferSelect
  story: typeof schema.stories.$inferSelect
  outlet: typeof schema.outlets.$inferSelect
  args: ArgsSpec
}

export function load(db: Db, id: string): Loaded | undefined {
  const publication = db.select().from(schema.publications).where(eq(schema.publications.id, id)).get()
  if (!publication) return undefined
  const story = db.select().from(schema.stories).where(eq(schema.stories.id, publication.storyId)).get()
  const outlet = db.select().from(schema.outlets).where(eq(schema.outlets.id, publication.outletId)).get()
  if (!story || !outlet) return undefined
  return { publication, story, outlet, args: JSON.parse(outlet.argsSpec) as ArgsSpec }
}

export function slotsOf(publication: typeof schema.publications.$inferSelect): Record<string, string> {
  return publication.slots ? (JSON.parse(publication.slots) as Record<string, string>) : {}
}

export function mergeContext(loaded: Loaded, slots: Record<string, string>) {
  return {
    story: {
      id: loaded.story.id,
      title: loaded.story.title,
      summary: loaded.story.summary,
      url: loaded.story.url,
    },
    slots,
  }
}

/**
 * A publication is open for work only until approval hands it to the wire.
 *
 * APPROVED is not a resting state — the payload is already frozen and a send is
 * already queued — so it has to close the desk just as firmly as PUBLISHED
 * does. Guarding only on PUBLISHED leaves a window the width of one queue poll
 * in which an edit shows copy that will never be sent and a second approve
 * re-freezes bytes that are already in flight.
 *
 * FAILED reopens on purpose: the way to fix a bad send is to edit and approve
 * again, while `retry` re-sends the frozen bytes untouched.
 *
 * SCHEDULED closes for the same reason APPROVED does, and it matters more here:
 * the payload was frozen hours before it will be sent, so an edit that appeared
 * to take would be the widest possible gap between what the screen shows and
 * what goes out. `withdraw` is the way back — it clears the frozen bytes, which
 * is what genuinely reopens the desk.
 *
 * AWAITING_SEND is the same case again, one step further along: a browser
 * outlet's slot has come and the bytes are waiting for an operator to open the
 * page and press the destination's own button. The payload is frozen and may
 * already be typed into a live composer, so editing here would be editing
 * something that is halfway out the door.
 */
export function closedReason(status: string): string | undefined {
  switch (status) {
    case 'AWAITING_APPROVAL':
    case 'FAILED':
      return undefined
    case 'APPROVED':
      return 'this is approved and queued to send'
    case 'SCHEDULED':
      return 'this is scheduled to send — withdraw it first if you need to change it'
    case 'AWAITING_SEND':
      return 'this is staged and waiting to be sent — withdraw it first if you need to change it'
    case 'NEEDS_AUTH':
      return 'the browser is signed out of this destination — sign it back in, or withdraw this'
    case 'PUBLISHED':
      return 'this has already been published'
    case 'REJECTED':
      return 'this was spiked'
    case 'EXPIRED':
      // Reopenable, unlike everything else down here: the copy is untouched and
      // still approved. What it lost was its slot.
      return 'this went too stale to send unwatched — withdraw it to edit, or give it a new time'
    case 'ABANDONED_DRAFT':
      return 'a draft of this was left unfinished at the destination — only a person can resolve that'
    default:
      return `this is ${status.toLowerCase()}`
  }
}

/**
 * What this outlet already owes the calendar: everything committed but not yet
 * sent, plus what it sent recently. Both matter — spacing is about how often
 * an audience hears from you, and a post two hours ago counts exactly as much
 * as one two hours from now.
 *
 * A week back is enough for any sane gap and keeps the scan bounded.
 */
export function bookedFor(db: Db, outletId: string, now: Date): Date[] {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString()
  const rows = db
    .select({
      scheduledFor: schema.publications.scheduledFor,
      publishedAt: schema.publications.publishedAt,
    })
    .from(schema.publications)
    .where(
      and(
        eq(schema.publications.outletId, outletId),
        or(
          gte(schema.publications.scheduledFor, since),
          gte(schema.publications.publishedAt, since),
        ),
      ),
    )
    .all()

  return rows
    .flatMap((row) => [row.scheduledFor, row.publishedAt])
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
}

/**
 * The slot the desk offers at review. Computed per request and never stored:
 * `scheduled_for` means a commitment, and a proposal measured against a
 * calendar that has since filled up would be worse than no proposal at all.
 */
export function proposalFor(db: Db, loaded: Loaded, now = new Date()): { at: string; reason: string } {
  const cadence = loaded.outlet.cadence ? (JSON.parse(loaded.outlet.cadence) as Cadence) : null
  const slot = proposeSlot({
    now,
    cadence,
    urgency: (loaded.publication.urgency as Urgency | null) ?? 'normal',
    taken: bookedFor(db, loaded.outlet.id, now).filter(
      // Its own committed time is not a conflict with itself.
      (at) => at.toISOString() !== loaded.publication.scheduledFor,
    ),
    timezone: getTimezone(db),
  })
  return { at: slot.at.toISOString(), reason: slot.reason }
}

/**
 * The handle a `db.transaction` callback is given. Both callers below cancel a
 * send and rewrite the row together, and those two must never come apart.
 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Drop the queued work for a publication that has not been claimed yet.
 *
 * Both kinds, because a browser hand-over leaves a reminder job behind as well
 * as the send: a withdrawn publication that kept nagging an operator to go and
 * publish it would be the desk arguing with itself.
 */
function cancelPendingSend(tx: Tx, publicationId: string): void {
  tx.delete(schema.jobs)
    .where(
      and(
        inArray(schema.jobs.kind, ['publish', 'handover-followup']),
        eq(schema.jobs.refId, publicationId),
        eq(schema.jobs.status, 'PENDING'),
      ),
    )
    .run()
}

/**
 * What a decision came to. Refusals carry the status code they deserve because
 * every one of them is a fact about editorial state — "already on its way",
 * "the outlet is switched off" — and flattening them to a boolean at this layer
 * would only have the route guess it back.
 */
export type Refusal = { ok: false; status: number; error: string; missing?: string[] }
export type Outcome<T> = ({ ok: true } & T) | Refusal

export type EnqueuePublish = (publicationId: string, runAfter?: Date) => void

export interface ApproveResult {
  status: 'APPROVED' | 'SCHEDULED'
  payload: Record<string, unknown>
  queued: boolean
  scheduledFor: string | null
}

/**
 * The gate. Freezes the merged payload and queues the send. Nothing else in the
 * system may move a publication to PUBLISHED.
 *
 * `scheduledFor` defers the send without weakening any of that: the payload is
 * frozen here exactly as it always was, and only the moment the queue hands it
 * to the wire moves. Omitting it sends immediately, which is what approval
 * always meant.
 */
export function approvePublication(
  db: Db,
  id: string,
  options: { scheduledFor?: Date; enqueuePublish?: EnqueuePublish; now?: () => number } = {},
): Outcome<ApproveResult> {
  const { scheduledFor, enqueuePublish } = options
  const now = options.now ?? Date.now

  const loaded = load(db, id)
  if (!loaded) return { ok: false, status: 404, error: 'no such publication' }

  // Approving twice is the one that bites: it re-freezes the payload and queues
  // a second send against a publication already on its way out.
  if (loaded.publication.status === 'APPROVED') {
    return { ok: false, status: 409, error: 'this is already approved and queued to send' }
  }
  if (loaded.publication.status === 'SCHEDULED') {
    return {
      ok: false,
      status: 409,
      error: 'this is already scheduled — move the time instead, or withdraw it',
    }
  }
  if (loaded.publication.status === 'AWAITING_SEND' || loaded.publication.status === 'NEEDS_AUTH') {
    return {
      ok: false,
      status: 409,
      error: 'this is already waiting to be published by hand — withdraw it instead',
    }
  }
  if (loaded.publication.status === 'PUBLISHED') {
    return { ok: false, status: 409, error: 'this has already been published' }
  }
  if (loaded.publication.status === 'REJECTED') {
    return { ok: false, status: 409, error: 'this was spiked — reopen it before approving' }
  }
  if (!loaded.outlet.enabled) {
    return { ok: false, status: 422, error: `outlet "${loaded.outlet.id}" is disabled` }
  }
  if (scheduledFor && scheduledFor.getTime() < now() - SCHEDULE_SLACK_MS) {
    return {
      ok: false,
      status: 422,
      error: 'that time has passed — pick a later one, or approve with no time to send now',
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = mergePayload(loaded.args, mergeContext(loaded, slotsOf(loaded.publication)))
  } catch (err) {
    if (err instanceof PayloadIncomplete) {
      return { ok: false, status: 422, error: err.message, missing: err.missing }
    }
    throw err
  }

  const status = scheduledFor ? 'SCHEDULED' : 'APPROVED'

  db.update(schema.publications)
    .set({
      status,
      // Frozen here and sent verbatim. This is what makes publish idempotent
      // and retry safe, and it is why no inference runs after this point —
      // including across the hours a scheduled send waits.
      payload: JSON.stringify(payload),
      approvedAt: new Date().toISOString(),
      scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
      error: null,
    })
    .where(eq(schema.publications.id, id))
    .run()

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'APPROVED',
    storyId: loaded.publication.storyId,
    publicationId: id,
    message: scheduledFor
      ? `approved for ${loaded.outlet.name}, sending ${scheduledFor.toISOString()}`
      : `approved for ${loaded.outlet.name}`,
    detail: { payload, scheduledFor: scheduledFor?.toISOString() ?? null },
  })

  if (enqueuePublish) enqueuePublish(id, scheduledFor)

  return {
    ok: true,
    status,
    payload,
    queued: Boolean(enqueuePublish),
    scheduledFor: scheduledFor?.toISOString() ?? null,
  }
}

/**
 * Pull a scheduled send back before it fires.
 *
 * Clearing the frozen payload is the substance of this: it is what reopens the
 * desk, because `closedReason` and the delivery guard both key off a row that
 * has one. Deleting the queued job is the other half — and the two must agree,
 * so they happen in one transaction.
 *
 * The guarantee is honest but bounded: a job the worker has already claimed
 * cannot be recalled. `deliverPublication` re-reads the row and stops quietly
 * if it finds it withdrawn, which shrinks the window to the width of one send,
 * but does not close it. In practice withdrawing before the scheduled minute
 * always works; withdrawing during it may not.
 *
 * AWAITING_SEND withdraws for the same reasons, and it is also how a browser
 * hand-over that nobody acted on expires: the operator never opened it, the
 * news has moved on, and the desk would rather ask for a new slot than fire
 * stale copy tomorrow morning. Nothing external has happened yet either way —
 * the destination's own button was never pressed.
 */
export function withdrawPublication(db: Db, id: string): Outcome<{ status: 'AWAITING_APPROVAL' }> {
  const loaded = load(db, id)
  if (!loaded) return { ok: false, status: 404, error: 'no such publication' }

  const withdrawable = ['SCHEDULED', 'AWAITING_SEND', 'NEEDS_AUTH', 'EXPIRED']
  if (!withdrawable.includes(loaded.publication.status)) {
    return {
      ok: false,
      status: 409,
      error:
        loaded.publication.status === 'APPROVED'
          ? 'this was approved to send immediately — it is already on its way'
          : `only a scheduled or staged publication can be withdrawn — this is ${loaded.publication.status.toLowerCase()}`,
    }
  }

  /**
   * A draft exists at the destination, so "nothing external has happened" — the
   * sentence this whole function is built on — is simply false.
   *
   * Resetting the row here would leave a real page at a real destination with
   * nothing in the desk pointing at it, and the desk cannot tidy that up itself:
   * deleting somebody's draft is not a thing it should ever do. So it refuses,
   * and offers the one honest ending instead. See docs/browser-publishing.md §5.
   */
  if (loaded.publication.draftUrl) {
    return {
      ok: false,
      status: 409,
      error: `this is already filed on ${loaded.outlet.name} — withdrawing it here would leave that draft there with nothing pointing at it. Finish it, or mark the draft abandoned.`,
    }
  }

  const staged = loaded.publication.status !== 'SCHEDULED'

  db.transaction((tx) => {
    cancelPendingSend(tx, id)
    tx.update(schema.publications)
      .set({
        status: 'AWAITING_APPROVAL',
        payload: null,
        approvedAt: null,
        scheduledFor: null,
        // A row that goes back to the desk must not look like it is still
        // sitting in a browser waiting for someone.
        stagedAt: null,
        error: null,
      })
      .where(eq(schema.publications.id, id))
      .run()
  })

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'WITHDRAWN',
    storyId: loaded.publication.storyId,
    publicationId: id,
    message: staged
      ? `withdrawn from ${loaded.outlet.name} before anyone sent it`
      : `withdrawn from the schedule for ${loaded.outlet.name} — it was due ${loaded.publication.scheduledFor}`,
  })

  return { ok: true, status: 'AWAITING_APPROVAL' }
}

/**
 * Give up on a draft that was filed and never finished.
 *
 * The one ending a `detached` row has that is neither published nor withdrawn.
 * Something real exists at the destination; the desk will not delete it and
 * cannot pretend it is not there, so the row becomes a permanent note saying
 * exactly that, with the link still on it. Only a person can resolve what is at
 * the other end, and this is the desk saying so rather than tidying the evidence
 * away. See docs/browser-publishing.md §5.
 */
export function abandonDraft(db: Db, id: string, reason?: string): Outcome<{ status: 'ABANDONED_DRAFT' }> {
  const loaded = load(db, id)
  if (!loaded) return { ok: false, status: 404, error: 'no such publication' }

  const draftUrl = loaded.publication.draftUrl
  if (!draftUrl) {
    return {
      ok: false,
      status: 409,
      error: 'nothing was filed for this — withdraw it instead, which leaves nothing behind',
    }
  }
  if (loaded.publication.status === 'PUBLISHED') {
    return { ok: false, status: 409, error: 'this already went out' }
  }

  db.transaction((tx) => {
    cancelPendingSend(tx, id)
    tx.update(schema.publications)
      .set({ status: 'ABANDONED_DRAFT', error: null })
      .where(eq(schema.publications.id, id))
      .run()
  })

  logEvent(db, {
    level: 'warn',
    actor: 'human',
    code: 'DRAFT_ABANDONED',
    storyId: loaded.publication.storyId,
    publicationId: id,
    message: `left unfinished on ${loaded.outlet.name} — the draft is still there`,
    detail: { outletId: loaded.outlet.id, draftUrl, ...(reason ? { reason } : {}) },
  })

  return { ok: true, status: 'ABANDONED_DRAFT' }
}

/**
 * How many rows one bulk decision may touch.
 *
 * A ceiling rather than a page: a sweep is a thing a person confirmed by
 * reading a count, and a count that quietly meant "the first two hundred of
 * six thousand" would be the wrong number to have agreed to. The tools report
 * what they left behind so the next call can take it.
 */
export const SWEEP_MAX = 200

/**
 * The publications a bulk decision may touch.
 *
 * Selection lives here, beside the decisions, so a caller cannot assemble a set
 * the decision would then refuse one row at a time — and so "everything waiting"
 * means the same statuses to the chat as `closedReason` means to the route.
 *
 * Ordered by the story's date, which is `listActions`' order too (`actions.ts:201`)
 * — a publication row carries no date of its own. That matters: the operator
 * confirms a sweep having read that list, so a sweep that took a different
 * hundred than the hundred they were shown would be the wrong hundred.
 */
export function openPublications(
  db: Db,
  statuses: readonly string[],
  options: { ids?: string[]; outletId?: string; limit?: number } = {},
): { id: string; status: string; storyId: string; outletId: string }[] {
  const { ids, outletId, limit } = options
  return db
    .select({
      id: schema.publications.id,
      status: schema.publications.status,
      storyId: schema.publications.storyId,
      outletId: schema.publications.outletId,
    })
    .from(schema.publications)
    .leftJoin(schema.stories, eq(schema.publications.storyId, schema.stories.id))
    .where(
      and(
        inArray(schema.publications.status, [...statuses]),
        ...(ids ? [inArray(schema.publications.id, ids)] : []),
        ...(outletId ? [eq(schema.publications.outletId, outletId)] : []),
      ),
    )
    .orderBy(schema.stories.createdAt, schema.publications.id)
    .limit(Math.min(limit ?? SWEEP_MAX, SWEEP_MAX))
    .all()
}

/** What `rejectPublication` will accept — the two statuses `closedReason` lets through. */
export const SPIKEABLE = ['AWAITING_APPROVAL', 'FAILED'] as const

/**
 * What `approvePublication` will accept.
 *
 * Narrower than `SPIKEABLE` on purpose: a FAILED row has already been approved
 * once and its frozen payload is still on it, so the way to send it again is
 * `retry`, which re-sends those bytes. Approving it here would re-merge from
 * configuration that may have moved — the one thing invariant 2 exists to stop.
 */
export const APPROVABLE = ['AWAITING_APPROVAL'] as const

/**
 * The current status of rows a caller named, for the half of a sweep that will
 * not happen.
 *
 * A sweep selects by status, so an id the operator named that has since moved
 * is simply not in the set — and saying nothing about it would be the worst
 * failure this design has. They confirmed three and got two; which one, and
 * why, is the whole answer.
 */
export function publicationStatus(db: Db, id: string): string | undefined {
  return db
    .select({ status: schema.publications.status })
    .from(schema.publications)
    .where(eq(schema.publications.id, id))
    .get()?.status
}

/** As above, for stories. */
export function storyStatus(db: Db, id: string): string | undefined {
  return db
    .select({ status: schema.stories.status })
    .from(schema.stories)
    .where(eq(schema.stories.id, id))
    .get()?.status
}

/** Held stories, for the drop sweep. Oldest question first. */
export function heldStories(
  db: Db,
  options: { ids?: string[]; limit?: number } = {},
): { id: string; title: string; holdReason: string | null }[] {
  const { ids, limit } = options
  return db
    .select({
      id: schema.stories.id,
      title: schema.stories.title,
      holdReason: schema.stories.holdReason,
    })
    .from(schema.stories)
    .where(and(eq(schema.stories.status, 'HELD'), ...(ids ? [inArray(schema.stories.id, ids)] : [])))
    .orderBy(schema.stories.createdAt, schema.stories.id)
    .limit(Math.min(limit ?? SWEEP_MAX, SWEEP_MAX))
    .all()
}

/**
 * The gate's other answer: this one is not running.
 *
 * Lifted out of `api/publications.ts` when the administrator chat gained the
 * power to spike in bulk, for the reason at the top of this file — a second
 * implementation, added for a second surface, is how this design actually
 * breaks. `closedReason` is the whole of the guard: a row that has committed to
 * a time may already be halfway out the door, and an abort the desk cannot
 * honour is worse than a refusal.
 */
export function rejectPublication(db: Db, id: string, reason?: string): Outcome<{ status: 'REJECTED' }> {
  const loaded = load(db, id)
  if (!loaded) return { ok: false, status: 404, error: 'no such publication' }

  const closed = closedReason(loaded.publication.status)
  if (closed) return { ok: false, status: 409, error: closed }

  // A switched-off proposal leaves a REJECTED row rather than disappearing:
  // that row is half of the override diff.
  db.update(schema.publications)
    .set({ status: 'REJECTED', error: reason ?? null })
    .where(eq(schema.publications.id, id))
    .run()

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'ROUTE_REJECTED',
    storyId: loaded.publication.storyId,
    publicationId: id,
    message: `spiked for ${loaded.outlet.name}${reason ? `: ${reason}` : ''}`,
  })

  return { ok: true, status: 'REJECTED' }
}

/**
 * Drop a story the desk asked a question about and nobody answered.
 *
 * `DROPPED` is not a new state — the managing editor already spikes into it for
 * a duplicate and for a story that placed nowhere (`managing-editor.ts:200`),
 * and the spiked view already reads it. What is new is a *person* putting a
 * story there, which is why the event is editorial rather than pipeline: the
 * desk did not run out of destinations, someone decided.
 *
 * Only a HELD story can be dropped this way. A PLACED one has publications
 * under it that are the real decision — spiking those is `rejectPublication`,
 * one destination at a time, and a story-level drop that silently closed them
 * would be a send cancelled by a screen that never named it.
 */
export function dropStory(db: Db, id: string, reason?: string): Outcome<{ status: 'DROPPED' }> {
  const story = db.select().from(schema.stories).where(eq(schema.stories.id, id)).get()
  if (!story) return { ok: false, status: 404, error: 'no such story' }
  if (story.status === 'DROPPED') return { ok: false, status: 409, error: 'this was already dropped' }
  if (story.status !== 'HELD') {
    return {
      ok: false,
      status: 409,
      error: `only a held story can be dropped — this one is ${story.status.toLowerCase()}`,
    }
  }

  db.update(schema.stories)
    .set({
      status: 'DROPPED',
      // The question it was held on is why it was dropped, so it survives the
      // drop: `holdReason` stays, and this records the answer nobody gave.
      dropReason: reason ?? 'dropped unanswered at the desk',
    })
    .where(eq(schema.stories.id, id))
    .run()

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'STORY_DROPPED',
    storyId: id,
    message: `dropped unanswered${reason ? `: ${reason}` : ''}`,
    ...(story.holdReason ? { detail: { heldOn: story.holdReason } } : {}),
  })

  return { ok: true, status: 'DROPPED' }
}

/**
 * Move a scheduled send. The payload is deliberately untouched: this changes
 * when the approved bytes go out, never what they are, so it needs no
 * re-approval and cannot become a way to edit past the gate.
 */
export function reschedulePublication(
  db: Db,
  id: string,
  scheduledFor: Date,
  options: { enqueuePublish?: EnqueuePublish; now?: () => number } = {},
): Outcome<{ status: 'SCHEDULED'; scheduledFor: string }> {
  const now = options.now ?? Date.now

  const loaded = load(db, id)
  if (!loaded) return { ok: false, status: 404, error: 'no such publication' }
  if (loaded.publication.status !== 'SCHEDULED') {
    return {
      ok: false,
      status: 409,
      error: `only a scheduled publication can be moved — this is ${loaded.publication.status.toLowerCase()}`,
    }
  }
  if (scheduledFor.getTime() < now() - SCHEDULE_SLACK_MS) {
    return { ok: false, status: 422, error: 'that time has passed — pick a later one' }
  }
  if (!options.enqueuePublish) {
    return { ok: false, status: 503, error: 'no publisher is wired on this instance' }
  }

  db.transaction((tx) => {
    cancelPendingSend(tx, id)
    tx.update(schema.publications)
      .set({ scheduledFor: scheduledFor.toISOString() })
      .where(eq(schema.publications.id, id))
      .run()
  })
  options.enqueuePublish(id, scheduledFor)

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'RESCHEDULED',
    storyId: loaded.publication.storyId,
    publicationId: id,
    message: `moved from ${loaded.publication.scheduledFor} to ${scheduledFor.toISOString()}`,
  })

  return { ok: true, status: 'SCHEDULED', scheduledFor: scheduledFor.toISOString() }
}
