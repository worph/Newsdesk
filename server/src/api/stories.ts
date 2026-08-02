import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import { queueStats } from '../pipeline/queue.js'

/**
 * Queue, Stories and the spiked view are one endpoint with filters — they are
 * the same rows asked different questions, and a story moves between them by
 * changing status rather than moving table.
 */

const listQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
})

const placementBody = z.object({
  outlet_id: z.string().min(1),
  reason: z.string().min(1).optional(),
})

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

export function registerStoryRoutes(
  app: FastifyInstance,
  db: Db,
  enqueueManagingEditor?: (filingId: string) => void,
  enqueueWriter?: (publicationId: string) => void,
): void {
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

    return {
      story: {
        ...story,
        comparedIds: story.comparedIds ? JSON.parse(story.comparedIds) : [],
        proposedPlacements: story.proposedPlacements ? JSON.parse(story.proposedPlacements) : [],
      },
      filings,
      placements: placementsFor(db, [id]).get(id) ?? [],
      related: related ? { id: related.id, title: related.title, summary: related.summary } : null,
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
      message: `editor added a placement to ${parsed.data.outlet_id}`,
    })

    return reply.code(201).send({ id: publicationId, drafting: Boolean(enqueueWriter) })
  })

  /** Re-run the managing editor over the filings that produced this story. */
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
