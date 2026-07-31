import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'

export const SETTING = {
  sessionSecret: 'session_secret',
  ingestToken: 'ingest_token',
  adminPasswordHash: 'admin_password_hash',
  configImportedAt: 'config_imported_at',
  /** The reporting block, as JSON. Configuration, not content — see config/store.ts. */
  reporting: 'reporting',
} as const

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()
}

/** Reads a setting, generating and persisting a random one the first time. */
export function getOrCreateSecret(db: Db, key: string, bytes = 32): string {
  const existing = getSetting(db, key)
  if (existing) return existing
  const value = randomBytes(bytes).toString('base64url')
  setSetting(db, key, value)
  return value
}
