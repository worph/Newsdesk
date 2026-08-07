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

/**
 * A browser the desk can drive. Configuration, exactly like an MCP endpoint —
 * the credentials it holds live in the container's own profile volume and are
 * never read by the desk (invariant 8).
 */
export const browserEngines = sqliteTable('browser_engines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiBase: text('api_base').notNull(),
  viewer: text('viewer').notNull().default('novnc'), // novnc | none
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
  /** browser driver: which browser drives it. */
  engineId: text('engine_id').references(() => browserEngines.id),
  /**
   * browser driver: the cookbook, prose and step lines together.
   *
   * Text rather than a parsed structure on purpose — it is a document the
   * operator edits, and the parse is cheap. Storing the parse would make the
   * prose and the steps two things that can disagree.
   */
  recipe: text('recipe'),
  /**
   * browser driver: how a publish here finishes — auto | tethered | detached.
   *
   * Null reads as `tethered`, which is what every browser outlet did before this
   * column existed, so an old row needs no backfill to keep behaving.
   *
   * It lives on the outlet rather than being inferred from the recipe's shape
   * because the two questions the recipe used to answer — who commits the send,
   * and when the browser gets involved — have different answers on a
   * destination that saves as you type. See docs/browser-publishing.md §3.
   */
  publish: text('publish'),
  /**
   * browser driver: this destination's terms require a person to press send.
   *
   * Refuses `publish: auto` at save time, permanently. Nullable rather than
   * defaulted so "never declared" stays distinguishable from "declared false" —
   * the first is an outlet nobody has thought about, the second is a decision.
   */
  requiresHuman: integer('requires_human', { mode: 'boolean' }),
  /**
   * JSON: the posting rhythm — window, days, spacing, daily cap. Read only by
   * the slot proposer, never by delivery, so an outlet without one still
   * publishes on demand exactly as before.
   */
  cadence: text('cadence'),
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
    /**
     * Who filed it: the managing editor reading the wire, or the desk itself
     * when you write and place a piece by hand.
     *
     * It is not decoration. A manual story carries no proposed placements, so
     * every placement on it is `origin: 'human'` — and anything measuring how
     * often you override the managing editor has to be able to leave those out,
     * or a desk that posts by hand reads as a managing editor getting it wrong
     * every time.
     */
    origin: text('origin').notNull().default('managing-editor'), // managing-editor | desk
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
    /**
     * When the frozen payload is due to go out. Null means it was approved to
     * send immediately — the behaviour before scheduling existed — so this is
     * a commitment and never a suggestion. The proposal the desk offers at
     * review is computed on request and deliberately not stored: one made
     * against yesterday's calendar would be wrong by the time anyone read it.
     */
    scheduledFor: text('scheduled_for'),
    /** The managing editor's read on how long this can wait. */
    urgency: text('urgency'), // breaking | normal | evergreen
    /**
     * When a browser outlet's page was actually composed and handed to the
     * operator. Null while AWAITING_SEND means the slot has come but nobody has
     * opened it yet — staging happens when they do, so nothing holds the
     * browser during the wait.
     */
    stagedAt: text('staged_at'),
    /**
     * Where a `detached` publish left its draft, read back from `## Verify` at
     * the moment it was filed.
     *
     * Deliberately its own column rather than `externalUrl`: `attest` overwrites
     * that one and `abandon` clears `stagedAt`, so neither can be trusted to
     * answer the only question that matters here — *does something already exist
     * at the destination?* `draftUrl !== null` is the one durable predicate no
     * other path resets, and it is what stops a reopened row filing a second
     * copy. See docs/browser-publishing.md §4.2.
     */
    draftUrl: text('draft_url'),
    /**
     * JSON: what the fields actually held when the operator confirmed.
     *
     * The frozen payload says what was approved; this says what the destination
     * received after a person worked on it. Keeping both is what makes the
     * `edited` grade a fact rather than a guess — see §2.
     */
    shipped: text('shipped'),
    /**
     * How the desk knows this went out: `verified` when a verify step found the
     * post, `attested` when the operator said so and the recipe had no way to
     * check, `edited` when the re-read at confirmation differed from the frozen
     * payload. All legitimate; any two being indistinguishable would not be.
     */
    evidence: text('evidence'), // verified | attested | edited
    publishedAt: text('published_at'),
  },
  (t) => [
    uniqueIndex('publications_story_outlet_idx').on(t.storyId, t.outletId),
    index('publications_status_idx').on(t.status),
    index('publications_scheduled_idx').on(t.scheduledFor),
  ],
)

/**
 * Every step the desk took inside a browser to publish something.
 *
 * The records half of browser publishing, and the sibling of
 * `dossier_sources`: a row exists because the thing actually happened, which is
 * what makes the audit claim worth anything. It is also the injection log —
 * the desk is acting on a live page full of other people's text, and invariant
 * 4 says pages a model or a driver read must be recorded.
 *
 * The row that matters most is the byte comparison: `detail` carries the hash
 * of the frozen payload and the hash of what was actually read back out of the
 * field, which is the evidence invariant 2 held.
 */
export const publishTraces = sqliteTable(
  'publish_traces',
  {
    id: text('id').primaryKey(),
    publicationId: text('publication_id')
      .notNull()
      .references(() => publications.id),
    at: text('at').notNull().default(now),
    phase: text('phase').notNull(), // stage | handover | verify
    action: text('action').notNull(), // navigate | wait | click | fill | read | screenshot | compare
    selector: text('selector'),
    url: text('url'),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    detail: text('detail'),
    /** Path under the data dir; the image itself is never in the database. */
    screenshotPath: text('screenshot_path'),
  },
  (t) => [index('publish_traces_pub_idx').on(t.publicationId)],
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

/**
 * What the configuration was, immediately before each write that changed it.
 *
 * `writeConfig` deletes and re-upserts outlets, voices, stringers and
 * endpoints in one transaction, so without this a bad save — by hand or
 * proposed by the assistant — has no way back. The snapshot is taken inside
 * that same transaction, before the first delete: taken outside it, there is a
 * window at exactly the moment a crash is likeliest.
 *
 * The whole document rather than a diff. It is a few kilobytes, and a diff
 * chain is only as good as every link in it — which is the wrong property for
 * the one table whose entire job is to work when something has gone wrong.
 *
 * Note what is deliberately NOT here: `mcp_endpoints.auth`. The OAuth token is
 * not part of the configuration surface (`readConfig` projects id/name/url),
 * and putting it here would copy the one credential the desk holds into a
 * second, historical, never-pruned table. The consequence — that restoring
 * over a deleted endpoint cannot bring its connection back — is surfaced as a
 * warning on the restore preview instead.
 */
export const configVersions = sqliteTable(
  'config_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull().default(now),
    /** ui | config.yaml | assistant | restore — who asked for the write this precedes. */
    author: text('author').notNull(),
    /** Why, in a sentence: "before assistant remedy 12 — disable the failing outlet". */
    reason: text('reason'),
    /** The document as it stood BEFORE the write. */
    yaml: text('yaml').notNull(),
    sha256: text('sha256').notNull(),
    /** Set when this snapshot was itself taken ahead of a restore. */
    restoredFromId: integer('restored_from_id'),
  },
  (t) => [index('config_versions_at_idx').on(t.at)],
)

/**
 * One run of the error assistant against one event.
 *
 * Stored rather than kept in the browser, which is the opposite of the tip
 * desk and for one reason: a tip desk answer is a note the human already owns,
 * while this produces proposals that change desk state minutes later. If the
 * remedies lived only in the client, applying one would mean the server
 * accepting a model-authored payload from a request body — and "a model's
 * output becomes a database row, never an action" would be enforced nowhere.
 * Persisting inverts it: apply takes an id and re-reads what the server itself
 * validated.
 *
 * The second reason is invariant 7. A diagnosis that evaporates on refresh is
 * useless in exactly the situation this screen exists for.
 */
export const assistSessions = sqliteTable(
  'assist_sessions',
  {
    id: text('id').primaryKey(),
    /** Integer, because `events.id` is an autoincrement primary key. */
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    at: text('at').notNull().default(now),
    status: text('status').notNull(), // OK | FAILED
    diagnosis: text('diagnosis'),
    confidence: text('confidence'), // high | medium | low
    /** Hash of the context it saw, so a second run over changed state is distinguishable. */
    bundleSha: text('bundle_sha'),
    /** JSON: proposals the server refused after the model returned them, and why. */
    rejected: text('rejected'),
    error: text('error'),
  },
  (t) => [index('assist_sessions_event_idx').on(t.eventId)],
)

/** A single proposal. Applied by id, never by payload. */
export const remedies = sqliteTable(
  'remedies',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => assistSessions.id),
    kind: text('kind').notNull(),
    /**
     * safe | high — derived server-side from the kind and the fields it
     * touches, never read from the model or the browser.
     */
    risk: text('risk').notNull().default('safe'),
    title: text('title').notNull(),
    rationale: text('rationale').notNull(),
    /** JSON, already validated against the schema for this kind. */
    payload: text('payload').notNull(),
    status: text('status').notNull().default('PROPOSED'), // PROPOSED|APPLIED|DISMISSED|FAILED
    appliedAt: text('applied_at'),
    /** The log row this remedy's own apply wrote. The audit trail in one column. */
    appliedEventId: integer('applied_event_id').references(() => events.id),
    error: text('error'),
  },
  (t) => [index('remedies_session_idx').on(t.sessionId), index('remedies_status_idx').on(t.status)],
)

// ── the administrator chat ──────────────────────────────────────────────────

/**
 * One conversation with the administrator.
 *
 * There is no thread list and no title: the operator sees one chat, and the
 * newest thread is it. A new one starts when the newest has been idle long
 * enough (see chat/thread.ts), which is what keeps the prompt's history window
 * honest — in a single unbounded thread the model silently stops seeing
 * exchanges that are still on screen.
 */
export const adminThreads = sqliteTable('admin_threads', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull().default(now),
  /** Last message. The idle roll reads this and nothing else. */
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * Every turn, including the tool calls.
 *
 * Tool turns are rows rather than hidden state because the thread *is* the
 * audit trail a human reads, and because the step the operator sees and the
 * step the model is shown next round have to be the same row or they will
 * disagree.
 */
export const adminMessages = sqliteTable(
  'admin_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => adminThreads.id),
    role: text('role').notNull(), // user | assistant | tool
    content: text('content').notNull(),
    /** For role=tool: which catalogue entry ran, and what it was given. */
    toolName: text('tool_name'),
    toolInput: text('tool_input', { mode: 'json' }),
    /** For role=tool: whether it succeeded. Null on the other roles. */
    ok: integer('ok', { mode: 'boolean' }),
    /**
     * What the operator must type before a proposed destructive call will run.
     * Set only on the rows that are offers rather than results.
     */
    confirmWith: text('confirm_with'),
    /**
     * The restore point this call created, so the row can offer an undo.
     *
     * Deliberately no foreign key: a purged or missing version must not stop a
     * message being written, and the row is a pointer for a link, not a claim
     * that the version still exists.
     */
    versionId: integer('version_id'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('admin_messages_thread_idx').on(t.threadId, t.createdAt)],
)
