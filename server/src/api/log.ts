import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { applyRemedy, dismissRemedy, RemedyRefused, type ApplyDeps } from '../assist/apply.js'
import {
  assistPreflight,
  AssistUnavailable,
  latestSession,
  restartable,
  runAssist,
} from '../assist/run.js'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { getEvent, isAssistable, listEvents, logEvent } from '../events.js'
import type { InferenceDriver } from '../ports/inference/types.js'

/**
 * The operations log as a screen reads it.
 *
 * It lives in its own module rather than beside ingest because it is the one
 * surface that must keep working when every port is broken (invariant 7) — and
 * because the error assistant hangs off these same rows, which is several more
 * routes than a file about receiving filings should be carrying.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
const CATEGORIES = [
  'pipeline',
  'delivery',
  'queue',
  'editorial',
  'config',
  'ports',
  'system',
  'other',
] as const

/**
 * Numbers arrive as strings on a query string, so they are coerced here rather
 * than cast — a `limit=abc` should be a 400 with a sentence, not a NaN that
 * silently becomes the default.
 */
const eventsQuery = z.object({
  level: z.enum(LEVELS).optional(),
  minLevel: z.enum(LEVELS).optional(),
  category: z.enum(CATEGORIES).optional(),
  actor: z.enum(['system', 'human']).optional(),
  storyId: z.string().min(1).optional(),
  publicationId: z.string().min(1).optional(),
  q: z.string().min(1).max(200).optional(),
  since: z.string().min(1).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

export interface LogRouteOptions extends ApplyDeps {
  driver?: () => InferenceDriver
  /** Overridden in tests so the suite does not wait on real network timeouts. */
  probeTimeoutMs?: number
}

const eventIdParam = z.object({ id: z.coerce.number().int().positive() })
const remedyIdParam = z.object({ id: z.string().min(1) })

export function registerLogRoutes(
  app: FastifyInstance,
  db: Db,
  options: LogRouteOptions = {},
): void {
  app.get('/api/v1/events', { preHandler: requireSession }, async (request, reply) => {
    const parsed = eventsQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'that is not a filter this log understands — check the level, category and limit',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    // `category: 'other'` is a legitimate filter — it is where rows written by
    // an older build land — so it is passed through rather than treated as
    // "no category given".
    return listEvents(db, parsed.data)
  })

  /**
   * Whether the assistant can be offered at all, and if not, why.
   *
   * The screen asks before it draws the button, so the reason can be on the
   * disabled button rather than arriving as a failure after a click. If the
   * Beacon is down the assistant is down — and the log entry still has to be
   * readable and actionable by hand, which is invariant 7.
   */
  app.get('/api/v1/assist/status', { preHandler: requireSession }, async () => {
    try {
      assistPreflight(db, options.driver)
      return { available: true as const, canRestart: restartable() }
    } catch (err) {
      if (err instanceof AssistUnavailable) {
        return { available: false as const, reason: err.message, canRestart: restartable() }
      }
      throw err
    }
  })

  app.get('/api/v1/events/:id/assist', { preHandler: requireSession }, async (request, reply) => {
    const parsed = eventIdParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'a log entry id is required' })

    // Stored, so a refresh — or a second person looking — keeps the diagnosis.
    const session = latestSession(db, parsed.data.id)
    return { session: session ?? null }
  })

  app.post('/api/v1/events/:id/assist', { preHandler: requireSession }, async (request, reply) => {
    const parsed = eventIdParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'a log entry id is required' })

    const row = getEvent(db, parsed.data.id)
    if (!row) return reply.code(404).send({ error: 'no such log entry' })
    if (!isAssistable(row.code)) {
      return reply.code(422).send({ error: 'there is nothing here the assistant could act on' })
    }

    try {
      assistPreflight(db, options.driver)
    } catch (err) {
      if (err instanceof AssistUnavailable) return reply.code(err.status).send({ error: err.message })
      throw err
    }

    try {
      const session = await runAssist(db, options.driver!(), parsed.data.id, {
        ...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
      })
      return { session }
    } catch (err) {
      if (err instanceof AssistUnavailable) return reply.code(err.status).send({ error: err.message })
      const message = err instanceof Error ? err.message : String(err)
      logEvent(db, {
        level: 'warn',
        code: 'ASSIST_FAILED',
        message: 'the assistant could not be reached, so this entry has no diagnosis',
        detail: { eventId: parsed.data.id, error: message },
      })
      return reply.code(502).send({ error: message })
    }
  })

  app.post('/api/v1/remedies/:id/apply', { preHandler: requireSession }, async (request, reply) => {
    const parsed = remedyIdParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'a proposal id is required' })

    const body = z.object({ confirm: z.string().optional() }).safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: 'confirm must be text' })

    try {
      // The id only. Nothing about what to do comes from this request.
      return applyRemedy(db, parsed.data.id, options, body.data.confirm)
    } catch (err) {
      if (err instanceof RemedyRefused) return reply.code(err.status).send({ error: err.message })
      throw err
    }
  })

  app.post('/api/v1/remedies/:id/dismiss', { preHandler: requireSession }, async (request, reply) => {
    const parsed = remedyIdParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'a proposal id is required' })

    try {
      dismissRemedy(db, parsed.data.id)
      return { status: 'dismissed' as const }
    } catch (err) {
      if (err instanceof RemedyRefused) return reply.code(err.status).send({ error: err.message })
      throw err
    }
  })
}
