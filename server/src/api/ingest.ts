import { and, desc, eq, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hasSession, requireIngestToken, requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { listEvents } from '../events.js'
import {
  receiveFilings,
  filingsBodySchema,
  type ReceiveOptions,
  type FilingInput,
} from '../ports/ingest/receive.js'

const tipBodySchema = z.object({
  text: z.string().min(1),
  url: z.string().optional(),
  stringer_id: z.string().optional(),
})

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

  app.post('/api/v1/filings', { preHandler: requireIngestToken(db) }, async (request, reply) => {
    const parsed = filingsBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid filing', issues: parsed.error.issues })
    }

    const inputs: FilingInput[] = Array.isArray(parsed.data) ? parsed.data : [parsed.data]
    const results = receiveFilings(db, inputs, receiveOptions)

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
   * outlet) or the ingest token (a bookmarklet, a script).
   */
  app.post('/api/v1/tips', async (request, reply) => {
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
    const [result] = receiveFilings(
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
  })

  // ── reading ───────────────────────────────────────────────────────────────

  app.get('/api/v1/filings', { preHandler: requireSession }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })

    const filters: SQL[] = []
    if (parsed.data.status) filters.push(eq(schema.filings.status, parsed.data.status))
    if (parsed.data.stringer) filters.push(eq(schema.filings.stringerId, parsed.data.stringer))

    const base = db
      .select({
        id: schema.filings.id,
        stringerId: schema.filings.stringerId,
        stringerName: schema.stringers.name,
        kind: schema.filings.kind,
        status: schema.filings.status,
        outcome: schema.filings.outcome,
        filedAt: schema.filings.filedAt,
        receivedAt: schema.filings.receivedAt,
        textLength: schema.filings.text,
        considered: schema.filings.considered,
      })
      .from(schema.filings)
      .leftJoin(schema.stringers, eq(schema.filings.stringerId, schema.stringers.id))

    const rows = (filters.length ? base.where(and(...filters)) : base)
      .orderBy(desc(schema.filings.receivedAt))
      .limit(parsed.data.limit ?? 100)
      .all()

    return {
      filings: rows.map((row) => ({
        ...row,
        textLength: row.textLength?.length ?? 0,
        consideredChars: row.considered?.length ?? 0,
        considered: undefined,
      })),
    }
  })

  app.get('/api/v1/filings/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = db.select().from(schema.filings).where(eq(schema.filings.id, id)).get()
    if (!row) return reply.code(404).send({ error: 'not found' })

    const stringer = db.select().from(schema.stringers).where(eq(schema.stringers.id, row.stringerId)).get()
    return {
      filing: {
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
