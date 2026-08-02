import { randomUUID } from 'node:crypto'
// Aliased: `slotsOf` imported from the approval module answers a different
// question — the values a publication holds, not the slots its outlet declares.
import { slotsOf as declaredSlots, type ArgsSpec } from '@newsdesk/shared'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import {
  approvePublication,
  closedReason,
  load,
  mergeContext,
  proposalFor,
  reschedulePublication,
  slotsOf,
  withdrawPublication,
  type Outcome,
} from '../pipeline/approval.js'
import { listChat, runCopyDesk } from '../pipeline/copy-desk.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { previewPayload } from '../render/payload.js'
import { authoringKeys } from '../schema/slots.js'
import { getTimezone } from '../settings.js'

/**
 * The desk's HTTP surface for one publication: read it, edit it, and hand the
 * three decisions that commit it to the wire — approve, withdraw, reschedule —
 * to `pipeline/approval.ts`, which owns them. Nothing here reimplements the
 * freeze; this file maps editorial outcomes onto status codes.
 */

const slotsBody = z.object({ slots: z.record(z.string(), z.string()) })
const rejectBody = z.object({ reason: z.string().min(1).optional() })
const revertBody = z.object({ version_id: z.string().min(1) })

/**
 * A send time, if one is wanted. Omitted means "now", which is what approval
 * always meant — so nothing about the immediate path changes.
 */
const scheduleAt = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a date')
  .transform((value) => new Date(value))

const approveBody = z.object({ scheduled_for: scheduleAt.optional() })
const scheduleBody = z.object({ scheduled_for: scheduleAt })

/** Send a decision's outcome: its own status code on a refusal, `okCode` otherwise. */
function settle<T>(reply: FastifyReply, result: Outcome<T>, okCode = 200) {
  if (!result.ok) {
    const { status, ok: _ok, ...body } = result
    return reply.code(status).send(body)
  }
  const { ok: _ok, ...body } = result
  return reply.code(okCode).send(body)
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
 * Has anything been written for this destination yet?
 *
 * A manual placement is created with no slots at all, so every sibling strip
 * has to be able to say which targets are still blank — that is the whole
 * navigation for writing a piece target by target.
 */
function isWritten(slots: string | null): boolean {
  if (!slots) return false
  try {
    return Object.values(JSON.parse(slots) as Record<string, string>).some(
      (value) => typeof value === 'string' && value.trim() !== '',
    )
  } catch {
    return false
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
    // approving one destination does not ship the others. `written` is what
    // turns the strip into the tab bar for a piece being written target by
    // target — a blank destination has to look blank from anywhere.
    const siblings = db
      .select({
        id: schema.publications.id,
        outletId: schema.publications.outletId,
        outletName: schema.outlets.name,
        status: schema.publications.status,
        slots: schema.publications.slots,
      })
      .from(schema.publications)
      .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))
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
      siblings: siblings.map(({ slots: siblingSlots, ...sibling }) => ({
        ...sibling,
        written: isWritten(siblingSlots),
      })),
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

  /** The gate. See `pipeline/approval.ts` — this route only names the outcome. */
  app.post('/api/v1/publications/:id/approve', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = approveBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'scheduled_for must be a date, or absent to send now' })
    }

    return settle(
      reply,
      approvePublication(db, id, {
        ...(parsed.data.scheduled_for ? { scheduledFor: parsed.data.scheduled_for } : {}),
        ...(enqueuePublish ? { enqueuePublish } : {}),
      }),
      202,
    )
  })

  app.post('/api/v1/publications/:id/withdraw', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    return settle(reply, withdrawPublication(db, id))
  })

  app.patch('/api/v1/publications/:id/schedule', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = scheduleBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'scheduled_for must be a date' })

    return settle(
      reply,
      reschedulePublication(db, id, parsed.data.scheduled_for, {
        ...(enqueuePublish ? { enqueuePublish } : {}),
      }),
    )
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
        storyOrigin: schema.stories.origin,
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
