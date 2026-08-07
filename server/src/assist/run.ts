import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { assistResultSchema, confirmationFor, riskOf, type Remedy } from '@newsdesk/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { fillPrompt, loadPrompt } from '../prompts/load.js'
import { runStructured } from '../ports/inference/structured.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { buildErrorBundle, serialiseBundle, type BundleOptions, type ErrorBundle } from './bundle.js'

/**
 * One diagnosis of one logged failure.
 *
 * Single shot. The desk gathers the evidence and asks once; the model never
 * calls anything. Handing it tools would mean handing tools to something
 * reading attacker-influenced text, which is the trade architecture invariant
 * 4 exists to refuse.
 *
 * A human is waiting for this, unlike every other inference the desk runs, and
 * that changes two things: the timeout is minutes rather than the queue's, and
 * a busy desk gets a refusal instead of a place in the queue.
 */

/** The queue absorbs a publish job's wait. Nobody absorbs this one. */
const TIMEOUT_MS = 90_000

const SHAPE = `{
  "diagnosis": string,              // one paragraph, the operator's language
  "confidence": "high" | "medium" | "low",
  "remedies": [                     // 0-4; use no_action rather than guessing
    {
      "kind": "no_action" | "retry_job" | "retry_publication" | "rerun_story"
            | "report_filing" | "disable_stringer" | "disable_outlet"
            | "reconnect_endpoint" | "propose_config_change"
            | "propose_literal_change" | "propose_restart",
      "title": string,              // imperative, < 140 chars, no ids
      "rationale": string,
      // plus the fields that kind takes — see the list above
    }
  ]
}`

/**
 * Split the bundle in two: what the desk knows about itself, and what came
 * from outside.
 *
 * The untrusted markers only mean something if most of the document is outside
 * them. Wrapping the whole context would make the warning noise, and the model
 * would learn to read past it.
 */
export function splitBundle(bundle: ErrorBundle): { head: ErrorBundle; untrusted: unknown } {
  const { detail, ...event } = bundle.event
  return {
    head: { ...bundle, event: { ...event, detail: '(see the untrusted block)' } as ErrorBundle['event'] },
    untrusted: {
      detail,
      ...(bundle.filing ? { filingExcerpt: bundle.filing.excerpt } : {}),
      ...(bundle.publication?.error ? { publicationError: bundle.publication.error } : {}),
      ...(bundle.job?.lastError ? { jobLastError: bundle.job.lastError } : {}),
    },
  }
}

export function buildAssistPrompt(db: Db, bundle: ErrorBundle): { prompt: string; sha256: string } {
  const { head, untrusted } = splitBundle(bundle)
  const serialised = serialiseBundle(db, head)

  const prompt = fillPrompt(loadPrompt('assist'), {
    BUNDLE_HEAD: serialised.json,
    UNTRUSTED_DETAIL: JSON.stringify(untrusted, null, 2),
    TRUNCATION_NOTE: bundle.truncated
      ? 'Some of the material above was too long and was cut. Say so if the missing part is what you would have needed.'
      : '',
  })

  return { prompt, sha256: serialised.sha256 }
}

export class AssistUnavailable extends Error {
  constructor(
    message: string,
    /** 503 when nothing is wired, 409 when the desk is merely busy. */
    readonly status: 503 | 409,
  ) {
    super(message)
    this.name = 'AssistUnavailable'
  }
}

/**
 * Whether the assistant can run at all, right now.
 *
 * Only one question left: is anything wired? This used to also refuse while
 * any job was RUNNING, because the Beacon served one query at a time and this
 * button gets pressed exactly when the pipeline is failing and retrying. That
 * constraint is gone — see the note on `QueueOptions.concurrency` in
 * pipeline/queue.ts — so the check was refusing a diagnosis for a reason that
 * had stopped being true, at the moment it was most wanted.
 *
 * The double-submit guard below is a different thing and stays.
 */
export function assistPreflight(_db: Db, driver?: () => InferenceDriver): void {
  if (!driver) {
    throw new AssistUnavailable('no inference is wired on this instance', 503)
  }
}

/** Single instance (invariant 9), so a Set is a sufficient double-submit guard. */
const inFlight = new Set<number>()

export interface AssistSession {
  id: string
  eventId: number
  at: string
  status: string
  diagnosis: string | null
  confidence: string | null
  rejected: { title: string; reason: string }[]
  remedies: StoredRemedy[]
}

export interface StoredRemedy {
  id: string
  kind: string
  risk: 'safe' | 'high'
  title: string
  rationale: string
  payload: unknown
  status: string
  appliedAt: string | null
  error: string | null
  /** What the operator must type to apply it. Null for the ordinary tier. */
  confirmWith: string | null
}

/**
 * Check a remedy against the desk as it actually is.
 *
 * The schema proves the shape; this proves the subject exists. They are
 * different failures: a bad shape is the model's to retry, an invented id is
 * not — retrying just invites a second guess. So these are dropped and
 * recorded rather than fed back.
 */
function verify(db: Db, remedy: Remedy): string | null {
  const exists = (table: 'jobs' | 'publications' | 'stories' | 'filings' | 'stringers' | 'outlets' | 'mcpEndpoints', id: string) => {
    const tables = {
      jobs: schema.jobs,
      publications: schema.publications,
      stories: schema.stories,
      filings: schema.filings,
      stringers: schema.stringers,
      outlets: schema.outlets,
      mcpEndpoints: schema.mcpEndpoints,
    } as const
    const t = tables[table]
    return db.select({ id: t.id }).from(t).where(eq(t.id, id)).get() !== undefined
  }

  switch (remedy.kind) {
    case 'retry_job':
      return exists('jobs', remedy.jobId) ? null : `no job "${remedy.jobId}"`
    case 'retry_publication':
      return exists('publications', remedy.publicationId) ? null : `no placement "${remedy.publicationId}"`
    case 'rerun_story':
      return exists('stories', remedy.storyId) ? null : `no story "${remedy.storyId}"`
    case 'report_filing':
      return exists('filings', remedy.filingId) ? null : `no filing "${remedy.filingId}"`
    case 'disable_stringer':
      return exists('stringers', remedy.stringerId) ? null : `no stringer "${remedy.stringerId}"`
    case 'disable_outlet':
      return exists('outlets', remedy.outletId) ? null : `no destination "${remedy.outletId}"`
    case 'reconnect_endpoint':
      return exists('mcpEndpoints', remedy.endpointId) ? null : `no endpoint "${remedy.endpointId}"`
    case 'propose_config_change':
    case 'propose_literal_change': {
      for (const change of remedy.changes) {
        if (change.target === 'reporting') continue
        const table = change.target === 'outlet' ? 'outlets' : change.target === 'stringer' ? 'stringers' : change.target === 'voice' ? 'voices' : 'mcpEndpoints'
        if (table === 'voices') {
          const found = db.select({ id: schema.voices.id }).from(schema.voices).where(eq(schema.voices.id, change.id!)).get()
          if (!found) return `no voice "${change.id}"`
          continue
        }
        if (!exists(table, change.id!)) return `no ${change.target} "${change.id}"`
      }
      return null
    }
    case 'propose_restart':
      return restartable() ? null : 'this desk cannot restart itself'
    case 'no_action':
      return null
    default:
      return 'unrecognised remedy'
  }
}

/**
 * Whether stopping the process would bring it back.
 *
 * Under compose the policy is `restart: unless-stopped`, so exiting is a
 * restart. Under `tsx watch` in development it is just the desk going away,
 * which is why the remedy is never offered there.
 */
export function restartable(): boolean {
  if (process.env.NEWSDESK_RESTARTABLE === '1') return true
  if (process.env.NEWSDESK_RESTARTABLE === '0') return false
  // Present in every Docker container; absent from a bare node run.
  return existsSync('/.dockerenv')
}

export async function runAssist(
  db: Db,
  driver: InferenceDriver,
  eventId: number,
  options: BundleOptions = {},
): Promise<AssistSession> {
  if (inFlight.has(eventId)) {
    throw new AssistUnavailable('a diagnosis for this entry is already running', 409)
  }
  inFlight.add(eventId)

  try {
    const bundle = await buildErrorBundle(db, eventId, options)
    if (!bundle) throw new AssistUnavailable('no such log entry', 503)

    const { prompt, sha256 } = buildAssistPrompt(db, bundle)
    const sessionId = randomUUID()

    let result
    try {
      result = await runStructured(db, driver, {
        purpose: 'assist',
        refId: String(eventId),
        prompt,
        schema: assistResultSchema,
        shapeHint: SHAPE,
        timeoutMs: TIMEOUT_MS,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.insert(schema.assistSessions)
        .values({ id: sessionId, eventId, status: 'FAILED', bundleSha: sha256, error: message })
        .run()
      throw err
    }

    const kept: { remedy: Remedy; id: string }[] = []
    const rejected: { title: string; reason: string }[] = []

    for (const remedy of result.remedies) {
      const problem = verify(db, remedy)
      if (problem) {
        rejected.push({ title: remedy.title, reason: problem })
        continue
      }
      kept.push({ remedy, id: randomUUID() })
    }

    db.transaction((tx) => {
      tx.insert(schema.assistSessions)
        .values({
          id: sessionId,
          eventId,
          status: 'OK',
          diagnosis: result.diagnosis,
          confidence: result.confidence,
          bundleSha: sha256,
          rejected: rejected.length ? JSON.stringify(rejected) : null,
        })
        .run()

      for (const { remedy, id } of kept) {
        const { kind, title, rationale, ...payload } = remedy
        tx.insert(schema.remedies)
          .values({
            id,
            sessionId,
            kind,
            // Server-derived. There is no field on the model's output for it,
            // so a proposal cannot understate what it is.
            risk: riskOf(remedy),
            title,
            rationale,
            payload: JSON.stringify(payload),
            status: 'PROPOSED',
          })
          .run()
      }
    })

    return loadSession(db, sessionId)!
  } finally {
    inFlight.delete(eventId)
  }
}

export function loadSession(db: Db, sessionId: string): AssistSession | undefined {
  const session = db.select().from(schema.assistSessions).where(eq(schema.assistSessions.id, sessionId)).get()
  if (!session) return undefined
  return hydrate(db, session)
}

/** The most recent diagnosis for an entry, so a refresh does not lose it. */
export function latestSession(db: Db, eventId: number): AssistSession | undefined {
  const session = db
    .select()
    .from(schema.assistSessions)
    .where(eq(schema.assistSessions.eventId, eventId))
    .orderBy(schema.assistSessions.at)
    .all()
    .at(-1)
  return session ? hydrate(db, session) : undefined
}

function hydrate(db: Db, session: typeof schema.assistSessions.$inferSelect): AssistSession {
  const rows = db.select().from(schema.remedies).where(eq(schema.remedies.sessionId, session.id)).all()

  return {
    id: session.id,
    eventId: session.eventId,
    at: session.at,
    status: session.status,
    diagnosis: session.diagnosis,
    confidence: session.confidence,
    rejected: session.rejected ? (JSON.parse(session.rejected) as { title: string; reason: string }[]) : [],
    remedies: rows.map((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      return {
        id: row.id,
        kind: row.kind,
        risk: row.risk as 'safe' | 'high',
        title: row.title,
        rationale: row.rationale,
        payload,
        status: row.status,
        appliedAt: row.appliedAt,
        error: row.error,
        confirmWith:
          row.risk === 'high'
            ? confirmationFor({ kind: row.kind, title: row.title, rationale: row.rationale, ...payload } as Remedy)
            : null,
      }
    }),
  }
}
