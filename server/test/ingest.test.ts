import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { writeConfig } from '../src/config/store.js'
import { openDb, runMigrations, type DbHandle } from '../src/db/index.js'
import { getOrCreateSecret, SETTING } from '../src/settings.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

const CONFIG = {
  charter: 'Anything about self-hosting goes to the test channel.',
  mcp_endpoints: [{ id: 'beacon', name: 'beacon', url: 'http://beacon-backend:9300/mcp' }],
  personas: [{ id: 'alicia', name: 'Alicia', voice: 'concise', audience: 'self-hosters' }],
  sources: [
    { id: 'idea-box', name: 'Idea box', kind: 'idea' },
    { id: 'github', name: 'GitHub stringer', kind: 'report' },
    { id: 'korben', name: 'korben', kind: 'timeline' },
    { id: 'appstore-state', name: 'AppStore state', kind: 'snapshot' },
    { id: 'sleeping', name: 'Disabled source', kind: 'report', enabled: false },
  ],
  targets: [
    {
      id: 'discord-test',
      name: 'Discord test',
      description: 'test channel',
      role: 'publish',
      driver: 'mcp',
      persona: 'alicia',
      endpoint: 'beacon',
      tool: 'discord-mcp__send_embed',
      args: {
        channelId: '1514993197082742814',
        title: { slot: 'text', label: 'Headline' },
        description: { slot: 'markdown', label: 'Body', primary: true },
      },
    },
  ],
}

let dir: string
let handle: DbHandle
let app: FastifyInstance
let token: string
let cookie: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'newsdesk-ingest-'))
  handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)
  await setPassword(handle.db, 'pw-for-tests')
  token = getOrCreateSecret(handle.db, SETTING.ingestToken)
  writeConfig(handle.db, CONFIG, 'test')

  app = await buildApp({
    db: handle.db,
    sessionSecret: 'test-secret',
    publicDir: join(dir, 'no-public'),
    logLevel: 'silent',
  })
  await app.ready()

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'pw-for-tests' },
  })
  cookie = `nd_session=${login.cookies.find((c) => c.name === 'nd_session')!.value}`
})

afterEach(async () => {
  await app.close()
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const file = (payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/submissions',
    headers: { authorization: `Bearer ${token}` },
    payload,
  })

describe('the ingest token', () => {
  it('is required', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/submissions',
      payload: { source_id: 'github', text: 'hello' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('is not satisfied by a session — stringers never hold one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/submissions',
      headers: { cookie },
      payload: { source_id: 'github', text: 'hello' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/submissions',
      headers: { authorization: 'Bearer nope' },
      payload: { source_id: 'github', text: 'hello' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('filing a report', () => {
  it('stores it whole and shows up in the inbox', async () => {
    const res = await file({ source_id: 'github', text: 'settings-center gained a dark mode' })
    expect(res.statusCode).toBe(201)
    expect(res.json().results[0]).toMatchObject({ sourceId: 'github', considered: true })

    const inbox = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: { cookie } })
    const rows = inbox.json().submissions
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceName: 'GitHub stringer', outcome: 'considered whole' })
    expect(rows[0].consideredChars).toBeGreaterThan(0)
  })

  it('rejects an unknown source with a usable message', async () => {
    const res = await file({ source_id: 'nobody', text: 'hello' })
    expect(res.statusCode).toBe(422)
    expect(res.json().results[0].note).toMatch(/unknown source "nobody"/)
  })

  it('stores a report filed to a disabled source rather than losing it', async () => {
    const res = await file({ source_id: 'sleeping', text: 'filed while asleep' })
    expect(res.statusCode).toBe(201)
    expect(res.json().results[0]).toMatchObject({
      considered: false,
      note: 'source disabled — stored but not processed',
    })

    const detailList = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: { cookie } })
    expect(detailList.json().submissions[0].outcome).toMatch(/disabled/)
  })

  it('accepts a batch and keeps the good rows when one is bad', async () => {
    const res = await file([
      { source_id: 'github', text: 'first' },
      { source_id: 'nobody', text: 'second' },
      { source_id: 'github', text: 'third' },
    ])
    expect(res.statusCode).toBe(201)
    const results = res.json().results
    expect(results.map((r: { status: string }) => r.status)).toEqual(['PROCESSED', 'REJECTED', 'PROCESSED'])

    const inbox = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: { cookie } })
    expect(inbox.json().submissions).toHaveLength(2)
  })

  it('rejects an empty submission', async () => {
    expect((await file({ source_id: 'github', text: '' })).statusCode).toBe(400)
  })
})

describe('a timeline source', () => {
  const window1 = ['- 2026-07-20 oldest', '- 2026-07-21 middle'].join('\n')
  const window2 = ['- 2026-07-21 middle', '- 2026-07-22 newest'].join('\n')

  it('baselines, then trims an overlapping re-file', async () => {
    const first = await file({ source_id: 'korben', text: window1 })
    expect(first.json().results[0].note).toMatch(/baseline/)

    // The stringer keeps no cursor and re-sends an overlapping window. Only
    // the genuinely new entry survives.
    const second = await file({ source_id: 'korben', text: window2 })
    expect(second.json().results[0]).toMatchObject({ considered: true })
    expect(second.json().results[0].note).toMatch(/1 of 2 entries newer/)

    // Filing the very same window again yields nothing new.
    const third = await file({ source_id: 'korben', text: window2 })
    expect(third.json().results[0]).toMatchObject({ considered: false })
    expect(third.json().results[0].note).toMatch(/nothing newer/)
  })

  it('records what was actually considered, so a miss is explainable', async () => {
    await file({ source_id: 'korben', text: window1 })
    await file({ source_id: 'korben', text: window2 })

    const list = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: { cookie } })
    const latest = list.json().submissions[0]
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/submissions/${latest.id}`,
      headers: { cookie },
    })
    const submission = detail.json().submission
    expect(submission.text).toContain('middle')
    expect(submission.considered).toContain('newest')
    expect(submission.considered).not.toContain('middle')
  })
})

describe('a snapshot source', () => {
  it('baselines silently, then hands over only the change', async () => {
    const first = await file({ source_id: 'appstore-state', text: 'immich 1.0\njellyfin 2.0' })
    expect(first.json().results[0]).toMatchObject({ considered: false })
    expect(first.json().results[0].note).toMatch(/baseline snapshot/)

    const second = await file({ source_id: 'appstore-state', text: 'immich 1.1\njellyfin 2.0' })
    expect(second.json().results[0]).toMatchObject({ considered: true })

    const list = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: { cookie } })
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/submissions/${list.json().submissions[0].id}`,
      headers: { cookie },
    })
    expect(detail.json().submission.considered).toBe('- immich 1.0\n+ immich 1.1')
  })
})

describe('the idea box', () => {
  it('accepts a session and appends the link to the text', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ideas',
      headers: { cookie },
      payload: { text: 'worth writing about', url: 'https://example.com/post' },
    })
    expect(res.statusCode).toBe(201)

    const list = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: { cookie } })
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/submissions/${list.json().submissions[0].id}`,
      headers: { cookie },
    })
    const submission = detail.json().submission
    expect(submission.kind).toBe('idea')
    expect(submission.text).toContain('https://example.com/post')
    expect(submission.refs).toEqual({ url: 'https://example.com/post' })
  })

  it('accepts the ingest token instead of a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ideas',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'from a bookmarklet' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('refuses anonymous ideas', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/ideas', payload: { text: 'nope' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('the event log', () => {
  it('records every filing, so silence and nothing-happened never look alike', async () => {
    await file({ source_id: 'github', text: 'a report' })
    const res = await app.inject({ method: 'GET', url: '/api/v1/events', headers: { cookie } })
    const events = res.json().events
    expect(events[0]).toMatchObject({ code: 'SUBMISSION_RECEIVED', level: 'info' })
    expect(events[0].message).toContain('github')
  })

  it('is readable when filtered by level', async () => {
    await file({ source_id: 'sleeping', text: 'filed while asleep' })
    const res = await app.inject({ method: 'GET', url: '/api/v1/events?level=warn', headers: { cookie } })
    expect(res.json().events[0].code).toBe('SUBMISSION_SOURCE_DISABLED')
  })
})
