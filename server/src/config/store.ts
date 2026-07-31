import { readFileSync } from 'node:fs'
import {
  parseConfig,
  reportingSchema,
  type Config,
  type ConfigIssue,
  type ArgsSpec,
  type Reporting,
} from '@newsdesk/shared'
import { desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { getSetting, SETTING, setSetting } from '../settings.js'

/**
 * The reporting block is a handful of scalars and two short lists, so it lives
 * as one JSON setting rather than earning tables of its own. The referential
 * integrity tables would buy — "this endpoint still exists" — is already
 * enforced by validateConfig, which runs over the whole configuration on every
 * write. Content gets tables; this is configuration.
 */
export function readReporting(db: Db): Reporting | undefined {
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
export function readConfig(db: Db): Config {
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
      })),
  }
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

/** Validate, then replace the configuration tables in one transaction. */
export function writeConfig(db: Db, input: unknown, author: string): Config {
  const { config, issues } = parseConfig(input)
  const all = [...issues, ...inUse(db, config)]
  if (all.length > 0) throw new ConfigRejected(all)

  db.transaction((tx) => {
    const endpointIds = config.mcp_endpoints.map((e) => e.id)
    const voiceIds = config.voices.map((p) => p.id)
    const stringerIds = config.stringers.map((s) => s.id)
    const outletIds = config.outlets.map((t) => t.id)

    // Outlets first on delete (they reference voices and endpoints).
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

    for (const e of config.mcp_endpoints) {
      tx.insert(schema.mcpEndpoints)
        .values({ id: e.id, name: e.name, url: e.url })
        .onConflictDoUpdate({ target: schema.mcpEndpoints.id, set: { name: e.name, url: e.url } })
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
