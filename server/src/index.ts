import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { buildApp, VERSION } from './app.js'
import { setPassword } from './auth.js'
import { importConfigFileOnFirstBoot, isUnconfigured, readReporting } from './config/store.js'
import { openDb, runMigrations } from './db/index.js'
import { disableAuthIgnored, loadEnv } from './env.js'
import { logEvent } from './events.js'
import { managingEditorHandler } from './pipeline/managing-editor.js'
import { enqueue, JobQueue } from './pipeline/queue.js'
import { reporterHandler } from './pipeline/reporter.js'
import { writerHandler } from './pipeline/writer.js'
import { handoverFollowupHandler } from './ports/delivery/browser/handover.js'
import { setTraceDir } from './ports/delivery/browser/session.js'
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

  // Browser publish evidence — screenshots of what was composed and what went
  // out. Beside the database rather than inside it, because images are large
  // and a backup is meant to stay one file worth copying.
  setTraceDir(resolve(env.dataDir, 'traces'))

  // A fixed token lets a stringer be configured from the same compose file
  // that starts the desk. First boot only — rotating from the UI afterwards
  // wins, so a stale env var can never silently resurrect an old token.
  if (env.ingestToken && !getSetting(db, SETTING.ingestToken)) {
    setSetting(db, SETTING.ingestToken, env.ingestToken)
  }
  const ingestToken = getOrCreateSecret(db, SETTING.ingestToken)

  // Same first-boot-only rule, for the same reason: the beaconify sidecar is
  // given this value from the compose file, so both sides can be set once
  // without anyone copying a generated secret by hand. Rotating from the
  // Settings screen afterwards wins, and the sidecar has to be told.
  if (env.mcpToken && !getSetting(db, SETTING.adminMcpToken)) {
    setSetting(db, SETTING.adminMcpToken, env.mcpToken)
  }
  getOrCreateSecret(db, SETTING.adminMcpToken)

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
  queue.register('handover-followup', handoverFollowupHandler())

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
      traceDir: resolve(env.dataDir, 'traces'),
      /**
       * The restart remedy, wired to the same shutdown the signal handlers
       * use. Under compose the policy is `restart: unless-stopped`, so exiting
       * cleanly is what a restart is; `restartable()` is what stops the remedy
       * being offered anywhere that is not true.
       */
      restart: () => {
        void (async () => {
          await queue.stop()
          await app.close()
          process.exit(0)
        })()
      },
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
    // The boot guard firing is worth a row: it means the database and the
    // migrations had drifted, and the next person to see something strange
    // deserves to find that here rather than in yesterday's container logs.
    logEvent(db, {
      level: 'warn',
      code: 'SCHEMA_RECONCILED',
      message: 'the database schema had drifted and was brought back in line at boot',
      detail: { statements: migrations.reconciled.length, extra: migrations.extra },
    })
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
    logEvent(db, {
      level: 'warn',
      code: 'DESK_UNCONFIGURED',
      message: 'the desk has no charter and no outlet yet, so nothing can be placed',
    })
  }

  setSetting(db, 'last_boot', new Date().toISOString())

  // The anchor every other row is read against: without it, "did it restart?"
  // is a question the log cannot answer, and a gap in the timeline looks the
  // same whether the desk was down or merely quiet.
  logEvent(db, {
    level: 'info',
    code: 'DESK_STARTED',
    message: `the desk started, running ${VERSION}`,
    detail: {
      version: VERSION,
      adoptedBaseline: migrations.adoptedBaseline,
      reconciled: migrations.reconciled.length,
      extra: migrations.extra.length,
    },
  })

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
