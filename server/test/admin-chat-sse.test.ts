import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { listMessages } from '../src/chat/thread.js'
import { openDb, runMigrations, type DbHandle } from '../src/db/index.js'
import type { InferenceDriver, InferenceRequest } from '../src/ports/inference/types.js'
import { seedDesk } from './helpers.js'

/**
 * The turn stream, over a real socket.
 *
 * `app.inject()` buffers, so it cannot see a response that arrives in pieces —
 * this is the one file in the suite that listens on a port and reads the body
 * as it comes. Everything about the loop itself is unit-tested in
 * admin-chat.test.ts; what is proved here is only the wiring: that the events
 * arrive, and that each one corresponds to a row that is already committed.
 */

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

let dir: string
let handle: DbHandle
let app: FastifyInstance
let base: string
let cookie: string
let answers: unknown[]

const driver: InferenceDriver = {
  name: 'scripted',
  capabilities: { toolCalling: false },
  async run(_request: InferenceRequest) {
    const next = answers.shift()
    if (next === undefined) throw new Error('out of scripted answers')
    return { text: typeof next === 'string' ? next : JSON.stringify(next) }
  },
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'newsdesk-chat-sse-'))
  handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)
  seedDesk(handle.db)
  await setPassword(handle.db, 'test-password')
  answers = []

  app = await buildApp({
    db: handle.db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: join(dir, 'no-public'),
    logLevel: 'silent',
    receiveOptions: { driver: () => driver, probeTimeoutMs: 50 },
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'test-password' },
  })
  cookie = login.headers['set-cookie'] as string
})

afterEach(async () => {
  await app.close()
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Reads the whole stream to its end, which the desk closes when the turn is over. */
async function streamTurn(message: string): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetch(`${base}/api/v1/admin-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ message }),
  })

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  }
}

/** The `data:` payloads of one event type, in order. */
function events(body: string, type: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith(`event: ${type}\n`))
    .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)) as Record<string, unknown>)
}

describe('streaming a turn', () => {
  it('sends each step as an event, and ends when the turn does', async () => {
    answers = [{ say: '', call: { tool: 'get_charter', input: {} } }, { say: 'That is it.', call: null }]

    const { status, contentType, body } = await streamTurn('what is the charter?')

    expect(status).toBe(200)
    expect(contentType).toContain('text/event-stream')

    expect(events(body, 'open')).toHaveLength(1)
    expect(events(body, 'done')).toHaveLength(1)

    const streamed = events(body, 'message')
    expect(streamed.map((message) => message.role)).toEqual(['user', 'tool', 'assistant'])
    expect(streamed[1]!.toolName).toBe('get_charter')
  })

  /**
   * The property the whole design rests on: a row exists before its event does,
   * so a browser that missed the stream entirely loses nothing.
   */
  it('emits nothing that is not already a row', async () => {
    answers = [{ say: '', call: { tool: 'get_config', input: {} } }, { say: 'Read it.', call: null }]

    const { body } = await streamTurn('read the config')
    const streamed = events(body, 'message')

    const threadId = String(events(body, 'open')[0]!.threadId)
    const stored = listMessages(handle.db, threadId)

    expect(streamed.map((message) => message.id)).toEqual(stored.map((message) => message.id))
  })

  it('serves the same conversation to a browser that reconnects', async () => {
    answers = [{ say: 'Hello.', call: null }]
    const { body } = await streamTurn('hello')
    const threadId = String(events(body, 'open')[0]!.threadId)

    const rejoined = await app.inject({ method: 'GET', url: '/api/v1/admin-chat', headers: { cookie } })
    const payload = rejoined.json() as { threadId: string; messages: unknown[]; running: boolean }

    expect(payload.threadId).toBe(threadId)
    expect(payload.messages).toHaveLength(2)
    expect(payload.running).toBe(false)
  })

  it('refuses without a session', async () => {
    const response = await fetch(`${base}/api/v1/admin-chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(response.status).toBe(401)
  })

  it('answers 503 rather than opening a stream when nothing is wired', async () => {
    await app.close()
    app = await buildApp({
      db: handle.db,
      sessionSecret: 'test-secret-value-at-least-32-characters',
      publicDir: join(dir, 'no-public'),
      logLevel: 'silent',
      receiveOptions: { probeTimeoutMs: 50 },
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (typeof address === 'string' || address === null) throw new Error('no port')
    base = `http://127.0.0.1:${address.port}`

    const response = await fetch(`${base}/api/v1/admin-chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'hello' }),
    })

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

describe('confirming a proposal', () => {
  it('runs it only with the typed confirmation, and by id', async () => {
    answers = [
      { say: '', call: { tool: 'remove_config_entry', input: { collection: 'voices', id: 'alicia' } } },
      { say: 'Say the word.', call: null },
    ]

    const { body } = await streamTurn('remove the alicia voice')
    const proposal = events(body, 'message').find((message) => message.confirmWith === 'alicia')!
    expect(proposal).toBeTruthy()

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/confirm',
      headers: { cookie },
      payload: { messageId: proposal.id, confirm: 'nope' },
    })
    expect(wrong.statusCode).toBe(422)

    // The outlet references the voice, so the store would refuse the removal
    // for a reason that has nothing to do with the confirmation.
    const right = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/confirm',
      headers: { cookie },
      payload: { messageId: proposal.id, confirm: 'alicia' },
    })
    expect(right.statusCode).toBe(200)
    const result = right.json() as { ok: boolean; message: { content: string } }
    expect(result.ok).toBe(false)
    expect(result.message.content).toContain('rejected')
  })

  it('does not know a proposal that was never made', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin-chat/confirm',
      headers: { cookie },
      payload: { messageId: 'not-a-message', confirm: 'x' },
    })
    expect(response.statusCode).toBe(404)
  })
})
