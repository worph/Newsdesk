import { describe, expect, it } from 'vitest'
import { openTestDb } from './helpers.js'
import {
  backoffMs,
  claimNext,
  Deferred,
  enqueue,
  JobQueue,
  queueStats,
  reclaimRunning,
} from '../src/pipeline/queue.js'
import { schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'

function mcpError(message: string, retryable: boolean): Error {
  return Object.assign(new Error(message), { name: 'McpError', retryable })
}

describe('backoff', () => {
  it('grows exponentially and then stops at the ceiling', () => {
    const fixed = { random: () => 1, baseDelayMs: 1000, maxDelayMs: 10_000 }
    expect(backoffMs(1, fixed)).toBe(1000)
    expect(backoffMs(2, fixed)).toBe(2000)
    expect(backoffMs(3, fixed)).toBe(4000)
    expect(backoffMs(9, fixed)).toBe(10_000)
  })

  it('jitters within half the ceiling, so retries do not wake in lockstep', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 10_000 }
    expect(backoffMs(1, { ...opts, random: () => 0 })).toBe(500)
    expect(backoffMs(1, { ...opts, random: () => 1 })).toBe(1000)
  })
})

describe('claiming', () => {
  it('takes the oldest due job and marks it RUNNING', () => {
    const { db } = openTestDb()
    enqueue(db, 'direct', 'sub-1')
    enqueue(db, 'direct', 'sub-2')

    const first = claimNext(db, new Date())
    expect(first?.refId).toBe('sub-1')
    expect(first?.attempts).toBe(1)

    const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, first!.id)).get()
    expect(row?.status).toBe('RUNNING')
  })

  it('does not claim a job whose backoff has not elapsed', () => {
    const { db } = openTestDb()
    enqueue(db, 'direct', 'later', new Date(Date.now() + 60_000))
    expect(claimNext(db, new Date())).toBeUndefined()
  })

  it('returns undefined on an empty queue', () => {
    const { db } = openTestDb()
    expect(claimNext(db, new Date())).toBeUndefined()
  })
})

describe('restart', () => {
  it('returns interrupted jobs to the queue, because one instance means nobody else has them', () => {
    const { db } = openTestDb()
    enqueue(db, 'direct', 'sub-1')
    claimNext(db, new Date())

    expect(reclaimRunning(db)).toBe(1)
    expect(db.select().from(schema.jobs).get()?.status).toBe('PENDING')
  })

  it('leaves a finished queue alone', () => {
    const { db } = openTestDb()
    expect(reclaimRunning(db)).toBe(0)
  })
})

describe('running jobs', () => {
  it('runs a handler and marks the job DONE', async () => {
    const { db } = openTestDb()
    const seen: string[] = []
    const queue = new JobQueue(db).register('direct', async (_db, refId) => {
      seen.push(refId)
    })

    enqueue(db, 'direct', 'sub-1')
    expect(await queue.tick()).toBe(1)

    expect(seen).toEqual(['sub-1'])
    expect(queueStats(db)).toMatchObject({ done: 1, pending: 0, failed: 0 })
  })

  it('reschedules a retryable failure instead of failing it', async () => {
    const { db } = openTestDb()
    const queue = new JobQueue(db, { now: () => 1_000_000, random: () => 1 }).register('direct', async () => {
      throw mcpError('HTTP 503', true)
    })

    // Due on the queue's clock, not the wall clock the default enqueue uses.
    enqueue(db, 'direct', 'sub-1', new Date(1_000_000))
    await queue.tick()

    const row = db.select().from(schema.jobs).get()
    expect(row?.status).toBe('PENDING')
    expect(row?.attempts).toBe(1)
    expect(row?.lastError).toBe('HTTP 503')
    // Scheduled into the future rather than retried immediately.
    expect(new Date(row!.runAfter).getTime()).toBeGreaterThan(1_000_000)
  })

  it('fails a terminal error immediately — waiting cannot fix a refusal', async () => {
    const { db } = openTestDb()
    const queue = new JobQueue(db).register('direct', async () => {
      throw mcpError('HTTP 422 bad arguments', false)
    })

    enqueue(db, 'direct', 'sub-1')
    await queue.tick()

    expect(db.select().from(schema.jobs).get()?.status).toBe('FAILED')
  })

  it('gives up after the attempt ceiling', async () => {
    const { db } = openTestDb()
    const queue = new JobQueue(db, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }).register(
      'direct',
      async () => {
        throw mcpError('HTTP 503', true)
      },
    )

    enqueue(db, 'direct', 'sub-1')
    for (let i = 0; i < 5; i++) await queue.tick()

    const row = db.select().from(schema.jobs).get()
    expect(row?.status).toBe('FAILED')
    expect(row?.attempts).toBe(3)
  })

  it('a deferral waits without spending an attempt', async () => {
    const { db } = openTestDb()
    let calls = 0
    const queue = new JobQueue(db, { now: () => 1_000_000 }).register('direct', async () => {
      calls++
      throw new Deferred('endpoint not configured yet', 30_000)
    })

    enqueue(db, 'direct', 'sub-1', new Date(1_000_000))
    await queue.tick()

    const row = db.select().from(schema.jobs).get()
    expect(calls).toBe(1)
    expect(row?.status).toBe('PENDING')
    // The attempt was handed back: a wait must not exhaust the retry ceiling.
    expect(row?.attempts).toBe(0)
    expect(new Date(row!.runAfter).getTime()).toBe(1_030_000)
  })

  it('fails a job whose kind has no handler, rather than silently dropping it', async () => {
    const { db } = openTestDb()
    const queue = new JobQueue(db)

    enqueue(db, 'write', 'pub-1')
    await queue.tick()

    const row = db.select().from(schema.jobs).get()
    expect(row?.status).toBe('FAILED')
    expect(row?.lastError).toContain('no handler')
  })

  it('runs one job at a time, so ordering stays deterministic', async () => {
    const { db } = openTestDb()
    let peak = 0
    let active = 0
    const queue = new JobQueue(db).register('direct', async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    })

    enqueue(db, 'direct', 'a')
    enqueue(db, 'direct', 'b')
    enqueue(db, 'direct', 'c')
    await queue.tick()

    expect(peak).toBe(1)
    expect(queueStats(db).done).toBe(3)
  })
})
