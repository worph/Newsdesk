import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { adminTool, CHAT_CALLER, type AdminToolContext } from '../src/admin/registry.js'
import { listActions } from '../src/api/actions.js'
import type { Db } from '../src/db/index.js'
import { dropStory, rejectPublication, SWEEP_MAX } from '../src/pipeline/approval.js'
import { listEvents } from '../src/events.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * The editorial decisions, in bulk.
 *
 * These are the tools that changed what this product guarantees, so what is
 * asserted here is mostly what they REFUSE. A sweep is confirmed by reading a
 * count, which means the set it takes has to be exactly the set that count
 * described — and a row that moved while the operator was reading has to come
 * back named, not be quietly included.
 */

function story(
  db: Db,
  title: string,
  options: { status?: string; hold?: string; createdAt?: string } = {},
) {
  const id = randomUUID()
  db.insert(schema.stories)
    .values({
      id,
      title,
      summary: 'A summary.',
      status: options.status ?? 'PLACED',
      dedupVerdict: 'NEW',
      holdReason: options.hold ?? null,
      origin: 'managing-editor',
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .run()
  return id
}

function secondOutlet(db: Db): void {
  const first = db.select().from(schema.outlets).all()[0]!
  db.insert(schema.outlets)
    .values({ ...first, id: 'telegram-test', name: 'Telegram' })
    .run()
}

function publication(db: Db, storyId: string, status: string, outletId = 'discord-test') {
  const id = randomUUID()
  db.insert(schema.publications)
    .values({
      id,
      storyId,
      outletId,
      status,
      origin: 'managing-editor',
      slots: JSON.stringify({ title: 'A headline.', description: 'Written.' }),
      payload: status === 'AWAITING_APPROVAL' ? null : '{}',
    })
    .run()
  return id
}

describe('dropping a held story', () => {
  it('closes the question and keeps it', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const id = story(db, 'Too thin to write from', { status: 'HELD', hold: 'no version number' })

    expect(dropStory(db, id, 'not worth chasing')).toEqual({ ok: true, status: 'DROPPED' })

    const after = db.select().from(schema.stories).all()[0]!
    expect(after.status).toBe('DROPPED')
    expect(after.dropReason).toBe('not worth chasing')
    // The question survives the drop: it is why the story was ever held, and
    // the spiked view is where someone goes to ask what happened.
    expect(after.holdReason).toBe('no version number')

    // Editorial, not pipeline: the desk did not run out of destinations.
    const logged = listEvents(db, {}).events.find((event) => event.code === 'STORY_DROPPED')!
    expect(logged.actor).toBe('human')
    expect(logged.category).toBe('editorial')
  })

  it('refuses a story that is not held', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const placed = story(db, 'Already placed')

    const result = dropStory(db, placed)
    expect(result).toMatchObject({ ok: false, status: 409 })
    // A placed story has publications under it, and closing them silently would
    // be a send cancelled by a screen that never named it.
    expect(!result.ok && result.error).toContain('only a held story')
  })

  it('refuses the second drop, so a repeated sweep is not a second decision', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const id = story(db, 'Held', { status: 'HELD' })

    expect(dropStory(db, id).ok).toBe(true)
    expect(dropStory(db, id)).toMatchObject({ ok: false, status: 409 })
  })

  it('says so when there is no such story', () => {
    const { db } = openTestDb()
    seedDesk(db)
    expect(dropStory(db, 'nope')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('spiking in bulk', () => {
  function ctx(db: Db): AdminToolContext {
    return { db, version: 'test', caller: CHAT_CALLER }
  }

  async function run(name: string, input: Record<string, unknown>, context: AdminToolContext) {
    const result = await adminTool(name)!.handler(input, context)
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, never>,
      text: result.content[0]!.text,
    }
  }

  it('clears every draft waiting on a person, and nothing else', async () => {
    const { db } = openTestDb()
    seedDesk(db)

    const waiting = [story(db, 'A'), story(db, 'B')].map((id) =>
      publication(db, id, 'AWAITING_APPROVAL'),
    )
    // Committed to a time or already gone: an abort the desk cannot honour.
    const sent = publication(db, story(db, 'C'), 'PUBLISHED')
    const queued = publication(db, story(db, 'D'), 'APPROVED')

    const { payload } = await run('spike_publications', { reason: 'stale' }, ctx(db))

    expect(payload.spiked).toBe(2)
    expect(new Set(payload.ids as unknown as string[])).toEqual(new Set(waiting))
    // Not refused — never selected. The sweep asks for the statuses the
    // decision accepts, so a published row is not a row it had an opinion on.
    expect(payload.refused).toBeUndefined()

    const statuses = db.select().from(schema.publications).all()
    expect(statuses.find((row) => row.id === sent)!.status).toBe('PUBLISHED')
    expect(statuses.find((row) => row.id === queued)!.status).toBe('APPROVED')
    expect(statuses.filter((row) => row.status === 'REJECTED')).toHaveLength(2)
    expect(statuses.find((row) => row.id === waiting[0])!.error).toBe('stale')
  })

  it('narrows to one outlet when asked, and takes the rest when not', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    secondOutlet(db)
    const a = story(db, 'A')
    publication(db, a, 'AWAITING_APPROVAL', 'discord-test')
    publication(db, a, 'AWAITING_APPROVAL', 'telegram-test')

    const narrowed = await run('spike_publications', { outlet_id: 'telegram-test' }, ctx(db))
    expect(narrowed.payload.spiked).toBe(1)

    const rest = await run('spike_publications', {}, ctx(db))
    expect(rest.payload.spiked).toBe(1)
  })

  it('takes only the ids it was given', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const mine = publication(db, story(db, 'A'), 'AWAITING_APPROVAL')
    publication(db, story(db, 'B'), 'AWAITING_APPROVAL')

    const { payload } = await run('spike_publications', { ids: [mine] }, ctx(db))
    expect(payload.ids).toEqual([mine])
    expect(db.select().from(schema.publications).all().filter((r) => r.status === 'REJECTED')).toHaveLength(1)
  })

  it('reports a row that moved under it rather than swallowing it', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const id = publication(db, story(db, 'A'), 'AWAITING_APPROVAL')

    // The operator is reading the proposal; the row goes out in the meantime.
    expect(rejectPublication(db, id).ok).toBe(true)

    const { payload } = await run('spike_publications', { ids: [id] }, ctx(db))
    expect(payload.spiked).toBe(0)
    // Named, with the reason. Selection is by status, so this row is not in the
    // set at all — and "not in the set" must not read the same as "done".
    expect(payload.refused).toEqual([{ id, error: 'this was spiked' }])
  })

  it('empties the actions list, which is what was actually asked for', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    publication(db, story(db, 'A'), 'AWAITING_APPROVAL')
    publication(db, story(db, 'B'), 'AWAITING_APPROVAL')
    story(db, 'Held', { status: 'HELD', hold: 'no version number' })

    expect(listActions(db)).toHaveLength(3)

    await run('spike_publications', {}, ctx(db))
    await run('drop_stories', {}, ctx(db))

    expect(listActions(db)).toHaveLength(0)
  })
})

describe('approving in bulk', () => {
  function ctx(db: Db, queue?: string[]): AdminToolContext {
    return {
      db,
      version: 'test',
      caller: CHAT_CALLER,
      ...(queue ? { enqueuePublish: (id: string) => void queue.push(id) } : {}),
    }
  }

  async function run(input: Record<string, unknown>, context: AdminToolContext) {
    const result = await adminTool('approve_publications')!.handler(input, context)
    return { isError: result.isError === true, text: result.content[0]!.text }
  }

  /**
   * The refusal that matters most, because the failure it prevents is silent:
   * an APPROVED row with nothing carrying it reads exactly like a sent one.
   */
  it('refuses outright when no publisher is wired', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const id = publication(db, story(db, 'A'), 'AWAITING_APPROVAL')

    const { isError, text } = await run({}, ctx(db))
    expect(isError).toBe(true)
    expect(text).toContain('no publisher is wired')

    // And nothing moved.
    expect(db.select().from(schema.publications).all().find((r) => r.id === id)!.status).toBe(
      'AWAITING_APPROVAL',
    )
  })

  it('freezes each payload and queues it', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const queue: string[] = []
    const ids = [story(db, 'A'), story(db, 'B')].map((id) => publication(db, id, 'AWAITING_APPROVAL'))

    const { text } = await run({}, ctx(db, queue))
    expect(JSON.parse(text).approved).toBe(2)
    expect(new Set(queue)).toEqual(new Set(ids))

    for (const row of db.select().from(schema.publications).all()) {
      expect(row.status).toBe('APPROVED')
      // Invariant 2: the bytes are fixed here, and nothing runs after.
      expect(row.payload).toBeTruthy()
    }
  })

  /**
   * A FAILED row has already been through the gate once and still carries the
   * bytes that were approved. Re-approving would re-merge from configuration
   * that may have moved since — which is the one thing invariant 2 exists to
   * stop — so `retry` owns that path and this sweep does not touch it.
   */
  it('leaves a failed delivery for retry rather than re-merging it', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const queue: string[] = []
    publication(db, story(db, 'A'), 'FAILED')

    expect(JSON.parse((await run({}, ctx(db, queue))).text).approved).toBe(0)
    expect(queue).toEqual([])
    expect(db.select().from(schema.publications).all()[0]!.status).toBe('FAILED')
  })

  it('is capped, and says so rather than reading as finished', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const queue: string[] = []
    for (let n = 0; n < SWEEP_MAX + 5; n++) {
      publication(db, story(db, `Story ${n}`), 'AWAITING_APPROVAL')
    }

    const first = JSON.parse((await run({}, ctx(db, queue))).text)
    expect(first.approved).toBe(SWEEP_MAX)
    expect(String(first.note)).toContain('call again')

    const second = JSON.parse((await run({}, ctx(db, queue))).text)
    expect(second.approved).toBe(5)
    expect(second.note).toBeUndefined()
  })
})
