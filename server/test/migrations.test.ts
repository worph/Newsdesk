import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, SchemaDriftError } from '../src/db/index.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

interface JournalEntry {
  when: number
  tag: string
}

function journal(): JournalEntry[] {
  const raw = readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries
}

function lock(): { migrations: { tag: string; when: number; sha256: string }[] } {
  return JSON.parse(readFileSync(join(migrationsFolder, 'migrations.lock.json'), 'utf8'))
}

/**
 * Drizzle applies a migration whenever the journal's `when` is above the newest
 * `created_at` in the database, so a regenerated file looks exactly like this
 * from the database's side: the schema is there, the stamp is behind.
 */
function rewindStamp(sqlite: ReturnType<typeof openDb>['sqlite']): void {
  const oldest = journal()[0].when - 1
  sqlite.prepare('update __drizzle_migrations set created_at = ?').run(oldest)
}

describe('shipped migrations', () => {
  // The guard that matters: everything else in this file only limits the damage
  // once a migration has already been rewritten.
  it('are byte-for-byte what was locked', () => {
    const entries = journal()
    for (const [index, locked] of lock().migrations.entries()) {
      const entry = entries[index]
      expect(entry, `migration ${locked.tag} has been removed from the journal`).toBeDefined()
      expect({ tag: entry.tag, when: entry.when }).toEqual({ tag: locked.tag, when: locked.when })

      const sql = readFileSync(join(migrationsFolder, `${locked.tag}.sql`), 'utf8')
      expect(
        createHash('sha256').update(sql).digest('hex'),
        `${locked.tag}.sql was edited — every existing database would re-run it. Add a migration instead.`,
      ).toBe(locked.sha256)
    }
  })

  it('are only ever appended to', () => {
    expect(journal().length).toBeGreaterThanOrEqual(lock().migrations.length)
  })
})

describe('runMigrations', () => {
  let dir: string
  let handle: ReturnType<typeof openDb>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'newsdesk-migrations-'))
    handle = openDb(join(dir, 'test.db'))
  })

  afterEach(() => {
    handle.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds the schema on a fresh database without repairing anything', () => {
    const report = runMigrations(handle.db, migrationsFolder)

    expect(report).toEqual({ adoptedBaseline: null, reconciled: [], extra: [] })
    const tables = handle.sqlite
      .prepare(`select name from sqlite_master where type = 'table'`)
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toContain('stories')
  })

  it('records a regenerated baseline instead of running it over existing tables', () => {
    runMigrations(handle.db, migrationsFolder)
    handle.sqlite.prepare('insert into charter (text, author) values (?, ?)').run('keep me', 'test')
    rewindStamp(handle.sqlite)

    const report = runMigrations(handle.db, migrationsFolder)

    expect(report.adoptedBaseline).toBe(journal()[0].tag)
    expect(report.reconciled).toEqual([])
    // The point of all this: the rows are still there.
    const charter = handle.sqlite.prepare('select text from charter').all() as { text: string }[]
    expect(charter).toEqual([{ text: 'keep me' }])
  })

  it('appends a column a regenerated baseline introduced', () => {
    runMigrations(handle.db, migrationsFolder)
    handle.sqlite.exec('ALTER TABLE `stories` DROP COLUMN `hold_reason`')
    rewindStamp(handle.sqlite)

    const report = runMigrations(handle.db, migrationsFolder)

    // The type comes back from `pragma table_info`, which reports it uppercased.
    expect(report.reconciled).toEqual(['ALTER TABLE `stories` ADD COLUMN `hold_reason` TEXT'])
    const columns = handle.sqlite.prepare('pragma table_info(`stories`)').all() as { name: string }[]
    expect(columns.map((c) => c.name)).toContain('hold_reason')
  })

  it('recreates a table and its indexes when both are gone', () => {
    runMigrations(handle.db, migrationsFolder)
    handle.sqlite.exec('DROP TABLE `events`')
    rewindStamp(handle.sqlite)

    const report = runMigrations(handle.db, migrationsFolder)

    expect(report.reconciled.some((s) => s.includes('CREATE TABLE `events`'))).toBe(true)
    expect(report.reconciled.some((s) => s.includes('events_at_idx'))).toBe(true)
    expect(report.extra).toEqual([])
  })

  it('refuses to guess when a column cannot be appended in place', () => {
    runMigrations(handle.db, migrationsFolder)
    // NOT NULL with no default: SQLite cannot append it, and what the existing
    // rows should hold is an editorial decision, not a migration detail.
    handle.sqlite.exec('ALTER TABLE `stories` DROP COLUMN `title`')
    rewindStamp(handle.sqlite)

    expect(() => runMigrations(handle.db, migrationsFolder)).toThrow(SchemaDriftError)
    expect(() => runMigrations(handle.db, migrationsFolder)).toThrow(/stories\.title/)
  })

  it('reports objects no migration creates without touching them', () => {
    runMigrations(handle.db, migrationsFolder)
    handle.sqlite.exec('CREATE TABLE `scratch` (`id` text)')

    const report = runMigrations(handle.db, migrationsFolder)

    expect(report.extra).toContain('scratch')
    expect(report.reconciled).toEqual([])
    const scratch = handle.sqlite
      .prepare(`select name from sqlite_master where name = 'scratch'`)
      .all() as { name: string }[]
    expect(scratch).toHaveLength(1)
  })
})
