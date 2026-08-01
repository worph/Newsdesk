import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Db } from './index.js'

/**
 * Migrations, defensively.
 *
 * Drizzle decides a migration is applied purely by timestamp: it runs one when
 * the newest `created_at` in `__drizzle_migrations` is below the journal's
 * `when`. The recorded hash is never compared. That makes migration files
 * immutable in practice — regenerating the squashed baseline mints a fresh
 * `when`, and every database created by an earlier build tries to `CREATE
 * TABLE` over tables it already has. The desk then crash-loops on boot, which
 * is exactly what happened on 2026-07-31 when the baseline was regenerated with
 * `stories.hold_reason` in it.
 *
 * Two guards, because the mistake is easy to make and expensive to discover in
 * production:
 *
 *   1. A baseline the database demonstrably already has is *stamped* rather
 *      than re-run. A baseline describes the schema of an existing install; it
 *      is not new work to perform.
 *   2. After the migrator has had its turn, the live schema is compared against
 *      the one the migration files describe, and any gap that can be closed
 *      without losing data is closed. Anything else stops the boot with the
 *      specific columns named, rather than a `table already exists` stack.
 *
 * The append-only rule is still the real fix — see `migrations.lock.json` and
 * the guard in `test/migrations.test.ts`. This module is what keeps a slip from
 * taking the desk down.
 */

/** Drizzle's own bookkeeping table; created here only when we have to stamp it. */
const MIGRATIONS_TABLE = '__drizzle_migrations'

interface JournalEntry {
  idx: number
  when: number
  tag: string
  breakpoints: boolean
}

/** A row of `pragma table_info`. */
interface Column {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

export interface MigrationReport {
  /** Tag of a baseline stamped as already applied rather than re-executed. */
  adoptedBaseline: string | null
  /** Non-destructive statements applied to bring the schema back in line. */
  reconciled: string[]
  /** Objects the database has that no migration creates — reported, never touched. */
  extra: string[]
}

/** Drift that cannot be repaired without deciding what happens to existing rows. */
export class SchemaDriftError extends Error {
  constructor(readonly problems: string[]) {
    super(
      ['database schema does not match the migrations, and the difference cannot be closed safely:']
        .concat(problems.map((problem) => `  - ${problem}`))
        .concat('Write a migration for this, or repair the database by hand, then restart.')
        .join('\n'),
    )
    this.name = 'SchemaDriftError'
  }
}

function readJournal(folder: string): JournalEntry[] {
  const raw = readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')
  return (JSON.parse(raw) as { entries?: JournalEntry[] }).entries ?? []
}

function readSql(folder: string, tag: string): string {
  return readFileSync(join(folder, `${tag}.sql`), 'utf8')
}

/** The same hash drizzle records, so a stamped row is indistinguishable from a run one. */
function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function statementsOf(text: string): string[] {
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

function tablesOf(sqlite: SqliteDatabase): Map<string, string> {
  const rows = sqlite
    .prepare(
      `select name, sql from sqlite_master
        where type = 'table' and name not like 'sqlite_%' and name <> ?`,
    )
    .all(MIGRATIONS_TABLE) as { name: string; sql: string }[]
  return new Map(rows.map((row) => [row.name, row.sql]))
}

function indexesOf(sqlite: SqliteDatabase): Map<string, string> {
  const rows = sqlite
    .prepare(`select name, sql from sqlite_master where type = 'index' and sql is not null`)
    .all() as { name: string; sql: string }[]
  return new Map(rows.map((row) => [row.name, row.sql]))
}

function columnsOf(sqlite: SqliteDatabase, table: string): Map<string, Column> {
  const rows = sqlite.prepare(`pragma table_info(\`${table}\`)`).all() as Column[]
  return new Map(rows.map((column) => [column.name, column]))
}

function describe(column: Column): string {
  const parts = [column.type || 'BLOB']
  if (column.notnull) parts.push('NOT NULL')
  if (column.dflt_value !== null) parts.push(`DEFAULT ${column.dflt_value}`)
  return parts.join(' ')
}

/**
 * `ALTER TABLE ... ADD COLUMN` has to be satisfiable by every row already
 * stored: SQLite refuses a NOT NULL column without a default, a primary key,
 * and a default it would have to evaluate per row rather than once.
 */
function canAppend(column: Column): boolean {
  if (column.pk || column.notnull) return false
  return column.dflt_value === null || !column.dflt_value.includes('(')
}

/** The schema the migration files describe, built by replaying them into memory. */
function expectedSchema(folder: string, entries: JournalEntry[]): SqliteDatabase {
  const memory = new Database(':memory:')
  for (const entry of entries) {
    for (const statement of statementsOf(readSql(folder, entry.tag))) memory.exec(statement)
  }
  return memory
}

/**
 * Record the journal as applied when the database plainly already has the
 * baseline, so a regenerated `when` cannot send the migrator back over `CREATE
 * TABLE`.
 *
 * Every entry is stamped, not just the baseline. Stamping the baseline alone
 * leaves the newest `created_at` below every later migration, so drizzle
 * replays them — and the second migration this repo ever shipped was three
 * `ADD COLUMN`s, which fail on a database that already has those columns. The
 * boot would crash-loop for exactly the reason the baseline guard exists to
 * prevent.
 *
 * This is safe because of what follows it: the reconcile pass compares the live
 * schema against what the migrations describe and adds whatever is genuinely
 * missing, so the schema still converges. The one thing it cannot recover is a
 * migration that transformed *data* rather than structure — if one is ever
 * written, it needs its own idempotence check rather than relying on this.
 *
 * Only reached when the stamp is behind the baseline, which means the baseline
 * was regenerated. A database that merely has not run the latest migration
 * stamps at or past the baseline and returns early below, so the migrator does
 * its normal job.
 */
function adoptBaseline(sqlite: SqliteDatabase, folder: string, entries: JournalEntry[]): string | null {
  const baseline = entries[0]
  if (!baseline) return null

  const baselineSql = readSql(folder, baseline.tag)
  const declared = [...baselineSql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"]?(\w+)[`"]?/gi)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  )
  // Any of the baseline's tables being present means this database has had the
  // baseline (or an ancestor of it) applied — migrations run in a transaction,
  // so there is no half-applied state to mistake for one. A database holding
  // none of them is genuinely fresh, and the migrator should do its job.
  // Whatever the baseline gained since is added by the reconcile pass, which
  // knows how to do it without dropping the rows already stored.
  const live = tablesOf(sqlite)
  if (declared.length === 0 || !declared.some((table) => live.has(table))) return null

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  )
  const last = sqlite
    .prepare(`select created_at from \`${MIGRATIONS_TABLE}\` order by created_at desc limit 1`)
    .get() as { created_at: number | null } | undefined
  // Already at or past the baseline — nothing to stamp, and stamping would hide
  // migrations that legitimately still have to run.
  if (last && Number(last.created_at) >= baseline.when) return null

  const stamp = sqlite.prepare(
    `insert into \`${MIGRATIONS_TABLE}\` ("hash", "created_at") values (?, ?)`,
  )
  for (const entry of entries) {
    if (last && Number(last.created_at) >= entry.when) continue
    stamp.run(hashOf(readSql(folder, entry.tag)), entry.when)
  }
  return baseline.tag
}

interface Reconciliation {
  statements: string[]
  problems: string[]
  extra: string[]
}

/** Diff the live schema against the one the migrations describe. */
function compare(sqlite: SqliteDatabase, expected: SqliteDatabase): Reconciliation {
  const statements: string[] = []
  const problems: string[] = []
  const extra: string[] = []

  const liveTables = tablesOf(sqlite)
  const wantedTables = tablesOf(expected)

  for (const [table, ddl] of wantedTables) {
    if (!liveTables.has(table)) {
      statements.push(ddl)
      continue
    }

    const liveColumns = columnsOf(sqlite, table)
    const wantedColumns = columnsOf(expected, table)

    for (const [name, wanted] of wantedColumns) {
      const live = liveColumns.get(name)
      if (!live) {
        if (canAppend(wanted)) {
          statements.push(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${describe(wanted)}`)
        } else {
          problems.push(`${table}.${name} is missing and cannot be appended in place (${describe(wanted)})`)
        }
        continue
      }
      if (
        live.type !== wanted.type ||
        live.notnull !== wanted.notnull ||
        String(live.dflt_value) !== String(wanted.dflt_value)
      ) {
        problems.push(`${table}.${name} is ${describe(live)}, the migrations say ${describe(wanted)}`)
      }
    }

    for (const name of liveColumns.keys()) if (!wantedColumns.has(name)) extra.push(`${table}.${name}`)
  }

  for (const table of liveTables.keys()) if (!wantedTables.has(table)) extra.push(table)

  // After the tables, so an index belonging to a table we just created lands on
  // something that exists.
  const liveIndexes = indexesOf(sqlite)
  const wantedIndexes = indexesOf(expected)
  for (const [name, ddl] of wantedIndexes) if (!liveIndexes.has(name)) statements.push(ddl)
  for (const name of liveIndexes.keys()) if (!wantedIndexes.has(name)) extra.push(`index ${name}`)

  return { statements, problems, extra }
}

export function runMigrations(db: Db, migrationsFolder: string): MigrationReport {
  const sqlite = db.$client
  const entries = readJournal(migrationsFolder)

  const adoptedBaseline = adoptBaseline(sqlite, migrationsFolder, entries)
  migrate(db, { migrationsFolder })

  const expected = expectedSchema(migrationsFolder, entries)
  try {
    const { statements, problems, extra } = compare(sqlite, expected)
    if (problems.length > 0) throw new SchemaDriftError(problems)
    if (statements.length > 0) {
      try {
        sqlite.transaction(() => {
          for (const statement of statements) sqlite.exec(statement)
        })()
      } catch (cause) {
        // A unique index the stored rows do not satisfy is the realistic case,
        // and it needs a human to decide which row wins.
        throw new SchemaDriftError([`${(cause as Error).message} (while applying: ${statements.join('; ')})`])
      }
    }
    return { adoptedBaseline, reconciled: statements, extra }
  } finally {
    expected.close()
  }
}
