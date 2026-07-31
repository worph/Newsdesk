import { readFileSync } from 'node:fs'
import {
  parseConfig,
  type Config,
  type ConfigIssue,
  type ArgsSpec,
} from '@newsdesk/shared'
import { desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { SETTING, setSetting } from '../settings.js'

/** Assemble the live configuration out of the tables. */
export function readConfig(db: Db): Config {
  const charterRow = db.select().from(schema.charter).orderBy(desc(schema.charter.id)).limit(1).get()

  return {
    charter: charterRow?.text ?? '',
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
    targets: db
      .select()
      .from(schema.targets)
      .all()
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        role: t.role as Config['targets'][number]['role'],
        driver: t.driver as Config['targets'][number]['driver'],
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
 * submissions, a target with publications. Reported as an issue rather than
 * letting a foreign key error surface as a 500.
 */
function inUse(db: Db, config: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const keepStringers = config.stringers.map((s) => s.id)
  const keepTargets = config.targets.map((t) => t.id)

  const orphanedStringers = db
    .selectDistinct({ id: schema.submissions.stringerId })
    .from(schema.submissions)
    .where(keepStringers.length ? notInArray(schema.submissions.stringerId, keepStringers) : sql`1=1`)
    .all()
  for (const row of orphanedStringers) {
    issues.push({
      path: 'stringers',
      message: `cannot remove stringer "${row.id}" — submissions reference it. Set enabled: false instead.`,
    })
  }

  const orphanedTargets = db
    .selectDistinct({ id: schema.publications.targetId })
    .from(schema.publications)
    .where(keepTargets.length ? notInArray(schema.publications.targetId, keepTargets) : sql`1=1`)
    .all()
  for (const row of orphanedTargets) {
    issues.push({
      path: 'targets',
      message: `cannot remove target "${row.id}" — publications reference it. Set enabled: false instead.`,
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
    const targetIds = config.targets.map((t) => t.id)

    // Targets first on delete (they reference voices and endpoints).
    tx.delete(schema.targets)
      .where(targetIds.length ? notInArray(schema.targets.id, targetIds) : sql`1=1`)
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
    for (const t of config.targets) {
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
      tx.insert(schema.targets).values(row).onConflictDoUpdate({ target: schema.targets.id, set: row }).run()
    }

    // The charter is append-only: a new version only when the text changed.
    const latest = tx.select().from(schema.charter).orderBy(desc(schema.charter.id)).limit(1).get()
    if (latest?.text !== config.charter) {
      tx.insert(schema.charter).values({ text: config.charter, author }).run()
    }
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
 * two competing definitions of a target.
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
