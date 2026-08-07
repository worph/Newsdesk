import {
  browserEngineSchema,
  mcpEndpointSchema,
  outletSchema,
  parseConfig,
  reportingSchema,
  stringerSchema,
  validateConfig,
  voiceSchema,
  type Config,
} from '@newsdesk/shared'
import { z } from 'zod'
import { listActions } from '../api/actions.js'
import { resolveTipStringer } from '../api/ingest.js'
import {
  ConfigRejected,
  configIssuesFrom,
  configToYaml,
  describeConfig,
  getConfigVersion,
  listConfigVersions,
  previewRestore,
  readConfig,
  restoreConfigVersion,
  writeConfig,
  yamlToConfig,
} from '../config/store.js'
import type { Db } from '../db/index.js'
import { listEvents, logEvent } from '../events.js'
import { checkHealth } from '../health.js'
import { receiveFilings, type ReceiveOptions } from '../ports/ingest/receive.js'
import { subscriptionCount } from '../push.js'
import { getSetting, getTimezone, SETTING, setSetting } from '../settings.js'

/**
 * The desk's administration tools, as data rather than as an MCP registration.
 *
 * Everything here is a thin wrapper over `config/store.js`, deliberately. That
 * module already validates, snapshots before every write and refuses removals
 * that content still references — so anything driving the desk gets the same
 * guarantees the Configuration screen does, including the way back. A tool that
 * reached past it to the tables would be a second definition of what a valid
 * desk is, and the first one to drift.
 *
 * What is NOT here is as deliberate. There is no approve, no publish, no spike:
 * a human between every draft and every channel is the product, and anything
 * that could send would delete it. Editorial content is not readable either —
 * this surface is configuration and diagnostics.
 *
 * Three things genuinely cannot be done from here, because they need a browser
 * a server does not have: authorising an MCP endpoint over OAuth (see
 * ports/mcp/oauth.ts), signing the publishing browser into a destination, and
 * changing the desk password.
 *
 * **Two callers, one list.** `admin/tools.ts` registers these on an MCP server;
 * `chat/loop.ts` dispatches them from the administrator chat. Keeping the
 * definitions here is what stops the two surfaces disagreeing about what a tool
 * takes, what it refuses, or what it records — which they would, the first time
 * one was tightened and the other was not.
 */

/** A tool result, in the shape an MCP content block already wants. */
export interface AdminToolResult {
  content: { type: 'text'; text: string }[]
  /**
   * Present and `true` on a refusal, never `false`.
   *
   * Typed that way so writing `isError: someBoolean` is a compile error: a
   * successful result that grew the key would be a change to what every MCP
   * caller sees.
   */
  isError?: true
  /**
   * The restore point this call took, when it took one.
   *
   * Read by the chat, which hangs an Undo off it. **Stripped by the MCP
   * adapter** — a `CallToolResult` has nowhere to put it, and passing it to the
   * SDK on the hope it is ignored is not a guarantee.
   */
  versionId?: number | null
}

/**
 * Who is driving.
 *
 * Every caller-specific string lives here rather than in a branch inside a
 * handler, so the MCP surface stays provably byte-identical to what it was
 * before these definitions were shared: the same restore-point author, the same
 * default reason on the version row, the same sentence in the log.
 */
export interface AdminCaller {
  /** Author on the restore point, and on the `CONFIG_CHANGED` row. */
  author: 'mcp' | 'chat'
  /** Subject of the log sentence: "an MCP client changed the charter". */
  phrase: string
  /** Tail of the default restore-point reason: "the charter, over MCP". */
  via: string
  /**
   * Whether secrets are shown in full. False for MCP, where the caller is a
   * sidecar that already holds a token; true for the chat, where the value
   * would land in a message row and a browser scrollback.
   */
  redactSecrets: boolean
}

export const MCP_CALLER: AdminCaller = {
  author: 'mcp',
  phrase: 'an MCP client',
  via: 'over MCP',
  redactSecrets: false,
}

export const CHAT_CALLER: AdminCaller = {
  author: 'chat',
  phrase: 'the administrator chat',
  via: 'in the chat',
  redactSecrets: true,
}

export interface AdminToolContext {
  db: Db
  /** Reported by `get_status`, and the only thing here that is not a row. */
  version: string
  /**
   * What a filed tip is handed on to. Absent means a tip is stored and goes no
   * further — which is what a desk with no inference does anyway, and is better
   * than refusing the tip.
   */
  receiveOptions?: ReceiveOptions
  caller: AdminCaller
}

type InputOf<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>

export interface AdminTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  /**
   * A raw zod shape, not a `ZodObject` — that is what `server.registerTool`
   * takes, and an in-process caller can wrap it with `z.object()` in one line.
   * Going the other way would cost the per-field `.describe()` for nothing.
   */
  inputSchema: S
  annotations?: { readOnlyHint?: true; destructiveHint?: true; idempotentHint?: true }
  /**
   * What the operator must type before the chat will run this, or absent when
   * the chat may run it unattended.
   *
   * Always something already on the proposal — an id, a collection name — so
   * confirming means having read the thing that is about to change. The same
   * rule `confirmationFor` follows for the error assistant's remedies.
   */
  confirmWith?: (input: InputOf<S>) => string
  handler: (input: InputOf<S>, ctx: AdminToolContext) => Promise<AdminToolResult>
}

/**
 * Keeps each entry's shape inferred inside the array.
 *
 * Without it the array widens to `AdminTool<ZodRawShape>` and every handler's
 * parameter becomes `unknown`. The cast is contravariance in the handler
 * position and is confined to this one line.
 */
function tool<S extends z.ZodRawShape>(spec: AdminTool<S>): AdminTool {
  return spec as unknown as AdminTool
}

/** JSON, as text, because that is what a tool result carries. */
function json(value: unknown): AdminToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** Prose, for the two answers a caller reads rather than parses. */
function said(text: string): AdminToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * A refusal the caller can act on.
 *
 * `isError` rather than a thrown exception: a model that gets the issues back
 * as a result can fix the document and call again, which is the entire reason
 * `validate_config` exists beside `write_config`.
 */
function refused(text: string, detail?: unknown): AdminToolResult {
  return {
    isError: true,
    content: [
      { type: 'text', text: detail === undefined ? text : `${text}\n${JSON.stringify(detail, null, 2)}` },
    ],
  }
}

/** What every write reports back: the document as it now stands. */
function saved(config: Config, what: string, versionId: number | null): AdminToolResult {
  return {
    ...json({ ok: true, changed: what, issues: validateConfig(config), yaml: configToYaml(config) }),
    versionId,
  }
}

/**
 * Read the configuration, change one thing about it, write it back.
 *
 * The read-modify-write is the point. `writeConfig` replaces the whole document
 * and deletes anything absent from it, so a tool that asked a model to restate
 * the configuration in order to change one outlet would make a truncated answer
 * indistinguishable from a deletion. Here the caller supplies only the entry it
 * means to change and the rest of the document is this process's own reading of
 * the database, which cannot be truncated.
 *
 * It is synchronous, and that is load-bearing rather than incidental: the read
 * and the write it derives from must not be separated by an await. better-
 * sqlite3 is synchronous and the loop is single-threaded, so nothing can
 * interleave between them and two concurrent upserts cannot lose one another's
 * change. Make this async and that stops being true silently — the second
 * writer would overwrite the first with a document read before it landed.
 */
function mutate(
  ctx: AdminToolContext,
  what: string,
  reason: string | undefined,
  change: (config: Config) => Config,
): AdminToolResult {
  let next: Config
  try {
    next = change(readConfig(ctx.db))
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err))
  }

  try {
    // The restore point the write took, so the row and the way back from it are
    // the same click apart. Null when the write changed nothing, and then there
    // is nothing to link to.
    const { config, versionId } = writeConfig(
      ctx.db,
      next,
      ctx.caller.author,
      reason ?? `${what}, ${ctx.caller.via}`,
    )
    logEvent(ctx.db, {
      level: 'info',
      code: 'CONFIG_CHANGED',
      message: `${ctx.caller.phrase} changed ${what}`,
      detail: {
        author: ctx.caller.author,
        summary: describeConfig(config),
        ...(versionId !== null ? { versionId } : {}),
      },
    })
    return saved(config, what, versionId)
  } catch (err) {
    if (err instanceof ConfigRejected) {
      // Nothing was written — writeConfig validates before it opens the
      // transaction — so this is a refusal to retry, not damage to repair.
      return refused('the configuration was rejected and nothing was written', err.issues)
    }
    // A shape failure from inside writeConfig lands here. Same treatment: a
    // path per problem, not a flattened ZodError nobody can act on.
    return refused('the configuration was rejected and nothing was written', configIssuesFrom(err))
  }
}

/** Replace the entry with this id, or append it. Order is otherwise kept. */
function upsertById<T extends { id: string }>(list: T[], entry: T): T[] {
  const at = list.findIndex((existing) => existing.id === entry.id)
  if (at === -1) return [...list, entry]
  return list.map((existing, index) => (index === at ? entry : existing))
}

const COLLECTIONS = ['voices', 'stringers', 'outlets', 'mcp_endpoints', 'browser_engines'] as const

const reason = z
  .string()
  .min(1)
  .optional()
  .describe('Why, in one sentence. Recorded on the restore point this write creates.')

/**
 * The catalogue, in order.
 *
 * **Registration order is `tools/list` order**, and a model reads that list top
 * down. Reordering this array changes what an MCP client sees, so it is asserted
 * as an ordered list in the tests rather than as a set.
 */
export const ADMIN_TOOLS: AdminTool[] = [
  // ── filing ──────────────────────────────────────────────────────────────

  /**
   * The one tool here that is not administration, and it earns its place.
   *
   * A tip is *ingest*: it puts something on the wire for the managing editor to
   * judge and a human to approve, and it publishes nothing. So it does not
   * cross the line the rest of this list holds — nothing here can still send.
   *
   * It also grants nothing new. `get_settings` already returns the ingest token
   * to an MCP caller, so one holding the administration token can already file
   * by POSTing to /api/v1/filings; this only saves the round trip.
   */
  tool({
    name: 'file_tip',
    title: 'File an article idea to the tip line',
    description:
      'Put an idea on the wire as a tip. It is stored, judged against the charter like any filing, and — if it is worth running — drafted for you to edit and approve. Nothing publishes from this. Names a stringer only when several tip stringers exist.',
    inputSchema: {
      text: z.string().min(1).describe('The idea, in free text. Depth is your business; the desk reads prose.'),
      url: z.string().url().optional().describe('A source link, if the idea came from somewhere.'),
      stringer_id: z
        .string()
        .min(1)
        .optional()
        .describe('Which tip stringer to file as. Only needed when the desk has more than one.'),
    },
    handler: async ({ text, url, stringer_id: stringerId }, ctx) => {
      const stringer = resolveTipStringer(ctx.db, stringerId)
      if ('error' in stringer) return refused(stringer.error)

      // The link goes in the text as well as in refs: the managing editor reads
      // prose, and a url it never sees is one it cannot weigh.
      const [result] = receiveFilings(
        ctx.db,
        [
          {
            stringer_id: stringer.id,
            kind: 'tip',
            text: url ? `${text}\n\n${url}` : text,
            ...(url ? { refs: { url } } : {}),
          },
        ],
        ctx.receiveOptions ?? {},
      )
      return json(result)
    },
  }),

  // ── reading ─────────────────────────────────────────────────────────────

  tool({
    name: 'get_config',
    title: 'Read the configuration',
    description:
      'The whole desk configuration — charter, voices, stringers, outlets, MCP endpoints, browser engines and the reporting block — as YAML, plus any validation issues it currently has. Start here.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const config = readConfig(ctx.db)
      return json({ yaml: configToYaml(config), issues: validateConfig(config) })
    },
  }),

  tool({
    name: 'validate_config',
    title: 'Check a configuration without saving it',
    description:
      'Parse and validate a candidate configuration document and report what is wrong with it. Touches nothing. Use this to iterate before calling write_config.',
    inputSchema: { yaml: z.string().min(1).describe('The candidate document, as YAML.') },
    annotations: { readOnlyHint: true },
    handler: async ({ yaml }) => {
      try {
        const { config, issues } = parseConfig(yamlToConfig(yaml))
        return json({ ok: issues.length === 0, issues, yaml: configToYaml(config) })
      } catch (err) {
        // A shape failure throws where a semantic one returns issues. Both are
        // reported the same way here, because the caller's next move is the
        // same either way: fix the field the path names and try again.
        return json({ ok: false, issues: configIssuesFrom(err) })
      }
    },
  }),

  tool({
    name: 'get_charter',
    title: 'Read the editorial charter',
    description:
      'The charter alone — the prose the managing editor places every story against. Cheaper to read than the whole configuration when the charter is what you are working on.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => said(readConfig(ctx.db).charter || '(no charter yet)'),
  }),

  tool({
    name: 'list_config_versions',
    title: 'List configuration restore points',
    description:
      'Every configuration snapshot, newest first. One is taken automatically before each write, so this is the undo history.',
    inputSchema: { limit: z.number().int().positive().max(200).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ limit }, ctx) => json({ versions: listConfigVersions(ctx.db, limit ?? 50) }),
  }),

  tool({
    name: 'get_config_version',
    title: 'Read one restore point',
    description: 'The full YAML of a stored configuration version.',
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: true },
    handler: async ({ id }, ctx) => {
      const version = getConfigVersion(ctx.db, id)
      return version ? json(version) : refused(`there is no configuration version ${id}`)
    },
  }),

  tool({
    name: 'preview_restore',
    title: 'See what restoring a version would do',
    description:
      'What would change, what would refuse to restore, and what would be lost for good — an MCP endpoint dropped by a restore loses its OAuth authorization, which no snapshot holds. Read this before restore_config_version.',
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: true },
    handler: async ({ id }, ctx) => {
      const preview = previewRestore(ctx.db, id)
      return preview ? json(preview) : refused(`there is no configuration version ${id}`)
    },
  }),

  tool({
    name: 'get_settings',
    title: 'Read the settings that are not configuration',
    description:
      'Timezone, the ingest token stringers file with, and how many devices are registered for push. These are properties of this installation rather than of what the desk publishes, which is why they are not in the configuration document.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => {
      const token = getSetting(ctx.db, SETTING.ingestToken) ?? ''
      const redact = ctx.caller.redactSecrets && token !== ''
      // Same key either way, so a model reads one shape. The extra keys appear
      // only when redacting, which keeps the MCP answer byte-identical.
      return json({
        timezone: getTimezone(ctx.db),
        ingestToken: redact ? `…${token.slice(-4)}` : token,
        ...(redact
          ? {
              ingestTokenRedacted: true,
              note: 'Only the last four characters are shown here. The whole token is on the Settings screen and cannot be read from this conversation.',
            }
          : {}),
        pushDevices: subscriptionCount(ctx.db),
      })
    },
  }),

  tool({
    name: 'get_status',
    title: 'Is the desk healthy',
    description:
      'Version, whether the desk is configured at all, and a live probe of every MCP endpoint — which is how you find out that inference or an outlet is unreachable or signed out.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_input, ctx) => json(await checkHealth(ctx.db, ctx.version)),
  }),

  /**
   * What the desk is waiting on a human for.
   *
   * Not a new capability — `listActions` already decides the wording, the verb
   * and the order for the /now screen and the notification that sends you
   * there. Reading it here rather than recomputing it is what stops a third
   * surface describing the same job differently.
   */
  tool({
    name: 'list_actions',
    title: 'What needs a decision right now',
    description:
      'Everything waiting on a human: drafts to approve, publications to send, failures to fix, questions to answer. Most overdue first, one verb each. This is what the desk would tell someone who just sat down.',
    inputSchema: { limit: z.number().int().positive().max(100).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ limit }, ctx) => {
      const actions = listActions(ctx.db, limit ?? 50)
      return json({
        actions,
        total: actions.length,
        overdue: actions.filter((action) => action.overdue).length,
      })
    },
  }),

  tool({
    name: 'read_log',
    title: 'Read the operations log',
    description:
      "The desk's own append-only log. The authoritative record of what happened and what broke — it keeps working when every port is down.",
    inputSchema: {
      minLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      category: z
        .enum(['pipeline', 'delivery', 'queue', 'editorial', 'config', 'ports', 'system', 'other'])
        .optional(),
      q: z.string().min(1).max(200).optional().describe('Substring match on the message.'),
      limit: z.number().int().positive().max(500).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async (query, ctx) => json(listEvents(ctx.db, { ...query, limit: query.limit ?? 50 })),
  }),

  // ── writing, one entry at a time ────────────────────────────────────────

  tool({
    name: 'set_charter',
    title: 'Rewrite the editorial charter',
    description:
      'Replace the charter prose. This is the placement policy: it decides what is newsworthy and where each story runs, so changing it changes every future verdict. The previous text is kept.',
    inputSchema: { charter: z.string().min(1), reason },
    annotations: { idempotentHint: true },
    handler: async ({ charter, reason: why }, ctx) =>
      mutate(ctx, 'the charter', why, (config) => ({ ...config, charter })),
  }),

  tool({
    name: 'upsert_voice',
    title: 'Add or update a voice',
    description:
      'A voice is how an outlet sounds — tone, audience, rules, examples. Supply the whole voice; an existing one with the same id is replaced.',
    inputSchema: { voice: voiceSchema, reason },
    handler: async ({ voice, reason: why }, ctx) =>
      mutate(ctx, `voice "${voice.id}"`, why, (config) => ({
        ...config,
        voices: upsertById(config.voices, voice),
      })),
  }),

  tool({
    name: 'upsert_stringer',
    title: 'Add or update a stringer',
    description:
      'A stringer is a source that files reports at POST /api/v1/filings. Supply the whole stringer; an existing one with the same id is replaced. Disable rather than remove one that has already filed.',
    inputSchema: { stringer: stringerSchema, reason },
    handler: async ({ stringer, reason: why }, ctx) =>
      mutate(ctx, `stringer "${stringer.id}"`, why, (config) => ({
        ...config,
        stringers: upsertById(config.stringers, stringer),
      })),
  }),

  tool({
    name: 'upsert_outlet',
    title: 'Add or update an outlet',
    description:
      'An outlet is a destination: its description is what the managing editor reads to decide what belongs there, and its args pin where a post actually lands. Supply the whole outlet; an existing one with the same id is replaced. A publish outlet must pin its destination as a literal or the save is refused.',
    inputSchema: { outlet: outletSchema, reason },
    handler: async ({ outlet, reason: why }, ctx) =>
      mutate(ctx, `outlet "${outlet.id}"`, why, (config) => ({
        ...config,
        outlets: upsertById(config.outlets, outlet),
      })),
  }),

  tool({
    name: 'upsert_mcp_endpoint',
    title: 'Add or update an MCP endpoint',
    description:
      'An MCP server the desk calls — a Beacon aggregator, usually. Adding one here does not authorize it: an endpoint that wants OAuth has to be connected from the Settings screen in a browser, which is not something this server can do for you.',
    inputSchema: { endpoint: mcpEndpointSchema, reason },
    handler: async ({ endpoint, reason: why }, ctx) =>
      mutate(ctx, `endpoint "${endpoint.id}"`, why, (config) => ({
        ...config,
        mcp_endpoints: upsertById(config.mcp_endpoints, endpoint),
      })),
  }),

  tool({
    name: 'upsert_browser_engine',
    title: 'Add or update a browser engine',
    description: 'A browser the desk can drive for outlets that have no API.',
    inputSchema: { engine: browserEngineSchema, reason },
    handler: async ({ engine, reason: why }, ctx) =>
      mutate(ctx, `browser engine "${engine.id}"`, why, (config) => ({
        ...config,
        browser_engines: upsertById(config.browser_engines, engine),
      })),
  }),

  tool({
    name: 'remove_config_entry',
    title: 'Remove one configuration entry',
    description:
      'Delete a voice, stringer, outlet, MCP endpoint or browser engine by id. Removal is refused when content still references it — a stringer that has filed or an outlet that has published must be disabled instead, not deleted. Removing an MCP endpoint destroys its OAuth authorization permanently.',
    inputSchema: { collection: z.enum(COLLECTIONS), id: z.string().min(1), reason },
    annotations: { destructiveHint: true },
    confirmWith: ({ id }) => id,
    handler: async ({ collection, id, reason: why }, ctx) =>
      mutate(ctx, `${collection} entry "${id}"`, why, (config) => {
        const list = config[collection]
        if (!list.some((entry) => entry.id === id)) {
          throw new Error(`there is no ${collection} entry with id "${id}"`)
        }
        // Rebuilt through the collection key rather than a switch, so adding a
        // collection to the configuration cannot leave a stale branch here.
        return { ...config, [collection]: list.filter((entry) => entry.id !== id) } as Config
      }),
  }),

  tool({
    name: 'set_reporting',
    title: 'Configure or switch off the reporting phase',
    description:
      'The phase that researches a filing before the managing editor reads it. Pass `reporting` to configure it, or omit it entirely to switch the phase off — tips then go straight to the managing editor. Listing a tool here IS the authorization to call it unattended.',
    inputSchema: { reporting: reportingSchema.optional(), reason },
    handler: async ({ reporting, reason: why }, ctx) =>
      mutate(ctx, reporting ? 'the reporting phase' : 'the reporting phase (switched off)', why, (config) => {
        const { reporting: _dropped, ...rest } = config
        return reporting ? { ...rest, reporting } : rest
      }),
  }),

  // ── writing the whole document ──────────────────────────────────────────

  tool({
    name: 'write_config',
    title: 'Replace the whole configuration',
    description:
      'Save a complete configuration document. This REPLACES everything: any outlet, voice, stringer, endpoint or engine absent from the document is deleted, and a dropped MCP endpoint loses its OAuth authorization for good. Prefer the upsert_* tools, which change one entry and leave the rest alone. Validate first. A restore point is taken before the write either way.',
    inputSchema: {
      yaml: z.string().min(1).describe('The complete document, as YAML.'),
      reason: z.string().min(1).describe('Why. Required here, because this tool can delete things.'),
    },
    annotations: { destructiveHint: true },
    confirmWith: () => 'replace',
    handler: async ({ yaml, reason: why }, ctx) => {
      let candidate: unknown
      try {
        candidate = yamlToConfig(yaml)
      } catch (err) {
        return refused('that document could not be parsed', configIssuesFrom(err))
      }
      return mutate(ctx, 'the whole configuration', why, () => candidate as Config)
    },
  }),

  tool({
    name: 'restore_config_version',
    title: 'Roll the configuration back',
    description:
      'Put a stored configuration version back. Call preview_restore first — a restore can be refused outright, and it can drop an MCP endpoint whose authorization cannot be recovered. The state being replaced is snapshotted first, so restoring a restore works.',
    inputSchema: { id: z.number().int().positive() },
    annotations: { destructiveHint: true },
    confirmWith: ({ id }) => String(id),
    handler: async ({ id }, ctx) => {
      const version = getConfigVersion(ctx.db, id)
      if (!version) return refused(`there is no configuration version ${id}`)
      try {
        const { config, versionId } = restoreConfigVersion(ctx.db, id, ctx.caller.author)
        logEvent(ctx.db, {
          level: 'info',
          code: 'CONFIG_RESTORED',
          message: `${ctx.caller.phrase} rolled the configuration back to how it stood at ${version.at}`,
          detail: {
            author: ctx.caller.author,
            restoredFromId: id,
            ...(versionId !== null ? { versionId } : {}),
          },
        })
        return saved(config, `restored version ${id}`, versionId)
      } catch (err) {
        if (err instanceof ConfigRejected) {
          return refused('that version cannot be restored, and nothing was written', err.issues)
        }
        return refused(err instanceof Error ? err.message : String(err))
      }
    },
  }),

  // ── settings ────────────────────────────────────────────────────────────

  tool({
    name: 'set_timezone',
    title: 'Set the desk timezone',
    description:
      'An IANA name. Every posting window and every slot the calendar has already proposed moves with it.',
    inputSchema: { timezone: z.string().min(1) },
    annotations: { idempotentHint: true },
    handler: async ({ timezone }, ctx) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone })
      } catch {
        return refused(`"${timezone}" is not a timezone this desk knows — use an IANA name like "Europe/Paris"`)
      }
      const previous = getTimezone(ctx.db)
      setSetting(ctx.db, SETTING.timezone, timezone)
      logEvent(ctx.db, {
        level: 'info',
        code: 'TIMEZONE_CHANGED',
        message: `the desk timezone is now ${timezone} — posting windows shift with it`,
        detail: { from: previous, to: timezone },
      })
      return said(`the desk timezone is now ${timezone}`)
    },
  }),
]

export function adminTool(name: string): AdminTool | undefined {
  return ADMIN_TOOLS.find((entry) => entry.name === name)
}
