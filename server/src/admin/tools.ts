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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
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
import { resolveTipStringer } from '../api/ingest.js'
import { receiveFilings, type ReceiveOptions } from '../ports/ingest/receive.js'
import { subscriptionCount } from '../push.js'
import { getSetting, getTimezone, SETTING, setSetting } from '../settings.js'

/**
 * The desk as an MCP server: administration, and nothing else.
 *
 * Everything here is a thin wrapper over `config/store.js`, deliberately. That
 * module already validates, snapshots before every write and refuses removals
 * that content still references — so an agent driving the desk gets the same
 * guarantees the Configuration screen does, including the way back. A tool
 * that reached past it to the tables would be a second definition of what a
 * valid desk is, and the first one to drift.
 *
 * What is NOT here is as deliberate. There is no approve, no publish, no
 * spike: a human between every draft and every channel is the product, and an
 * agent that could send would delete it. Editorial content is not readable
 * either — this surface is configuration and diagnostics.
 *
 * Three things genuinely cannot be done from here, because they need a
 * browser a server does not have: authorising an MCP endpoint over OAuth
 * (see ports/mcp/oauth.ts), signing the publishing browser into a
 * destination, and changing the desk password.
 */

/** JSON, as text, because that is what a tool result carries. */
function json(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function said(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * A refusal the caller can act on.
 *
 * `isError` rather than a thrown exception: a model that gets the issues back
 * as a result can fix the document and call again, which is the entire reason
 * `validate_config` exists beside `write_config`.
 */
function refused(text: string, detail?: unknown) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: detail === undefined ? text : `${text}\n${JSON.stringify(detail, null, 2)}` },
    ],
  }
}

/** What every write reports back: the document as it now stands. */
function saved(config: Config, what: string) {
  return json({ ok: true, changed: what, issues: validateConfig(config), yaml: configToYaml(config) })
}

/**
 * Read the configuration, change one thing about it, write it back.
 *
 * The read-modify-write is the point. `writeConfig` replaces the whole
 * document and deletes anything absent from it, so a tool that asked a model
 * to restate the configuration in order to change one outlet would make a
 * truncated answer indistinguishable from a deletion. Here the model supplies
 * only the entry it means to change and the rest of the document is this
 * process's own reading of the database, which cannot be truncated.
 *
 * It is synchronous, and that is load-bearing rather than incidental: the read
 * and the write it derives from must not be separated by an await. better-
 * sqlite3 is synchronous and the loop is single-threaded, so nothing can
 * interleave between them and two concurrent upserts cannot lose one another's
 * change. Make this async and that stops being true silently — the second
 * writer would overwrite the first with a document read before it landed.
 */
function mutate(db: Db, what: string, reason: string | undefined, change: (config: Config) => Config) {
  let next: Config
  try {
    next = change(readConfig(db))
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err))
  }

  try {
    const config = writeConfig(db, next, 'mcp', reason ?? `${what}, over MCP`)
    // The restore point writeConfig just took, so the row and the way back
    // from it are the same click apart — as they are for a save from the UI.
    const restorePoint = listConfigVersions(db, 1)[0]
    logEvent(db, {
      level: 'info',
      code: 'CONFIG_CHANGED',
      message: `an MCP client changed ${what}`,
      detail: {
        author: 'mcp',
        summary: describeConfig(config),
        ...(restorePoint ? { versionId: restorePoint.id } : {}),
      },
    })
    return saved(config, what)
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

export interface AdminToolOptions {
  /** Reported by `get_status`, and the only thing here that is not a row. */
  version: string
  /**
   * What a filed tip is handed on to. Absent means a tip is stored and goes no
   * further — which is what a desk with no inference does anyway, and is
   * better than refusing the tip.
   */
  receiveOptions?: ReceiveOptions
}

export function registerAdminTools(server: McpServer, db: Db, options: AdminToolOptions): void {
  // ── filing ────────────────────────────────────────────────────────────────

  /**
   * The one tool here that is not administration, and it earns its place.
   *
   * A tip is *ingest*: it puts something on the wire for the managing editor
   * to judge and a human to approve, and it publishes nothing. So it does not
   * cross the line the rest of this file holds — nothing here can still send.
   *
   * It also grants nothing new. `get_settings` already returns the ingest
   * token, so a caller holding the administration token can already file by
   * POSTing to /api/v1/filings; this only saves the round trip.
   */
  server.registerTool(
    'file_tip',
    {
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
    },
    async ({ text, url, stringer_id: stringerId }) => {
      const stringer = resolveTipStringer(db, stringerId)
      if ('error' in stringer) return refused(stringer.error)

      // The link goes in the text as well as in refs: the managing editor
      // reads prose, and a url it never sees is one it cannot weigh.
      const [result] = receiveFilings(
        db,
        [
          {
            stringer_id: stringer.id,
            kind: 'tip',
            text: url ? `${text}\n\n${url}` : text,
            ...(url ? { refs: { url } } : {}),
          },
        ],
        options.receiveOptions ?? {},
      )
      return json(result)
    },
  )

  // ── reading ───────────────────────────────────────────────────────────────

  server.registerTool(
    'get_config',
    {
      title: 'Read the configuration',
      description:
        'The whole desk configuration — charter, voices, stringers, outlets, MCP endpoints, browser engines and the reporting block — as YAML, plus any validation issues it currently has. Start here.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const config = readConfig(db)
      return json({ yaml: configToYaml(config), issues: validateConfig(config) })
    },
  )

  server.registerTool(
    'validate_config',
    {
      title: 'Check a configuration without saving it',
      description:
        'Parse and validate a candidate configuration document and report what is wrong with it. Touches nothing. Use this to iterate before calling write_config.',
      inputSchema: {
        yaml: z.string().min(1).describe('The candidate document, as YAML.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ yaml }) => {
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
  )

  server.registerTool(
    'get_charter',
    {
      title: 'Read the editorial charter',
      description:
        'The charter alone — the prose the managing editor places every story against. Cheaper to read than the whole configuration when the charter is what you are working on.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => said(readConfig(db).charter || '(no charter yet)'),
  )

  server.registerTool(
    'list_config_versions',
    {
      title: 'List configuration restore points',
      description:
        'Every configuration snapshot, newest first. One is taken automatically before each write, so this is the undo history.',
      inputSchema: { limit: z.number().int().positive().max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => json({ versions: listConfigVersions(db, limit ?? 50) }),
  )

  server.registerTool(
    'get_config_version',
    {
      title: 'Read one restore point',
      description: 'The full YAML of a stored configuration version.',
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const version = getConfigVersion(db, id)
      return version ? json(version) : refused(`there is no configuration version ${id}`)
    },
  )

  server.registerTool(
    'preview_restore',
    {
      title: 'See what restoring a version would do',
      description:
        'What would change, what would refuse to restore, and what would be lost for good — an MCP endpoint dropped by a restore loses its OAuth authorization, which no snapshot holds. Read this before restore_config_version.',
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const preview = previewRestore(db, id)
      return preview ? json(preview) : refused(`there is no configuration version ${id}`)
    },
  )

  server.registerTool(
    'get_settings',
    {
      title: 'Read the settings that are not configuration',
      description:
        'Timezone, the ingest token stringers file with, and how many devices are registered for push. These are properties of this installation rather than of what the desk publishes, which is why they are not in the configuration document.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json({
        timezone: getTimezone(db),
        ingestToken: getSetting(db, SETTING.ingestToken) ?? '',
        pushDevices: subscriptionCount(db),
      }),
  )

  server.registerTool(
    'get_status',
    {
      title: 'Is the desk healthy',
      description:
        'Version, whether the desk is configured at all, and a live probe of every MCP endpoint — which is how you find out that inference or an outlet is unreachable or signed out.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await checkHealth(db, options.version)),
  )

  server.registerTool(
    'read_log',
    {
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
    },
    async (query) => json(listEvents(db, { ...query, limit: query.limit ?? 50 })),
  )

  // ── writing, one entry at a time ──────────────────────────────────────────

  server.registerTool(
    'set_charter',
    {
      title: 'Rewrite the editorial charter',
      description:
        'Replace the charter prose. This is the placement policy: it decides what is newsworthy and where each story runs, so changing it changes every future verdict. The previous text is kept.',
      inputSchema: { charter: z.string().min(1), reason },
      annotations: { idempotentHint: true },
    },
    async ({ charter, reason: why }) =>
      mutate(db, 'the charter', why, (config) => ({ ...config, charter })),
  )

  server.registerTool(
    'upsert_voice',
    {
      title: 'Add or update a voice',
      description:
        'A voice is how an outlet sounds — tone, audience, rules, examples. Supply the whole voice; an existing one with the same id is replaced.',
      inputSchema: { voice: voiceSchema, reason },
    },
    async ({ voice, reason: why }) =>
      mutate(db, `voice "${voice.id}"`, why, (config) => ({ ...config, voices: upsertById(config.voices, voice) })),
  )

  server.registerTool(
    'upsert_stringer',
    {
      title: 'Add or update a stringer',
      description:
        'A stringer is a source that files reports at POST /api/v1/filings. Supply the whole stringer; an existing one with the same id is replaced. Disable rather than remove one that has already filed.',
      inputSchema: { stringer: stringerSchema, reason },
    },
    async ({ stringer, reason: why }) =>
      mutate(db, `stringer "${stringer.id}"`, why, (config) => ({
        ...config,
        stringers: upsertById(config.stringers, stringer),
      })),
  )

  server.registerTool(
    'upsert_outlet',
    {
      title: 'Add or update an outlet',
      description:
        'An outlet is a destination: its description is what the managing editor reads to decide what belongs there, and its args pin where a post actually lands. Supply the whole outlet; an existing one with the same id is replaced. A publish outlet must pin its destination as a literal or the save is refused.',
      inputSchema: { outlet: outletSchema, reason },
    },
    async ({ outlet, reason: why }) =>
      mutate(db, `outlet "${outlet.id}"`, why, (config) => ({
        ...config,
        outlets: upsertById(config.outlets, outlet),
      })),
  )

  server.registerTool(
    'upsert_mcp_endpoint',
    {
      title: 'Add or update an MCP endpoint',
      description:
        'An MCP server the desk calls — a Beacon aggregator, usually. Adding one here does not authorize it: an endpoint that wants OAuth has to be connected from the Settings screen in a browser, which is not something this server can do for you.',
      inputSchema: { endpoint: mcpEndpointSchema, reason },
    },
    async ({ endpoint, reason: why }) =>
      mutate(db, `endpoint "${endpoint.id}"`, why, (config) => ({
        ...config,
        mcp_endpoints: upsertById(config.mcp_endpoints, endpoint),
      })),
  )

  server.registerTool(
    'upsert_browser_engine',
    {
      title: 'Add or update a browser engine',
      description: 'A browser the desk can drive for outlets that have no API.',
      inputSchema: { engine: browserEngineSchema, reason },
    },
    async ({ engine, reason: why }) =>
      mutate(db, `browser engine "${engine.id}"`, why, (config) => ({
        ...config,
        browser_engines: upsertById(config.browser_engines, engine),
      })),
  )

  server.registerTool(
    'remove_config_entry',
    {
      title: 'Remove one configuration entry',
      description:
        'Delete a voice, stringer, outlet, MCP endpoint or browser engine by id. Removal is refused when content still references it — a stringer that has filed or an outlet that has published must be disabled instead, not deleted. Removing an MCP endpoint destroys its OAuth authorization permanently.',
      inputSchema: {
        collection: z.enum(COLLECTIONS),
        id: z.string().min(1),
        reason,
      },
      annotations: { destructiveHint: true },
    },
    async ({ collection, id, reason: why }) =>
      mutate(db, `${collection} entry "${id}"`, why, (config) => {
        const list = config[collection]
        if (!list.some((entry) => entry.id === id)) {
          throw new Error(`there is no ${collection} entry with id "${id}"`)
        }
        // Rebuilt through the collection key rather than a switch, so adding a
        // collection to the configuration cannot leave a stale branch here.
        return { ...config, [collection]: list.filter((entry) => entry.id !== id) } as Config
      }),
  )

  server.registerTool(
    'set_reporting',
    {
      title: 'Configure or switch off the reporting phase',
      description:
        'The phase that researches a filing before the managing editor reads it. Pass `reporting` to configure it, or omit it entirely to switch the phase off — tips then go straight to the managing editor. Listing a tool here IS the authorization to call it unattended.',
      inputSchema: { reporting: reportingSchema.optional(), reason },
    },
    async ({ reporting, reason: why }) =>
      mutate(db, reporting ? 'the reporting phase' : 'the reporting phase (switched off)', why, (config) => {
        const { reporting: _dropped, ...rest } = config
        return reporting ? { ...rest, reporting } : rest
      }),
  )

  // ── writing the whole document ────────────────────────────────────────────

  server.registerTool(
    'write_config',
    {
      title: 'Replace the whole configuration',
      description:
        'Save a complete configuration document. This REPLACES everything: any outlet, voice, stringer, endpoint or engine absent from the document is deleted, and a dropped MCP endpoint loses its OAuth authorization for good. Prefer the upsert_* tools, which change one entry and leave the rest alone. Validate first. A restore point is taken before the write either way.',
      inputSchema: {
        yaml: z.string().min(1).describe('The complete document, as YAML.'),
        reason: z.string().min(1).describe('Why. Required here, because this tool can delete things.'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ yaml, reason: why }) => {
      let candidate: unknown
      try {
        candidate = yamlToConfig(yaml)
      } catch (err) {
        return refused('that document could not be parsed', configIssuesFrom(err))
      }
      return mutate(db, 'the whole configuration', why, () => candidate as Config)
    },
  )

  server.registerTool(
    'restore_config_version',
    {
      title: 'Roll the configuration back',
      description:
        'Put a stored configuration version back. Call preview_restore first — a restore can be refused outright, and it can drop an MCP endpoint whose authorization cannot be recovered. The state being replaced is snapshotted first, so restoring a restore works.',
      inputSchema: { id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const version = getConfigVersion(db, id)
      if (!version) return refused(`there is no configuration version ${id}`)
      try {
        const config = restoreConfigVersion(db, id, 'mcp')
        logEvent(db, {
          level: 'info',
          code: 'CONFIG_RESTORED',
          message: `an MCP client rolled the configuration back to how it stood at ${version.at}`,
          detail: { author: 'mcp', restoredFromId: id },
        })
        return saved(config, `restored version ${id}`)
      } catch (err) {
        if (err instanceof ConfigRejected) {
          return refused('that version cannot be restored, and nothing was written', err.issues)
        }
        return refused(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // ── settings ──────────────────────────────────────────────────────────────

  server.registerTool(
    'set_timezone',
    {
      title: 'Set the desk timezone',
      description:
        'An IANA name. Every posting window and every slot the calendar has already proposed moves with it.',
      inputSchema: { timezone: z.string().min(1) },
      annotations: { idempotentHint: true },
    },
    async ({ timezone }) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone })
      } catch {
        return refused(`"${timezone}" is not a timezone this desk knows — use an IANA name like "Europe/Paris"`)
      }
      const previous = getTimezone(db)
      setSetting(db, SETTING.timezone, timezone)
      logEvent(db, {
        level: 'info',
        code: 'TIMEZONE_CHANGED',
        message: `the desk timezone is now ${timezone} — posting windows shift with it`,
        detail: { from: previous, to: timezone },
      })
      return said(`the desk timezone is now ${timezone}`)
    },
  )
}
