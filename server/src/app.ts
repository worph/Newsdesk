import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerRoutes } from './api/routes.js'
import type { Db } from './db/index.js'

export const VERSION = '0.1.0'

export interface AppOptions {
  db: Db
  sessionSecret: string
  publicDir: string
  logLevel?: string
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    // Behind the nsl.sh reverse proxy; needed for correct request.ip in logs.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  })

  await app.register(cookie, { secret: options.sessionSecret })

  registerRoutes(app, options.db, VERSION)

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
