import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import type { Db } from '../src/db/index.js'
import { enqueue } from '../src/pipeline/queue.js'
import { deliverPublication, publishHandler } from '../src/ports/delivery/index.js'
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
      status: 'PLACED',
      dedupVerdict: 'NEW',
    })
    .run()
  db.insert(schema.publications)
    .values({
      id: publicationId,
      storyId,
      outletId: 'discord-test',
      status: 'AWAITING_APPROVAL',
      origin: 'managing-editor',
      placementReason: 'self-hosters run it',
      angle: 'lead on the upgrade',
      slots: JSON.stringify({ title: 'Immich 1.142.0', description: 'Adds Intel QSV transcoding.' }),
    })
    .run()

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
    receiveOptions: {
      // Real job rows, not just a spy: scheduling *is* the job's `run_after`,
      // and withdraw has to delete a row that genuinely exists.
      enqueuePublish: (id, runAfter) => {
        published.push(id)
        enqueue(db, 'publish', id, runAfter)
      },
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

  it('lists sibling placements, so approving one is never mistaken for shipping all', async () => {
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

  it('refuses a second approve while the first send is still queued', async () => {
    // The window between APPROVED and PUBLISHED is one queue poll wide. A
    // second approve inside it would re-freeze the payload and queue a second
    // send against a publication already on its way to the wire.
    await post(`/api/v1/publications/${publicationId}/approve`)
    expect(row().status).toBe('APPROVED')

    const again = await post(`/api/v1/publications/${publicationId}/approve`)
    expect(again.statusCode).toBe(409)
    expect(published).toEqual([publicationId])
  })

  it('reopens for editing and re-approval after a failed send', async () => {
    // FAILED is the one state that goes back to the desk: `retry` re-sends the
    // frozen bytes, but fixing the copy means editing and approving again.
    await post(`/api/v1/publications/${publicationId}/approve`)
    db.update(schema.publications)
      .set({ status: 'FAILED', error: 'discord said no' })
      .where(eq(schema.publications.id, publicationId))
      .run()

    const edit = await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'Second try' } })
    expect(edit.statusCode).toBe(200)
    expect((await post(`/api/v1/publications/${publicationId}/approve`)).statusCode).toBe(202)
    expect(JSON.parse(row().payload!).title).toBe('Second try')
  })

  it('refuses a disabled outlet', async () => {
    db.update(schema.outlets).set({ enabled: false }).where(eq(schema.outlets.id, 'discord-test')).run()
    expect((await post(`/api/v1/publications/${publicationId}/approve`)).statusCode).toBe(422)
  })

  it('refuses every edit once approved, rather than letting the slots drift', async () => {
    // Invariant 2: nothing may alter the payload between approval and the
    // wire. The slots must not drift either — an accepted edit would leave the
    // screen showing copy that will never be sent.
    // One saved version before approval, so revert has somewhere to go back to.
    await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'The approved headline' } })
    const version = db.select().from(schema.draftVersions).all()[0]!

    await post(`/api/v1/publications/${publicationId}/approve`)
    const frozen = row().payload!

    const edit = await patch(`/api/v1/publications/${publicationId}`, {
      slots: { title: 'Changed my mind' },
    })
    expect(edit.statusCode).toBe(409)

    // Reverting writes slots too, so it closes with the rest of the desk.
    const rollback = await post(`/api/v1/publications/${publicationId}/revert`, {
      version_id: version.id,
    })
    expect(rollback.statusCode).toBe(409)

    expect(row().payload).toBe(frozen)
    expect(JSON.parse(row().slots!).title).toBe('The approved headline')
  })

  it('serves the frozen bytes rather than a fresh merge once approved', async () => {
    await post(`/api/v1/publications/${publicationId}/approve`)

    const body = (await get(`/api/v1/publications/${publicationId}/payload`)).json()
    expect(body.frozen).toBe(true)
    expect(body.payload.title).toBe('Immich 1.142.0')
  })
})

describe('rejection', () => {
  it('leaves a REJECTED row rather than deleting the proposal', async () => {
    // That row is half of the override diff — what the managing editor proposed
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
    db.update(schema.outlets).set({ driver: 'builtin' }).where(eq(schema.outlets.id, 'discord-test')).run()
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
    db.update(schema.outlets).set({ driver: 'builtin' }).where(eq(schema.outlets.id, 'discord-test')).run()
    await post(`/api/v1/publications/${publicationId}/approve`)
    await deliverPublication(db, publicationId)
    const firstPublishedAt = row().publishedAt

    await deliverPublication(db, publicationId)
    expect(row().publishedAt).toBe(firstPublishedAt)
  })

  it('records a delivery failure on the row and in the log', async () => {
    // An mcp outlet pointing at an endpoint that does not resolve.
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
    db.update(schema.outlets).set({ driver: 'builtin' }).where(eq(schema.outlets.id, 'discord-test')).run()
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

describe('the article half of the queue', () => {
  /** A second story, older or newer than the seeded one, with a draft waiting. */
  function draft(options: { createdAt: string; status: string; title: string }): string {
    const otherStory = randomUUID()
    const id = randomUUID()
    db.insert(schema.stories)
      .values({
        id: otherStory,
        title: options.title,
        summary: 'S',
        status: 'PLACED',
        dedupVerdict: 'NEW',
        createdAt: options.createdAt,
      })
      .run()
    db.insert(schema.publications)
      .values({
        id,
        storyId: otherStory,
        outletId: 'discord-test',
        status: options.status,
        origin: 'managing-editor',
        slots: JSON.stringify({ title: 'H', description: 'The body of the piece.' }),
      })
      .run()
    return id
  }

  it('filters on several statuses at once', async () => {
    // The queue asks one question about two states: a finished draft and a send
    // that failed are both waiting on a person.
    const failed = draft({ createdAt: '2026-01-01T00:00:00.000Z', status: 'FAILED', title: 'Failed' })
    draft({ createdAt: '2026-01-02T00:00:00.000Z', status: 'PUBLISHED', title: 'Gone out' })

    const body = (await get('/api/v1/publications?status=AWAITING_APPROVAL,FAILED')).json()
    const ids = body.publications.map((p: { id: string }) => p.id)

    expect(ids).toContain(publicationId)
    expect(ids).toContain(failed)
    expect(ids).toHaveLength(2)
  })

  it('orders oldest first, by when the story arrived', async () => {
    // Not by approved_at: nothing in this list has been approved, so that
    // column is null on every row and sorts them arbitrarily.
    const oldest = draft({ createdAt: '2020-01-01T00:00:00.000Z', status: 'AWAITING_APPROVAL', title: 'Ancient' })

    const body = (await get('/api/v1/publications?status=AWAITING_APPROVAL')).json()
    expect(body.publications[0].id).toBe(oldest)
  })

  it('carries the opening of the draft, so a row can be read without opening it', async () => {
    const body = (await get('/api/v1/publications?status=AWAITING_APPROVAL')).json()
    const seeded = body.publications.find((p: { id: string }) => p.id === publicationId)

    // The primary slot is the piece of writing; `title` is furniture the outlet
    // happens to want.
    expect(seeded.preview).toBe('Adds Intel QSV transcoding.')
    expect(seeded.storyTitle).toBe('Immich v1.142.0')
    expect(seeded.outletName).toBe('Discord')
  })

  it('previews nothing rather than guessing when no draft has been written', async () => {
    db.update(schema.publications)
      .set({ slots: null, status: 'PROPOSED' })
      .where(eq(schema.publications.id, publicationId))
      .run()

    const body = (await get('/api/v1/publications?status=PROPOSED')).json()
    expect(body.publications[0].preview).toBeNull()
  })

  it('never leaks the outlet spec it read the primary slot from', async () => {
    // The destination is configuration, and the review surface is the one place
    // it is deliberately withheld — a list must not be the way round it.
    const body = (await get('/api/v1/publications?status=AWAITING_APPROVAL')).json()
    expect(body.publications[0].argsSpec).toBeUndefined()
    expect(body.publications[0].slots).toBeUndefined()
  })
})

/**
 * Scheduling changes when the approved bytes go out, and nothing else. These
 * tests exist mostly to hold that line: the payload is still frozen at approval,
 * the desk is still closed afterwards, and the only way back is a withdrawal
 * that says so in the log.
 */
describe('scheduling', () => {
  const soon = () => new Date(Date.now() + 6 * 60 * 60_000).toISOString()

  const jobs = () => db.select().from(schema.jobs).where(eq(schema.jobs.kind, 'publish')).all()

  it('approves without a time exactly as it always did', async () => {
    const response = await post(`/api/v1/publications/${publicationId}/approve`)

    expect(response.statusCode).toBe(202)
    expect(response.json().status).toBe('APPROVED')
    expect(row().status).toBe('APPROVED')
    expect(row().scheduledFor).toBeNull()
    // Due immediately: the queue claims it on the next poll.
    expect(new Date(jobs()[0]!.runAfter).getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('freezes the payload and defers the send when given a time', async () => {
    const at = soon()
    const response = await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: at })

    expect(response.statusCode).toBe(202)
    expect(response.json().status).toBe('SCHEDULED')

    const stored = row()
    expect(stored.status).toBe('SCHEDULED')
    expect(stored.scheduledFor).toBe(at)
    // The whole point: approved now, sent later, with the bytes already fixed.
    expect(stored.approvedAt).toBeTruthy()
    expect(JSON.parse(stored.payload!).channelId).toBe('1514993197082742814')
    expect(jobs()[0]!.runAfter).toBe(at)
  })

  it('refuses a time that has already passed', async () => {
    const response = await post(`/api/v1/publications/${publicationId}/approve`, {
      scheduled_for: new Date(Date.now() - 60 * 60_000).toISOString(),
    })

    expect(response.statusCode).toBe(422)
    expect(row().status).toBe('AWAITING_APPROVAL')
  })

  it('closes the desk while scheduled, exactly as approval does', async () => {
    await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() })

    for (const attempt of [
      patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'sneaky' } }),
      post(`/api/v1/publications/${publicationId}/reject`),
      post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() }),
    ]) {
      expect((await attempt).statusCode).toBe(409)
    }
    // The frozen bytes are untouched by any of it.
    expect(JSON.parse(row().payload!).title).toBe('Immich 1.142.0')
  })

  /**
   * A browser outlet's slot has come and it is waiting for a person to publish
   * it by hand. The payload is frozen and may already be typed into a live
   * composer, so the desk has to be as closed as it is for a scheduled send —
   * and withdrawing has to be the way back, because that is also how an
   * unclaimed hand-over expires.
   */
  describe('waiting for a person to publish it', () => {
    const staged = () => {
      db.update(schema.publications)
        .set({ status: 'AWAITING_SEND' })
        .where(eq(schema.publications.id, publicationId))
        .run()
    }

    it('closes the desk exactly as a scheduled send does', async () => {
      await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() })
      staged()

      for (const attempt of [
        patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'sneaky' } }),
        post(`/api/v1/publications/${publicationId}/approve`),
        post(`/api/v1/publications/${publicationId}/reject`),
      ]) {
        expect((await attempt).statusCode).toBe(409)
      }
      expect(JSON.parse(row().payload!).title).toBe('Immich 1.142.0')
    })

    it('withdraws back to an editable draft', async () => {
      await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() })
      staged()

      expect((await post(`/api/v1/publications/${publicationId}/withdraw`)).statusCode).toBe(200)

      const stored = row()
      expect(stored.status).toBe('AWAITING_APPROVAL')
      expect(stored.payload).toBeNull()
      // Nothing should still look like it is sitting in a browser.
      expect(stored.stagedAt).toBeNull()
      expect(
        (await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'Rewritten' } }))
          .statusCode,
      ).toBe(200)
    })
  })

  it('moves a scheduled send without touching what was approved', async () => {
    await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() })
    const frozen = row().payload

    const later = new Date(Date.now() + 12 * 60 * 60_000).toISOString()
    const response = await patch(`/api/v1/publications/${publicationId}/schedule`, {
      scheduled_for: later,
    })

    expect(response.statusCode).toBe(200)
    expect(row().scheduledFor).toBe(later)
    expect(row().payload).toBe(frozen)
    // One job, at the new time — the old one is gone rather than doubled.
    expect(jobs().filter((job) => job.status === 'PENDING')).toHaveLength(1)
    expect(jobs().find((job) => job.status === 'PENDING')!.runAfter).toBe(later)
  })

  it('withdraws back to an editable draft and drops the queued send', async () => {
    await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() })

    const response = await post(`/api/v1/publications/${publicationId}/withdraw`)
    expect(response.statusCode).toBe(200)

    const stored = row()
    expect(stored.status).toBe('AWAITING_APPROVAL')
    // Clearing the payload is what genuinely reopens it: re-approving re-freezes.
    expect(stored.payload).toBeNull()
    expect(stored.scheduledFor).toBeNull()
    expect(stored.approvedAt).toBeNull()
    expect(jobs().filter((job) => job.status === 'PENDING')).toHaveLength(0)

    // And the desk is genuinely open again.
    const edit = await patch(`/api/v1/publications/${publicationId}`, { slots: { title: 'Rewritten' } })
    expect(edit.statusCode).toBe(200)

    const event = db.select().from(schema.events).all().find((e) => e.code === 'WITHDRAWN')
    expect(event).toBeTruthy()
  })

  it('will not withdraw something already on its way', async () => {
    await post(`/api/v1/publications/${publicationId}/approve`)

    const response = await post(`/api/v1/publications/${publicationId}/withdraw`)
    expect(response.statusCode).toBe(409)
    expect(row().status).toBe('APPROVED')
  })

  it('does not send a withdrawal that raced a claimed job', async () => {
    db.update(schema.outlets).set({ driver: 'builtin' }).where(eq(schema.outlets.id, 'discord-test')).run()
    await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() })
    await post(`/api/v1/publications/${publicationId}/withdraw`)

    // The worker had already claimed the job when the withdrawal landed, so it
    // still runs. It must decline quietly rather than failing the job.
    await publishHandler()(db, publicationId, { id: 'j', kind: 'publish', refId: publicationId, attempts: 1 })

    expect(row().status).toBe('AWAITING_APPROVAL')
    expect(row().publishedAt).toBeNull()
    const event = db.select().from(schema.events).all().find((e) => e.code === 'PUBLISH_CANCELLED')
    expect(event).toBeTruthy()
  })

  it('offers a send time at review and stops once the row settles', async () => {
    const open = (await get(`/api/v1/publications/${publicationId}`)).json()
    expect(open.scheduleProposal.at).toBeTruthy()
    expect(new Date(open.scheduleProposal.at).getTime()).toBeGreaterThanOrEqual(Date.now() - 5 * 60_000)
    expect(open.scheduleProposal.reason).toBeTruthy()

    await post(`/api/v1/publications/${publicationId}/approve`, { scheduled_for: soon() })
    const closed = (await get(`/api/v1/publications/${publicationId}`)).json()
    expect(closed.scheduleProposal).toBeNull()
  })
})

describe('the calendar', () => {
  const window = () => ({
    from: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    to: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  })

  const calendar = async () => {
    const { from, to } = window()
    return (await get(`/api/v1/calendar?${new URLSearchParams({ from, to })}`)).json()
  }

  it('shows what is planned and what already went out, as one list', async () => {
    // One scheduled ahead, one already sent behind.
    await post(`/api/v1/publications/${publicationId}/approve`, {
      scheduled_for: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
    })

    // A second story: a publication is unique per story x outlet.
    const olderStoryId = randomUUID()
    db.insert(schema.stories)
      .values({
        id: olderStoryId,
        title: 'Immich v1.141.0',
        summary: 'The release before.',
        status: 'PLACED',
        dedupVerdict: 'NEW',
      })
      .run()

    const sentId = randomUUID()
    db.insert(schema.publications)
      .values({
        id: sentId,
        storyId: olderStoryId,
        outletId: 'discord-test',
        status: 'PUBLISHED',
        origin: 'managing-editor',
        publishedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      })
      .run()

    const body = await calendar()
    expect(body.entries).toHaveLength(2)
    // Placed by when it happens, or happened — and in order.
    expect(body.entries[0].id).toBe(sentId)
    expect(body.entries[1].id).toBe(publicationId)
    expect(body.timezone).toBe('UTC')
  })

  it('leaves undecided drafts off — a backlog is not a schedule', async () => {
    const body = await calendar()
    expect(body.entries).toHaveLength(0)
  })

  it('refuses a window it will not scan', async () => {
    const response = await get(
      `/api/v1/calendar?from=${new Date().toISOString()}&to=${new Date(Date.now() + 400 * 24 * 60 * 60_000).toISOString()}`,
    )
    expect(response.statusCode).toBe(422)
  })
})
