import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

// `$client` is on drizzle()'s return type rather than the class, and the
// migration guards need the raw handle for `pragma` and `sqlite_master`.
export type Db = BetterSQLite3Database<typeof schema> & { $client: SqliteDatabase }

/**
 * A transaction handle, which drizzle types separately from the database.
 *
 * Only the first argument of the callback `db.transaction` is given, derived
 * rather than named, so it cannot drift from whatever drizzle actually passes.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Whatever can run a query — the database or a transaction on it.
 *
 * Readers take this so they can be called from inside a transaction and see
 * its uncommitted state. Writers keep taking `Db` or `Tx` explicitly, because
 * which one they are given is a decision, not a detail.
 */
export type Queryable = Db | Tx

export interface DbHandle {
  db: Db
  sqlite: SqliteDatabase
}

export function openDb(file: string): DbHandle {
  mkdirSync(dirname(resolve(file)), { recursive: true })
  const sqlite = new Database(file)
  // WAL so a reader never blocks the queue worker; foreign keys are off by
  // default in SQLite and we rely on them.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

export { runMigrations, SchemaDriftError, type MigrationReport } from './migrations.js'

export { schema }
