import { and, desc, eq, type SQL } from 'drizzle-orm'
import type { FastifyInstance, RouteHandlerMethod } from 'fastify'
import { z } from 'zod'
import { hasSession, requireIngestToken, requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { listEvents } from '../events.js'
import {
  receiveSubmissions,
  submissionsBodySchema,
  type ReceiveOptions,
  type SubmissionInput,
} from '../ports/ingest/receive.js'

const tipBodySchema = z
  .object({
    text: z.string().min(1),
    url: z.string().optional(),
    stringer_id: z.string().optional(),
    /** Pre-rename spelling, still accepted. */
    source_id: z.string().optional(),
  })
  .transform(({ source_id, ...rest }) => ({ ...rest, stringer_id: rest.stringer_id ?? source_id }))

const listQuerySchema = z.object({
  status: z.string().optional(),
  stringer: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

function resolveTipStringer(db: Db, requested?: string): { id: string } | { error: string } {
  if (requested) {
    const found = db.select().from(schema.stringers).where(eq(schema.stringers.id, requested)).get()
    return found ? { id: found.id } : { error: `unknown stringer "${requested}"` }
  }
  const tipStringers = db.select().from(schema.stringers).where(eq(schema.stringers.kind, 'tip')).all()
  if (tipStringers.length === 0) {
    return { error: 'no stringer of kind "tip" is configured — add one in Configuration' }
  }
  if (tipStringers.length > 1) {
    return { error: 'several tip stringers are configured — name one with stringer_id' }
  }
  return { id: tipStringers[0]!.id }
}

export function registerIngestRoutes(
  app: FastifyInstance,
  db: Db,
  receiveOptions: ReceiveOptions = {},
): void {
  // ── filing ────────────────────────────────────────────────────────────────

  app.post('/api/v1/submissions', { preHandler: requireIngestToken(db) }, async (request, reply) => {
    const parsed = submissionsBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid submission', issues: parsed.error.issues })
    }

    const inputs: SubmissionInput[] = Array.isArray(parsed.data) ? parsed.data : [parsed.data]
    const results = receiveSubmissions(db, inputs, receiveOptions)

    // An unknown stringer is the filer's mistake and worth a non-2xx, but only
    // when nothing at all landed — a mixed batch should not lose its good rows.
    const accepted = results.filter((r) => r.status !== 'REJECTED')
    if (accepted.length === 0) {
      return reply.code(422).send({ results })
    }
    return reply.code(201).send({ results })
  })

  /**
   * The tip line. Accepts a session (the in-app form and the Android share
   * target) or the ingest token (a bookmarklet, a script).
   */
  const fileTip: RouteHandlerMethod = async (request, reply) => {
    if (!hasSession(request)) {
      const guard = requireIngestToken(db)
      await guard(request, reply)
      if (reply.sent) return reply
    }

    const parsed = tipBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'text required' })

    const stringer = resolveTipStringer(db, parsed.data.stringer_id)
    if ('error' in stringer) return reply.code(422).send({ error: stringer.error })

    const text = parsed.data.url ? `${parsed.data.text}\n\n${parsed.data.url}` : parsed.data.text
    const [result] = receiveSubmissions(
      db,
      [
        {
          stringer_id: stringer.id,
          kind: 'tip',
          text,
          ...(parsed.data.url ? { refs: { url: parsed.data.url } } : {}),
        },
      ],
      receiveOptions,
    )
    return reply.code(201).send({ result })
  }

  app.post('/api/v1/tips', fileTip)
  // The pre-rename spelling, kept for bookmarklets and any share-sheet entry
  // installed before the desk learned the word "tip".
  app.post('/api/v1/ideas', fileTip)

  // ── reading ───────────────────────────────────────────────────────────────

  app.get('/api/v1/submissions', { preHandler: requireSession }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })

    const filters: SQL[] = []
    if (parsed.data.status) filters.push(eq(schema.submissions.status, parsed.data.status))
    if (parsed.data.stringer) filters.push(eq(schema.submissions.stringerId, parsed.data.stringer))

    const base = db
      .select({
        id: schema.submissions.id,
        stringerId: schema.submissions.stringerId,
        stringerName: schema.stringers.name,
        kind: schema.submissions.kind,
        status: schema.submissions.status,
        outcome: schema.submissions.outcome,
        filedAt: schema.submissions.filedAt,
        receivedAt: schema.submissions.receivedAt,
        textLength: schema.submissions.text,
        considered: schema.submissions.considered,
      })
      .from(schema.submissions)
      .leftJoin(schema.stringers, eq(schema.submissions.stringerId, schema.stringers.id))

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

    const stringer = db.select().from(schema.stringers).where(eq(schema.stringers.id, row.stringerId)).get()
    return {
      submission: {
        ...row,
        refs: row.refs ? JSON.parse(row.refs) : null,
        stringerName: stringer?.name ?? row.stringerId,
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
