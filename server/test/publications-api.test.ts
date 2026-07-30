import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import type { Db } from '../src/db/index.js'
import { deliverPublication } from '../src/ports/delivery/index.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

let app: FastifyInstance
let db: Db
let cookie: string
const published: string[] = []

let publicationId: string
let storyId: string

beforeEach(async () => {
  published.length = 0
  const handle = openTestDb()
  db = handle.db
  seedDesk(db)
  await setPassword(db, 'test-password')

  storyId = randomUUID()
  publicationId = randomUUID()
  db.insert(schema.stories)
    .values({
      id: storyId,
      title: 'Immich v1.142.0',
      summary: 'A point release.',
      url: 'https://example.dev/immich',
      status: 'ROUTED',
      dedupVerdict: 'NEW',
    })
    .run()
  db.insert(schema.publications)
    .values({
      id: publicationId,
      storyId,
      targetId: 'discord-test',
      status: 'AWAITING_APPROVAL',
      origin: 'director',
      routeReason: 'self-hosters run it',
      angle: 'lead on the upgrade',
      slots: JSON.stringify({ title: 'Immich 1.142.0', description: 'Adds Intel QSV transcoding.' }),
    })
    .run()

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
    receiveOptions: { enqueuePublish: (id) => published.push(id) },
  })

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'test-password' },
  })
  cookie = login.headers['set-cookie'] as string
})

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })
const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) })
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: { cookie }, payload })

const row = () =>
  db.select().from(schema.publications).where(eq(schema.publications.id, publicationId)).get()!

describe('reviewing', () => {
  it('shows only the authoring slots, never the destination', async () => {
    const body = (await get(`/api/v1/publications/${publicationId}`)).json()
    expect(Object.keys(body.slotSpec)).toEqual(['title', 'description'])
    expect(body.slotSpec.channelId).toBeUndefined()
  })

  it('previews what will be sent, separating authored from fixed', async () => {
    const body = (await get(`/api/v1/publications/${publicationId}`)).json()
    expect(body.preview.payload.channelId).toBe('1514993197082742814')
    expect(body.preview.authored).toEqual(['title', 'description'])
    expect(body.preview.fixed).toContain('channelId')
  })

  it('lists sibling routes, so approving one is never mistaken for shipping all', async () => {
    const body = (await get(`/api/v1/publications/${publicationId}`)).json()
    expect(body.siblings).toHaveLength(1)
  })
})

describe('editing', () => {
  it('saves slots and records a version', async () => {
    const response = await patch(`/api/v1/publications/${publicationId}`, {
      slots: { title: 'A better headline' },
    })
    expect(response.statusCode).toBe(200)

    expect(JSON.parse(row().slots!).title).toBe('A better headline')
    // The other slot survives a partial save.
    expect(JSON.parse(row().slots!).description).toContain('Intel QSV')

    const versions = db.select().from(schema.draftVersions).all()
    expect(versions).toHaveLength(1)
    expect(versions[0]?.origin).toBe('human')
  })

  it('refuses to write a key that is not an authoring slot', async () => {
    // Invariant 3 at the API boundary: not even the editor addresses a message
    // by hand — the destination is configuration.
    const response = await patch(`/api/v1/publications/${publicationId}`, {
      slots: { channelId: 'somewhere-else' },
    })
    expect(response.statusCode).toBe(422)
  })

  it('reverts by appending, so history is never rewound', async () => {
    await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'First edit' } })
    const first = db.select().from(schema.draftVersions).all()[0]!
    await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'Second edit' } })

    const response = await post(`/api/v1/publications/${publicationId}/revert`, { version_id: first.id })
    expect(response.statusCode).toBe(200)

    expect(JSON.parse(row().slots!).title).toBe('First edit')
    expect(db.select().from(schema.draftVersions).all()).toHaveLength(3)
  })
})

describe('approval — the gate', () => {
  it('freezes the merged payload and queues the send', async () => {
    const response = await post(`/api/v1/publications/${publicationId}/approve`)
    expect(response.statusCode).toBe(202)

    const stored = row()
    expect(stored.status).toBe('APPROVED')
    expect(stored.approvedAt).toBeTruthy()
    expect(JSON.parse(stored.payload!)).toEqual({
      channelId: '1514993197082742814',
      timestamp: true,
      footer: 'https://example.dev/immich',
      title: 'Immich 1.142.0',
      description: 'Adds Intel QSV transcoding.',
    })
    expect(published).toEqual([publicationId])
  })

  it('refuses to approve a draft missing a required slot', async () => {
    db.update(schema.publications)
      .set({ slots: JSON.stringify({ title: 'Only a title' }) })
      .where(eq(schema.publications.id, publicationId))
      .run()

    const response = await post(`/api/v1/publications/${publicationId}/approve`)
    expect(response.statusCode).toBe(422)
    expect(response.json().missing).toEqual(['description'])
    expect(row().status).toBe('AWAITING_APPROVAL')
  })

  it('refuses to approve twice', async () => {
    await post(`/api/v1/publications/${publicationId}/approve`)
    db.update(schema.publications)
      .set({ status: 'PUBLISHED' })
      .where(eq(schema.publications.id, publicationId))
      .run()

    expect((await post(`/api/v1/publications/${publicationId}/approve`)).statusCode).toBe(409)
  })

  it('refuses a disabled target', async () => {
    db.update(schema.targets).set({ enabled: false }).where(eq(schema.targets.id, 'discord-test')).run()
    expect((await post(`/api/v1/publications/${publicationId}/approve`)).statusCode).toBe(422)
  })

  it('an edit after approval does not change the frozen payload', async () => {
    // Invariant 2: nothing may alter the payload between approval and the wire.
    await post(`/api/v1/publications/${publicationId}/approve`)
    const frozen = row().payload!

    await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'Changed my mind' } })

    expect(row().payload).toBe(frozen)
    expect(JSON.parse(row().payload!).title).toBe('Immich 1.142.0')
  })

  it('serves the frozen bytes rather than a fresh merge once approved', async () => {
    await post(`/api/v1/publications/${publicationId}/approve`)
    await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'Changed' } })

    const body = (await get(`/api/v1/publications/${publicationId}/payload`)).json()
    expect(body.frozen).toBe(true)
    expect(body.payload.title).toBe('Immich 1.142.0')
  })
})

describe('rejection', () => {
  it('leaves a REJECTED row rather than deleting the proposal', async () => {
    // That row is half of the override diff — what the director proposed
    // against what you decided.
    const response = await post(`/api/v1/publications/${publicationId}/reject`, { reason: 'too thin' })
    expect(response.statusCode).toBe(200)

    const stored = row()
    expect(stored.status).toBe('REJECTED')
    expect(stored.error).toBe('too thin')
  })

  it('refuses to approve something already spiked', async () => {
    await post(`/api/v1/publications/${publicationId}/reject`, {})
    expect((await post(`/api/v1/publications/${publicationId}/approve`)).statusCode).toBe(409)
  })
})

describe('delivery', () => {
  it('sends the frozen payload byte for byte through the sink driver', async () => {
    // Invariants 1 and 2 as an assertion: what is delivered equals what was
    // approved, exactly.
    db.update(schema.targets).set({ driver: 'builtin' }).where(eq(schema.targets.id, 'discord-test')).run()
    await post(`/api/v1/publications/${publicationId}/approve`)
    const approved = JSON.parse(row().payload!)

    await deliverPublication(db, publicationId)

    const stored = row()
    expect(stored.status).toBe('PUBLISHED')
    expect(stored.publishedAt).toBeTruthy()
    expect(JSON.parse(stored.payload!)).toEqual(approved)

    const event = db.select().from(schema.events).all().find((e) => e.code === 'PUBLISHED')
    expect(event?.detail).toContain('1514993197082742814')
  })

  it('refuses to deliver something that was never approved', async () => {
    await expect(deliverPublication(db, publicationId)).rejects.toThrow(/only an approved payload/)
  })

  it('does not double-post an already published row', async () => {
    db.update(schema.targets).set({ driver: 'builtin' }).where(eq(schema.targets.id, 'discord-test')).run()
    await post(`/api/v1/publications/${publicationId}/approve`)
    await deliverPublication(db, publicationId)
    const firstPublishedAt = row().publishedAt

    await deliverPublication(db, publicationId)
    expect(row().publishedAt).toBe(firstPublishedAt)
  })

  it('records a delivery failure on the row and in the log', async () => {
    // An mcp target pointing at an endpoint that does not resolve.
    db.update(schema.mcpEndpoints)
      .set({ url: 'http://127.0.0.1:9/mcp/' })
      .where(eq(schema.mcpEndpoints.id, 'beacon'))
      .run()
    await post(`/api/v1/publications/${publicationId}/approve`)

    await expect(deliverPublication(db, publicationId)).rejects.toThrow()

    const stored = row()
    expect(stored.status).toBe('FAILED')
    expect(stored.error).toBeTruthy()
    expect(db.select().from(schema.events).all().some((e) => e.code === 'PUBLISH_FAILED')).toBe(true)
  })

  it('retry re-sends the frozen payload without rebuilding it', async () => {
    db.update(schema.targets).set({ driver: 'builtin' }).where(eq(schema.targets.id, 'discord-test')).run()
    await post(`/api/v1/publications/${publicationId}/approve`)
    db.update(schema.publications)
      .set({ status: 'FAILED', error: 'upstream was down' })
      .where(eq(schema.publications.id, publicationId))
      .run()
    published.length = 0

    const response = await post(`/api/v1/publications/${publicationId}/retry`)
    expect(response.statusCode).toBe(202)
    expect(published).toEqual([publicationId])
  })

  it('refuses to retry something never approved', async () => {
    expect((await post(`/api/v1/publications/${publicationId}/retry`)).statusCode).toBe(422)
  })
})
