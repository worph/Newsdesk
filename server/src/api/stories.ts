import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import {
  approvePublication,
  closedReason,
  dropStory,
  load,
  mergeContext,
  proposalFor,
  slotsOf,
  type EnqueuePublish,
} from '../pipeline/approval.js'
import { queueStats } from '../pipeline/queue.js'
import { previewPayload } from '../render/payload.js'
import { getTimezone } from '../settings.js'

/**
 * Stories, the spiked view and one story in full are one endpoint with filters —
 * they are the same rows asked different questions, and a story moves between
 * them by changing status rather than moving table.
 */

const dropBody = z.object({ reason: z.string().max(500).optional() })

const listQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
})

const placementBody = z.object({
  outlet_id: z.string().min(1),
  reason: z.string().min(1).optional(),
})

/**
 * One time for every placement, when the editor overrules the proposals. Absent
 * — the normal case — means each destination keeps the slot the desk worked out
 * for it, which is the whole point of proposing per placement.
 */
const approveAllBody = z.object({
  scheduled_for: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), 'not a date')
    .transform((value) => new Date(value))
    .optional(),
})

/** The one status at which a draft is standing at the gate, waiting to be let through. */
const AT_THE_GATE = 'AWAITING_APPROVAL'

/**
 * Rows whose time is no longer an open question: committed to the queue, out,
 * or spiked. Everything else — proposed, being written, waiting at the gate, or
 * failed — still gets a proposal, because the story screen is exactly where you
 * read a placement the writer has not finished yet.
 */
const DECIDED: ReadonlySet<string> = new Set([
  'APPROVED',
  'SCHEDULED',
  'AWAITING_SEND',
  'NEEDS_AUTH',
  'PUBLISHED',
  'REJECTED',
])

export interface StoryRow {
  id: string
  title: string
  summary: string
  url: string | null
  status: string
  dedupVerdict: string
  dedupReason: string | null
  relatedStoryId: string | null
  relatedTitle: string | null
  /** 'managing-editor' | 'desk' — a story the wire produced, or one you wrote. */
  origin: string
  label: string | null
  dropReason: string | null
  holdReason: string | null
  createdAt: string
  sourceCount: number
  placements: Array<{
    id: string
    outletId: string
    outletName: string | null
    status: string
    origin: string
    placementReason: string | null
    angle: string | null
  }>
}

function placementsFor(db: Db, storyIds: string[]): Map<string, StoryRow['placements']> {
  const byStory = new Map<string, StoryRow['placements']>()
  if (storyIds.length === 0) return byStory

  const rows = db
    .select({
      id: schema.publications.id,
      storyId: schema.publications.storyId,
      outletId: schema.publications.outletId,
      outletName: schema.outlets.name,
      status: schema.publications.status,
      origin: schema.publications.origin,
      placementReason: schema.publications.placementReason,
      angle: schema.publications.angle,
    })
    .from(schema.publications)
    .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))
    .where(inArray(schema.publications.storyId, storyIds))
    .all()

  for (const row of rows) {
    const list = byStory.get(row.storyId) ?? []
    list.push({
      id: row.id,
      outletId: row.outletId,
      outletName: row.outletName,
      status: row.status,
      origin: row.origin,
      placementReason: row.placementReason,
      angle: row.angle,
    })
    byStory.set(row.storyId, list)
  }
  return byStory
}

/**
 * What the desk can say about one placement without opening it: when it
 * proposes to send, and whether there would be anything to send.
 *
 * This is what turns the story screen into a place you can decide from. The
 * proposal is the same arithmetic the review screen offers — the outlet's
 * posting window, its spacing, what it already owes the calendar, and the
 * urgency the managing editor set — computed now and never stored, because a
 * time written down at placement would be measured against a calendar that has
 * since filled up.
 *
 * `ready` is deliberately the whole gate condition rather than a status check:
 * a draft with a blank required slot is refused by `approvePublication` at 422,
 * and a button that offers a decision the desk will refuse is worse than one
 * that says why it is off.
 */
export interface PlacementDecision {
  scheduledFor: string | null
  urgency: string | null
  /** The slot the desk proposes. Null once the time is settled. */
  schedule: { at: string; reason: string } | null
  /** Approving right now would go through, with no review needed. */
  ready: boolean
  /** The slots still blank — why `ready` is false, in the outlet's own words. */
  missing: string[]
}

function decide(db: Db, publicationId: string, now = new Date()): PlacementDecision {
  const loaded = load(db, publicationId)
  // The outlet was taken out of the configuration under a live placement. There
  // is nothing to propose and nothing to approve, and saying so is better than
  // a row that is missing half its fields.
  if (!loaded) {
    return { scheduledFor: null, urgency: null, schedule: null, ready: false, missing: [] }
  }

  const { status } = loaded.publication
  const { missing } = previewPayload(loaded.args, mergeContext(loaded, slotsOf(loaded.publication)))

  return {
    scheduledFor: loaded.publication.scheduledFor,
    urgency: loaded.publication.urgency,
    schedule: DECIDED.has(status) ? null : proposalFor(db, loaded, now),
    ready: status === AT_THE_GATE && missing.length === 0 && loaded.outlet.enabled,
    missing,
  }
}

/** Why a placement cannot be waved through, said the way the screen says it. */
function whyNotAtTheGate(status: string): string {
  if (status === 'PROPOSED' || status === 'DRAFTING') {
    return 'the writer has not finished this one yet'
  }
  return closedReason(status) ?? `this is ${status.toLowerCase()}`
}

function sourceCounts(db: Db, storyIds: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (storyIds.length === 0) return counts
  for (const row of db
    .select()
    .from(schema.storyFilings)
    .where(inArray(schema.storyFilings.storyId, storyIds))
    .all()) {
    counts.set(row.storyId, (counts.get(row.storyId) ?? 0) + 1)
  }
  return counts
}

function relatedTitles(db: Db, ids: string[]): Map<string, string> {
  const titles = new Map<string, string>()
  const wanted = ids.filter(Boolean)
  if (wanted.length === 0) return titles
  for (const row of db.select().from(schema.stories).where(inArray(schema.stories.id, wanted)).all()) {
    titles.set(row.id, row.title)
  }
  return titles
}

export interface StoryRouteHooks {
  enqueueManagingEditor?: (filingId: string) => void
  enqueueWriter?: (publicationId: string) => void
  /** Needed by approve-all: without it a placement approves but never sends. */
  enqueuePublish?: EnqueuePublish
}

export function registerStoryRoutes(
  app: FastifyInstance,
  db: Db,
  hooks: StoryRouteHooks = {},
): void {
  const { enqueueManagingEditor, enqueueWriter, enqueuePublish } = hooks

  app.get('/api/v1/stories', { preHandler: requireSession }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })

    const filters: SQL[] = []
    if (parsed.data.status) {
      const wanted = parsed.data.status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      if (wanted.length > 0) filters.push(inArray(schema.stories.status, wanted))
    }
    if (parsed.data.q) {
      const needle = `%${parsed.data.q}%`
      const match = or(like(schema.stories.title, needle), like(schema.stories.summary, needle))
      if (match) filters.push(match)
    }

    const base = db.select().from(schema.stories)
    const rows = (filters.length ? base.where(and(...filters)) : base)
      .orderBy(desc(schema.stories.createdAt))
      .limit(parsed.data.limit ?? 100)
      .all()

    const ids = rows.map((r) => r.id)
    const placements = placementsFor(db, ids)
    const counts = sourceCounts(db, ids)
    const titles = relatedTitles(db, rows.map((r) => r.relatedStoryId).filter((v): v is string => Boolean(v)))

    const stories: StoryRow[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      url: row.url,
      status: row.status,
      dedupVerdict: row.dedupVerdict,
      dedupReason: row.dedupReason,
      relatedStoryId: row.relatedStoryId,
      relatedTitle: row.relatedStoryId ? (titles.get(row.relatedStoryId) ?? null) : null,
      origin: row.origin,
      label: row.label,
      dropReason: row.dropReason,
      holdReason: row.holdReason,
      createdAt: row.createdAt,
      sourceCount: counts.get(row.id) ?? 0,
      placements: placements.get(row.id) ?? [],
    }))

    return { stories }
  })

  app.get('/api/v1/stories/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const story = db.select().from(schema.stories).where(eq(schema.stories.id, id)).get()
    if (!story) return reply.code(404).send({ error: 'no such story' })

    const links = db
      .select()
      .from(schema.storyFilings)
      .where(eq(schema.storyFilings.storyId, id))
      .all()

    const filings =
      links.length > 0
        ? db
            .select({
              id: schema.filings.id,
              stringerId: schema.filings.stringerId,
              stringerName: schema.stringers.name,
              kind: schema.filings.kind,
              receivedAt: schema.filings.receivedAt,
              considered: schema.filings.considered,
            })
            .from(schema.filings)
            .leftJoin(schema.stringers, eq(schema.filings.stringerId, schema.stringers.id))
            .where(inArray(schema.filings.id, links.map((l) => l.filingId)))
            .all()
        : []

    const related = story.relatedStoryId
      ? (db.select().from(schema.stories).where(eq(schema.stories.id, story.relatedStoryId)).get() ?? null)
      : null

    /**
     * One clock for every proposal on the screen. Computed per placement but
     * from a single `now`, so two destinations proposed in the same breath are
     * spaced against the same moment rather than against each other's latency.
     */
    const now = new Date()

    return {
      story: {
        ...story,
        comparedIds: story.comparedIds ? JSON.parse(story.comparedIds) : [],
        proposedPlacements: story.proposedPlacements ? JSON.parse(story.proposedPlacements) : [],
      },
      filings,
      placements: (placementsFor(db, [id]).get(id) ?? []).map((placement) => ({
        ...placement,
        ...decide(db, placement.id, now),
      })),
      related: related ? { id: related.id, title: related.title, summary: related.summary } : null,
      // So a proposed time reads the same here as it does on the calendar.
      timezone: getTimezone(db),
    }
  })

  /**
   * Add a placement the managing editor did not propose. `origin: 'human'` is what makes
   * the override diff readable later — a placement you added must never look like
   * one the managing editor suggested.
   */
  app.post('/api/v1/stories/:id/placements', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = placementBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'outlet_id required' })

    const story = db.select().from(schema.stories).where(eq(schema.stories.id, id)).get()
    if (!story) return reply.code(404).send({ error: 'no such story' })

    const outlet = db.select().from(schema.outlets).where(eq(schema.outlets.id, parsed.data.outlet_id)).get()
    if (!outlet) return reply.code(422).send({ error: `unknown outlet "${parsed.data.outlet_id}"` })

    const existing = db
      .select()
      .from(schema.publications)
      .where(
        and(eq(schema.publications.storyId, id), eq(schema.publications.outletId, parsed.data.outlet_id)),
      )
      .get()
    if (existing) return reply.code(409).send({ error: 'this story already has a placement to that destination' })

    const publicationId = randomUUID()
    db.insert(schema.publications)
      .values({
        id: publicationId,
        storyId: id,
        outletId: parsed.data.outlet_id,
        status: 'PROPOSED',
        origin: 'human',
        placementReason: parsed.data.reason ?? 'added by the editor',
        angle: null,
        slots: null,
        payload: null,
      })
      .run()

    // A story spiked for having no placements is no longer spiked once you add one.
    if (story.status === 'DROPPED' && story.dedupVerdict !== 'DUPLICATE') {
      db.update(schema.stories)
        .set({ status: 'PLACED', dropReason: null, holdReason: null })
        .where(eq(schema.stories.id, id))
        .run()
    }

    // A placement you added still needs something written for it, exactly like one
    // the managing editor proposed — otherwise it sits at PROPOSED with no draft and
    // no way to reach the gate.
    enqueueWriter?.(publicationId)

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'ROUTE_ADDED',
      storyId: id,
      publicationId,
      message: `you added a placement on ${outlet.name}`,
      detail: { outletId: outlet.id },
    })

    return reply.code(201).send({ id: publicationId, drafting: Boolean(enqueueWriter) })
  })

  /**
   * Let every draft on this story through the gate at once.
   *
   * The times are the ones the story screen showed: each destination keeps its
   * own proposal rather than sharing one instant, because the whole reason a
   * proposal exists is that an outlet's posting window and spacing are its own.
   * They are recomputed here rather than taken from the browser — a time that
   * arrived from a screen open since this morning would be measured against a
   * calendar that has since filled up — and one at a time, so the second
   * destination is spaced against what the first just committed to.
   *
   * Nothing about the gate is weakened: this calls `approvePublication` once per
   * placement, so each freezes its own payload and each is refused on its own
   * terms. A refusal skips that destination and the rest still go — a bulk
   * decision that stopped at the first blank draft would be useless on the one
   * screen where blank drafts are normal.
   */
  app.post('/api/v1/stories/:id/placements/approve', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = approveAllBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'scheduled_for must be a date, or absent to use each proposal' })
    }

    const story = db.select().from(schema.stories).where(eq(schema.stories.id, id)).get()
    if (!story) return reply.code(404).send({ error: 'no such story' })

    const rows = db
      .select({
        id: schema.publications.id,
        outletId: schema.publications.outletId,
        outletName: schema.outlets.name,
        status: schema.publications.status,
      })
      .from(schema.publications)
      .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))
      .where(eq(schema.publications.storyId, id))
      .orderBy(asc(schema.publications.outletId))
      .all()

    const approved: Array<{ id: string; outlet: string; scheduledFor: string | null }> = []
    const skipped: Array<{ id: string; outlet: string; reason: string }> = []

    for (const row of rows) {
      const outlet = row.outletName ?? row.outletId
      if (row.status !== AT_THE_GATE) {
        skipped.push({ id: row.id, outlet, reason: whyNotAtTheGate(row.status) })
        continue
      }

      const loaded = load(db, row.id)
      if (!loaded) {
        skipped.push({ id: row.id, outlet, reason: `${outlet} is no longer a destination this desk has` })
        continue
      }

      const at = parsed.data.scheduled_for ?? new Date(proposalFor(db, loaded).at)
      const result = approvePublication(db, row.id, {
        scheduledFor: at,
        ...(enqueuePublish ? { enqueuePublish } : {}),
      })

      if (result.ok) approved.push({ id: row.id, outlet, scheduledFor: result.scheduledFor })
      else skipped.push({ id: row.id, outlet, reason: result.error })
    }

    // Each approval logs itself. This says they were one decision, which is the
    // part the ledger cannot reconstruct from the rows afterwards.
    if (approved.length > 1) {
      logEvent(db, {
        level: 'info',
        actor: 'human',
        code: 'PLACEMENTS_APPROVED',
        storyId: id,
        message: `you approved ${approved.length} placements at once`,
        detail: { approved, skipped },
      })
    }

    return { approved, skipped }
  })

  /** Re-run the managing editor over the filings that produced this story. */
  /**
   * The other answer to a held story.
   *
   * `rerun` below says "go and look again"; this says the question is not worth
   * answering. Both close a row that would otherwise sit in the actions list
   * forever, which is the point — a desk whose backlog only grows stops being
   * a list of what needs you.
   */
  app.post('/api/v1/stories/:id/drop', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = dropBody.safeParse(request.body ?? {})
    const result = dropStory(db, id, parsed.success ? parsed.data.reason : undefined)
    if (!result.ok) {
      const { status, ok: _ok, ...body } = result
      return reply.code(status).send(body)
    }
    return { status: result.status }
  })

  app.post('/api/v1/stories/:id/rerun', { preHandler: requireSession }, async (request, reply) => {
    if (!enqueueManagingEditor) {
      return reply.code(503).send({ error: 'no managing editor is wired on this instance' })
    }

    const { id } = request.params as { id: string }
    const links = db
      .select()
      .from(schema.storyFilings)
      .where(eq(schema.storyFilings.storyId, id))
      .all()

    if (links.length === 0) return reply.code(404).send({ error: 'no filings behind this story' })

    for (const link of links) {
      db.update(schema.filings)
        .set({ status: 'PROCESSING', outcome: 're-queued by the editor' })
        .where(eq(schema.filings.id, link.filingId))
        .run()
      enqueueManagingEditor(link.filingId)
    }

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'STORY_RERUN',
      storyId: id,
      message: `editor re-queued ${links.length} filing(s)`,
    })

    return reply.code(202).send({ queued: links.length })
  })

  app.get('/api/v1/jobs', { preHandler: requireSession }, async () => {
    const recent = db
      .select()
      .from(schema.jobs)
      .orderBy(desc(schema.jobs.createdAt))
      .limit(50)
      .all()
    return { stats: queueStats(db), jobs: recent }
  })
}
