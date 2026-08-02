import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import type { Db } from '../src/db/index.js'
import { logEvent } from '../src/events.js'
import { openTestDb, seedDesk } from './helpers.js'

/**
 * The log has to be readable when everything else is broken, so what is
 * checked here is the boring half: that a filter the screen sends is
 * understood, that a filter it could never send is refused with a sentence,
 * and that the cursor round-trips.
 */

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

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } })
}

describe('GET /events', () => {
  it('refuses without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/events' })
    expect(response.statusCode).toBe(401)
  })

  it('returns rows newest first with the category already resolved', async () => {
    logEvent(db, { level: 'info', code: 'PUBLISHED', message: 'sent to Discord' })
    logEvent(db, {
      level: 'error',
      code: 'PUBLISH_FAILED',
      message: 'could not send to Discord',
      detail: { outletId: 'discord-test', outletName: 'Discord', driver: 'mcp', error: 'HTTP 401' },
    })

    const response = await get('/api/v1/events')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { events: Array<Record<string, unknown>>; nextCursor: number | null }

    expect(body.events[0]?.code).toBe('PUBLISH_FAILED')
    expect(body.events[0]?.category).toBe('delivery')
    expect(body.events[0]?.assistable).toBe(true)
    // Parsed, not a JSON string — the screen should never have to parse twice.
    expect(body.events[0]?.detail).toMatchObject({ error: 'HTTP 401' })
    expect(body.nextCursor).toBeNull()
  })

  it('understands minLevel as "this and worse"', async () => {
    logEvent(db, { level: 'info', code: 'PUBLISHED', message: 'sent to Discord' })
    logEvent(db, { level: 'error', code: 'DRAFT_FAILED', message: 'the writer could not produce a usable draft',
      detail: { publicationId: 'pub-1', error: 'no JSON found' } })

    const body = (await get('/api/v1/events?minLevel=warn')).json() as { events: Array<{ level: string }> }
    expect(body.events).toHaveLength(1)
    expect(body.events[0]?.level).toBe('error')
  })

  it('round-trips the cursor', async () => {
    for (let i = 0; i < 5; i++) {
      logEvent(db, { level: 'info', code: 'PUBLISHED', message: `sent ${i}` })
    }

    const first = (await get('/api/v1/events?limit=2')).json() as {
      events: Array<{ id: number }>
      nextCursor: number
    }
    expect(first.events).toHaveLength(2)
    expect(first.nextCursor).toBeTypeOf('number')

    const second = (await get(`/api/v1/events?limit=2&before=${first.nextCursor}`)).json() as {
      events: Array<{ id: number }>
    }
    const overlap = second.events.filter((row) => first.events.some((seen) => seen.id === row.id))
    expect(overlap).toHaveLength(0)
  })

  it('refuses a filter it does not understand, with a sentence', async () => {
    const response = await get('/api/v1/events?level=catastrophe')
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toContain('log understands')
  })

  it('refuses a limit that is not a number rather than silently defaulting', async () => {
    expect((await get('/api/v1/events?limit=abc')).statusCode).toBe(400)
  })

  it('lets "other" be asked for, because that is where an older build\'s rows land', async () => {
    const response = await get('/api/v1/events?category=other')
    expect(response.statusCode).toBe(200)
  })
})
