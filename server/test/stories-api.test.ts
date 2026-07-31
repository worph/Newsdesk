import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import type { Db } from '../src/db/index.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

let app: FastifyInstance
let db: Db
let cookie: string
const queued: string[] = []

async function seedStory(over: Partial<typeof schema.stories.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? randomUUID()
  db.insert(schema.stories)
    .values({
      id,
      title: 'Immich v1.142.0',
      summary: 'A point release.',
      status: 'PLACED',
      dedupVerdict: 'NEW',
      ...over,
    })
    .run()
  return id
}

function seedFiling(): string {
  const id = randomUUID()
  db.insert(schema.filings)
    .values({ id, stringerId: 'korben', kind: 'report', text: 'filed', considered: 'filed', status: 'PROCESSED' })
    .run()
  return id
}

beforeEach(async () => {
  queued.length = 0
  const handle = openTestDb()
  db = handle.db
  seedDesk(db)
  await setPassword(db, 'test-password')

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
    receiveOptions: { enqueueManagingEditor: (id) => queued.push(id) },
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
  app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) })

describe('GET /stories', () => {
  it('refuses without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/stories' })
    expect(response.statusCode).toBe(401)
  })

  it('lists stories with their placements and source counts', async () => {
    const storyId = await seedStory()
    const filingId = seedFiling()
    db.insert(schema.storyFilings).values({ storyId, filingId }).run()
    db.insert(schema.publications)
      .values({
        id: randomUUID(),
        storyId,
        outletId: 'discord-test',
        status: 'PROPOSED',
        origin: 'managing-editor',
        placementReason: 'self-hosters run it',
      })
      .run()

    const body = (await get('/api/v1/stories')).json()
    expect(body.stories).toHaveLength(1)
    expect(body.stories[0]).toMatchObject({ sourceCount: 1 })
    expect(body.stories[0].placements[0]).toMatchObject({
      outletId: 'discord-test',
      outletName: 'Discord',
      placementReason: 'self-hosters run it',
    })
  })

  it('filters by status, which is what the spiked view is', async () => {
    await seedStory({ status: 'PLACED' })
    await seedStory({ status: 'DROPPED', dropReason: 'nothing clears the bar' })

    const spiked = (await get('/api/v1/stories?status=DROPPED')).json()
    expect(spiked.stories).toHaveLength(1)
    expect(spiked.stories[0].dropReason).toBe('nothing clears the bar')
  })

  it('names the story a duplicate matched, so the verdict is checkable', async () => {
    const earlier = await seedStory({ title: 'The original' })
    await seedStory({
      title: 'The duplicate',
      status: 'DROPPED',
      dedupVerdict: 'DUPLICATE',
      relatedStoryId: earlier,
    })

    const body = (await get('/api/v1/stories?status=DROPPED')).json()
    expect(body.stories[0].relatedTitle).toBe('The original')
  })

  it('searches title and summary', async () => {
    await seedStory({ title: 'Immich release' })
    await seedStory({ title: 'Something else', summary: 'unrelated' })

    const body = (await get('/api/v1/stories?q=Immich')).json()
    expect(body.stories).toHaveLength(1)
  })
})

describe('GET /stories/:id', () => {
  it('returns the story, its filings and the related story', async () => {
    const earlier = await seedStory({ title: 'The original' })
    const storyId = await seedStory({ title: 'Follow-up', dedupVerdict: 'UPDATE', relatedStoryId: earlier })
    const filingId = seedFiling()
    db.insert(schema.storyFilings).values({ storyId, filingId }).run()

    const body = (await get(`/api/v1/stories/${storyId}`)).json()
    expect(body.story.title).toBe('Follow-up')
    expect(body.related.title).toBe('The original')
    expect(body.filings[0]).toMatchObject({ stringerId: 'korben', stringerName: 'korben.info' })
  })

  it('404s on an unknown story', async () => {
    expect((await get('/api/v1/stories/nope')).statusCode).toBe(404)
  })
})

describe('POST /stories/:id/placements', () => {
  it('adds a placement the managing editor did not propose, marked as yours', async () => {
    // The override diff is the highest-value data the desk produces, so a
    // placement you added must never look like one the managing editor suggested.
    const storyId = await seedStory()
    const response = await post(`/api/v1/stories/${storyId}/placements`, { outlet_id: 'discord-test' })
    expect(response.statusCode).toBe(201)

    const publication = db.select().from(schema.publications).get()!
    expect(publication.origin).toBe('human')
  })

  it('un-spikes a story that was dropped only for having no placements', async () => {
    const storyId = await seedStory({ status: 'DROPPED', dropReason: 'no destination clears the bar' })
    await post(`/api/v1/stories/${storyId}/placements`, { outlet_id: 'discord-test' })

    const story = db.select().from(schema.stories).get()!
    expect(story.status).toBe('PLACED')
    expect(story.dropReason).toBeNull()
  })

  it('leaves a duplicate spiked — adding a placement does not make it not a duplicate', async () => {
    const earlier = await seedStory()
    const storyId = await seedStory({
      status: 'DROPPED',
      dedupVerdict: 'DUPLICATE',
      relatedStoryId: earlier,
      dropReason: 'already told',
    })
    await post(`/api/v1/stories/${storyId}/placements`, { outlet_id: 'discord-test' })

    const story = db.select().from(schema.stories).where(eq(schema.stories.id, storyId)).get()!
    expect(story.status).toBe('DROPPED')
  })

  it('refuses an unknown outlet', async () => {
    const storyId = await seedStory()
    const response = await post(`/api/v1/stories/${storyId}/placements`, { outlet_id: 'invented' })
    expect(response.statusCode).toBe(422)
  })

  it('refuses a duplicate placement to the same destination', async () => {
    const storyId = await seedStory()
    await post(`/api/v1/stories/${storyId}/placements`, { outlet_id: 'discord-test' })
    const second = await post(`/api/v1/stories/${storyId}/placements`, { outlet_id: 'discord-test' })
    expect(second.statusCode).toBe(409)
  })
})

describe('POST /stories/:id/rerun', () => {
  it('re-queues every filing behind the story', async () => {
    const storyId = await seedStory()
    const filingId = seedFiling()
    db.insert(schema.storyFilings).values({ storyId, filingId }).run()

    const response = await post(`/api/v1/stories/${storyId}/rerun`)
    expect(response.statusCode).toBe(202)
    expect(queued).toEqual([filingId])
    expect(db.select().from(schema.filings).get()?.status).toBe('PROCESSING')
  })

  it('404s when nothing produced the story', async () => {
    const storyId = await seedStory()
    expect((await post(`/api/v1/stories/${storyId}/rerun`)).statusCode).toBe(404)
  })
})

describe('GET /jobs', () => {
  it('reports queue state', async () => {
    const body = (await get('/api/v1/jobs')).json()
    expect(body.stats).toMatchObject({ pending: 0, running: 0, done: 0, failed: 0 })
  })
})
