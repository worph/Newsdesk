import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import type { Db } from '../src/db/index.js'
import { buildManagingEditorContext } from '../src/pipeline/managing-editor.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * Writing and placing a piece yourself.
 *
 * The app under test is built with **no inference driver at all**, which is the
 * substance of the feature rather than a convenience: a manual send is what you
 * reach for when the wire is quiet or the agent is busy, so every assertion
 * below is also an assertion that nothing on this path calls a model.
 */

let app: FastifyInstance
let db: Db
let cookie: string

beforeEach(async () => {
  const handle = openTestDb()
  db = handle.db
  seedDesk(db)

  // A second destination that wants a different shape: one document, no
  // headline. Writing the same piece for both is two pieces of writing, which
  // is the whole reason each is written separately.
  db.insert(schema.outlets)
    .values({
      id: 'telegram-test',
      name: 'Telegram',
      description: 'The internal room.',
      role: 'notify',
      driver: 'mcp',
      enabled: true,
      voiceId: 'alicia',
      endpointId: 'beacon',
      tool: 'telegram-mcp__send_message',
      destinationKey: null,
      argsSpec: JSON.stringify({
        chatId: '-100123',
        text: { slot: 'markdown', label: 'Message', max: 4096, optional: false, primary: true },
      }),
    })
    .run()

  await setPassword(db, 'test-password')

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
    receiveOptions: { enqueuePublish: () => undefined },
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

const compose = (body: Record<string, unknown>) => post('/api/v1/compose', body)

const both = {
  title: 'Immich 1.142 is out',
  outlet_ids: ['discord-test', 'telegram-test'],
}

describe('composing', () => {
  it('creates one story and one blank draft per destination', async () => {
    const response = await compose({ ...both, summary: 'A point release with QSV transcoding.' })
    expect(response.statusCode).toBe(201)

    const { storyId, publications } = response.json()
    expect(publications).toHaveLength(2)

    const story = db.select().from(schema.stories).where(eq(schema.stories.id, storyId)).get()!
    expect(story.title).toBe('Immich 1.142 is out')
    expect(story.summary).toBe('A point release with QSV transcoding.')
    // Placed, because you placed it: the decisions live on the publications.
    expect(story.status).toBe('PLACED')
    expect(story.origin).toBe('desk')
    // Nothing was proposed, so there is nothing to diff an override against.
    expect(story.proposedPlacements).toBeNull()

    const rows = db.select().from(schema.publications).all()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.origin).toBe('human')
      // Open for writing straight away — no writer is coming.
      expect(row.status).toBe('AWAITING_APPROVAL')
      expect(row.slots).toBeNull()
      expect(row.payload).toBeNull()
    }
  })

  it('falls back to the title rather than demanding a summary', async () => {
    const { storyId } = (await compose(both)).json()
    const story = db.select().from(schema.stories).where(eq(schema.stories.id, storyId)).get()!
    expect(story.summary).toBe('Immich 1.142 is out')
  })

  it('carries urgency through to the row that schedules on it', async () => {
    const { publications } = (await compose({ ...both, urgency: 'breaking' })).json()
    const row = db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, publications[0].id))
      .get()!
    expect(row.urgency).toBe('breaking')
  })

  it('treats a repeated destination as one, not as two rows', async () => {
    const response = await compose({
      title: 'Twice',
      outlet_ids: ['discord-test', 'discord-test'],
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().publications).toHaveLength(1)
  })

  it('refuses an unknown destination before creating anything', async () => {
    const response = await compose({ title: 'Nowhere', outlet_ids: ['discord-test', 'ghost'] })
    expect(response.statusCode).toBe(422)
    expect(response.json().error).toContain('ghost')
    expect(db.select().from(schema.stories).all()).toHaveLength(0)
  })

  it('refuses a switched-off destination here rather than at the gate', async () => {
    // Otherwise you would write the piece before finding out it can never be
    // approved.
    db.update(schema.outlets).set({ enabled: false }).where(eq(schema.outlets.id, 'telegram-test')).run()

    const response = await compose(both)
    expect(response.statusCode).toBe(422)
    expect(response.json().error).toContain('telegram-test')
    expect(db.select().from(schema.publications).all()).toHaveLength(0)
  })

  it('refuses a piece with nowhere to run', async () => {
    expect((await compose({ title: 'Orphan', outlet_ids: [] })).statusCode).toBe(400)
  })

  it('needs a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/compose', payload: both })
    expect(response.statusCode).toBe(401)
  })
})

describe('writing each destination', () => {
  it('will not send a destination nobody has written', async () => {
    const { publications } = (await compose(both)).json()
    const blank = publications.find((p: { outletId: string }) => p.outletId === 'discord-test')!

    const response = await post(`/api/v1/publications/${blank.id}/approve`)
    expect(response.statusCode).toBe(422)
    // Named, so the review screen can say which fields are still empty.
    expect(response.json().missing).toEqual(['title', 'description'])
  })

  it('sends one destination without touching the other', async () => {
    const { publications } = (await compose(both)).json()
    const discord = publications.find((p: { outletId: string }) => p.outletId === 'discord-test')!
    const telegram = publications.find((p: { outletId: string }) => p.outletId === 'telegram-test')!

    await patch(`/api/v1/publications/${discord.id}`, {
      slots: { title: 'Immich 1.142', description: 'Adds Intel QSV transcoding.' },
    })
    expect((await post(`/api/v1/publications/${discord.id}/approve`)).statusCode).toBe(202)

    const sent = db.select().from(schema.publications).where(eq(schema.publications.id, discord.id)).get()!
    expect(sent.status).toBe('APPROVED')
    // The destination is configuration, exactly as on a written story.
    expect(JSON.parse(sent.payload!).channelId).toBe('1514993197082742814')

    const untouched = db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, telegram.id))
      .get()!
    expect(untouched.status).toBe('AWAITING_APPROVAL')
    expect(untouched.payload).toBeNull()
  })

  it('says which destinations are still blank', async () => {
    const { publications } = (await compose(both)).json()
    const discord = publications.find((p: { outletId: string }) => p.outletId === 'discord-test')!

    await patch(`/api/v1/publications/${discord.id}`, {
      slots: { title: 'Immich 1.142', description: 'The body.' },
    })

    const body = (await get(`/api/v1/publications/${discord.id}`)).json()
    expect(body.story.origin).toBe('desk')
    expect(body.siblings).toHaveLength(2)
    expect(body.siblings.find((s: { outletId: string }) => s.outletId === 'discord-test').written).toBe(true)
    expect(body.siblings.find((s: { outletId: string }) => s.outletId === 'telegram-test').written).toBe(false)
    // The strip is navigation, so it has to be readable without an outlet lookup.
    expect(body.siblings.find((s: { outletId: string }) => s.outletId === 'telegram-test').outletName).toBe(
      'Telegram',
    )
  })

  it('counts whitespace as unwritten', async () => {
    const { publications } = (await compose(both)).json()
    const discord = publications.find((p: { outletId: string }) => p.outletId === 'discord-test')!

    await patch(`/api/v1/publications/${discord.id}`, { slots: { title: '   ' } })

    const body = (await get(`/api/v1/publications/${discord.id}`)).json()
    expect(body.siblings.find((s: { outletId: string }) => s.outletId === 'discord-test').written).toBe(false)
  })

  it('offers a send time like any other draft', async () => {
    const { publications } = (await compose(both)).json()
    const body = (await get(`/api/v1/publications/${publications[0].id}`)).json()
    expect(body.scheduleProposal.at).toBeTruthy()
    expect(body.scheduleProposal.reason).toBeTruthy()
  })
})

describe('what the rest of the desk sees', () => {
  it('shows a blank draft in the queue as unstarted rather than as nothing', async () => {
    await compose(both)
    const body = (await get('/api/v1/publications?status=AWAITING_APPROVAL')).json()

    expect(body.publications).toHaveLength(2)
    for (const row of body.publications) {
      expect(row.storyOrigin).toBe('desk')
      expect(row.preview).toBeNull()
    }
  })

  it('hands a manual story to the managing editor as something already told', async () => {
    // Deliberate: a piece you sent by hand is exactly the thing that should make
    // a stringer's filing about the same event come back as a duplicate. Leaving
    // manual stories out of the comparison window would reintroduce the double
    // post the desk exists to prevent.
    await compose({ ...both, summary: 'A point release with QSV transcoding.' })

    const context = buildManagingEditorContext(db, {
      id: 'filing-1',
      stringerId: 'korben',
      considered: 'Immich shipped 1.142 today.',
      text: 'Immich shipped 1.142 today.',
    })

    expect(context.prompt).toContain('Immich 1.142 is out')
    expect(context.prompt).toContain('A point release with QSV transcoding.')
  })
})
