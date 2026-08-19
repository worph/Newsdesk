import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { InferenceUnavailable, type InferenceDriver } from '../src/ports/inference/types.js'
import { currentThread, listMessages } from '../src/chat/thread.js'
import { openTestDb, seedDesk } from './helpers.js'

/**
 * The Start routine: what the desk would tell someone who just sat down.
 *
 * The whole point of it is that it answers when nothing else does. It runs no
 * inference, and every value in it is a database read or a probe that reports
 * rather than throws — so these tests are mostly about the broken cases, which
 * are the ones the front page has to survive.
 */

const NOT_A_REAL_DRIVER = {} as InferenceDriver

async function boot(options: { seed?: boolean; withDriver?: boolean } = {}) {
  const { db } = openTestDb()
  if (options.seed !== false) seedDesk(db)
  await setPassword(db, 'test-password')

  const app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
    receiveOptions: {
      ...(options.withDriver === false ? {} : { driver: () => NOT_A_REAL_DRIVER }),
      // The seeded endpoint does not exist, so a real probe would spend its
      // whole timeout failing to reach it once per test.
      probeTimeoutMs: 50,
    },
  })

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'test-password' },
  })

  return { app, db, cookie: login.headers['set-cookie'] as string }
}

async function status(app: FastifyInstance, cookie: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin-chat/status',
    headers: { cookie },
  })
  return { code: response.statusCode, body: response.json() as Record<string, never> }
}

describe('the desk status', () => {
  it('refuses without a session', async () => {
    const { app } = await boot()
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin-chat/status' })
    expect(response.statusCode).toBe(401)
  })

  it('answers on a desk that has never been configured', async () => {
    // No charter, no endpoint, nothing. This is the very first screen a new
    // install shows, and it is the one that must not be a blank page.
    const { app, cookie } = await boot({ seed: false })
    const { code, body } = await status(app, cookie)

    expect(code).toBe(200)
    expect(body.configured).toBe(false)
    expect(body.health).toMatchObject({ endpoints: [] })
    expect(body.total).toBe(0)
  })

  it('answers with an endpoint that cannot be reached', async () => {
    const { app, cookie } = await boot()
    const { code, body } = await status(app, cookie)

    expect(code).toBe(200)
    expect(body.configured).toBe(true)
    // The probe reports rather than throws, which is what keeps the page up.
    const endpoints = body.health.endpoints as { id: string; status: string }[]
    expect(endpoints).toHaveLength(1)
    expect(['unreachable', 'error']).toContain(endpoints[0]!.status)
  })

  it('says so when no inference is wired, rather than failing', async () => {
    const { app, cookie } = await boot({ withDriver: false })
    const { code, body } = await status(app, cookie)

    expect(code).toBe(200)
    expect(body.inference).toMatchObject({ available: false })
    expect(String((body.inference as unknown as { reason: string }).reason)).toContain('no inference')
  })

  /**
   * A driver factory is always wired in production; what decides the answer is
   * the configuration it reads. Reporting a factory as "available" would have a
   * brand-new desk — the one case this screen exists for — claim it could think
   * when its first call is about to throw.
   */
  it('reports a driver that cannot be built as unavailable, with its reason', async () => {
    const { db } = openTestDb()
    await setPassword(db, 'test-password')

    const app = await buildApp({
      db,
      sessionSecret: 'test-secret-value-at-least-32-characters',
      publicDir: '/nonexistent',
      logLevel: 'silent',
      receiveOptions: {
        driver: () => {
          throw new InferenceUnavailable('no MCP endpoint configured — add one in Configuration')
        },
        probeTimeoutMs: 50,
      },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'test-password' },
    })

    const { code, body } = await status(app, login.headers['set-cookie'] as string)

    expect(code).toBe(200)
    expect(body.inference).toMatchObject({ available: false })
    // The reason is the one the port itself gives, so the screen says what to
    // go and do rather than paraphrasing it.
    expect(String((body.inference as unknown as { reason: string }).reason)).toContain('Configuration')
  })

  it('carries the same action list the /now screen renders', async () => {
    const { app, cookie } = await boot()

    const [fromStatus, fromActions] = await Promise.all([
      status(app, cookie),
      app.inject({ method: 'GET', url: '/api/v1/actions', headers: { cookie } }),
    ])

    // One `listActions`, so the card, the screen and the badge can never
    // describe the same job differently.
    const actions = fromActions.json() as { actions: unknown[]; total: number; overdue: number }
    expect(fromStatus.body.actions).toEqual(actions.actions)
    expect(fromStatus.body.total).toBe(actions.total)
    expect(fromStatus.body.overdue).toBe(actions.overdue)
  })

  /**
   * The command exists so the answer survives the administrator being the
   * broken thing — so the one case that must work is the one with no driver.
   */
  it('answers /status as a pair of turns, without inference', async () => {
    const { app, cookie, db } = await boot({ withDriver: false })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/command',
      headers: { cookie },
      payload: { command: '/status' },
    })

    expect(response.statusCode).toBe(200)
    const { messages } = response.json() as { messages: { role: string; content: string }[] }
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0]!.content).toBe('/status')
    expect(messages[1]!.content).toContain('Nothing is waiting on you')
    expect(messages[1]!.content).toContain('No inference')

    // Ordinary rows, so the answer is in the conversation and the audit trail.
    const threadId = currentThread(db)!
    expect(listMessages(db, threadId)).toHaveLength(2)
  })

  it('says what it does not know rather than guessing at a command', async () => {
    const { app, cookie } = await boot()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/command',
      headers: { cookie },
      payload: { command: '/deploy' },
    })

    expect(response.statusCode).toBe(400)
    const { error } = response.json() as { error: string }
    expect(error).toContain('/status')
    expect(error).toContain('/new')
  })

  /**
   * The roll of §8.1, asked for by hand.
   *
   * Two things are worth asserting and neither is that a thread was created.
   * The first is what it does NOT do: the conversation being put away is still
   * in the database, because the old thread is why a change was made and the
   * configuration version it produced cannot say that. The second is the
   * `threadId` — it is the only thing telling a client that this command
   * replaced the conversation rather than answering in it, so a `/status` that
   * started carrying one would make the page throw its own rows away
   * mid-answer.
   */
  it('starts a fresh conversation on /new, keeping the one it replaces', async () => {
    const { app, cookie, db } = await boot({ withDriver: false })

    const answered = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/command',
      headers: { cookie },
      payload: { command: '/status' },
    })
    expect(answered.json()).not.toHaveProperty('threadId')

    const before = currentThread(db)!
    expect(listMessages(db, before)).toHaveLength(2)

    // Typed with the spaces and the shouting a person actually types.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/command',
      headers: { cookie },
      payload: { command: '  /NEW  ' },
    })

    expect(response.statusCode).toBe(200)
    const rolled = response.json() as { threadId: string; messages: unknown[] }
    expect(rolled.messages).toEqual([])
    expect(rolled.threadId).not.toBe(before)

    // The visible conversation is the new one, and empty.
    expect(currentThread(db)).toBe(rolled.threadId)
    expect(listMessages(db, rolled.threadId)).toHaveLength(0)

    // The old one is put away, not deleted.
    expect(listMessages(db, before)).toHaveLength(2)
  })

  /** The same door the button uses, so it had better still be the same room. */
  it('rolls identically whether asked by /new or by DELETE', async () => {
    const { app, cookie, db } = await boot({ withDriver: false })

    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/admin-chat', headers: { cookie } })
    expect(deleted.statusCode).toBe(200)
    const first = (deleted.json() as { threadId: string }).threadId
    expect(deleted.json()).toEqual({ threadId: first, messages: [] })
    expect(currentThread(db)).toBe(first)

    const commanded = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/command',
      headers: { cookie },
      payload: { command: '/new' },
    })
    expect(commanded.statusCode).toBe(200)
    expect(commanded.json()).toEqual({ threadId: currentThread(db), messages: [] })
    expect(currentThread(db)).not.toBe(first)
  })

  it('summarises what the desk has, in the words the log uses', async () => {
    const { app, cookie } = await boot()
    const { body } = await status(app, cookie)

    expect(String(body.summary)).toContain('outlet')
  })
})
