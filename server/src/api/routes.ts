import { validateConfig, type ConfigIssue } from '@newsdesk/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { checkPassword, clearSession, hasSession, issueSession, requireSession, setPassword } from '../auth.js'
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
const configBody = z.object({ yaml: z.string() })
const passwordBody = z.object({ current: z.string().min(1), next: z.string().min(8) })

function issuesReply(issues: ConfigIssue[]) {
  return { error: 'configuration rejected', issues }
}

export interface RouteOptions extends ReceiveOptions {
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
  receiveOptions: RouteOptions = {},
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

  app.get('/api/v1/auth/me', async (request) => ({ authenticated: hasSession(request) }))

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

  /** Dry run: parse and validate without touching the database. */
  app.post('/api/v1/config/validate', { preHandler: requireSession }, async (request, reply) => {
    const parsed = configBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'yaml required' })
    try {
      const candidate = yamlToConfig(parsed.data.yaml)
      const { parseConfig } = await import('@newsdesk/shared')
      const { issues } = parseConfig(candidate)
      return { ok: issues.length === 0, issues }
    } catch (err) {
      return reply.code(400).send({
        error: 'could not parse',
        issues: [{ path: '', message: err instanceof Error ? err.message : String(err) }],
      })
    }
  })

  app.put('/api/v1/config', { preHandler: requireSession }, async (request, reply) => {
    const parsed = configBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'yaml required' })
    try {
      const config = writeConfig(db, yamlToConfig(parsed.data.yaml), 'ui')
      return { ok: true, yaml: configToYaml(config), config }
    } catch (err) {
      if (err instanceof ConfigRejected) return reply.code(422).send(issuesReply(err.issues))
      return reply.code(400).send({
        error: 'could not parse',
        issues: [{ path: '', message: err instanceof Error ? err.message : String(err) }],
      })
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
