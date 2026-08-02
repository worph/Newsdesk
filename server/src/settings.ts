import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db, Queryable } from './db/index.js'
import { schema } from './db/index.js'

export const SETTING = {
  sessionSecret: 'session_secret',
  ingestToken: 'ingest_token',
  adminPasswordHash: 'admin_password_hash',
  configImportedAt: 'config_imported_at',
  /**
   * The desk's own timezone, IANA. Rows stay ISO-8601 UTC everywhere; this is
   * only how a cadence window like "09:00–18:00" is interpreted, and what an
   * outlet's own `cadence.timezone` overrides.
   */
  timezone: 'timezone',
  /** The reporting block, as JSON. Configuration, not content — see config/store.ts. */
  reporting: 'reporting',
} as const

export function getSetting(db: Queryable, key: string): string | undefined {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()
}

/**
 * UTC rather than the host's zone: a container's clock is whatever the image
 * happened to ship with, and a posting window that quietly means something
 * different after a redeploy is worse than one that is plainly wrong.
 */
export const DEFAULT_TIMEZONE = 'UTC'

export function getTimezone(db: Db): string {
  return getSetting(db, SETTING.timezone) ?? DEFAULT_TIMEZONE
}

/** Reads a setting, generating and persisting a random one the first time. */
export function getOrCreateSecret(db: Db, key: string, bytes = 32): string {
  const existing = getSetting(db, key)
  if (existing) return existing
  const value = randomBytes(bytes).toString('base64url')
  setSetting(db, key, value)
  return value
}
