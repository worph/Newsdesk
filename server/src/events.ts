import { and, desc, eq, gt, inArray, like, lt, type SQL } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'

/**
 * The append-only audit and error log. This is authoritative: external
 * alerting is best-effort, because if the Beacon is down an alert cannot go
 * out through the Beacon. The app must stay fully diagnosable from its own
 * screens with every port broken (invariant 7).
 *
 * Two rules hold everywhere a row is written:
 *
 *   `message` is one sentence a human reads — no ids, no interpolated error
 *   strings, no JSON. It is the log as a newsroom would keep it.
 *
 *   `detail` is the technical payload, shown only on warn and error. It is
 *   what someone debugging needs and what the error assistant is handed.
 *
 * Splicing an upstream error into `message` collapses the two and is the one
 * thing that makes the log unreadable, so the codes below that carry a
 * declared detail shape require it at the type level.
 */

export type EventLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * How the Log screen groups a row. Derived from `code`, never stored.
 *
 * A column would be null for every row already written, so the first click on
 * a category filter would empty the log — precisely the failure invariant 6
 * exists to prevent — and backfilling it would need a *data* migration, which
 * `db/migrations.ts` documents as the one thing the baseline guard cannot make
 * idempotent. A lookup costs nothing and covers history for free.
 */
export type EventCategory =
  | 'pipeline'
  | 'delivery'
  | 'queue'
  | 'editorial'
  | 'config'
  | 'ports'
  | 'system'
  | 'other'

interface CodeSpec {
  category: EventCategory
  /** Shown in the row legend and the filter tooltip. */
  label: string
  /**
   * Whether the error assistant is offered on this code.
   *
   * Not the same question as "is this an error". `PUSH_NO_DEVICES` is a warn
   * with nothing to remedy — no device is registered because nobody registered
   * one — and a Fix button there is furniture that teaches people to ignore
   * the button where it matters.
   */
  assistable?: true
}

export const EVENT_CODES = {
  // ── pipeline ──────────────────────────────────────────────────────────────
  FILING_RECEIVED: { category: 'pipeline', label: 'filing received' },
  FILING_STRINGER_DISABLED: { category: 'pipeline', label: 'filed to a disabled stringer', assistable: true },
  FILING_REPORTED: { category: 'pipeline', label: 'filing reported' },
  REPORTING_FAILED: { category: 'pipeline', label: 'reporting failed', assistable: true },
  DOSSIER_CITATION_UNVERIFIED: { category: 'pipeline', label: 'citation demoted to recall' },
  STORY_OPENED: { category: 'pipeline', label: 'story opened' },
  STORY_DUPLICATE: { category: 'pipeline', label: 'story judged a duplicate' },
  STORY_SPIKED: { category: 'pipeline', label: 'story placed nowhere' },
  MANAGING_EDITOR_VERDICT_UNLINKED: { category: 'pipeline', label: 'verdict downgraded' },
  DRAFT_READY: { category: 'pipeline', label: 'draft ready' },
  DRAFT_FAILED: { category: 'pipeline', label: 'draft failed', assistable: true },

  // ── delivery ──────────────────────────────────────────────────────────────
  PUBLISHED: { category: 'delivery', label: 'published' },
  PUBLISH_FAILED: { category: 'delivery', label: 'send failed', assistable: true },
  PUBLISH_CANCELLED: { category: 'delivery', label: 'send cancelled' },
  PUBLISH_LATE: { category: 'delivery', label: 'sent late' },
  HANDOVER_DUE: { category: 'delivery', label: 'waiting for someone to publish' },
  NEEDS_AUTH: { category: 'delivery', label: 'the browser is signed out', assistable: true },
  SIGNIN_CHECK_FAILED: { category: 'delivery', label: 'could not check the sign-in' },
  SIGNED_IN: { category: 'delivery', label: 'signed back in' },
  STAGED: { category: 'delivery', label: 'composed in the browser' },
  STAGE_FAILED: { category: 'delivery', label: 'could not compose', assistable: true },
  VERIFY_FAILED: { category: 'delivery', label: 'could not confirm the post' },
  SEND_EXPIRED: { category: 'delivery', label: 'too stale to send' },
  DRAFT_FILED: { category: 'delivery', label: 'draft filed at the destination' },
  DRAFT_ABANDONED: { category: 'delivery', label: 'draft left unfinished' },

  // ── queue ─────────────────────────────────────────────────────────────────
  JOB_RETRY: { category: 'queue', label: 'job will retry' },
  JOB_FAILED: { category: 'queue', label: 'job failed', assistable: true },
  JOB_DEFERRED: { category: 'queue', label: 'job deferred' },
  JOBS_RECLAIMED: { category: 'queue', label: 'jobs reclaimed' },

  // ── editorial ─────────────────────────────────────────────────────────────
  APPROVED: { category: 'editorial', label: 'approved' },
  PLACEMENTS_APPROVED: { category: 'editorial', label: 'placements approved together' },
  WITHDRAWN: { category: 'editorial', label: 'withdrawn' },
  RESCHEDULED: { category: 'editorial', label: 'rescheduled' },
  ROUTE_ADDED: { category: 'editorial', label: 'placement added' },
  ROUTE_REJECTED: { category: 'editorial', label: 'placement spiked' },
  STORY_RERUN: { category: 'editorial', label: 'story re-queued' },
  COMPOSED: { category: 'editorial', label: 'written at the desk' },

  // ── config ────────────────────────────────────────────────────────────────
  CONFIG_CHANGED: { category: 'config', label: 'configuration changed' },
  CONFIG_RESTORED: { category: 'config', label: 'configuration restored' },
  CONFIG_TOKEN_ROTATED: { category: 'config', label: 'ingest token rotated' },
  MCP_TOKEN_ROTATED: { category: 'config', label: 'admin MCP token rotated' },
  TIMEZONE_CHANGED: { category: 'config', label: 'timezone changed' },
  // Neither is assistable: what fixes a refused tool call or an exhausted turn
  // is the next thing said in the conversation, not a remedy proposed here.
  CHAT_TOOL_FAILED: { category: 'config', label: 'chat tool refused' },
  CHAT_TURN_FAILED: { category: 'config', label: 'chat turn failed' },

  // ── ports ─────────────────────────────────────────────────────────────────
  'mcp.oauth.started': { category: 'ports', label: 'authorization started' },
  'mcp.oauth.connected': { category: 'ports', label: 'endpoint connected' },
  'mcp.oauth.failed': { category: 'ports', label: 'authorization failed', assistable: true },
  'mcp.oauth.forgotten': { category: 'ports', label: 'endpoint disconnected' },
  INFERENCE_UNAVAILABLE: { category: 'ports', label: 'no inference available', assistable: true },
  COPY_DESK_FAILED: { category: 'ports', label: 'copy desk failed', assistable: true },
  TIP_DESK_FAILED: { category: 'ports', label: 'tip desk failed', assistable: true },
  PUSH_UNCONFIGURED: { category: 'ports', label: 'push not configured', assistable: true },
  PUSH_NO_DEVICES: { category: 'ports', label: 'no device registered' },
  PUSH_REGISTRATION_DEAD: { category: 'ports', label: 'registration retired' },
  PUSH_FAILED: { category: 'ports', label: 'push failed', assistable: true },

  // ── system ────────────────────────────────────────────────────────────────
  DESK_STARTED: { category: 'system', label: 'desk started' },
  DESK_UNCONFIGURED: { category: 'system', label: 'desk unconfigured' },
  SCHEMA_RECONCILED: { category: 'system', label: 'schema reconciled' },
  AUTH_LOGIN_FAILED: { category: 'system', label: 'failed sign-in' },
  AUTH_PASSWORD_CHANGED: { category: 'system', label: 'password changed' },
  DESK_RESTART_REQUESTED: { category: 'system', label: 'restart requested' },

  // ── the assistant ─────────────────────────────────────────────────────────
  // Its own work is logged like anything else, in the same log it is fixing.
  REMEDY_APPLIED: { category: 'system', label: 'assistant fix applied' },
  ASSIST_FAILED: { category: 'ports', label: 'assistant unavailable' },
} as const satisfies Record<string, CodeSpec>

export type EventCode = keyof typeof EVENT_CODES

/**
 * Detail shapes that are required rather than optional.
 *
 * Every code here is one someone reaches for while debugging, and each was
 * once logged with its technical payload spliced into the sentence or missing
 * altogether. Declaring the shape makes tsc the thing that enforces the split.
 */
interface EventDetails {
  REPORTING_FAILED: { filingId: string; error: string; stack?: string }
  DRAFT_FAILED: { publicationId: string; outletId?: string; error: string; stack?: string }
  PUBLISH_FAILED: {
    outletId: string
    outletName?: string
    driver?: string
    tool?: string | null
    endpointId?: string | null
    httpStatus?: number
    /** The classifier's read: is a human reconnecting the fix, or is this a bug to chase? */
    needsAuth?: boolean
    retryable?: boolean
    /** A browser publish that never got a lane: who had it, and since when. */
    heldBy?: string
    since?: number
    error: string
    stack?: string
  }
  PUBLISH_LATE: { outletId: string; scheduledFor: string; sentAt: string; lateBySeconds: number }
  /** Which page, which browser, and what it refused to do — see publish_traces for the steps. */
  STAGE_FAILED: { outletId: string; engine: string; error: string; stack?: string }
  /**
   * `allowedHours` is what the row's urgency permitted. Only an outlet that
   * publishes unwatched can expire — a hand-over one waits as long as it takes,
   * because a person sees the date before it goes anywhere.
   */
  SEND_EXPIRED: {
    outletId: string
    waitedHours: number
    urgency?: string | null
    allowedHours?: number
    error?: string
  }
  DRAFT_FILED: { outletId: string; draftUrl: string | null }
  DRAFT_ABANDONED: { outletId: string; draftUrl: string; reason?: string }
  JOB_RETRY: { jobId: string; kind: string; refId: string; attempts: number; retryInSeconds: number; error: string }
  JOB_FAILED: { jobId: string; kind: string; refId: string; attempts: number; error: string; stack?: string }
  JOB_DEFERRED: { jobId: string; kind: string; refId: string; retryInSeconds: number; reason: string }
  JOBS_RECLAIMED: { ids: string[] }
  INFERENCE_UNAVAILABLE: { reason: string }
  COPY_DESK_FAILED: { publicationId: string; error: string }
  TIP_DESK_FAILED: { error: string }
  PUSH_FAILED: { status?: number; endpoint: string; error: string }
  PUSH_REGISTRATION_DEAD: { status?: number; endpoint: string; detail?: string }
  'mcp.oauth.failed': { endpointId?: string; phase: 'start' | 'callback' | 'exchange'; error: string }
  CONFIG_CHANGED: { author: string; versionId?: number; summary: string }
  CONFIG_RESTORED: { author: string; restoredFromId: number; versionId?: number }
  CONFIG_TOKEN_ROTATED: Record<string, never>
  MCP_TOKEN_ROTATED: Record<string, never>
  TIMEZONE_CHANGED: { from: string; to: string }
  CHAT_TOOL_FAILED: { threadId: string; tool: string; error: string }
  CHAT_TURN_FAILED: {
    threadId: string
    calls: number
    reason: 'bound' | 'timeout' | 'inference'
    error: string
  }
  DESK_STARTED: { version: string; adoptedBaseline: string | null; reconciled: number; extra: number }
  SCHEMA_RECONCILED: { statements: number; extra: string[] }
  AUTH_LOGIN_FAILED: { ip: string }
  REMEDY_APPLIED: {
    remedyId: string
    kind: string
    risk: string
    outcome: string
    forEventId?: number
  }
  ASSIST_FAILED: { eventId: number; error: string }
}

type DetailPart<C extends EventCode> = C extends keyof EventDetails
  ? { detail: EventDetails[C] }
  : { detail?: Record<string, unknown> }

/**
 * A discriminated union over `code`, so the required detail shape travels with
 * the code rather than living in a comment nobody reads.
 */
export type EventInput = {
  [C in EventCode]: {
    level: EventLevel
    code: C
    message: string
    actor?: 'system' | 'human'
    storyId?: string
    publicationId?: string
  } & DetailPart<C>
}[EventCode]

export function categoryOf(code: string): EventCategory {
  const known = (EVENT_CODES as Record<string, CodeSpec | undefined>)[code]
  if (known) return known.category

  // A row written before this table existed, or by a build that has since been
  // rolled back. It still belongs in the log — an event nobody can find is the
  // same as an event nobody wrote.
  if (code.startsWith('mcp.') || code.startsWith('PUSH_')) return 'ports'
  if (code.startsWith('STORY_') || code.startsWith('FILING_') || code.startsWith('DRAFT_')) return 'pipeline'
  if (code.startsWith('JOB')) return 'queue'
  if (code.startsWith('PUBLISH')) return 'delivery'
  if (code.startsWith('CONFIG_')) return 'config'
  if (code.startsWith('AUTH_') || code.startsWith('DESK_')) return 'system'
  return 'other'
}

export function isAssistable(code: string): boolean {
  return (EVENT_CODES as Record<string, CodeSpec | undefined>)[code]?.assistable === true
}

export function codesInCategory(category: EventCategory): EventCode[] {
  return (Object.keys(EVENT_CODES) as EventCode[]).filter((code) => EVENT_CODES[code].category === category)
}

function insert(db: Db, event: EventInput) {
  return db.insert(schema.events).values({
    level: event.level,
    actor: event.actor ?? 'system',
    code: event.code,
    storyId: event.storyId ?? null,
    publicationId: event.publicationId ?? null,
    message: event.message,
    detail: event.detail === undefined ? null : JSON.stringify(event.detail),
  })
}

/**
 * Record an event. Never throws.
 *
 * A locked database must not take down the operation this was only meant to
 * observe — an unguarded insert here turns "we could not write that we
 * published" into "we could not publish".
 */
export function logEvent(db: Db, event: EventInput): void {
  try {
    insert(db, event).run()
  } catch (err) {
    console.error('could not write an event to the log', event.code, err)
  }
}

/**
 * As `logEvent`, but returns the row id — or null if the write failed.
 *
 * Applying a remedy has to point at the event its own apply produced, and that
 * link is the whole audit trail for an assistant-initiated change.
 */
export function logEventReturning(db: Db, event: EventInput): number | null {
  try {
    const row = insert(db, event).returning({ id: schema.events.id }).get()
    return row?.id ?? null
  } catch (err) {
    console.error('could not write an event to the log', event.code, err)
    return null
  }
}

/**
 * Severity as an order, which the column itself does not carry.
 *
 * Translated to a set membership rather than a comparison, so the existing
 * `events_level_idx` still serves the query — a CASE expression over the text
 * would be correct and unindexed.
 */
const LEVEL_RANK: Record<EventLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function levelsAtOrAbove(min: EventLevel): EventLevel[] {
  return (Object.keys(LEVEL_RANK) as EventLevel[]).filter((level) => LEVEL_RANK[level] >= LEVEL_RANK[min])
}

export function getEvent(db: Db, id: number) {
  return db.select().from(schema.events).where(eq(schema.events.id, id)).get()
}

export interface EventQuery {
  /** Exactly this level. */
  level?: EventLevel
  /** This level and everything worse — what the Log screen actually filters on. */
  minLevel?: EventLevel
  category?: EventCategory
  actor?: 'system' | 'human'
  storyId?: string
  publicationId?: string
  /** Free text over the human sentence. Never over `detail`, which is not prose. */
  q?: string
  since?: string
  /** Cursor: return rows older than this id. */
  before?: number
  limit?: number
}

export interface EventListRow {
  id: number
  at: string
  level: EventLevel
  actor: string
  code: string
  category: EventCategory
  assistable: boolean
  message: string
  detail: unknown
  storyId: string | null
  /** Null when the story has since been deleted; the id is still shown. */
  storyTitle: string | null
  publicationId: string | null
  outletId: string | null
  outletName: string | null
}

/**
 * One page of the log, newest first, with the entities already resolved.
 *
 * The joins are left joins and must stay that way: `events.story_id` and
 * `events.publication_id` carry no foreign key, so a row can outlive what it
 * points at. When that happens the screen shows the bare id — an event that
 * renders blank is worse than one that renders ugly.
 *
 * Paginated on `id` rather than `at`: the id is autoincrement and therefore
 * monotone with time, while two events written in the same millisecond share
 * an `at` and would make a timestamp cursor skip or repeat rows.
 */
export function listEvents(db: Db, query: EventQuery = {}): { events: EventListRow[]; nextCursor: number | null } {
  const filters: SQL[] = []
  if (query.level) filters.push(eq(schema.events.level, query.level))
  if (query.minLevel) filters.push(inArray(schema.events.level, levelsAtOrAbove(query.minLevel)))
  if (query.category) filters.push(inArray(schema.events.code, codesInCategory(query.category)))
  if (query.actor) filters.push(eq(schema.events.actor, query.actor))
  if (query.storyId) filters.push(eq(schema.events.storyId, query.storyId))
  if (query.publicationId) filters.push(eq(schema.events.publicationId, query.publicationId))
  if (query.q) filters.push(like(schema.events.message, `%${query.q}%`))
  if (query.since) filters.push(gt(schema.events.at, query.since))
  if (query.before !== undefined) filters.push(lt(schema.events.id, query.before))

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)

  const rows = db
    .select({
      id: schema.events.id,
      at: schema.events.at,
      level: schema.events.level,
      actor: schema.events.actor,
      code: schema.events.code,
      message: schema.events.message,
      detail: schema.events.detail,
      storyId: schema.events.storyId,
      storyTitle: schema.stories.title,
      publicationId: schema.events.publicationId,
      outletId: schema.publications.outletId,
      outletName: schema.outlets.name,
    })
    .from(schema.events)
    .leftJoin(schema.stories, eq(schema.events.storyId, schema.stories.id))
    .leftJoin(schema.publications, eq(schema.events.publicationId, schema.publications.id))
    .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(schema.events.id))
    // One more than asked for, so "is there another page" needs no second query.
    .limit(limit + 1)
    .all()

  const page = rows.slice(0, limit)
  return {
    events: page.map((row) => ({
      ...row,
      level: row.level as EventLevel,
      category: categoryOf(row.code),
      assistable: isAssistable(row.code),
      detail: row.detail ? (JSON.parse(row.detail) as unknown) : null,
    })),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}
