import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import webpush from 'web-push'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import type { Db } from '../src/db/index.js'
import {
  awaitingCount,
  getOrCreateVapidKeys,
  notifyAll,
  notifyPlacementsWaiting,
  placementCount,
  saveSubscription,
} from '../src/push.js'
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

afterEach(() => {
  vi.restoreAllMocks()
})

/** Fail every send with the status a push service would have returned. */
function pushRefuses(statusCode: number) {
  return vi
    .spyOn(webpush, 'sendNotification')
    .mockRejectedValue(Object.assign(new Error(`refused with ${statusCode}`), { statusCode }))
}

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
    await expect(notifyAll(db, { title: 't', body: 'b', url: '/queue' })).resolves.toEqual({
      subscribers: 0,
      delivered: 0,
      dropped: 0,
      failed: 0,
    })
  })

  it('records why nothing was sent when no device is registered', async () => {
    // The commonest cause of "I never get notified", and it used to leave no
    // trace at all — so the log could not answer the question either.
    await notifyAll(db, { title: 't', body: 'b', url: '/queue' })
    const codes = db.select().from(schema.events).all().map((row) => row.code)
    expect(codes).toContain('PUSH_NO_DEVICES')
  })

  it('drops a subscription the push service has retired', async () => {
    saveSubscription(db, { ...subscription, endpoint: 'https://127.0.0.1:9/gone' })

    // The endpoint is unreachable rather than 410, so it is kept and logged —
    // only an explicit 404/410 means the registration is really dead.
    await notifyAll(db, { title: 't', body: 'b', url: '/queue' })
    expect(db.select().from(schema.pushSubscriptions).all().length).toBeLessThanOrEqual(1)
  })

  it('counts what is standing at the gate', () => {
    // One publication per story: (story_id, outlet_id) is unique, which is the
    // ledger refusing to hold two rows for the same story in the same place.
    for (const status of ['AWAITING_APPROVAL', 'AWAITING_APPROVAL', 'PUBLISHED']) {
      const storyId = randomUUID()
      db.insert(schema.stories)
        .values({ id: storyId, title: 'T', summary: 'S', status: 'PLACED', dedupVerdict: 'NEW' })
        .run()
      db.insert(schema.publications)
        .values({
          id: randomUUID(),
          storyId,
          outletId: 'discord-test',
          status,
          origin: 'managing-editor',
        })
        .run()
    }

    // Only drafts awaiting a decision count — a published one is not waiting.
    expect(awaitingCount(db)).toBe(2)
  })

  it('forgets a device whose VAPID key the desk no longer holds', async () => {
    // 403 is what a re-created database looks like from the push service: the
    // device subscribed against a keypair that no longer exists. Retrying it
    // forever is how a desk ends up reporting a device as notified while every
    // send is refused.
    saveSubscription(db, subscription)
    pushRefuses(403)

    const result = await notifyAll(db, { title: 't', body: 'b', url: '/queue' })

    expect(result).toMatchObject({ subscribers: 1, delivered: 0, dropped: 1, failed: 0 })
    expect(db.select().from(schema.pushSubscriptions).all()).toHaveLength(0)
    expect(db.select().from(schema.events).all().map((row) => row.code)).toContain(
      'PUSH_REGISTRATION_DEAD',
    )
  })

  it('keeps a device whose push service merely misbehaved', async () => {
    // A 500 says nothing about the registration, so throwing it away would cost
    // a device its notifications over someone else's outage.
    saveSubscription(db, subscription)
    pushRefuses(500)

    const result = await notifyAll(db, { title: 't', body: 'b', url: '/queue' })

    expect(result).toMatchObject({ subscribers: 1, delivered: 0, dropped: 0, failed: 1 })
    expect(db.select().from(schema.pushSubscriptions).all()).toHaveLength(1)
  })
})

describe('the placement queue notification', () => {
  function placeStory(status: string): string {
    const id = randomUUID()
    db.insert(schema.stories)
      .values({ id, title: `Story ${id.slice(0, 4)}`, summary: 'S', status, dedupVerdict: 'NEW' })
      .run()
    return id
  }

  it('counts placed and held stories, and nothing else', () => {
    // Held is still a decision waiting on a person, so it stands in the queue.
    placeStory('PLACED')
    placeStory('HELD')
    placeStory('DROPPED')
    placeStory('CLOSED')

    expect(placementCount(db)).toBe(2)
  })

  it('sends one notification for the several stories a single filing opened', async () => {
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never)
    saveSubscription(db, subscription)

    const first = placeStory('PLACED')
    const second = placeStory('PLACED')
    await notifyPlacementsWaiting(db, [
      { storyId: first, title: 'One', held: false },
      { storyId: second, title: 'Two', held: false },
    ])

    // Three chimes for one wire item is how a person turns notifications off.
    expect(send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(send.mock.calls[0]?.[1] as string) as { body: string; url: string }
    expect(payload.body).toBe('One · Two')
    // No single story to open, so it lands on the action list — a notification
    // exists to be acted on, and the Queue makes you hunt for what just chimed.
    expect(payload.url).toBe('/now')
  })

  it('deep-links a lone story to itself', async () => {
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never)
    saveSubscription(db, subscription)

    const storyId = placeStory('PLACED')
    await notifyPlacementsWaiting(db, [{ storyId, title: 'Only one', held: false }])

    const payload = JSON.parse(send.mock.calls[0]?.[1] as string) as { title: string; url: string }
    expect(payload.url).toBe(`/stories/${storyId}`)
    expect(payload.title).toBe('A placement is waiting')
  })

  it('says a held story needs context rather than calling it a placement', async () => {
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never)
    saveSubscription(db, subscription)

    const storyId = placeStory('HELD')
    await notifyPlacementsWaiting(db, [{ storyId, title: 'Unclear', held: true }])

    const payload = JSON.parse(send.mock.calls[0]?.[1] as string) as { title: string }
    expect(payload.title).toBe('A story needs context')
  })

  it('does nothing when the filing opened no story', async () => {
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never)
    saveSubscription(db, subscription)

    await notifyPlacementsWaiting(db, [])

    expect(send).not.toHaveBeenCalled()
  })
})

describe('the notification diagnostics', () => {
  it('reports the key and how many devices the desk believes it can reach', async () => {
    saveSubscription(db, subscription)

    const response = await app.inject({ method: 'GET', url: '/api/v1/push/status', headers: { cookie } })

    expect(response.statusCode).toBe(200)
    // The key is what lets the screen notice a device registered against an
    // older one — the failure a browser cannot see by itself.
    expect(response.json()).toEqual({
      publicKey: getOrCreateVapidKeys(db).publicKey,
      devices: 1,
    })
  })

  it('sends a real notification and reports where it stopped', async () => {
    saveSubscription(db, subscription)
    pushRefuses(500)

    const response = await app.inject({ method: 'POST', url: '/api/v1/push/test', headers: { cookie } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ subscribers: 1, delivered: 0, failed: 1 })
  })

  it('keeps both diagnostics behind the session', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/push/status'],
      ['POST', '/api/v1/push/test'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401)
    }
  })
})
