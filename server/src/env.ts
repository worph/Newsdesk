import { resolve } from 'node:path'

export interface Env {
  dataDir: string
  dbFile: string
  configFile: string
  publicDir: string
  migrationsDir: string
  port: number
  host: string
  /** Initial password, consumed on first boot only. */
  adminPassword: string | undefined
  /** Initial ingest token, consumed on first boot only. Lets a stringer be
   *  configured from the same compose file that starts the desk. */
  ingestToken: string | undefined
  logLevel: string
  /**
   * Public origin the desk is reached on. The OAuth redirect URI is built
   * from it and must match what was registered, so it cannot be inferred from
   * an inbound request when a reverse proxy sits in front.
   */
  publicUrl: string | undefined
}

export function loadEnv(): Env {
  const dataDir = resolve(process.env.NEWSDESK_DATA_DIR ?? '/data')
  const here = new URL('.', import.meta.url).pathname
  return {
    dataDir,
    dbFile: resolve(dataDir, 'newsdesk.db'),
    configFile: resolve(dataDir, 'config.yaml'),
    // dist/ at runtime, src/ under tsx — public and drizzle sit beside both.
    publicDir: resolve(here, '../public'),
    migrationsDir: resolve(here, '../drizzle'),
    port: Number(process.env.NEWSDESK_PORT ?? 8080),
    host: process.env.NEWSDESK_HOST ?? '0.0.0.0',
    adminPassword: process.env.NEWSDESK_ADMIN_PASSWORD,
    ingestToken: process.env.NEWSDESK_INGEST_TOKEN,
    logLevel: process.env.NEWSDESK_LOG_LEVEL ?? 'info',
    publicUrl: process.env.NEWSDESK_PUBLIC_URL,
  }
}
