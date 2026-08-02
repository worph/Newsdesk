import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { openDb, runMigrations } from '../src/db/index.js'
import type { Db } from '../src/db/index.js'
import { schema, seedDesk } from './helpers.js'

/**
 * The viewer socket, and who is allowed to open it.
 *
 * This is the most dangerous route in the desk: on the other end of it is a
 * browser holding every session an operator has ever signed in to, and the
 * container's own port is deliberately not published so this proxy is the only
 * way to reach it. If the websocket upgrade skipped the session check — as it
 * would if the proxy hijacked the socket before Fastify ran its hooks — anyone
 * who could reach the desk would have remote control of that browser.
 *
 * Proven with a real listening server rather than `inject`, because an upgrade
 * is exactly the thing `inject` cannot exercise.
 */

let app: FastifyInstance
let db: Db
let port: number
let cookie: string
let close: () => void

/** A websocket handshake, far enough to see whether we are let through. */
function upgrade(path: string, cookie?: string): Promise<string> {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(cookie ? { cookie } : {}),
      },
    })
    request.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve('upgraded')
    })
    request.on('response', (response) => {
      response.resume()
      resolve(`http ${response.statusCode}`)
    })
    request.on('error', (err) => resolve(`error ${err.message}`))
    request.end()
  })
}

/**
 * Once for the file, not once per test: these four probes read and mutate
 * nothing, and the setup is a migrated database plus an argon2 hash plus a
 * listening server — expensive enough that repeating it four times is what
 * makes this file time out on a loaded machine rather than anything it tests.
 */
beforeAll(async () => {
  // `openTestDb` cleans up through `onTestFinished`, which only fires inside a
  // test — so the database is opened by hand here and closed in afterAll.
  const dir = mkdtempSync(join(tmpdir(), 'newsdesk-viewer-'))
  const handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, fileURLToPath(new URL('../drizzle', import.meta.url)))
  db = handle.db
  close = () => {
    handle.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
  seedDesk(db)
  await setPassword(db, 'test-password')

  // Registered at boot, so the engine has to exist before the app is built.
  // The upstream is deliberately dead: nothing that gets past the gate should
  // reach it, and an auth failure must not depend on the browser being up.
  db.insert(schema.browserEngines)
    .values({ id: 'sidecar', name: 'browser', apiBase: 'http://127.0.0.1:1', viewer: 'novnc' })
    .run()

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as { port: number }).port

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'test-password' },
  })
  cookie = login.headers['set-cookie'] as string
  // Generous on purpose: migrations, an argon2 hash and a listening socket, on
  // a machine already running the rest of the suite. The default 10s is a
  // coin toss under that load, and a flaky security test is a test people
  // learn to ignore.
}, 60_000)

afterAll(async () => {
  await app.close()
  close()
})

describe('the viewer socket', () => {
  it('refuses a websocket upgrade from a stranger', async () => {
    // The upgrade goes through Fastify's router precisely so the route's
    // preHandler runs. If this ever answers "upgraded", the desk is handing
    // out remote control of a logged-in browser to anyone who asks.
    expect(await upgrade('/api/v1/browser/vnc/websockify')).toBe('http 401')
  })

  it('refuses the noVNC page itself without a session', async () => {
    // An ordinary GET, probed as one: sending an upgrade header at a plain page
    // races the proxy tearing the socket down, which says nothing about auth.
    const response = await app.inject({ method: 'GET', url: '/api/v1/browser/vnc/vnc.html' })
    expect(response.statusCode).toBe(401)
  })

  it('refuses the password endpoint without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/browser/viewer/anything' })
    expect(response.statusCode).toBe(401)
  })

  it('lets a signed-in operator through to the upstream', async () => {
    // The upstream is dead, so "got past the gate" is what is being asserted —
    // anything other than a 401 means the session was accepted.
    expect(await upgrade('/api/v1/browser/vnc/websockify', cookie)).not.toBe('http 401')
  })
})
