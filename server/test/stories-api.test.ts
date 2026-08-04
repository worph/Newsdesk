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
const sends: Array<{ id: string; runAfter?: Date }> = []

/** A second destination, so "approve all" has more than one thing to approve. */
function seedSecondOutlet(): void {
  db.insert(schema.outlets)
    .values({
      id: 'telegram-test',
      name: 'Telegram',
      description: 'Test channel.',
      role: 'publish',
      driver: 'mcp',
      enabled: true,
      voiceId: 'alicia',
      endpointId: 'beacon',
      tool: 'telegram-mcp__send_message',
      destinationKey: null,
      argsSpec: JSON.stringify({
        title: { slot: 'text', label: 'Headline', max: 256, optional: false, primary: false },
        description: { slot: 'markdown', label: 'Body', max: 4096, optional: false, primary: true },
      }),
    })
    .run()
}

/** The seeded outlets both declare a headline and a body; this fills both. */
const WRITTEN = JSON.stringify({ title: 'Immich 1.142', description: 'A point release.' })

function seedPlacement(
  storyId: string,
  over: Partial<typeof schema.publications.$inferInsert> = {},
): string {
  const id = over.id ?? randomUUID()
  db.insert(schema.publications)
    .values({
      id,
      storyId,
      outletId: 'discord-test',
      status: 'AWAITING_APPROVAL',
      origin: 'managing-editor',
      placementReason: 'self-hosters run it',
      slots: WRITTEN,
      ...over,
    })
    .run()
  return id
}

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
  sends.length = 0
  const handle = openTestDb()
  db = handle.db
  seedDesk(db)
  seedSecondOutlet()
  await setPassword(db, 'test-password')

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
    receiveOptions: {
      enqueueManagingEditor: (id) => queued.push(id),
      enqueuePublish: (id, runAfter) => sends.push({ id, ...(runAfter ? { runAfter } : {}) }),
    },
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

describe('GET /stories/:id — the placement decision', () => {
  it('proposes a time for every placement, including one nobody has written yet', async () => {
    // The proposal is the whole reason this screen can be decided from: it is
    // what the "approve all" button commits to, and it has to be there from the
    // moment the managing editor places the story — not once a draft lands.
    const storyId = await seedStory()
    seedPlacement(storyId, { status: 'PROPOSED', slots: null })

    const body = (await get(`/api/v1/stories/${storyId}`)).json()
    const [placement] = body.placements
    expect(placement.schedule.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(placement.schedule.reason).toBeTruthy()
    // Nothing is written, so the desk must not offer to send it.
    expect(placement).toMatchObject({ ready: false })
    expect(body.timezone).toBeTruthy()
  })

  it('marks a finished draft ready, and names what is missing when it is not', async () => {
    const storyId = await seedStory()
    seedPlacement(storyId)
    const blank = seedPlacement(storyId, {
      outletId: 'telegram-test',
      slots: JSON.stringify({ title: 'Immich 1.142' }),
    })

    const body = (await get(`/api/v1/stories/${storyId}`)).json()
    const byId = Object.fromEntries(body.placements.map((row: { id: string }) => [row.id, row]))
    expect(body.placements.find((row: { ready: boolean }) => row.ready)).toBeTruthy()
    expect(byId[blank]).toMatchObject({ ready: false, missing: ['description'] })
  })

  it('proposes nothing once the time is committed — a schedule is not a suggestion', async () => {
    const storyId = await seedStory()
    const at = new Date(Date.now() + 3_600_000).toISOString()
    seedPlacement(storyId, { status: 'SCHEDULED', scheduledFor: at, payload: '{}' })

    const body = (await get(`/api/v1/stories/${storyId}`)).json()
    expect(body.placements[0]).toMatchObject({ schedule: null, scheduledFor: at, ready: false })
  })
})

describe('POST /stories/:id/placements/approve', () => {
  it('approves every finished draft at its own proposed time, freezing each payload', async () => {
    const storyId = await seedStory()
    const first = seedPlacement(storyId)
    const second = seedPlacement(storyId, { outletId: 'telegram-test' })

    const response = await post(`/api/v1/stories/${storyId}/placements/approve`)
    expect(response.statusCode).toBe(200)
    expect(response.json().approved).toHaveLength(2)
    expect(response.json().skipped).toEqual([])

    for (const id of [first, second]) {
      const row = db.select().from(schema.publications).where(eq(schema.publications.id, id)).get()!
      expect(row.status).toBe('SCHEDULED')
      // The gate's guarantee, unchanged by being reached in bulk.
      expect(JSON.parse(row.payload!)).toMatchObject({ title: 'Immich 1.142' })
      expect(row.scheduledFor).toBeTruthy()
    }
    expect(sends.map((send) => send.id).sort()).toEqual([first, second].sort())
  })

  it('gives each destination its own posting window rather than one shared instant', async () => {
    // This is why the bulk path proposes per placement instead of picking one
    // time and applying it to everything: a destination that only posts at 03:00
    // must still only post at 03:00 when it is approved alongside four others.
    const storyId = await seedStory()
    seedPlacement(storyId)
    seedPlacement(storyId, { outletId: 'telegram-test' })
    db.update(schema.outlets)
      .set({ cadence: JSON.stringify({ timezone: 'UTC', window: { from: '03:00', to: '03:30' } }) })
      .where(eq(schema.outlets.id, 'telegram-test'))
      .run()

    const approved = (await post(`/api/v1/stories/${storyId}/placements/approve`)).json().approved
    const telegram = approved.find((row: { outlet: string }) => row.outlet === 'Telegram')
    const at = new Date(telegram.scheduledFor)
    expect(at.getUTCHours()).toBe(3)
    expect(at.getUTCMinutes()).toBeLessThanOrEqual(30)
  })

  it('skips what is not standing at the gate, by name, and still approves the rest', async () => {
    const storyId = await seedStory()
    const ready = seedPlacement(storyId)
    seedPlacement(storyId, { outletId: 'telegram-test', status: 'PROPOSED', slots: null })

    const body = (await post(`/api/v1/stories/${storyId}/placements/approve`)).json()
    expect(body.approved.map((row: { id: string }) => row.id)).toEqual([ready])
    expect(body.skipped).toHaveLength(1)
    expect(body.skipped[0]).toMatchObject({
      outlet: 'Telegram',
      reason: 'the writer has not finished this one yet',
    })
  })

  it('honours one time for all of them when the editor overrules the proposals', async () => {
    const storyId = await seedStory()
    seedPlacement(storyId)
    seedPlacement(storyId, { outletId: 'telegram-test' })
    const at = new Date(Date.now() + 7_200_000).toISOString()

    const body = (await post(`/api/v1/stories/${storyId}/placements/approve`, { scheduled_for: at })).json()
    expect(body.approved.map((row: { scheduledFor: string }) => row.scheduledFor)).toEqual([at, at])
  })

  it('refuses a time that has passed the same way a single approval does', async () => {
    const storyId = await seedStory()
    seedPlacement(storyId)
    const past = new Date(Date.now() - 3_600_000).toISOString()

    const body = (await post(`/api/v1/stories/${storyId}/placements/approve`, { scheduled_for: past })).json()
    expect(body.approved).toEqual([])
    expect(body.skipped[0].reason).toMatch(/passed/)
    expect(db.select().from(schema.publications).get()!.status).toBe('AWAITING_APPROVAL')
  })

  it('404s on an unknown story', async () => {
    expect((await post('/api/v1/stories/nope/placements/approve')).statusCode).toBe(404)
  })

  it('records the bulk decision, which the per-row events cannot show', async () => {
    const storyId = await seedStory()
    seedPlacement(storyId)
    seedPlacement(storyId, { outletId: 'telegram-test' })

    await post(`/api/v1/stories/${storyId}/placements/approve`)
    const codes = db.select().from(schema.events).all().map((event) => event.code)
    expect(codes).toContain('PLACEMENTS_APPROVED')
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
