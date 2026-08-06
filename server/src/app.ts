import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerVncProxy } from './api/browser.js'
import { registerRoutes } from './api/routes.js'
import { GATE_TRUSTED } from './auth.js'
import { createGateCheck, type GateCheck } from './gate.js'
import type { Db } from './db/index.js'
import type { PlacementOptions } from './api/routes.js'

/**
 * Kept in step with package.json by hand, and by hand because the alternative
 * is reading package.json at runtime — which means resolving a path that is
 * one thing in the workspace, another in the built server, and another again
 * in the image. This string is what the boot log and /healthz report, so a
 * stale one costs an afternoon working out which build a box is actually
 * running. Bump it in the same commit as the four package.json files.
 */
export const VERSION = '1.3.0'

export interface AppOptions {
  db: Db
  sessionSecret: string
  publicDir: string
  logLevel?: string
  /** Wires ingest and approval to the queue. Absent means nothing is enqueued. */
  receiveOptions?: PlacementOptions
  /**
   * Container name of the SSO gate in front of the desk. When set, a request
   * whose TCP peer is that container counts as authenticated and the desk's
   * own password login is not asked for. See gate.ts.
   */
  trustedGate?: string
  /** Injectable for tests, which have no container network to resolve on. */
  gateCheck?: GateCheck
  /**
   * Treat every request as signed in. Development only — `loadEnv` refuses to
   * set it in a production build, and nothing else should pass it.
   */
  disableAuth?: boolean
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    // Behind the nsl.sh reverse proxy; needed for correct request.ip in logs.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  })

  await app.register(cookie, { secret: options.sessionSecret })

  // The same trust flag the SSO gate sets, granted unconditionally: the desk
  // is single-user, so "already authenticated" is the whole of what a session
  // proves and there is nothing else to skip.
  if (options.disableAuth) {
    app.addHook('onRequest', async (request) => {
      ;(request as unknown as Record<symbol, unknown>)[GATE_TRUSTED] = true
    })
  }

  const gateCheck = options.gateCheck ?? (options.trustedGate ? createGateCheck(options.trustedGate) : undefined)
  if (gateCheck) {
    app.addHook('onRequest', async (request) => {
      // Only the API is gated, so only the API pays for the lookup — the SPA
      // shell is a static file and asking DNS about each of its assets would
      // be a per-asset round trip for nothing.
      if (!request.url.startsWith('/api/')) return
      // The raw socket, deliberately: `request.ip` honours X-Forwarded-For
      // (trustProxy above), which the caller controls.
      if (await gateCheck(request.raw.socket.remoteAddress)) {
        ;(request as unknown as Record<symbol, unknown>)[GATE_TRUSTED] = true
      }
    })
  }

  registerRoutes(app, options.db, VERSION, options.receiveOptions ?? {})

  /**
   * A proxy's upstream is fixed when it is registered, so this is wired at boot
   * rather than per request — and awaited here, where registration already is.
   * It is a no-op unless a browser engine with a viewer is configured.
   */
  await registerVncProxy(app, options.db)

  // The SPA is built into server/public. Absent in dev, where Vite serves it.
  if (existsSync(options.publicDir)) {
    await app.register(fastifyStatic, { root: options.publicDir, wildcard: false })

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}

export { join }
