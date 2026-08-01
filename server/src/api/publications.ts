import { randomUUID } from 'node:crypto'
// Aliased: `slotsOf` below is this module's own, and answers a different
// question — the values a publication holds, not the slots its outlet declares.
import { slotsOf as declaredSlots, type ArgsSpec, type Cadence } from '@newsdesk/shared'
import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import { listChat, runCopyDesk } from '../pipeline/copy-desk.js'
import { proposeSlot, type Urgency } from '../pipeline/schedule.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { mergePayload, PayloadIncomplete, previewPayload } from '../render/payload.js'
import { authoringKeys } from '../schema/slots.js'
import { getTimezone } from '../settings.js'

/**
 * The gate. `approve` is the only path to the wire, and it freezes the merged
 * payload onto the row before anything is queued — so what is sent is exactly
 * what was approved, and a retry re-sends those bytes rather than rebuilding
 * them.
 */

const slotsBody = z.object({ slots: z.record(z.string(), z.string()) })
const rejectBody = z.object({ reason: z.string().min(1).optional() })
const revertBody = z.object({ version_id: z.string().min(1) })

/**
 * A send time, if one is wanted. Omitted means "now", which is what approval
 * always meant — so nothing about the immediate path changes.
 *
 * A minute of slack absorbs the round trip between the browser rendering a
 * proposal and the human clicking it; without it, approving the slot the desk
 * itself just offered could be rejected as already past.
 */
const SCHEDULE_SLACK_MS = 60_000

const scheduleAt = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a date')
  .transform((value) => new Date(value))

const approveBody = z.object({ scheduled_for: scheduleAt.optional() })
const scheduleBody = z.object({ scheduled_for: scheduleAt })

interface Loaded {
  publication: typeof schema.publications.$inferSelect
  story: typeof schema.stories.$inferSelect
  outlet: typeof schema.outlets.$inferSelect
  args: ArgsSpec
}

function load(db: Db, id: string): Loaded | undefined {
  const publication = db.select().from(schema.publications).where(eq(schema.publications.id, id)).get()
  if (!publication) return undefined
  const story = db.select().from(schema.stories).where(eq(schema.stories.id, publication.storyId)).get()
  const outlet = db.select().from(schema.outlets).where(eq(schema.outlets.id, publication.outletId)).get()
  if (!story || !outlet) return undefined
  return { publication, story, outlet, args: JSON.parse(outlet.argsSpec) as ArgsSpec }
}

function slotsOf(publication: typeof schema.publications.$inferSelect): Record<string, string> {
  return publication.slots ? (JSON.parse(publication.slots) as Record<string, string>) : {}
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
 */
function closedReason(status: string): string | undefined {
  switch (status) {
    case 'AWAITING_APPROVAL':
    case 'FAILED':
      return undefined
    case 'APPROVED':
      return 'this is approved and queued to send'
    case 'SCHEDULED':
      return 'this is scheduled to send — withdraw it first if you need to change it'
    case 'PUBLISHED':
      return 'this has already been published'
    case 'REJECTED':
      return 'this was spiked'
    default:
      return `this is ${status.toLowerCase()}`
  }
}

/** Enough of the draft to recognise it in a list without opening it. */
const PREVIEW_CHARS = 240

/**
 * The opening of what was actually written, for a list row.
 *
 * The primary slot is the piece of writing; everything else is furniture the
 * outlet needs. Falling back to the first authored slot rather than to nothing
 * keeps outlets whose spec declares no primary from showing an empty row.
 */
function draftPreview(slots: string | null, argsSpec: string | null): string | null {
  if (!slots) return null
  let parsed: Record<string, string>
  let args: ArgsSpec
  try {
    parsed = JSON.parse(slots) as Record<string, string>
    args = JSON.parse(argsSpec ?? '{}') as ArgsSpec
  } catch {
    return null
  }

  const slotDefs = declaredSlots(args)
  const primary = slotDefs.find(({ def }) => def.primary)?.key
  const text =
    (primary ? parsed[primary] : undefined) ?? slotDefs.map(({ key }) => parsed[key]).find(Boolean)
  if (!text) return null

  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat
}

/**
 * What this outlet already owes the calendar: everything committed but not yet
 * sent, plus what it sent recently. Both matter — spacing is about how often
 * an audience hears from you, and a post two hours ago counts exactly as much
 * as one two hours from now.
 *
 * A week back is enough for any sane gap and keeps the scan bounded.
 */
function bookedFor(db: Db, outletId: string, now: Date): Date[] {
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
function proposalFor(db: Db, loaded: Loaded, now = new Date()): { at: string; reason: string } {
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

/** Drop the queued send for a publication that has not been claimed yet. */
function cancelPendingSend(tx: Tx, publicationId: string): void {
  tx.delete(schema.jobs)
    .where(
      and(
        eq(schema.jobs.kind, 'publish'),
        eq(schema.jobs.refId, publicationId),
        eq(schema.jobs.status, 'PENDING'),
      ),
    )
    .run()
}

function mergeContext(loaded: Loaded, slots: Record<string, string>) {
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

export function registerPublicationRoutes(
  app: FastifyInstance,
  db: Db,
  enqueuePublish?: (publicationId: string, runAfter?: Date) => void,
  driver?: () => InferenceDriver,
): void {
  app.get('/api/v1/publications/:id/chat', { preHandler: requireSession }, async (request) => {
    const { id } = request.params as { id: string }
    return { messages: listChat(db, id) }
  })

  /**
   * One turn with the copy desk. It returns a reply and the whole updated
   * draft, which replaces the slots wholesale — a partial patch would silently
   * drop whatever it left out.
   */
  app.post('/api/v1/publications/:id/chat', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ message: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'message required' })
    if (!driver) return reply.code(503).send({ error: 'no inference is wired on this instance' })

    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    const closed = closedReason(loaded.publication.status)
    if (closed) return reply.code(409).send({ error: closed })

    try {
      const result = await runCopyDesk(db, driver(), id, parsed.data.message)
      return result
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/v1/publications/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })

    const slots = slotsOf(loaded.publication)
    const preview = previewPayload(loaded.args, mergeContext(loaded, slots))

    // Sibling routes: the review surface must make it unmistakable that
    // approving one destination does not ship the others.
    const siblings = db
      .select({
        id: schema.publications.id,
        outletId: schema.publications.outletId,
        status: schema.publications.status,
      })
      .from(schema.publications)
      .where(eq(schema.publications.storyId, loaded.publication.storyId))
      .all()

    return {
      publication: { ...loaded.publication, slots },
      story: loaded.story,
      outlet: {
        id: loaded.outlet.id,
        name: loaded.outlet.name,
        description: loaded.outlet.description,
        role: loaded.outlet.role,
        driver: loaded.outlet.driver,
        tool: loaded.outlet.tool,
      },
      // Only the authoring slots are reviewable; literals and derived values
      // appear in the payload preview instead.
      slotSpec: Object.fromEntries(
        authoringKeys(loaded.args).map((key) => [key, loaded.args[key]]),
      ),
      preview,
      siblings,
      // A suggestion, computed now and never stored — the human commits it by
      // approving. Pointless once the row has settled, so it is not computed.
      scheduleProposal: closedReason(loaded.publication.status) ? null : proposalFor(db, loaded),
      timezone: getTimezone(db),
    }
  })

  app.get('/api/v1/publications/:id/versions', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const versions = db
      .select()
      .from(schema.draftVersions)
      .where(eq(schema.draftVersions.publicationId, id))
      // Insertion order: several versions can share a millisecond, and a
      // random-UUID tiebreaker would shuffle the history.
      .orderBy(sql`rowid desc`)
      .all()
    return reply.send({ versions: versions.map((v) => ({ ...v, slots: JSON.parse(v.slots) })) })
  })

  app.get('/api/v1/publications/:id/payload', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })

    // Once frozen, show the frozen bytes — not a fresh merge that might differ.
    if (loaded.publication.payload) {
      return { payload: JSON.parse(loaded.publication.payload), frozen: true }
    }
    const preview = previewPayload(loaded.args, mergeContext(loaded, slotsOf(loaded.publication)))
    return { ...preview, frozen: false }
  })

  /** Save edited slots. Every save is a version, so nothing is ever lost. */
  app.patch('/api/v1/publications/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = slotsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'slots required' })

    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    const closed = closedReason(loaded.publication.status)
    if (closed) return reply.code(409).send({ error: closed })

    // Only declared slots may be written: a key outside the spec would be an
    // argument configuration never offered.
    const allowed = new Set(authoringKeys(loaded.args))
    const unknown = Object.keys(parsed.data.slots).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      return reply.code(422).send({ error: `not authoring slots: ${unknown.join(', ')}` })
    }

    const slots = { ...slotsOf(loaded.publication), ...parsed.data.slots }
    const versionId = randomUUID()

    db.transaction((tx) => {
      tx.insert(schema.draftVersions)
        .values({ id: versionId, publicationId: id, slots: JSON.stringify(slots), origin: 'human' })
        .run()
      tx.update(schema.publications)
        .set({ slots: JSON.stringify(slots) })
        .where(eq(schema.publications.id, id))
        .run()
    })

    return { slots, versionId }
  })

  app.post('/api/v1/publications/:id/revert', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = revertBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'version_id required' })

    // Reverting writes slots, so it closes with the rest of the desk. The
    // review screen already disables the control; this is the same rule at the
    // boundary, where it is actually enforced.
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    const closed = closedReason(loaded.publication.status)
    if (closed) return reply.code(409).send({ error: closed })

    const version = db
      .select()
      .from(schema.draftVersions)
      .where(eq(schema.draftVersions.id, parsed.data.version_id))
      .get()
    if (!version || version.publicationId !== id) {
      return reply.code(404).send({ error: 'no such version for this publication' })
    }

    const versionId = randomUUID()
    db.transaction((tx) => {
      // Reverting appends rather than rewinds: the history stays append-only.
      tx.insert(schema.draftVersions)
        .values({ id: versionId, publicationId: id, slots: version.slots, origin: 'human' })
        .run()
      tx.update(schema.publications)
        .set({ slots: version.slots })
        .where(eq(schema.publications.id, id))
        .run()
    })

    return { slots: JSON.parse(version.slots), versionId }
  })

  /**
   * The gate. Freezes the merged payload and queues the send. Nothing else in
   * the system may move a publication to PUBLISHED.
   *
   * `scheduled_for` defers the send without weakening any of that: the payload
   * is frozen here exactly as it always was, and only the moment the queue
   * hands it to the wire moves. Omitting it keeps the original behaviour
   * byte for byte.
   */
  app.post('/api/v1/publications/:id/approve', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = approveBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'scheduled_for must be a date, or absent to send now' })
    }
    const scheduledFor = parsed.data.scheduled_for

    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })

    // Approving twice is the one that bites: it re-freezes the payload and
    // queues a second send against a publication already on its way out.
    if (loaded.publication.status === 'APPROVED') {
      return reply.code(409).send({ error: 'this is already approved and queued to send' })
    }
    if (loaded.publication.status === 'SCHEDULED') {
      return reply
        .code(409)
        .send({ error: 'this is already scheduled — move the time instead, or withdraw it' })
    }
    if (loaded.publication.status === 'PUBLISHED') {
      return reply.code(409).send({ error: 'this has already been published' })
    }
    if (loaded.publication.status === 'REJECTED') {
      return reply.code(409).send({ error: 'this was spiked — reopen it before approving' })
    }
    if (!loaded.outlet.enabled) {
      return reply.code(422).send({ error: `outlet "${loaded.outlet.id}" is disabled` })
    }
    if (scheduledFor && scheduledFor.getTime() < Date.now() - SCHEDULE_SLACK_MS) {
      return reply
        .code(422)
        .send({ error: 'that time has passed — pick a later one, or approve with no time to send now' })
    }

    let payload: Record<string, unknown>
    try {
      payload = mergePayload(loaded.args, mergeContext(loaded, slotsOf(loaded.publication)))
    } catch (err) {
      if (err instanceof PayloadIncomplete) {
        return reply.code(422).send({ error: err.message, missing: err.missing })
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

    return reply.code(202).send({
      status,
      payload,
      queued: Boolean(enqueuePublish),
      scheduledFor: scheduledFor?.toISOString() ?? null,
    })
  })

  /**
   * Pull a scheduled send back before it fires.
   *
   * Clearing the frozen payload is the substance of this: it is what reopens
   * the desk, because `closedReason` and the delivery guard both key off a row
   * that has one. Deleting the queued job is the other half — and the two must
   * agree, so they happen in one transaction.
   *
   * The guarantee is honest but bounded: a job the worker has already claimed
   * cannot be recalled. `deliverPublication` re-reads the row and stops quietly
   * if it finds it withdrawn, which shrinks the window to the width of one
   * send, but does not close it. In practice withdrawing before the scheduled
   * minute always works; withdrawing during it may not.
   */
  app.post('/api/v1/publications/:id/withdraw', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })

    if (loaded.publication.status !== 'SCHEDULED') {
      return reply.code(409).send({
        error:
          loaded.publication.status === 'APPROVED'
            ? 'this was approved to send immediately — it is already on its way'
            : `only a scheduled publication can be withdrawn — this is ${loaded.publication.status.toLowerCase()}`,
      })
    }

    db.transaction((tx) => {
      cancelPendingSend(tx, id)
      tx.update(schema.publications)
        .set({
          status: 'AWAITING_APPROVAL',
          payload: null,
          approvedAt: null,
          scheduledFor: null,
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
      message: `withdrawn from the schedule for ${loaded.outlet.name} — it was due ${loaded.publication.scheduledFor}`,
    })

    return { status: 'AWAITING_APPROVAL' }
  })

  /**
   * Move a scheduled send. The payload is deliberately untouched: this changes
   * when the approved bytes go out, never what they are, so it needs no
   * re-approval and cannot become a way to edit past the gate.
   */
  app.patch('/api/v1/publications/:id/schedule', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = scheduleBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'scheduled_for must be a date' })
    const scheduledFor = parsed.data.scheduled_for

    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    if (loaded.publication.status !== 'SCHEDULED') {
      return reply
        .code(409)
        .send({ error: `only a scheduled publication can be moved — this is ${loaded.publication.status.toLowerCase()}` })
    }
    if (scheduledFor.getTime() < Date.now() - SCHEDULE_SLACK_MS) {
      return reply.code(422).send({ error: 'that time has passed — pick a later one' })
    }
    if (!enqueuePublish) return reply.code(503).send({ error: 'no publisher is wired on this instance' })

    db.transaction((tx) => {
      cancelPendingSend(tx, id)
      tx.update(schema.publications)
        .set({ scheduledFor: scheduledFor.toISOString() })
        .where(eq(schema.publications.id, id))
        .run()
    })
    enqueuePublish(id, scheduledFor)

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'RESCHEDULED',
      storyId: loaded.publication.storyId,
      publicationId: id,
      message: `moved from ${loaded.publication.scheduledFor} to ${scheduledFor.toISOString()}`,
    })

    return { status: 'SCHEDULED', scheduledFor: scheduledFor.toISOString() }
  })

  app.post('/api/v1/publications/:id/reject', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = rejectBody.safeParse(request.body ?? {})
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    // Spiking an approved publication would be an abort the desk cannot honour
    // — the send may already be in flight — so it closes here too.
    const closed = closedReason(loaded.publication.status)
    if (closed) return reply.code(409).send({ error: closed })

    const reason = parsed.success ? parsed.data.reason : undefined

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

    return { status: 'REJECTED' }
  })

  /** Re-send the frozen payload after a delivery failure. No re-merge. */
  app.post('/api/v1/publications/:id/retry', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    if (!loaded.publication.payload) {
      return reply.code(422).send({ error: 'nothing was ever approved for this destination' })
    }
    if (loaded.publication.status === 'PUBLISHED') {
      return reply.code(409).send({ error: 'this has already been published' })
    }
    if (!enqueuePublish) return reply.code(503).send({ error: 'no publisher is wired on this instance' })

    enqueuePublish(id)
    return reply.code(202).send({ queued: true })
  })

  /**
   * The article half of the queue.
   *
   * Ordered by when the story arrived rather than when it was approved: the
   * rows this list exists for have not been approved, so `approved_at` is null
   * on every one of them and sorts them arbitrarily. Oldest first, like the
   * placement half — a queue is a backlog.
   */
  app.get('/api/v1/publications', { preHandler: requireSession }, async (request) => {
    const query = z
      .object({
        /** One status or several, comma-separated — the queue wants two at once. */
        status: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .safeParse(request.query)

    const wanted = (query.success ? query.data.status : undefined)
      ?.split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)

    const base = db
      .select({
        id: schema.publications.id,
        storyId: schema.publications.storyId,
        storyTitle: schema.stories.title,
        storySummary: schema.stories.summary,
        storyCreatedAt: schema.stories.createdAt,
        outletId: schema.publications.outletId,
        outletName: schema.outlets.name,
        status: schema.publications.status,
        origin: schema.publications.origin,
        placementReason: schema.publications.placementReason,
        approvedAt: schema.publications.approvedAt,
        publishedAt: schema.publications.publishedAt,
        error: schema.publications.error,
        slots: schema.publications.slots,
        argsSpec: schema.outlets.argsSpec,
      })
      .from(schema.publications)
      .leftJoin(schema.stories, eq(schema.publications.storyId, schema.stories.id))
      .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))

    const rows = (wanted && wanted.length > 0 ? base.where(inArray(schema.publications.status, wanted)) : base)
      .orderBy(asc(schema.stories.createdAt))
      .limit(query.success ? (query.data.limit ?? 100) : 100)
      .all()

    // The list is meant to be read without opening anything, so each row
    // carries the opening of the draft itself — the primary slot, which is the
    // piece of writing, not the headline the outlet happens to call `title`.
    return {
      publications: rows.map(({ slots, argsSpec, ...row }) => ({
        ...row,
        preview: draftPreview(slots, argsSpec),
      })),
    }
  })
}
