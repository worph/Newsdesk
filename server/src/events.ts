import { desc, eq, gt, and, type SQL } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'

/**
 * The append-only audit and error log. This is authoritative: external
 * alerting is best-effort, because if the Beacon is down an alert cannot go
 * out through the Beacon. The app must stay fully diagnosable from its own
 * screens with every port broken (invariant 7).
 */

export type EventLevel = 'debug' | 'info' | 'warn' | 'error'

export interface EventInput {
  level: EventLevel
  code: string
  message: string
  actor?: 'system' | 'human'
  storyId?: string
  publicationId?: string
  detail?: unknown
}

export function logEvent(db: Db, event: EventInput): void {
  db.insert(schema.events)
    .values({
      level: event.level,
      actor: event.actor ?? 'system',
      code: event.code,
      storyId: event.storyId ?? null,
      publicationId: event.publicationId ?? null,
      message: event.message,
      detail: event.detail === undefined ? null : JSON.stringify(event.detail),
    })
    .run()
}

export interface EventQuery {
  level?: EventLevel
  since?: string
  limit?: number
}

export function listEvents(db: Db, query: EventQuery = {}) {
  const filters: SQL[] = []
  if (query.level) filters.push(eq(schema.events.level, query.level))
  if (query.since) filters.push(gt(schema.events.at, query.since))

  const base = db.select().from(schema.events)
  const filtered = filters.length ? base.where(and(...filters)) : base

  return filtered.orderBy(desc(schema.events.id)).limit(Math.min(query.limit ?? 200, 1000)).all()
}
