import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { categoryOf, type EventCategory, type EventLevel } from '../events.js'
import { probeEndpoint, type EndpointHealth } from '../health.js'
import { getSetting, SETTING } from '../settings.js'

/**
 * Everything the assistant is told about one failure.
 *
 * This is the read side of the feature, and it is where all the power lives —
 * the model itself has none. It cannot call anything; it is handed a document
 * and asked what it thinks. That is what makes the single-shot design safe
 * enough to hand attacker-influenced text to.
 *
 * The rule for every field below is **allowlist, never denylist**. `detail`
 * blobs are written by three dozen call sites and a scrub pass over them would
 * miss one; projecting only what is named here cannot.
 */

/** Below these, a large error body would push the actual question out of the window. */
const LIMITS = {
  detailChars: 4_000,
  neighbourMessageChars: 200,
  neighbours: 30,
  filingChars: 2_000,
  totalChars: 24_000,
} as const

/**
 * Settings the assistant may see. Everything else in that table is a secret or
 * on its way to being one, so the list is what is allowed rather than what is
 * forbidden.
 */
const READABLE_SETTINGS = [
  SETTING.timezone,
  SETTING.reporting,
  SETTING.configImportedAt,
  'vapid_public_key',
  'vapid_subject',
  'last_boot',
] as const

export interface BundleEvent {
  id: number
  at: string
  level: EventLevel
  category: EventCategory
  actor: string
  code: string
  message: string
  detail: unknown
}

export interface ErrorBundle {
  event: BundleEvent
  /** What else the desk was doing around it. */
  neighbours: { at: string; level: string; code: string; message: string }[]
  story?: { id: string; title: string; status: string; summary: string }
  publication?: {
    id: string
    status: string
    outletId: string
    outletName: string
    /** Names only. An argument VALUE can carry a channel id or a token. */
    outletArgKeys: string[]
    driver: string
    tool: string | null
    endpointId: string | null
    error: string | null
    scheduledFor: string | null
  }
  filing?: { id: string; stringerId: string; stringerName: string; kind: string; status: string; excerpt: string }
  job?: { id: string; kind: string; status: string; attempts: number; lastError: string | null; runAfter: string }
  /** How the desk's own thinking has been going. Often the whole answer. */
  inference: { at: string; purpose: string; ok: boolean; durationMs: number | null; error: string | null }[]
  /** Live, and only for the endpoints on the failing path. */
  probes: EndpointHealth[]
  config: {
    outlets: { id: string; name: string; enabled: boolean; role: string; driver: string; endpointId: string | null; tool: string | null }[]
    stringers: { id: string; name: string; kind: string; enabled: boolean }[]
    endpoints: { id: string; name: string; origin: string; connected: boolean }[]
    settings: Record<string, string>
  }
  /** True when something above was cut to fit. The prompt is told to expect it. */
  truncated: boolean
}

function clip(text: string, max: number): { text: string; clipped: boolean } {
  return text.length <= max ? { text, clipped: false } : { text: text.slice(0, max), clipped: true }
}

/**
 * An endpoint URL reduced to scheme and host.
 *
 * Some MCP bridges carry a token in the query string, and a URL is not the
 * kind of value anyone thinks of as a credential — which is exactly why it
 * has to be handled as one here.
 */
function origin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return '(unparseable url)'
  }
}

/**
 * The last line of defence.
 *
 * Everything above is an allowlist, so in principle no secret reaches this
 * point. In practice a call site may have logged one into `detail`, and these
 * are known literal strings, so replacing them costs nothing and closes the
 * one hole the allowlist cannot see.
 */
function scrubKnownSecrets(db: Db, serialised: string): string {
  let out = serialised
  for (const key of [SETTING.ingestToken, SETTING.sessionSecret, SETTING.adminPasswordHash, 'vapid_private_key']) {
    const value = getSetting(db, key)
    if (value && value.length >= 8) out = out.split(value).join('[redacted]')
  }
  return out
}

export interface BundleOptions {
  /**
   * How long to wait on each live probe.
   *
   * Shorter than /healthz's, deliberately: that answers an orchestrator which
   * can wait, and this one is on a path where somebody is watching a spinner.
   * An endpoint that has not answered in two and a half seconds is a fact
   * worth reporting on its own.
   */
  probeTimeoutMs?: number
}

export function buildErrorBundle(
  db: Db,
  eventId: number,
  options: BundleOptions = {},
): Promise<ErrorBundle | undefined> {
  return build(db, eventId, options)
}

async function build(db: Db, eventId: number, options: BundleOptions): Promise<ErrorBundle | undefined> {
  const row = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get()
  if (!row) return undefined

  let truncated = false
  const detailRaw = row.detail ?? ''
  const detailClip = clip(detailRaw, LIMITS.detailChars)
  truncated ||= detailClip.clipped

  let detail: unknown = null
  try {
    detail = detailClip.clipped ? { truncated: true, raw: detailClip.text } : JSON.parse(detailRaw || 'null')
  } catch {
    detail = { unparseable: detailClip.text }
  }

  const event: BundleEvent = {
    id: row.id,
    at: row.at,
    level: row.level as EventLevel,
    category: categoryOf(row.code),
    actor: row.actor,
    code: row.code,
    message: row.message,
    detail,
  }

  // What else was happening: the rows just before it, plus everything about
  // the same story or placement whenever it happened.
  const related = [
    lt(schema.events.id, eventId),
    ...(row.storyId ? [eq(schema.events.storyId, row.storyId)] : []),
    ...(row.publicationId ? [eq(schema.events.publicationId, row.publicationId)] : []),
  ]
  const neighbours = db
    .select({
      at: schema.events.at,
      level: schema.events.level,
      code: schema.events.code,
      message: schema.events.message,
    })
    .from(schema.events)
    .where(and(or(...related), lt(schema.events.id, eventId)))
    .orderBy(desc(schema.events.id))
    .limit(LIMITS.neighbours)
    .all()
    .map((neighbour) => {
      const message = clip(neighbour.message, LIMITS.neighbourMessageChars)
      truncated ||= message.clipped
      return { ...neighbour, message: message.text }
    })

  const bundle: ErrorBundle = {
    event,
    neighbours,
    inference: [],
    probes: [],
    config: { outlets: [], stringers: [], endpoints: [], settings: {} },
    truncated,
  }

  if (row.storyId) {
    const story = db.select().from(schema.stories).where(eq(schema.stories.id, row.storyId)).get()
    if (story) {
      bundle.story = {
        id: story.id,
        title: story.title,
        status: story.status,
        summary: clip(story.summary, LIMITS.filingChars).text,
      }
    }
  }

  if (row.publicationId) {
    const publication = db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, row.publicationId))
      .get()
    if (publication) {
      const outlet = db
        .select()
        .from(schema.outlets)
        .where(eq(schema.outlets.id, publication.outletId))
        .get()
      bundle.publication = {
        id: publication.id,
        status: publication.status,
        outletId: publication.outletId,
        outletName: outlet?.name ?? publication.outletId,
        // Keys only. A value here is a channel id, a webhook, or worse.
        outletArgKeys: outlet ? Object.keys(JSON.parse(outlet.argsSpec) as Record<string, unknown>) : [],
        driver: outlet?.driver ?? 'unknown',
        tool: outlet?.tool ?? null,
        endpointId: outlet?.endpointId ?? null,
        error: publication.error,
        scheduledFor: publication.scheduledFor,
      }
    }
  }

  const filingId = typeof detail === 'object' && detail !== null ? (detail as { filingId?: unknown }).filingId : undefined
  if (typeof filingId === 'string') {
    const filing = db.select().from(schema.filings).where(eq(schema.filings.id, filingId)).get()
    if (filing) {
      const stringer = db
        .select()
        .from(schema.stringers)
        .where(eq(schema.stringers.id, filing.stringerId))
        .get()
      const excerpt = clip(filing.text, LIMITS.filingChars)
      truncated ||= excerpt.clipped
      bundle.filing = {
        id: filing.id,
        stringerId: filing.stringerId,
        stringerName: stringer?.name ?? filing.stringerId,
        kind: filing.kind,
        status: filing.status,
        excerpt: excerpt.text,
      }
    }
  }

  const jobId = typeof detail === 'object' && detail !== null ? (detail as { jobId?: unknown }).jobId : undefined
  if (typeof jobId === 'string') {
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get()
    if (job) {
      bundle.job = {
        id: job.id,
        kind: job.kind,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        runAfter: job.runAfter,
      }
    }
  }

  bundle.inference = db
    .select()
    .from(schema.inferenceCalls)
    .orderBy(desc(schema.inferenceCalls.id))
    .limit(10)
    .all()
    .map((call) => ({
      at: call.at,
      purpose: call.purpose,
      ok: call.ok,
      durationMs: call.durationMs,
      error: call.error,
    }))

  // Never `select()` the whole row: it carries the OAuth token. The projection
  // is the discipline health.ts already keeps for the same reason.
  const endpoints = db
    .select({
      id: schema.mcpEndpoints.id,
      name: schema.mcpEndpoints.name,
      url: schema.mcpEndpoints.url,
      auth: schema.mcpEndpoints.auth,
    })
    .from(schema.mcpEndpoints)
    .all()

  bundle.config = {
    outlets: db
      .select()
      .from(schema.outlets)
      .all()
      .map((outlet) => ({
        id: outlet.id,
        name: outlet.name,
        enabled: outlet.enabled,
        role: outlet.role,
        driver: outlet.driver,
        endpointId: outlet.endpointId,
        tool: outlet.tool,
      })),
    stringers: db
      .select()
      .from(schema.stringers)
      .all()
      .map((stringer) => ({
        id: stringer.id,
        name: stringer.name,
        kind: stringer.kind,
        enabled: stringer.enabled,
      })),
    endpoints: endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      origin: origin(endpoint.url),
      connected: Boolean(endpoint.auth),
    })),
    settings: Object.fromEntries(
      db
        .select()
        .from(schema.settings)
        .where(inArray(schema.settings.key, [...READABLE_SETTINGS]))
        .all()
        .map((setting) => [setting.key, setting.value]),
    ),
  }

  /**
   * Only the endpoints on the failing path, not all of them: each probe costs
   * up to four seconds and a human is waiting. `probeEndpoint` is written to
   * report on a broken port rather than fail with it, which is exactly the
   * property wanted when the whole reason we are here is that something is
   * broken.
   */
  const onPath = new Set<string>()
  if (bundle.publication?.endpointId) onPath.add(bundle.publication.endpointId)
  const detailEndpoint =
    typeof detail === 'object' && detail !== null ? (detail as { endpointId?: unknown }).endpointId : undefined
  if (typeof detailEndpoint === 'string') onPath.add(detailEndpoint)
  // A failure of the desk's own thinking is a failure of whatever endpoint
  // serves it, and that is worth probing even when nothing named it.
  if (bundle.event.category === 'ports' && endpoints.length === 1 && endpoints[0]) {
    onPath.add(endpoints[0].id)
  }

  bundle.probes = await Promise.all(
    endpoints
      .filter((endpoint) => onPath.has(endpoint.id))
      .map((endpoint) => probeEndpoint(endpoint, options.probeTimeoutMs ?? 2_500)),
  )

  return bundle
}

/**
 * The bundle as the prompt will carry it, with the secret sweep applied and
 * a hash so two runs over changed state are distinguishable.
 */
export function serialiseBundle(db: Db, bundle: ErrorBundle): { json: string; sha256: string } {
  let json = scrubKnownSecrets(db, JSON.stringify(bundle, null, 2))
  if (json.length > LIMITS.totalChars) {
    json = `${json.slice(0, LIMITS.totalChars)}\n… (truncated)`
  }
  return { json, sha256: createHash('sha256').update(json).digest('hex') }
}
