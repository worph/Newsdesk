import { randomBytes } from 'node:crypto'
import { buildApp, VERSION } from './app.js'
import { setPassword } from './auth.js'
import { importConfigFileOnFirstBoot, isUnconfigured } from './config/store.js'
import { openDb, runMigrations } from './db/index.js'
import { loadEnv } from './env.js'
import { getOrCreateSecret, getSetting, SETTING, setSetting } from './settings.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const { db } = openDb(env.dbFile)
  runMigrations(db, env.migrationsDir)

  const sessionSecret = getOrCreateSecret(db, SETTING.sessionSecret)
  const ingestToken = getOrCreateSecret(db, SETTING.ingestToken)

  const app = await buildApp({
    db,
    sessionSecret,
    publicDir: env.publicDir,
    logLevel: env.logLevel,
  })

  // First boot: set the admin password from the environment, or mint a random
  // one and log it once. Never leave the desk open.
  if (!getSetting(db, SETTING.adminPasswordHash)) {
    const initial = env.adminPassword ?? randomBytes(12).toString('base64url')
    await setPassword(db, initial)
    if (env.adminPassword) {
      app.log.info('admin password set from NEWSDESK_ADMIN_PASSWORD')
    } else {
      app.log.warn(`no NEWSDESK_ADMIN_PASSWORD set — generated one for this install: ${initial}`)
    }
  }

  const imported = importConfigFileOnFirstBoot(db, env.configFile)
  if (imported.imported) {
    app.log.info({ file: env.configFile }, 'seeded configuration from file')
  } else if (imported.issues?.length) {
    app.log.error({ file: env.configFile, issues: imported.issues }, 'config file rejected — not seeded')
  } else if (imported.error) {
    app.log.error({ file: env.configFile, error: imported.error }, 'config file could not be read')
  }

  if (isUnconfigured(db)) {
    app.log.warn('no configuration yet — open the Config screen and write a charter and at least one target')
  }

  setSetting(db, 'last_boot', new Date().toISOString())

  await app.listen({ port: env.port, host: env.host })
  app.log.info(
    { version: VERSION, data: env.dataDir, ingestTokenSet: Boolean(ingestToken) },
    'newsdesk listening',
  )
}

main().catch((err) => {
  console.error('newsdesk failed to start:', err)
  process.exit(1)
})
