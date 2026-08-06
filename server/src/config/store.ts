import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  parseConfig,
  reportingSchema,
  type Cadence,
  type Config,
  type ConfigIssue,
  type ArgsSpec,
  type PublishMode,
  type Reporting,
} from '@newsdesk/shared'
import { desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import type { Db, Queryable, Tx } from '../db/index.js'
import { schema } from '../db/index.js'
import { getSetting, SETTING, setSetting } from '../settings.js'

/**
 * The reporting block is a handful of scalars and two short lists, so it lives
 * as one JSON setting rather than earning tables of its own. The referential
 * integrity tables would buy — "this endpoint still exists" — is already
 * enforced by validateConfig, which runs over the whole configuration on every
 * write. Content gets tables; this is configuration.
 */
export function readReporting(db: Queryable): Reporting | undefined {
  const raw = getSetting(db, SETTING.reporting)
  if (!raw) return undefined
  try {
    return reportingSchema.parse(JSON.parse(raw))
  } catch {
    // A blob we cannot parse means the phase does not run, rather than the desk
    // failing to boot. The Config screen will show it as absent.
    return undefined
  }
}

/** Assemble the live configuration out of the tables. */
export function readConfig(db: Queryable): Config {
  const charterRow = db.select().from(schema.charter).orderBy(desc(schema.charter.id)).limit(1).get()
  const reporting = readReporting(db)

  return {
    charter: charterRow?.text ?? '',
    ...(reporting ? { reporting } : {}),
    mcp_endpoints: db
      .select()
      .from(schema.mcpEndpoints)
      .all()
      .map((e) => ({ id: e.id, name: e.name, url: e.url })),
    browser_engines: db
      .select()
      .from(schema.browserEngines)
      .all()
      .map((e) => ({
        id: e.id,
        name: e.name,
        api_base: e.apiBase,
        viewer: e.viewer as Config['browser_engines'][number]['viewer'],
      })),
    voices: db
      .select()
      .from(schema.voices)
      .all()
      .map((p) => ({
        id: p.id,
        name: p.name,
        tone: p.tone,
        audience: p.audience,
        ...(p.rules ? { rules: p.rules } : {}),
        ...(p.examples ? { examples: p.examples } : {}),
      })),
    stringers: db
      .select()
      .from(schema.stringers)
      .all()
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind as Config['stringers'][number]['kind'],
        enabled: s.enabled,
        ...(s.hint ? { hint: s.hint } : {}),
      })),
    outlets: db
      .select()
      .from(schema.outlets)
      .all()
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        role: t.role as Config['outlets'][number]['role'],
        driver: t.driver as Config['outlets'][number]['driver'],
        enabled: t.enabled,
        ...(t.voiceId ? { voice: t.voiceId } : {}),
        ...(t.endpointId ? { endpoint: t.endpointId } : {}),
        ...(t.tool ? { tool: t.tool } : {}),
        ...(t.destinationKey ? { destination_key: t.destinationKey } : {}),
        args: JSON.parse(t.argsSpec) as ArgsSpec,
        ...(t.cadence ? { cadence: JSON.parse(t.cadence) as Cadence } : {}),
        ...(t.engineId ? { engine: t.engineId } : {}),
        ...(t.recipe ? { recipe: t.recipe } : {}),
        ...(t.publish ? { publish: t.publish as PublishMode } : {}),
        ...(t.requiresHuman ? { requires_human: true } : {}),
      })),
  }
}

/**
 * A parse failure as a list of issues, in the same shape a semantic failure
 * arrives in.
 *
 * `parseConfig` throws on a shape failure and returns issues on a semantic
 * one, which is the right split for the caller that has to distinguish them —
 * but every surface that reports to a human or a model wants one list with a
 * path per problem. Flattening a ZodError to a single string is what puts
 * someone back to hunting through a document for the field that upset zod.
 */
export function configIssuesFrom(err: unknown): ConfigIssue[] {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  }
  return [{ path: '', message: err instanceof Error ? err.message : String(err) }]
}

export class ConfigRejected extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`configuration rejected: ${issues.length} issue(s)`)
    this.name = 'ConfigRejected'
  }
}

/**
 * Rows still referenced by content cannot be removed — a stringer with
 * filings, an outlet with publications. Reported as an issue rather than
 * letting a foreign key error surface as a 500.
 */
function inUse(db: Db, config: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const keepStringers = config.stringers.map((s) => s.id)
  const keepOutlets = config.outlets.map((t) => t.id)

  const orphanedStringers = db
    .selectDistinct({ id: schema.filings.stringerId })
    .from(schema.filings)
    .where(keepStringers.length ? notInArray(schema.filings.stringerId, keepStringers) : sql`1=1`)
    .all()
  for (const row of orphanedStringers) {
    issues.push({
      path: 'stringers',
      message: `cannot remove stringer "${row.id}" — filings reference it. Set enabled: false instead.`,
    })
  }

  const orphanedOutlets = db
    .selectDistinct({ id: schema.publications.outletId })
    .from(schema.publications)
    .where(keepOutlets.length ? notInArray(schema.publications.outletId, keepOutlets) : sql`1=1`)
    .all()
  for (const row of orphanedOutlets) {
    issues.push({
      path: 'outlets',
      message: `cannot remove outlet "${row.id}" — publications reference it. Set enabled: false instead.`,
    })
  }

  return issues
}

function hash(yaml: string): string {
  return createHash('sha256').update(yaml).digest('hex')
}

/**
 * Record what the configuration was, unless it is what we already recorded.
 *
 * The equality check is what keeps the history readable: the Config screen
 * saves the whole document on every press, so without it a pass over the
 * forms that changed nothing would mint a version indistinguishable from one
 * that changed everything.
 */
function snapshot(tx: Tx, author: string, reason?: string, restoredFromId?: number): void {
  const yaml = configToYaml(readConfig(tx))
  const sha256 = hash(yaml)

  const latest = tx
    .select({ sha256: schema.configVersions.sha256 })
    .from(schema.configVersions)
    .orderBy(desc(schema.configVersions.id))
    .limit(1)
    .get()
  if (latest?.sha256 === sha256) return

  tx.insert(schema.configVersions)
    .values({
      author,
      reason: reason ?? null,
      yaml,
      sha256,
      restoredFromId: restoredFromId ?? null,
    })
    .run()
}

/** Validate, then replace the configuration tables in one transaction. */
export function writeConfig(db: Db, input: unknown, author: string, reason?: string): Config {
  const { config, issues } = parseConfig(input)
  const all = [...issues, ...inUse(db, config)]
  if (all.length > 0) throw new ConfigRejected(all)

  db.transaction((tx) => {
    /**
     * The way back, taken before the first delete and inside this same
     * transaction.
     *
     * Inside, because the deletes below are destructive and a snapshot taken
     * before the transaction opened would leave a window at exactly the moment
     * a crash is likeliest; one taken after would not be a snapshot at all. If
     * anything downstream throws, this row rolls back with the rest, which is
     * correct — nothing was lost, so there is nothing to restore.
     */
    snapshot(tx, author, reason)

    const endpointIds = config.mcp_endpoints.map((e) => e.id)
    const engineIds = config.browser_engines.map((e) => e.id)
    const voiceIds = config.voices.map((p) => p.id)
    const stringerIds = config.stringers.map((s) => s.id)
    const outletIds = config.outlets.map((t) => t.id)

    // Outlets first on delete (they reference voices, endpoints and engines).
    tx.delete(schema.outlets)
      .where(outletIds.length ? notInArray(schema.outlets.id, outletIds) : sql`1=1`)
      .run()
    tx.delete(schema.stringers)
      .where(stringerIds.length ? notInArray(schema.stringers.id, stringerIds) : sql`1=1`)
      .run()
    tx.delete(schema.voices)
      .where(voiceIds.length ? notInArray(schema.voices.id, voiceIds) : sql`1=1`)
      .run()
    tx.delete(schema.mcpEndpoints)
      .where(endpointIds.length ? notInArray(schema.mcpEndpoints.id, endpointIds) : sql`1=1`)
      .run()
    tx.delete(schema.browserEngines)
      .where(engineIds.length ? notInArray(schema.browserEngines.id, engineIds) : sql`1=1`)
      .run()

    for (const e of config.mcp_endpoints) {
      tx.insert(schema.mcpEndpoints)
        .values({ id: e.id, name: e.name, url: e.url })
        .onConflictDoUpdate({ target: schema.mcpEndpoints.id, set: { name: e.name, url: e.url } })
        .run()
    }
    for (const e of config.browser_engines) {
      const row = { id: e.id, name: e.name, apiBase: e.api_base, viewer: e.viewer }
      tx.insert(schema.browserEngines)
        .values(row)
        .onConflictDoUpdate({ target: schema.browserEngines.id, set: row })
        .run()
    }
    for (const p of config.voices) {
      const row = {
        id: p.id,
        name: p.name,
        tone: p.tone,
        audience: p.audience,
        rules: p.rules ?? null,
        examples: p.examples ?? null,
      }
      tx.insert(schema.voices).values(row).onConflictDoUpdate({ target: schema.voices.id, set: row }).run()
    }
    for (const s of config.stringers) {
      const row = { id: s.id, name: s.name, kind: s.kind, enabled: s.enabled, hint: s.hint ?? null }
      tx.insert(schema.stringers).values(row).onConflictDoUpdate({ target: schema.stringers.id, set: row }).run()
    }
    for (const t of config.outlets) {
      const row = {
        id: t.id,
        name: t.name,
        description: t.description,
        role: t.role,
        driver: t.driver,
        enabled: t.enabled,
        voiceId: t.voice ?? null,
        endpointId: t.endpoint ?? null,
        tool: t.tool ?? null,
        destinationKey: t.destination_key ?? null,
        argsSpec: JSON.stringify(t.args),
        cadence: t.cadence ? JSON.stringify(t.cadence) : null,
        engineId: t.engine ?? null,
        recipe: t.recipe ?? null,
        publish: t.publish ?? null,
        requiresHuman: t.requires_human ?? null,
      }
      tx.insert(schema.outlets).values(row).onConflictDoUpdate({ target: schema.outlets.id, set: row }).run()
    }

    // The charter is append-only: a new version only when the text changed.
    const latest = tx.select().from(schema.charter).orderBy(desc(schema.charter.id)).limit(1).get()
    if (latest?.text !== config.charter) {
      tx.insert(schema.charter).values({ text: config.charter, author }).run()
    }

    // Omitting the block removes it, so the phase can be switched off by
    // deleting it from the file rather than hunting for an `enabled: false`.
    tx.insert(schema.settings)
      .values({ key: SETTING.reporting, value: JSON.stringify(config.reporting ?? null) })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: JSON.stringify(config.reporting ?? null) },
      })
      .run()
  })

  return readConfig(db)
}

export function configToYaml(config: Config): string {
  return stringifyYaml(config, { lineWidth: 100 })
}

/**
 * What the configuration is, in the shape a human scanning the log wants:
 * counts, not a diff. Shared by every writer of a `CONFIG_CHANGED` row so the
 * log reads the same whether the change came from the screen or over MCP.
 */
export function describeConfig(config: Config): string {
  return [
    `${config.outlets.length} outlet${config.outlets.length === 1 ? '' : 's'}`,
    `${config.stringers.length} stringer${config.stringers.length === 1 ? '' : 's'}`,
    `${config.voices.length} voice${config.voices.length === 1 ? '' : 's'}`,
    `${config.mcp_endpoints.length} endpoint${config.mcp_endpoints.length === 1 ? '' : 's'}`,
  ].join(', ')
}

// ── history ─────────────────────────────────────────────────────────────────

export interface ConfigVersionSummary {
  id: number
  at: string
  author: string
  reason: string | null
  sha256: string
  restoredFromId: number | null
  /** Counts rather than a diff, so the list is scannable without opening anything. */
  summary: string
}

function summarise(yaml: string): string {
  try {
    return describeConfig(parseConfig(parseYaml(yaml)).config)
  } catch {
    // A snapshot we can no longer parse is still a snapshot worth offering:
    // the YAML is intact and a human can read it even if this build's schema
    // has moved on.
    return 'could not be summarised'
  }
}

export function listConfigVersions(db: Db, limit = 50): ConfigVersionSummary[] {
  return db
    .select()
    .from(schema.configVersions)
    .orderBy(desc(schema.configVersions.id))
    .limit(Math.min(limit, 200))
    .all()
    .map((row) => ({
      id: row.id,
      at: row.at,
      author: row.author,
      reason: row.reason,
      sha256: row.sha256,
      restoredFromId: row.restoredFromId,
      summary: summarise(row.yaml),
    }))
}

export function getConfigVersion(db: Db, id: number): { id: number; at: string; yaml: string } | undefined {
  const row = db.select().from(schema.configVersions).where(eq(schema.configVersions.id, id)).get()
  return row ? { id: row.id, at: row.at, yaml: row.yaml } : undefined
}

export interface RestorePreview {
  id: number
  at: string
  /** Why this cannot be restored at all. Empty means the restore would go through. */
  issues: ConfigIssue[]
  /** Why you might not want to, even though it would go through. */
  warnings: string[]
  currentYaml: string
  versionYaml: string
}

/**
 * What restoring this version would do, without doing any of it.
 *
 * Restore is not a one-click operation and pretending otherwise is how people
 * lose things: `inUse` can refuse it outright, and the endpoint case below is
 * both silent and permanent.
 */
export function previewRestore(db: Db, id: number): RestorePreview | undefined {
  const row = db.select().from(schema.configVersions).where(eq(schema.configVersions.id, id)).get()
  if (!row) return undefined

  const current = readConfig(db)
  let issues: ConfigIssue[] = []
  let target: Config | undefined

  try {
    const parsed = parseConfig(parseYaml(row.yaml))
    target = parsed.config
    issues = [...parsed.issues, ...inUse(db, parsed.config)]
  } catch (err) {
    issues = [{ path: '', message: err instanceof Error ? err.message : String(err) }]
  }

  const warnings: string[] = []
  if (target) {
    /**
     * The hazard that has no undo.
     *
     * `writeConfig` deletes endpoints absent from the document, and
     * `mcp_endpoints.auth` holds the OAuth token — which is not part of the
     * configuration surface and therefore not in any snapshot. So an endpoint
     * dropped by a restore loses its connection permanently, and one re-added
     * by a restore comes back signed out. `inUse` guards stringers and outlets
     * against exactly this kind of loss; it has no equivalent for endpoints,
     * which is why it is said here instead.
     *
     * An endpoint that survives keeps its token: the upsert in `writeConfig`
     * sets only name and url, deliberately.
     */
    const targetIds = new Set(target.mcp_endpoints.map((endpoint) => endpoint.id))
    const connected = db
      .select({ id: schema.mcpEndpoints.id, name: schema.mcpEndpoints.name, auth: schema.mcpEndpoints.auth })
      .from(schema.mcpEndpoints)
      .all()

    for (const endpoint of connected) {
      if (!targetIds.has(endpoint.id) && endpoint.auth) {
        warnings.push(
          `"${endpoint.name}" would be removed, and its authorization cannot be restored — you would have to connect it again.`,
        )
      }
    }

    const currentIds = new Set(current.mcp_endpoints.map((endpoint) => endpoint.id))
    for (const endpoint of target.mcp_endpoints) {
      if (!currentIds.has(endpoint.id)) {
        warnings.push(`"${endpoint.name}" would come back, but signed out — it will need authorizing.`)
      }
    }
  }

  return {
    id: row.id,
    at: row.at,
    issues,
    warnings,
    currentYaml: configToYaml(current),
    versionYaml: row.yaml,
  }
}

/**
 * Put a stored version back.
 *
 * It goes through `writeConfig` rather than around it, so a restore is
 * validated exactly like any other save — one that `inUse` refuses throws
 * `ConfigRejected` and writes nothing — and so the state being replaced is
 * itself snapshotted first. Restoring a restore therefore works.
 */
export function restoreConfigVersion(db: Db, id: number, author = 'restore'): Config {
  const row = db.select().from(schema.configVersions).where(eq(schema.configVersions.id, id)).get()
  if (!row) throw new ConfigRejected([{ path: '', message: `no configuration version ${id}` }])

  const config = writeConfig(db, parseYaml(row.yaml), author, `restored version ${id}`)

  // Stamp the snapshot writeConfig just took, so the history says what it was
  // taken ahead of rather than leaving a bare row before a restore.
  const latest = db
    .select({ id: schema.configVersions.id })
    .from(schema.configVersions)
    .orderBy(desc(schema.configVersions.id))
    .limit(1)
    .get()
  if (latest) {
    db.update(schema.configVersions)
      .set({ restoredFromId: id })
      .where(eq(schema.configVersions.id, latest.id))
      .run()
  }

  return config
}

export function yamlToConfig(text: string): unknown {
  return parseYaml(text)
}

/** True when nothing has been configured yet. */
export function isUnconfigured(db: Db): boolean {
  return db.select().from(schema.charter).limit(1).get() === undefined
}

/**
 * On first boot only, seed from /data/config.yaml if present. After that the
 * database is the source of truth and the file is ignored, so there are never
 * two competing definitions of an outlet.
 */
export function importConfigFileOnFirstBoot(
  db: Db,
  file: string,
): { imported: boolean; issues?: ConfigIssue[]; error?: string } {
  if (!isUnconfigured(db)) return { imported: false }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { imported: false }
  }

  try {
    writeConfig(db, yamlToConfig(text), 'config.yaml')
    setSetting(db, SETTING.configImportedAt, new Date().toISOString())
    return { imported: true }
  } catch (err) {
    if (err instanceof ConfigRejected) return { imported: false, issues: err.issues }
    return { imported: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export { eq, inArray }
