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

const routeBody = z.object({
  target_id: z.string().min(1),
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
  label: string | null
  dropReason: string | null
  createdAt: string
  sourceCount: number
  routes: Array<{
    id: string
    targetId: string
    targetName: string | null
    status: string
    origin: string
    routeReason: string | null
    angle: string | null
  }>
}

function routesFor(db: Db, storyIds: string[]): Map<string, StoryRow['routes']> {
  const byStory = new Map<string, StoryRow['routes']>()
  if (storyIds.length === 0) return byStory

  const rows = db
    .select({
      id: schema.publications.id,
      storyId: schema.publications.storyId,
      targetId: schema.publications.targetId,
      targetName: schema.targets.name,
      status: schema.publications.status,
      origin: schema.publications.origin,
      routeReason: schema.publications.routeReason,
      angle: schema.publications.angle,
    })
    .from(schema.publications)
    .leftJoin(schema.targets, eq(schema.publications.targetId, schema.targets.id))
    .where(inArray(schema.publications.storyId, storyIds))
    .all()

  for (const row of rows) {
    const list = byStory.get(row.storyId) ?? []
    list.push({
      id: row.id,
      targetId: row.targetId,
      targetName: row.targetName,
      status: row.status,
      origin: row.origin,
      routeReason: row.routeReason,
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
    .from(schema.storySubmissions)
    .where(inArray(schema.storySubmissions.storyId, storyIds))
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
  enqueueManagingEditor?: (submissionId: string) => void,
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
    const routes = routesFor(db, ids)
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
      label: row.label,
      dropReason: row.dropReason,
      createdAt: row.createdAt,
      sourceCount: counts.get(row.id) ?? 0,
      routes: routes.get(row.id) ?? [],
    }))

    return { stories }
  })

  app.get('/api/v1/stories/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const story = db.select().from(schema.stories).where(eq(schema.stories.id, id)).get()
    if (!story) return reply.code(404).send({ error: 'no such story' })

    const links = db
      .select()
      .from(schema.storySubmissions)
      .where(eq(schema.storySubmissions.storyId, id))
      .all()

    const submissions =
      links.length > 0
        ? db
            .select({
              id: schema.submissions.id,
              stringerId: schema.submissions.stringerId,
              stringerName: schema.stringers.name,
              kind: schema.submissions.kind,
              receivedAt: schema.submissions.receivedAt,
              considered: schema.submissions.considered,
            })
            .from(schema.submissions)
            .leftJoin(schema.stringers, eq(schema.submissions.stringerId, schema.stringers.id))
            .where(inArray(schema.submissions.id, links.map((l) => l.submissionId)))
            .all()
        : []

    const related = story.relatedStoryId
      ? (db.select().from(schema.stories).where(eq(schema.stories.id, story.relatedStoryId)).get() ?? null)
      : null

    return {
      story: {
        ...story,
        comparedIds: story.comparedIds ? JSON.parse(story.comparedIds) : [],
        proposedRoutes: story.proposedRoutes ? JSON.parse(story.proposedRoutes) : [],
      },
      submissions,
      routes: routesFor(db, [id]).get(id) ?? [],
      related: related ? { id: related.id, title: related.title, summary: related.summary } : null,
    }
  })

  /**
   * Add a route the managing editor did not propose. `origin: 'human'` is what makes
   * the override diff readable later — a route you added must never look like
   * one the managing editor suggested.
   */
  app.post('/api/v1/stories/:id/routes', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = routeBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'target_id required' })

    const story = db.select().from(schema.stories).where(eq(schema.stories.id, id)).get()
    if (!story) return reply.code(404).send({ error: 'no such story' })

    const target = db.select().from(schema.targets).where(eq(schema.targets.id, parsed.data.target_id)).get()
    if (!target) return reply.code(422).send({ error: `unknown target "${parsed.data.target_id}"` })

    const existing = db
      .select()
      .from(schema.publications)
      .where(
        and(eq(schema.publications.storyId, id), eq(schema.publications.targetId, parsed.data.target_id)),
      )
      .get()
    if (existing) return reply.code(409).send({ error: 'this story already has a route to that destination' })

    const publicationId = randomUUID()
    db.insert(schema.publications)
      .values({
        id: publicationId,
        storyId: id,
        targetId: parsed.data.target_id,
        status: 'PROPOSED',
        origin: 'human',
        routeReason: parsed.data.reason ?? 'added by the editor',
        angle: null,
        slots: null,
        payload: null,
      })
      .run()

    // A story spiked for having no routes is no longer spiked once you add one.
    if (story.status === 'DROPPED' && story.dedupVerdict !== 'DUPLICATE') {
      db.update(schema.stories)
        .set({ status: 'ROUTED', dropReason: null })
        .where(eq(schema.stories.id, id))
        .run()
    }

    // A route you added still needs something written for it, exactly like one
    // the managing editor proposed — otherwise it sits at PROPOSED with no draft and
    // no way to reach the gate.
    enqueueWriter?.(publicationId)

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'ROUTE_ADDED',
      storyId: id,
      publicationId,
      message: `editor added a route to ${parsed.data.target_id}`,
    })

    return reply.code(201).send({ id: publicationId, drafting: Boolean(enqueueWriter) })
  })

  /** Re-run the managing editor over the submissions that produced this story. */
  app.post('/api/v1/stories/:id/rerun', { preHandler: requireSession }, async (request, reply) => {
    if (!enqueueManagingEditor) {
      return reply.code(503).send({ error: 'no managing editor is wired on this instance' })
    }

    const { id } = request.params as { id: string }
    const links = db
      .select()
      .from(schema.storySubmissions)
      .where(eq(schema.storySubmissions.storyId, id))
      .all()

    if (links.length === 0) return reply.code(404).send({ error: 'no submissions behind this story' })

    for (const link of links) {
      db.update(schema.submissions)
        .set({ status: 'PROCESSING', outcome: 're-queued by the editor' })
        .where(eq(schema.submissions.id, link.submissionId))
        .run()
      enqueueManagingEditor(link.submissionId)
    }

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'STORY_RERUN',
      storyId: id,
      message: `editor re-queued ${links.length} submission(s)`,
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
