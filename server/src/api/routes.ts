import { parseConfig, validateConfig, type ConfigIssue } from '@newsdesk/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  checkPassword,
  clearSession,
  hasSession,
  isGateTrusted,
  issueSession,
  requireSession,
  setPassword,
} from '../auth.js'
import {
  ConfigRejected,
  configToYaml,
  readConfig,
  writeConfig,
  yamlToConfig,
} from '../config/store.js'
import type { Db } from '../db/index.js'
import { checkHealth } from '../health.js'
import { getOrCreateVapidKeys, removeSubscription, saveSubscription } from '../push.js'
import { getSetting, getOrCreateSecret, SETTING } from '../settings.js'
import { registerIngestRoutes } from './ingest.js'
import { registerMcpRoutes } from './mcp.js'
import { registerPublicationRoutes } from './publications.js'
import { registerStoryRoutes } from './stories.js'
import type { ReceiveOptions } from '../ports/ingest/receive.js'
import type { InferenceDriver } from '../ports/inference/types.js'

const loginBody = z.object({ password: z.string().min(1) })
/**
 * Two ways to say the same thing: `yaml` is the document as typed in the
 * Advanced editor, `config` the object the forms build. Both land in the same
 * `writeConfig`, so neither is a second source of truth.
 */
const configBody = z.union([
  z.object({ yaml: z.string() }),
  z.object({ config: z.record(z.string(), z.unknown()) }),
])
const passwordBody = z.object({ current: z.string().min(1), next: z.string().min(8) })

function issuesReply(issues: ConfigIssue[]) {
  return { error: 'configuration rejected', issues }
}

/**
 * A shape failure carries a path per problem; flattening it to one string
 * would put the forms back to hunting through a document for the field that
 * upset zod.
 */
function issuesFrom(err: unknown): ConfigIssue[] {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  }
  return [{ path: '', message: err instanceof Error ? err.message : String(err) }]
}

function candidateFrom(body: z.infer<typeof configBody>): unknown {
  return 'yaml' in body ? yamlToConfig(body.yaml) : body.config
}

export interface PlacementOptions extends ReceiveOptions {
  enqueuePublish?: (publicationId: string) => void
  enqueueWriter?: (publicationId: string) => void
  driver?: () => InferenceDriver
  /** Public origin, for the OAuth redirect URI. */
  publicUrl?: string
}

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  version: string,
  receiveOptions: PlacementOptions = {},
): void {
  registerIngestRoutes(app, db, receiveOptions)
  registerStoryRoutes(app, db, receiveOptions.enqueueManagingEditor, receiveOptions.enqueueWriter)
  registerPublicationRoutes(app, db, receiveOptions.enqueuePublish, receiveOptions.driver)
  registerMcpRoutes(app, db, receiveOptions.publicUrl)

  // ── push ──────────────────────────────────────────────────────────────────
  // The public key is needed by the service worker before it can subscribe.
  app.get('/api/v1/push/key', { preHandler: requireSession }, async () => ({
    publicKey: getOrCreateVapidKeys(db).publicKey,
  }))

  app.post('/api/v1/push/subscribe', { preHandler: requireSession }, async (request, reply) => {
    const parsed = z
      .object({
        endpoint: z.string().url(),
        keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
        ua: z.string().optional(),
      })
      .safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid subscription' })

    const id = saveSubscription(db, parsed.data)
    return reply.code(201).send({ id })
  })

  app.post('/api/v1/push/unsubscribe', { preHandler: requireSession }, async (request, reply) => {
    const parsed = z.object({ endpoint: z.string().url() }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'endpoint required' })
    removeSubscription(db, parsed.data.endpoint)
    return { ok: true }
  })

  // ── health ────────────────────────────────────────────────────────────────
  // Unauthenticated on purpose: a container orchestrator has no session, and
  // the app must be diagnosable when everything else is broken.
  app.get('/healthz', async () => checkHealth(db, version))

  // ── auth ──────────────────────────────────────────────────────────────────
  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'password required' })

    if (!(await checkPassword(db, parsed.data.password))) {
      request.log.warn({ ip: request.ip }, 'failed login')
      return reply.code(401).send({ error: 'invalid password' })
    }
    issueSession(reply)
    return { ok: true }
  })

  app.post('/api/v1/auth/logout', async (_request, reply) => {
    clearSession(reply)
    return { ok: true }
  })

  /**
   * `passwordRequired` is false when something else already vouched for this
   * request — the SSO gate in front, or a dev stack with the password off. In
   * both cases signing out would clear a cookie that was never what let you
   * in, so the UI hides the button rather than offering a no-op.
   */
  app.get('/api/v1/auth/me', async (request) => ({
    authenticated: hasSession(request),
    passwordRequired: !isGateTrusted(request),
  }))

  app.post(
    '/api/v1/auth/password',
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = passwordBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'current password and a next password of 8+ characters required' })
      }
      if (!(await checkPassword(db, parsed.data.current))) {
        return reply.code(401).send({ error: 'invalid password' })
      }
      await setPassword(db, parsed.data.next)
      return { ok: true }
    },
  )

  // ── configuration ─────────────────────────────────────────────────────────
  app.get('/api/v1/config', { preHandler: requireSession }, async () => {
    const config = readConfig(db)
    return {
      yaml: configToYaml(config),
      config,
      issues: validateConfig(config),
      ingestToken: getSetting(db, SETTING.ingestToken) ?? '',
    }
  })

  /**
   * Dry run: parse and validate without touching the database.
   *
   * Both renderings of the candidate come back, which is also how the
   * Configuration screen converts between its forms and its editor — the
   * browser never has to serialise the document itself, so there is one
   * definition of what the document looks like.
   */
  app.post('/api/v1/config/validate', { preHandler: requireSession }, async (request, reply) => {
    const parsed = configBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'yaml or config required' })
    try {
      const { config, issues } = parseConfig(candidateFrom(parsed.data))
      return { ok: issues.length === 0, issues, config, yaml: configToYaml(config) }
    } catch (err) {
      return reply.code(400).send({ error: 'could not parse', issues: issuesFrom(err) })
    }
  })

  app.put('/api/v1/config', { preHandler: requireSession }, async (request, reply) => {
    const parsed = configBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'yaml or config required' })
    try {
      const config = writeConfig(db, candidateFrom(parsed.data), 'ui')
      return { ok: true, yaml: configToYaml(config), config }
    } catch (err) {
      if (err instanceof ConfigRejected) return reply.code(422).send(issuesReply(err.issues))
      return reply.code(400).send({ error: 'could not parse', issues: issuesFrom(err) })
    }
  })

  app.post('/api/v1/config/ingest-token/rotate', { preHandler: requireSession }, async (_request, reply) => {
    const { setSetting } = await import('../settings.js')
    const { randomBytes } = await import('node:crypto')
    const token = randomBytes(32).toString('base64url')
    setSetting(db, SETTING.ingestToken, token)
    return reply.send({ ingestToken: token })
  })
}

export { getOrCreateSecret }
