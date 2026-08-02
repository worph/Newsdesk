import { confirmationFor, type Remedy } from '@newsdesk/shared'
import { eq } from 'drizzle-orm'
import { readConfig, writeConfig } from '../config/store.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent, logEventReturning, type EventInput } from '../events.js'
import { restartable } from './run.js'

/**
 * Applying a proposal.
 *
 * The one rule that makes this safe: **the payload is never read from the
 * request.** The route hands over an id, this re-reads the row the server
 * itself validated and stored, and re-checks it against the desk as it is
 * now — state moves between proposing and applying, and a remedy that was
 * right ten minutes ago may not be.
 *
 * Each branch writes its own log rows: `REMEDY_APPLIED` for the audit trail,
 * plus the domain code an equivalent human action would have written, so the
 * Log reads the same whether a person or a remedy caused it.
 */

export class RemedyRefused extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422 | 503,
  ) {
    super(message)
    this.name = 'RemedyRefused'
  }
}

export interface ApplyDeps {
  enqueuePublish?: (publicationId: string, runAfter?: Date) => void
  enqueueManagingEditor?: (filingId: string) => void
  enqueueReporter?: (filingId: string) => void
  /** Stopping the process. Injected so a test never actually exits. */
  restart?: () => void
}

export interface AppliedResult {
  status: 'applied'
  kind: string
  /** What the operator should be told happened, in one sentence. */
  outcome: string
  /** Set when applying it does not finish the job — reconnecting, for one. */
  next?: { action: 'authorize-endpoint' | 'wait-for-restart'; id?: string }
}

function remedyFrom(row: typeof schema.remedies.$inferSelect): Remedy {
  return {
    kind: row.kind,
    title: row.title,
    rationale: row.rationale,
    ...(JSON.parse(row.payload) as Record<string, unknown>),
  } as Remedy
}

/**
 * Change one field of the live configuration and save it.
 *
 * A typed switch, never a dynamic path walker: a walker takes the field name
 * as a route into an arbitrary object, which is precisely the shape of hole
 * the field allowlist exists to close.
 */
function applyConfigChanges(
  db: Db,
  changes: Extract<Remedy, { kind: 'propose_config_change' | 'propose_literal_change' }>['changes'],
  remedyId: string,
  title: string,
): string {
  const config = readConfig(db)
  const described: string[] = []

  for (const change of changes) {
    if (change.target === 'reporting') {
      if (!config.reporting) throw new RemedyRefused('this desk has no research block to change', 422)
      const reporting = config.reporting as unknown as Record<string, unknown>
      described.push(`reporting.${change.field}: ${String(reporting[change.field])} → ${String(change.value)}`)
      reporting[change.field] = change.value
      continue
    }

    if (change.target === 'outlet') {
      const outlet = config.outlets.find((candidate) => candidate.id === change.id)
      if (!outlet) throw new RemedyRefused(`destination "${change.id}" no longer exists`, 409)

      switch (change.field) {
        case 'enabled':
          described.push(`${outlet.name}: enabled ${outlet.enabled} → ${Boolean(change.value)}`)
          outlet.enabled = Boolean(change.value)
          break
        case 'description':
          described.push(`${outlet.name}: description rewritten`)
          outlet.description = String(change.value)
          break
        case 'role':
          described.push(`${outlet.name}: role ${outlet.role} → ${String(change.value)}`)
          outlet.role = String(change.value) as typeof outlet.role
          break
        case 'cadence.min_gap_minutes':
          outlet.cadence = { ...outlet.cadence, min_gap_minutes: Number(change.value) }
          described.push(`${outlet.name}: minimum gap → ${Number(change.value)} minutes`)
          break
        case 'cadence.max_per_day':
          outlet.cadence = { ...outlet.cadence, max_per_day: Number(change.value) }
          described.push(`${outlet.name}: at most ${Number(change.value)} a day`)
          break
        case 'tool':
          described.push(`${outlet.name}: tool ${outlet.tool ?? '(none)'} → ${String(change.value)}`)
          outlet.tool = String(change.value)
          break
        case 'destination_key':
          described.push(`${outlet.name}: destination key changed`)
          outlet.destination_key = String(change.value)
          break
        case 'endpoint':
          described.push(`${outlet.name}: endpoint ${outlet.endpoint ?? '(none)'} → ${String(change.value)}`)
          outlet.endpoint = String(change.value)
          break
      }
      continue
    }

    if (change.target === 'stringer') {
      const stringer = config.stringers.find((candidate) => candidate.id === change.id)
      if (!stringer) throw new RemedyRefused(`stringer "${change.id}" no longer exists`, 409)
      if (change.field === 'enabled') {
        described.push(`${stringer.name}: enabled ${stringer.enabled} → ${Boolean(change.value)}`)
        stringer.enabled = Boolean(change.value)
      } else {
        described.push(`${stringer.name}: hint rewritten`)
        stringer.hint = String(change.value)
      }
      continue
    }

    if (change.target === 'voice') {
      const voice = config.voices.find((candidate) => candidate.id === change.id)
      if (!voice) throw new RemedyRefused(`voice "${change.id}" no longer exists`, 409)
      described.push(`${voice.name}: ${change.field} rewritten`)
      voice[change.field] = String(change.value)
      continue
    }

    const endpoint = config.mcp_endpoints.find((candidate) => candidate.id === change.id)
    if (!endpoint) throw new RemedyRefused(`endpoint "${change.id}" no longer exists`, 409)
    described.push(`${endpoint.name}: url changed`)
    endpoint.url = String(change.value)
  }

  // The restore point is taken inside writeConfig's own transaction, and named
  // after the remedy so the history says what it was taken ahead of.
  writeConfig(db, config, 'assistant', `before assistant remedy ${remedyId} — ${title}`)
  return described.join('; ')
}

export function applyRemedy(
  db: Db,
  remedyId: string,
  deps: ApplyDeps = {},
  confirm?: string,
): AppliedResult {
  const row = db.select().from(schema.remedies).where(eq(schema.remedies.id, remedyId)).get()
  if (!row) throw new RemedyRefused('no such proposal', 404)
  if (row.status !== 'PROPOSED') {
    throw new RemedyRefused(`this proposal was already ${row.status.toLowerCase()}`, 409)
  }

  const remedy = remedyFrom(row)

  /**
   * The confirmation for a high-risk remedy, checked against what the server
   * stored rather than what the browser sent. A client that decides for itself
   * that a remedy is safe changes nothing here.
   */
  if (row.risk === 'high') {
    const expected = confirmationFor(remedy)
    if (!expected || confirm !== expected) {
      throw new RemedyRefused(
        `this changes where content goes — type "${expected ?? ''}" to confirm you have read it`,
        422,
      )
    }
  }

  const session = db
    .select({ eventId: schema.assistSessions.eventId })
    .from(schema.assistSessions)
    .where(eq(schema.assistSessions.id, row.sessionId))
    .get()

  const result = run(db, remedy, deps, remedyId, row.title)

  const appliedEventId = logEventReturning(db, {
    level: 'info',
    actor: 'human',
    code: 'REMEDY_APPLIED',
    message: `you applied a fix the assistant proposed: ${row.title}`,
    detail: {
      remedyId,
      kind: row.kind,
      risk: row.risk,
      outcome: result.outcome,
      ...(session ? { forEventId: session.eventId } : {}),
    },
  })

  db.update(schema.remedies)
    .set({
      status: 'APPLIED',
      appliedAt: new Date().toISOString(),
      appliedEventId,
      error: null,
    })
    .where(eq(schema.remedies.id, remedyId))
    .run()

  return result
}

function run(db: Db, remedy: Remedy, deps: ApplyDeps, remedyId: string, title: string): AppliedResult {
  const domain = (event: EventInput) => logEvent(db, event)

  switch (remedy.kind) {
    case 'no_action':
      return { status: 'applied', kind: remedy.kind, outcome: 'noted; nothing was changed' }

    case 'retry_job': {
      const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, remedy.jobId)).get()
      if (!job) throw new RemedyRefused('that job no longer exists', 409)
      if (job.status === 'RUNNING') throw new RemedyRefused('that job is running right now', 409)

      db.update(schema.jobs)
        .set({ status: 'PENDING', attempts: 0, runAfter: new Date().toISOString(), lastError: null })
        .where(eq(schema.jobs.id, remedy.jobId))
        .run()
      return { status: 'applied', kind: remedy.kind, outcome: `the ${job.kind} job is queued again` }
    }

    case 'retry_publication': {
      const publication = db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, remedy.publicationId))
        .get()
      if (!publication) throw new RemedyRefused('that placement no longer exists', 409)
      if (!publication.payload) {
        throw new RemedyRefused('nothing was ever approved for that destination', 422)
      }
      if (publication.status === 'PUBLISHED') {
        throw new RemedyRefused('that has already been published', 409)
      }
      if (!deps.enqueuePublish) throw new RemedyRefused('no publisher is wired on this instance', 503)

      // The same bytes, unchanged. Approval froze them and nothing here thaws.
      deps.enqueuePublish(remedy.publicationId)
      return { status: 'applied', kind: remedy.kind, outcome: 'the approved payload is queued to send again' }
    }

    case 'rerun_story': {
      const links = db
        .select({ filingId: schema.storyFilings.filingId })
        .from(schema.storyFilings)
        .where(eq(schema.storyFilings.storyId, remedy.storyId))
        .all()
      if (links.length === 0) throw new RemedyRefused('that story has no filings to re-read', 422)
      if (!deps.enqueueManagingEditor) throw new RemedyRefused('no pipeline is wired on this instance', 503)

      for (const link of links) deps.enqueueManagingEditor(link.filingId)
      domain({
        level: 'info',
        actor: 'human',
        code: 'STORY_RERUN',
        storyId: remedy.storyId,
        message: `${links.length} filing(s) went back to the managing editor`,
      })
      return { status: 'applied', kind: remedy.kind, outcome: `${links.length} filing(s) re-queued` }
    }

    case 'report_filing': {
      const filing = db.select().from(schema.filings).where(eq(schema.filings.id, remedy.filingId)).get()
      if (!filing) throw new RemedyRefused('that filing no longer exists', 409)
      if (!deps.enqueueReporter) throw new RemedyRefused('the research phase is not wired on this instance', 503)

      db.transaction((tx) => {
        tx.delete(schema.dossierSources).where(eq(schema.dossierSources.filingId, remedy.filingId)).run()
        tx.update(schema.filings)
          .set({ dossier: null, reportedAt: null, status: 'PROCESSING', outcome: 're-reporting' })
          .where(eq(schema.filings.id, remedy.filingId))
          .run()
      })
      deps.enqueueReporter(remedy.filingId)
      return { status: 'applied', kind: remedy.kind, outcome: 'the filing is being reported again' }
    }

    case 'disable_stringer': {
      const outcome = applyConfigChanges(
        db,
        [{ target: 'stringer', id: remedy.stringerId, field: 'enabled', value: false }],
        remedyId,
        title,
      )
      return { status: 'applied', kind: remedy.kind, outcome }
    }

    case 'disable_outlet': {
      const outcome = applyConfigChanges(
        db,
        [{ target: 'outlet', id: remedy.outletId, field: 'enabled', value: false }],
        remedyId,
        title,
      )
      return { status: 'applied', kind: remedy.kind, outcome }
    }

    case 'reconnect_endpoint': {
      // Deliberately writes nothing. The desk cannot authorize on someone's
      // behalf, and a remedy that pretended to would be a lie about what
      // happened. It hands the operator to the flow instead.
      const endpoint = db
        .select({ id: schema.mcpEndpoints.id, name: schema.mcpEndpoints.name })
        .from(schema.mcpEndpoints)
        .where(eq(schema.mcpEndpoints.id, remedy.endpointId))
        .get()
      if (!endpoint) throw new RemedyRefused('that endpoint no longer exists', 409)

      return {
        status: 'applied',
        kind: remedy.kind,
        outcome: `${endpoint.name} is waiting for you to authorize it`,
        next: { action: 'authorize-endpoint', id: endpoint.id },
      }
    }

    case 'propose_config_change':
    case 'propose_literal_change': {
      const outcome = applyConfigChanges(db, remedy.changes, remedyId, title)
      domain({
        level: 'info',
        actor: 'human',
        code: 'CONFIG_CHANGED',
        message: 'you applied a configuration change the assistant proposed',
        detail: { author: 'assistant', summary: outcome },
      })
      return { status: 'applied', kind: remedy.kind, outcome }
    }

    case 'propose_restart': {
      if (!restartable()) throw new RemedyRefused('this desk cannot restart itself', 422)
      const running = db.select().from(schema.jobs).where(eq(schema.jobs.status, 'RUNNING')).limit(1).get()
      if (running) throw new RemedyRefused('a job is running — try again once it finishes', 409)

      domain({
        level: 'warn',
        actor: 'human',
        code: 'DESK_RESTART_REQUESTED',
        message: 'you asked the desk to restart itself',
      })
      // Scheduled rather than immediate, so the reply reaches the browser
      // before the process goes away.
      setTimeout(() => deps.restart?.(), 250).unref()
      return {
        status: 'applied',
        kind: remedy.kind,
        outcome: 'the desk is restarting',
        next: { action: 'wait-for-restart' },
      }
    }

    default:
      throw new RemedyRefused('that proposal is of a kind this build does not know', 422)
  }
}

export function dismissRemedy(db: Db, remedyId: string): void {
  const row = db.select().from(schema.remedies).where(eq(schema.remedies.id, remedyId)).get()
  if (!row) throw new RemedyRefused('no such proposal', 404)
  if (row.status !== 'PROPOSED') {
    throw new RemedyRefused(`this proposal was already ${row.status.toLowerCase()}`, 409)
  }
  db.update(schema.remedies).set({ status: 'DISMISSED' }).where(eq(schema.remedies.id, remedyId)).run()
}
