import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>

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

export function runMigrations(db: Db, migrationsFolder: string): void {
  migrate(db, { migrationsFolder })
}

export { schema }
