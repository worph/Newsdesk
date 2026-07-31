import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Schema per IMPLEMENTATION.md section 3. Timestamps are ISO-8601 UTC text.
 * JSON columns hold driver-specific blobs.
 *
 * Note what is deliberately absent: there is NO uniqueness constraint on
 * incoming content. Deduplication is the managing editor's judgement, recorded on the
 * story with its reason and the ids it compared against.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

// ── configuration ───────────────────────────────────────────────────────────

export const mcpEndpoints = sqliteTable('mcp_endpoints', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  auth: text('auth'),
  /** Discovered servers/tools/schemas. An authoring aid, never an outbound validator. */
  catalogue: text('catalogue'),
  discoveredAt: text('discovered_at'),
  status: text('status'),
})

export const voices = sqliteTable('voices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tone: text('tone').notNull(),
  audience: text('audience').notNull(),
  rules: text('rules'),
  examples: text('examples'),
})

export const stringers = sqliteTable('stringers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // report | timeline | snapshot | tip
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  hint: text('hint'),
  /** Last considered timestamp, for timeline stringers. */
  watermark: text('watermark'),
  /** Previous body, for snapshot stringers, so the managing editor is handed the change. */
  lastSnapshot: text('last_snapshot'),
  createdAt: text('created_at').notNull().default(now),
})

export const outlets = sqliteTable('outlets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** The managing editor reads this to decide what belongs here. */
  description: text('description').notNull(),
  role: text('role').notNull().default('publish'), // publish | notify
  driver: text('driver').notNull().default('mcp'), // mcp | webhook | builtin
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  voiceId: text('voice_id').references(() => voices.id),
  endpointId: text('endpoint_id').references(() => mcpEndpoints.id),
  tool: text('tool'),
  destinationKey: text('destination_key'),
  /** JSON: each key is literal | derived | slot. */
  argsSpec: text('args_spec').notNull(),
})

/** Append-only; the latest row wins. */
export const charter = sqliteTable('charter', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull().default(now),
  author: text('author').notNull(),
})

// ── content ─────────────────────────────────────────────────────────────────

export const filings = sqliteTable(
  'filings',
  {
    id: text('id').primaryKey(),
    stringerId: text('stringer_id')
      .notNull()
      .references(() => stringers.id),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    /** The slice actually sent to the managing editor, after watermark or snapshot diff. */
    considered: text('considered'),
    /**
     * JSON: the story file the reporter produced, for filings that were
     * reported. A third column rather than a rewrite of the two above, because
     * they answer different questions: `text` is what a human wrote,
     * `considered` is the deterministic slice of it, and this is what the desk
     * went and found. Conflating them would make "what you filed" and "what we
     * produced" indistinguishable.
     */
    dossier: text('dossier'),
    reportedAt: text('reported_at'),
    refs: text('refs'),
    filedAt: text('filed_at'),
    receivedAt: text('received_at').notNull().default(now),
    status: text('status').notNull(), // RECEIVED|REPORTING|PROCESSING|PROCESSED|FAILED
    outcome: text('outcome'),
  },
  (t) => [index('filings_status_idx').on(t.status), index('filings_stringer_idx').on(t.stringerId)],
)

/**
 * Every page the desk actually retrieved while reporting a filing.
 *
 * This is the records half of reporting, and it is what makes a citation
 * verifiable: a row exists because we fetched it, so a url the model invented
 * has nowhere to appear. The reporter validates its sourced claims against
 * this table before storing a dossier.
 */
export const dossierSources = sqliteTable(
  'dossier_sources',
  {
    id: text('id').primaryKey(),
    filingId: text('filing_id')
      .notNull()
      .references(() => filings.id),
    url: text('url').notNull(),
    title: text('title'),
    /** How we came to it: carried by the tip, or surfaced by a search. */
    via: text('via').notNull(), // tip | search
    /** The query that surfaced it, when via = search. */
    query: text('query'),
    /** Whether the retrieval actually succeeded — a dead link is still a record. */
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    chars: integer('chars'),
    fetchedAt: text('fetched_at').notNull().default(now),
  },
  (t) => [index('dossier_sources_filing_idx').on(t.filingId)],
)

export const stories = sqliteTable(
  'stories',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    /** What the managing editor understood; the writers' factual basis. */
    summary: text('summary').notNull(),
    body: text('body'),
    url: text('url'),
    status: text('status').notNull(), // PROPOSED|PLACED|DROPPED|HELD|CLOSED
    dedupVerdict: text('dedup_verdict').notNull(), // NEW | DUPLICATE | UPDATE
    dedupReason: text('dedup_reason'),
    relatedStoryId: text('related_story_id'),
    /** JSON: the ids the verdict was made against. */
    comparedIds: text('compared_ids'),
    /** Coarse and cosmetic: sorts the queue, never filters. */
    label: text('label'),
    dropReason: text('drop_reason'),
    /** Why a HELD story is held: what the filing did not carry. */
    holdReason: text('hold_reason'),
    /** JSON snapshot of the managing editor's calls, kept for the override diff. */
    proposedPlacements: text('proposed_placements'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('stories_status_idx').on(t.status), index('stories_created_idx').on(t.createdAt)],
)

/** Many-to-many: redundancy across sources is a feature, not waste. */
export const storyFilings = sqliteTable(
  'story_filings',
  {
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id),
    filingId: text('filing_id')
      .notNull()
      .references(() => filings.id),
  },
  (t) => [primaryKey({ columns: [t.storyId, t.filingId] })],
)

/** The story x outlet ledger. */
export const publications = sqliteTable(
  'publications',
  {
    id: text('id').primaryKey(),
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id),
    outletId: text('outlet_id')
      .notNull()
      .references(() => outlets.id),
    status: text('status').notNull(),
    /** 'managing-editor' | 'human' — was this placement proposed, or added by the editor? */
    origin: text('origin').notNull(),
    placementReason: text('placement_reason'),
    /** The managing editor's note to the writer. */
    angle: text('angle'),
    /** JSON: current authored slot values. */
    slots: text('slots'),
    /** JSON: merged and frozen at approval, sent verbatim. */
    payload: text('payload'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    error: text('error'),
    approvedAt: text('approved_at'),
    publishedAt: text('published_at'),
  },
  (t) => [
    uniqueIndex('publications_story_outlet_idx').on(t.storyId, t.outletId),
    index('publications_status_idx').on(t.status),
  ],
)

/** Every copy-desk edit and manual save. Safety lives here, not in an accept ceremony. */
export const draftVersions = sqliteTable(
  'draft_versions',
  {
    id: text('id').primaryKey(),
    publicationId: text('publication_id')
      .notNull()
      .references(() => publications.id),
    slots: text('slots').notNull(),
    origin: text('origin').notNull(), // writer | copy-desk | human
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('draft_versions_pub_idx').on(t.publicationId)],
)

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    publicationId: text('publication_id')
      .notNull()
      .references(() => publications.id),
    role: text('role').notNull(), // user | assistant
    content: text('content').notNull(),
    versionId: text('version_id').references(() => draftVersions.id),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('chat_messages_pub_idx').on(t.publicationId)],
)

// ── operations ──────────────────────────────────────────────────────────────

/** DB-backed queue, so a restart resumes and a 409 just waits. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // assign | write | publish
    refId: text('ref_id').notNull(),
    status: text('status').notNull(), // PENDING|RUNNING|DONE|FAILED
    attempts: integer('attempts').notNull().default(0),
    runAfter: text('run_after').notNull().default(now),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('jobs_status_runafter_idx').on(t.status, t.runAfter)],
)

/** Append-only audit and error log. Authoritative — external alerting is best-effort. */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull().default(now),
    level: text('level').notNull(), // debug|info|warn|error
    actor: text('actor').notNull(), // system | human
    code: text('code').notNull(),
    storyId: text('story_id'),
    publicationId: text('publication_id'),
    message: text('message').notNull(),
    detail: text('detail'),
  },
  (t) => [index('events_at_idx').on(t.at), index('events_level_idx').on(t.level)],
)

export const inferenceCalls = sqliteTable('inference_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: text('at').notNull().default(now),
  purpose: text('purpose').notNull(), // managing-editor | writer | copy-desk
  refId: text('ref_id'),
  durationMs: integer('duration_ms'),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  error: text('error'),
})

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  keys: text('keys').notNull(),
  ua: text('ua'),
  createdAt: text('created_at').notNull().default(now),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
