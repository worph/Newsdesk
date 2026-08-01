import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { writeConfig } from '../src/config/store.js'
import { openDb, runMigrations, schema, type DbHandle } from '../src/db/index.js'
import { getOrCreateSecret, SETTING } from '../src/settings.js'
import type { InferenceDriver } from '../src/ports/inference/types.js'

/**
 * The tip line as an API: where a tip goes next, what the Wire can see of the
 * reporting, and the assistant that helps shape a note before it is filed.
 */

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

const REPORTING = {
  search: [{ endpoint: 'beacon', tool: 'searxng__search', args: { query: '{{ call.query }}' } }],
  fetch: [{ endpoint: 'beacon', tool: 'browser-mcp__get_page_text', args: { url: '{{ call.url }}' } }],
}

const CONFIG = {
  charter: 'Anything about self-hosting goes to the test channel.',
  mcp_endpoints: [{ id: 'beacon', name: 'beacon', url: 'http://beacon-backend:9300/mcp' }],
  voices: [{ id: 'alicia', name: 'Alicia', tone: 'concise', audience: 'self-hosters' }],
  stringers: [{ id: 'tip-line', name: 'Tip line', kind: 'tip' }],
  outlets: [
    {
      id: 'discord-test',
      name: 'Discord test',
      description: 'test channel',
      role: 'publish',
      driver: 'mcp',
      voice: 'alicia',
      endpoint: 'beacon',
      tool: 'discord-mcp__send_embed',
      args: {
        channelId: '1514993197082742814',
        description: { slot: 'markdown', label: 'Body', primary: true },
      },
    },
  ],
}

let dir: string
let handle: DbHandle
let app: FastifyInstance
let cookie: string
let ingestToken: string
let queued: Array<{ kind: string; id: string }>
let replies: string[]

async function boot(config: unknown = CONFIG): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'newsdesk-tips-'))
  handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)
  await setPassword(handle.db, 'pw-for-tests')
  ingestToken = getOrCreateSecret(handle.db, SETTING.ingestToken)
  writeConfig(handle.db, config, 'test')

  queued = []
  replies = []
  const driver: InferenceDriver = {
    name: 'scripted',
    capabilities: { toolCalling: false },
    async run() {
      return { text: replies.shift() ?? '{"reply":"tightened it","text":"a sharper note"}' }
    },
  }

  app = await buildApp({
    db: handle.db,
    sessionSecret: 'test-secret',
    publicDir: join(dir, 'no-public'),
    logLevel: 'silent',
    receiveOptions: {
      enqueueManagingEditor: (id) => queued.push({ kind: 'assign', id }),
      enqueueReporter: (id) => queued.push({ kind: 'report', id }),
      reportedKinds: (config as { reporting?: { kinds: string[] } }).reporting?.kinds ?? [],
      driver: () => driver,
    },
  })
  await app.ready()

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'pw-for-tests' },
  })
  cookie = `nd_session=${login.cookies.find((c) => c.name === 'nd_session')!.value}`
}

afterEach(async () => {
  await app.close()
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const postTip = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/tips', headers: { cookie }, payload })

describe('where a tip goes next', () => {
  it('goes to the reporter when the phase covers its kind', async () => {
    await boot({ ...CONFIG, reporting: { ...REPORTING, kinds: ['tip'] } })

    const res = await postTip({ text: 'a story about sam altman singularity' })

    expect(res.statusCode).toBe(201)
    expect(queued.map((j) => j.kind)).toEqual(['report'])
    const filing = handle.db.select().from(schema.filings).all()[0]
    expect(filing?.outcome).toMatch(/queued for the reporter/)
  })

  it('goes straight to the managing editor when reporting is not configured', async () => {
    await boot()

    await postTip({ text: 'a story about sam altman singularity' })

    expect(queued.map((j) => j.kind)).toEqual(['assign'])
  })

  it('leaves stringer filings alone — they already have credentials and access', async () => {
    await boot({
      ...CONFIG,
      stringers: [...CONFIG.stringers, { id: 'korben', name: 'korben', kind: 'report' }],
      reporting: { ...REPORTING, kinds: ['tip'] },
    })

    await app.inject({
      method: 'POST',
      url: '/api/v1/filings',
      headers: { authorization: `Bearer ${ingestToken}` },
      payload: { stringer_id: 'korben', text: 'Immich 1.142 is out' },
    })

    expect(queued.map((j) => j.kind)).toEqual(['assign'])
  })

  /**
   * More than one tip stringer is the normal shape once the Telegram ideas
   * group files here too, so an unnamed tip has to be refused rather than sent
   * to whichever row happened to be first.
   */
  it('refuses to guess between two tip stringers, and takes the one it is given', async () => {
    const twoTips = {
      ...CONFIG,
      stringers: [...CONFIG.stringers, { id: 'telegram-news-idea', name: 'Telegram ideas', kind: 'tip' }],
    }
    await boot(twoTips)

    const ambiguous = await postTip({ text: 'worth writing about' })
    expect(ambiguous.statusCode).toBe(422)
    expect(ambiguous.json().error).toMatch(/several tip stringers/)

    const named = await postTip({ text: 'worth writing about', stringer_id: 'telegram-news-idea' })
    expect(named.statusCode).toBe(201)
    expect(handle.db.select().from(schema.filings).all()[0]?.stringerId).toBe('telegram-news-idea')
  })

  it('still folds a posted url into the text, for bookmarklets', async () => {
    await boot()

    await postTip({ text: 'worth a look', url: 'https://immich.app/blog' })

    const filing = handle.db.select().from(schema.filings).all()[0]
    expect(filing?.text).toContain('https://immich.app/blog')
  })
})

describe('what the Wire can see of the reporting', () => {
  it('returns the dossier parsed, beside the sources actually retrieved', async () => {
    await boot()
    await postTip({ text: 'tip' })
    const id = handle.db.select().from(schema.filings).all()[0]!.id

    handle.db
      .update(schema.filings)
      .set({ dossier: JSON.stringify({ headline: 'A thing', sourced: [] }) })
      .where(eq(schema.filings.id, id))
      .run()
    handle.db
      .insert(schema.dossierSources)
      .values({
        id: randomUUID(),
        filingId: id,
        url: 'https://a.example',
        title: 'A',
        via: 'search',
        query: 'a thing',
        ok: true,
        chars: 120,
      })
      .run()

    const res = await app.inject({ method: 'GET', url: `/api/v1/filings/${id}`, headers: { cookie } })
    const body = res.json()

    expect(body.filing.dossier.headline).toBe('A thing')
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0].url).toBe('https://a.example')
  })

  it('re-reporting clears the previous dossier and its sources before queueing', async () => {
    await boot({ ...CONFIG, reporting: { ...REPORTING, kinds: ['tip'] } })
    await postTip({ text: 'tip' })
    const id = handle.db.select().from(schema.filings).all()[0]!.id

    handle.db
      .update(schema.filings)
      .set({ dossier: JSON.stringify({ headline: 'stale' }), reportedAt: '2026-07-31T00:00:00Z' })
      .where(eq(schema.filings.id, id))
      .run()
    handle.db
      .insert(schema.dossierSources)
      .values({ id: randomUUID(), filingId: id, url: 'https://old.example', via: 'search', ok: true })
      .run()

    const res = await app.inject({ method: 'POST', url: `/api/v1/filings/${id}/report`, headers: { cookie } })

    expect(res.statusCode).toBe(202)
    const filing = handle.db.select().from(schema.filings).where(eq(schema.filings.id, id)).get()
    expect(filing?.dossier).toBeNull()
    expect(filing?.reportedAt).toBeNull()
    expect(handle.db.select().from(schema.dossierSources).all()).toEqual([])
    expect(queued.at(-1)).toEqual({ kind: 'report', id })
  })

  it('refuses to re-report when the phase is not wired', async () => {
    await boot()
    await postTip({ text: 'tip' })
    const id = handle.db.select().from(schema.filings).all()[0]!.id

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/filings/${id}/report`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(503)
  })
})

describe('the tip assistant', () => {
  it('needs a session — the ingest token is for filing, not for thinking', async () => {
    await boot()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tips/assist',
      payload: { text: 'note', message: 'sharpen this' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns the reply and the whole updated note', async () => {
    await boot()
    replies = ['{"reply":"cut the throat clearing","text":"Altman says the singularity is here."}']

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tips/assist',
      headers: { cookie },
      payload: { text: 'so basically altman said stuff', message: 'tighten it' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      reply: 'cut the throat clearing',
      text: 'Altman says the singularity is here.',
    })
  })

  /**
   * A note that is never filed should leave nothing behind — no filing, no
   * chat rows, nothing to clean up later.
   */
  it('persists nothing', async () => {
    await boot()
    await app.inject({
      method: 'POST',
      url: '/api/v1/tips/assist',
      headers: { cookie },
      payload: { text: 'a note', message: 'help' },
    })

    expect(handle.db.select().from(schema.filings).all()).toEqual([])
    expect(handle.db.select().from(schema.chatMessages).all()).toEqual([])
  })

  it('rejects an empty turn', async () => {
    await boot()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tips/assist',
      headers: { cookie },
      payload: { text: 'a note', message: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})
