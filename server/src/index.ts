import { randomBytes } from 'node:crypto'
import { buildApp, VERSION } from './app.js'
import { setPassword } from './auth.js'
import { importConfigFileOnFirstBoot, isUnconfigured, readReporting } from './config/store.js'
import { openDb, runMigrations } from './db/index.js'
import { disableAuthIgnored, loadEnv } from './env.js'
import { managingEditorHandler } from './pipeline/managing-editor.js'
import { enqueue, JobQueue } from './pipeline/queue.js'
import { reporterHandler } from './pipeline/reporter.js'
import { writerHandler } from './pipeline/writer.js'
import { publishHandler } from './ports/delivery/index.js'
import { createInferenceDriver } from './ports/inference/index.js'
import { createMcpReportingTools } from './ports/reporting/tools.js'
import { getOrCreateSecret, getSetting, SETTING, setSetting } from './settings.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const { db } = openDb(env.dbFile)
  // Logged once the app exists — this runs before there is a logger, and what
  // it has to say is worth structured output rather than a bare console line.
  const migrations = runMigrations(db, env.migrationsDir)

  const sessionSecret = getOrCreateSecret(db, SETTING.sessionSecret)

  // A fixed token lets a stringer be configured from the same compose file
  // that starts the desk. First boot only — rotating from the UI afterwards
  // wins, so a stale env var can never silently resurrect an old token.
  if (env.ingestToken && !getSetting(db, SETTING.ingestToken)) {
    setSetting(db, SETTING.ingestToken, env.ingestToken)
  }
  const ingestToken = getOrCreateSecret(db, SETTING.ingestToken)

  // The desk owns its clock: queue state lives in rows, so a restart resumes
  // whatever was in flight rather than stranding it.
  const queue = new JobQueue(db)
  const driver = () => createInferenceDriver(db)
  const enqueueWriter = (publicationId: string) => {
    enqueue(db, 'write', publicationId)
  }

  const enqueueManagingEditor = (filingId: string) => {
    enqueue(db, 'assign', filingId)
  }

  // Read per call rather than captured: the reporting block is edited from the
  // Config screen, and a desk that had to be restarted to pick up a new search
  // tool would be a desk nobody reconfigures.
  const reporting = () => readReporting(db)
  const reportingTools = () => {
    const config = reporting()
    return config?.enabled ? createMcpReportingTools(db, config) : undefined
  }

  queue.register('report', reporterHandler(driver, reportingTools, reporting, { enqueueManagingEditor }))
  queue.register('assign', managingEditorHandler(driver, { enqueueWriter }))
  queue.register('write', writerHandler(driver))
  queue.register('publish', publishHandler())

  const app = await buildApp({
    db,
    sessionSecret,
    publicDir: env.publicDir,
    logLevel: env.logLevel,
    trustedGate: env.trustedGate,
    disableAuth: env.disableAuth,
    receiveOptions: {
      enqueueManagingEditor,
      enqueueReporter: (filingId) => {
        enqueue(db, 'report', filingId)
      },
      get reportedKinds() {
        // A getter so switching reporting on in the Config screen takes effect
        // for the next filing rather than the next restart.
        const config = reporting()
        return config?.enabled ? config.kinds : []
      },
      // `runAfter` is what makes a scheduled post work: the queue already only
      // claims jobs whose time has come, so a future date is the whole feature.
      enqueuePublish: (publicationId, runAfter) => {
        enqueue(db, 'publish', publicationId, runAfter)
      },
      enqueueWriter,
      driver,
      publicUrl: env.publicUrl,
    },
  })

  if (migrations.adoptedBaseline) {
    app.log.warn(
      { baseline: migrations.adoptedBaseline },
      'baseline was already applied — recorded it rather than running it again',
    )
  }
  if (migrations.reconciled.length > 0) {
    app.log.warn({ statements: migrations.reconciled }, 'brought the schema back in line with the migrations')
  }
  if (migrations.extra.length > 0) {
    app.log.info({ objects: migrations.extra }, 'database holds objects no migration creates')
  }

  if (env.disableAuth) {
    app.log.warn('NEWSDESK_DISABLE_AUTH is set — every request counts as signed in. Development only.')
  } else if (disableAuthIgnored()) {
    app.log.error('NEWSDESK_DISABLE_AUTH ignored: this is a production build and the password stands.')
  }

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
    app.log.warn('no configuration yet — open the Config screen and write a charter and at least one outlet')
  }

  setSetting(db, 'last_boot', new Date().toISOString())

  queue.start()

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        await queue.stop()
        await app.close()
        process.exit(0)
      })()
    })
  }

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
