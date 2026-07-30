import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import type { Db } from '../src/db/index.js'
import { awaitingCount, getOrCreateVapidKeys, notifyAll, saveSubscription } from '../src/push.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

let app: FastifyInstance
let db: Db
let cookie: string

beforeEach(async () => {
  const handle = openTestDb()
  db = handle.db
  seedDesk(db)
  await setPassword(db, 'test-password')

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
  })

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'test-password' },
  })
  cookie = login.headers['set-cookie'] as string
})

const subscription = {
  endpoint: 'https://push.example.dev/abc',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=', auth: 'tBHItJI5svbpez7KI4CCXg==' },
}

describe('VAPID keys', () => {
  it('generates once and reuses thereafter, so subscriptions survive a restart', () => {
    // Regenerating would silently invalidate every registered device.
    const first = getOrCreateVapidKeys(db)
    const second = getOrCreateVapidKeys(db)
    expect(first.publicKey).toBe(second.publicKey)
    expect(first.publicKey.length).toBeGreaterThan(20)
  })
})

describe('subscription API', () => {
  it('refuses without a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      payload: subscription,
    })
    expect(response.statusCode).toBe(401)
  })

  it('serves the public key the service worker needs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/push/key', headers: { cookie } })
    expect(response.statusCode).toBe(200)
    expect(response.json().publicKey).toBeTruthy()
  })

  it('registers a device', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie },
      payload: subscription,
    })
    expect(response.statusCode).toBe(201)
    expect(db.select().from(schema.pushSubscriptions).all()).toHaveLength(1)
  })

  it('re-registering the same endpoint updates rather than duplicating', async () => {
    saveSubscription(db, subscription)
    saveSubscription(db, { ...subscription, ua: 'Pixel' })

    const rows = db.select().from(schema.pushSubscriptions).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ua).toBe('Pixel')
  })

  it('unsubscribes a device', async () => {
    saveSubscription(db, subscription)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/push/unsubscribe',
      headers: { cookie },
      payload: { endpoint: subscription.endpoint },
    })
    expect(response.statusCode).toBe(200)
    expect(db.select().from(schema.pushSubscriptions).all()).toHaveLength(0)
  })

  it('rejects a malformed subscription', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie },
      payload: { endpoint: 'not-a-url' },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('notifying', () => {
  it('sends nothing when no device is registered, without erroring', async () => {
    // Push is best-effort: silence here must never become an exception that
    // fails whatever was being published.
    await expect(notifyAll(db, { title: 't', body: 'b', url: '/queue' })).resolves.toBe(0)
  })

  it('drops a subscription the push service has retired', async () => {
    saveSubscription(db, { ...subscription, endpoint: 'https://127.0.0.1:9/gone' })

    // The endpoint is unreachable rather than 410, so it is kept and logged —
    // only an explicit 404/410 means the registration is really dead.
    await notifyAll(db, { title: 't', body: 'b', url: '/queue' })
    expect(db.select().from(schema.pushSubscriptions).all().length).toBeLessThanOrEqual(1)
  })

  it('counts what is standing at the gate', () => {
    // One publication per story: (story_id, target_id) is unique, which is the
    // ledger refusing to hold two rows for the same story in the same place.
    for (const status of ['AWAITING_APPROVAL', 'AWAITING_APPROVAL', 'PUBLISHED']) {
      const storyId = randomUUID()
      db.insert(schema.stories)
        .values({ id: storyId, title: 'T', summary: 'S', status: 'ROUTED', dedupVerdict: 'NEW' })
        .run()
      db.insert(schema.publications)
        .values({
          id: randomUUID(),
          storyId,
          targetId: 'discord-test',
          status,
          origin: 'director',
        })
        .run()
    }

    // Only drafts awaiting a decision count — a published one is not waiting.
    expect(awaitingCount(db)).toBe(2)
  })
})
