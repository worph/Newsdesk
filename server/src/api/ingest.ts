import { and, desc, eq, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hasSession, requireIngestToken, requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { listEvents } from '../events.js'
import {
  receiveSubmissions,
  submissionsBodySchema,
  type SubmissionInput,
} from '../ports/ingest/receive.js'

const ideaBodySchema = z.object({
  text: z.string().min(1),
  url: z.string().optional(),
  source_id: z.string().optional(),
})

const listQuerySchema = z.object({
  status: z.string().optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

function resolveIdeaSource(db: Db, requested?: string): { id: string } | { error: string } {
  if (requested) {
    const found = db.select().from(schema.sources).where(eq(schema.sources.id, requested)).get()
    return found ? { id: found.id } : { error: `unknown source "${requested}"` }
  }
  const ideaSources = db.select().from(schema.sources).where(eq(schema.sources.kind, 'idea')).all()
  if (ideaSources.length === 0) {
    return { error: 'no source of kind "idea" is configured — add one in Configuration' }
  }
  if (ideaSources.length > 1) {
    return { error: 'several idea sources are configured — name one with source_id' }
  }
  return { id: ideaSources[0]!.id }
}

export function registerIngestRoutes(app: FastifyInstance, db: Db): void {
  // ── filing ────────────────────────────────────────────────────────────────

  app.post('/api/v1/submissions', { preHandler: requireIngestToken(db) }, async (request, reply) => {
    const parsed = submissionsBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid submission', issues: parsed.error.issues })
    }

    const inputs: SubmissionInput[] = Array.isArray(parsed.data) ? parsed.data : [parsed.data]
    const results = receiveSubmissions(db, inputs)

    // An unknown source is the filer's mistake and worth a non-2xx, but only
    // when nothing at all landed — a mixed batch should not lose its good rows.
    const accepted = results.filter((r) => r.status !== 'REJECTED')
    if (accepted.length === 0) {
      return reply.code(422).send({ results })
    }
    return reply.code(201).send({ results })
  })

  /**
   * The idea box. Accepts a session (the in-app form and the Android share
   * target) or the ingest token (a bookmarklet, a script).
   */
  app.post('/api/v1/ideas', async (request, reply) => {
    if (!hasSession(request)) {
      const guard = requireIngestToken(db)
      await guard(request, reply)
      if (reply.sent) return reply
    }

    const parsed = ideaBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'text required' })

    const source = resolveIdeaSource(db, parsed.data.source_id)
    if ('error' in source) return reply.code(422).send({ error: source.error })

    const text = parsed.data.url ? `${parsed.data.text}\n\n${parsed.data.url}` : parsed.data.text
    const [result] = receiveSubmissions(db, [
      {
        source_id: source.id,
        kind: 'idea',
        text,
        ...(parsed.data.url ? { refs: { url: parsed.data.url } } : {}),
      },
    ])
    return reply.code(201).send({ result })
  })

  // ── reading ───────────────────────────────────────────────────────────────

  app.get('/api/v1/submissions', { preHandler: requireSession }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })

    const filters: SQL[] = []
    if (parsed.data.status) filters.push(eq(schema.submissions.status, parsed.data.status))
    if (parsed.data.source) filters.push(eq(schema.submissions.sourceId, parsed.data.source))

    const base = db
      .select({
        id: schema.submissions.id,
        sourceId: schema.submissions.sourceId,
        sourceName: schema.sources.name,
        kind: schema.submissions.kind,
        status: schema.submissions.status,
        outcome: schema.submissions.outcome,
        filedAt: schema.submissions.filedAt,
        receivedAt: schema.submissions.receivedAt,
        textLength: schema.submissions.text,
        considered: schema.submissions.considered,
      })
      .from(schema.submissions)
      .leftJoin(schema.sources, eq(schema.submissions.sourceId, schema.sources.id))

    const rows = (filters.length ? base.where(and(...filters)) : base)
      .orderBy(desc(schema.submissions.receivedAt))
      .limit(parsed.data.limit ?? 100)
      .all()

    return {
      submissions: rows.map((row) => ({
        ...row,
        textLength: row.textLength?.length ?? 0,
        consideredChars: row.considered?.length ?? 0,
        considered: undefined,
      })),
    }
  })

  app.get('/api/v1/submissions/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.select().from(schema.submissions).where(eq(schema.submissions.id, id)).get()
    if (!row) return reply.code(404).send({ error: 'not found' })

    const source = db.select().from(schema.sources).where(eq(schema.sources.id, row.sourceId)).get()
    return {
      submission: {
        ...row,
        refs: row.refs ? JSON.parse(row.refs) : null,
        sourceName: source?.name ?? row.sourceId,
      },
    }
  })

  app.get('/api/v1/events', { preHandler: requireSession }, async (request) => {
    const query = request.query as { level?: string; since?: string; limit?: string }
    return {
      events: listEvents(db, {
        ...(query.level ? { level: query.level as 'debug' | 'info' | 'warn' | 'error' } : {}),
        ...(query.since ? { since: query.since } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      }).map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })),
    }
  })
}
