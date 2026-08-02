import { createReadStream, existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { browser, loadEngine } from '../ports/delivery/browser/engine.js'
import { BrowserBusy, holder } from '../ports/delivery/browser/lease.js'
import {
  abandon,
  attest,
  beginSignIn,
  confirmSignedIn,
  keepAlive,
  stage,
} from '../ports/delivery/browser/session.js'
import { McpError } from '../ports/mcp/client.js'

/**
 * The operator's half of a browser publish.
 *
 * Everything here is behind the desk's own session, and the browser container
 * is never reachable any other way: its port is not published, so these routes
 * are the only door to a browser holding live logged-in sessions. That is worth
 * stating because the viewer below is, precisely, remote control of it.
 *
 * See docs/browser-publishing.md sections 4 and 6.
 */

const VNC_PREFIX = '/api/v1/browser/vnc'

function failure(err: unknown): { code: number; body: Record<string, unknown> } {
  if (err instanceof BrowserBusy) {
    return {
      code: 409,
      body: {
        error: `the desk is publishing ${err.held.label} for someone else — you are next`,
        busy: { label: err.held.label, publicationId: err.held.publicationId, since: new Date(err.held.takenAt).toISOString() },
      },
    }
  }
  if (err instanceof McpError) {
    return { code: err.retryable ? 503 : 422, body: { error: err.message } }
  }
  return { code: 500, body: { error: err instanceof Error ? err.message : String(err) } }
}

/** The engine a publication publishes through, or undefined if it is not a browser outlet. */
function engineFor(db: Db, publicationId: string) {
  const row = db
    .select({ engineId: schema.outlets.engineId, driver: schema.outlets.driver })
    .from(schema.publications)
    .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))
    .where(eq(schema.publications.id, publicationId))
    .get()
  if (!row || row.driver !== 'browser') return undefined
  return loadEngine(db, row.engineId)
}

export function registerBrowserRoutes(app: FastifyInstance, db: Db, traceDir: string): void {
  /**
   * Compose the page and take the browser.
   *
   * Called when the operator opens the live view, never at the scheduled
   * moment — the wait for a person must not hold a browser (section 4).
   */
  app.post('/api/v1/publications/:id/stage', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const staged = await stage(db, id)
      const engine = engineFor(db, id)
      return {
        ...staged,
        lease: { expiresAt: new Date(staged.lease.expiresAt).toISOString() },
        viewer: engine?.viewer === 'novnc' ? { kind: 'novnc', path: VNC_PREFIX } : { kind: 'none' },
      }
    } catch (err) {
      const { code, body } = failure(err)
      return reply.code(code).send(body)
    }
  })

  /** The operator pressed the destination's own button. */
  app.post('/api/v1/publications/:id/sent', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return await attest(db, id)
    } catch (err) {
      const { code, body } = failure(err)
      return reply.code(code).send(body)
    }
  })

  /**
   * Put the destination's own login page in front of the operator, and hold the
   * browser while they use it.
   */
  app.post('/api/v1/publications/:id/open-sign-in', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const { url, lease } = await beginSignIn(db, id)
      const engine = engineFor(db, id)
      return {
        url,
        lease: { expiresAt: new Date(lease.expiresAt).toISOString() },
        viewer: engine?.viewer === 'novnc' ? { kind: 'novnc', path: VNC_PREFIX } : { kind: 'none' },
      }
    } catch (err) {
      const { code, body } = failure(err)
      return reply.code(code).send(body)
    }
  })

  /**
   * "I've signed in." Verified rather than believed — see `confirmSignedIn`.
   */
  app.post('/api/v1/publications/:id/signed-in', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const signedIn = await confirmSignedIn(db, id)
      return signedIn
        ? { signedIn: true }
        : reply.code(409).send({
            signedIn: false,
            error: 'the destination still shows a sign-in page — finish signing in, then try again',
          })
    } catch (err) {
      const { code, body } = failure(err)
      return reply.code(code).send(body)
    }
  })

  /** They opened it and did not send. The slot survives; the browser is freed. */
  app.post('/api/v1/publications/:id/not-sent', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      abandon(db, id)
      return { ok: true }
    } catch (err) {
      const { code, body } = failure(err)
      return reply.code(code).send(body)
    }
  })

  /** Hold the lease while the live view is open. */
  app.post('/api/v1/publications/:id/keepalive', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return { held: keepAlive(db, id) }
    } catch (err) {
      const { code, body } = failure(err)
      return reply.code(code).send(body)
    }
  })

  /** Every step the desk took on the page, for the log and the review screen. */
  app.get('/api/v1/publications/:id/traces', { preHandler: requireSession }, async (request) => {
    const { id } = request.params as { id: string }
    const traces = db
      .select()
      .from(schema.publishTraces)
      .where(eq(schema.publishTraces.publicationId, id))
      .orderBy(desc(schema.publishTraces.at))
      .limit(200)
      .all()
    return { traces: traces.map((t) => ({ ...t, detail: t.detail ? JSON.parse(t.detail) : null })) }
  })

  /** A screenshot the desk took. Served from the data dir, never from the web root. */
  app.get('/api/v1/browser/screenshot/:name', { preHandler: requireSession }, async (request, reply) => {
    const { name } = request.params as { name: string }
    // The name comes from our own rows, but it reaches us through a URL — so it
    // is treated as a path someone chose until proven otherwise.
    const safe = normalize(name).replace(/^(\.\.[/\\])+/, '')
    if (safe.includes('/') || safe.includes('\\') || !safe.endsWith('.png')) {
      return reply.code(400).send({ error: 'not a screenshot' })
    }
    const file = join(traceDir, safe)
    if (!existsSync(file)) return reply.code(404).send({ error: 'no such screenshot' })
    return reply.type('image/png').send(createReadStream(file))
  })

  /**
   * What the viewer needs to connect: the address of the noVNC surface and the
   * password, which rotates every time the container boots.
   *
   * Fetched here rather than by the browser so the container is never named to
   * the client, and so an operator without a session never learns either.
   */
  app.get('/api/v1/browser/viewer/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const engine = engineFor(db, id)
    if (!engine) return reply.code(404).send({ error: 'this outlet does not publish through a browser' })
    if (engine.viewer !== 'novnc') return { kind: 'none' }

    try {
      const password = await browser.vncPassword(engine)
      const held = holder(engine.id)
      return {
        kind: 'novnc',
        // noVNC's own page, proxied under this origin. `path` is where its
        // client opens the socket, relative to the page it was served from.
        url: `${VNC_PREFIX}/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=${encodeURIComponent(
          `${VNC_PREFIX.slice(1)}/websockify`,
        )}${password ? `&password=${encodeURIComponent(password)}` : ''}`,
        heldBy: held?.publicationId === id ? null : (held?.label ?? null),
      }
    } catch (err) {
      const { code, body } = failure(err)
      return reply.code(code).send(body)
    }
  })
}

/**
 * The noVNC surface, proxied under the desk's origin.
 *
 * Registered separately from the routes above because it is an upstream rather
 * than a handler, and because it has to be wired to one engine at boot: a
 * proxy's target is fixed when it is registered. One browser engine is the
 * supported shape (section 7), so this reads the first one configured.
 *
 * `preHandler` matters more here than anywhere else in the desk. Without it
 * this path would be unauthenticated remote control of a browser holding every
 * session the operator has ever logged into.
 */
export async function registerVncProxy(app: FastifyInstance, db: Db): Promise<void> {
  const engine = db.select().from(schema.browserEngines).limit(1).get()
  if (!engine || engine.viewer !== 'novnc') return

  // Imported here rather than at the top of the file so a desk with no browser
  // never pays to load a proxy stack it will not register — which is every
  // deployment that does not run the sidecar, and every test that boots the app.
  const { default: httpProxy } = await import('@fastify/http-proxy')

  await app.register(httpProxy, {
    upstream: engine.apiBase.replace(/\/+$/, ''),
    prefix: VNC_PREFIX,
    rewritePrefix: '/vnc',
    websocket: true,
    preHandler: requireSession,
  })
}
