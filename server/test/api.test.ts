import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { importConfigFileOnFirstBoot, readConfig } from '../src/config/store.js'
import { openDb, runMigrations, type DbHandle } from '../src/db/index.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

const VALID_YAML = `
charter: |
  AppStore releases go to the test channel for a general audience.
mcp_endpoints:
  - id: beacon
    name: yunderalabs beacon
    url: http://beacon-backend:9300/mcp
voices:
  - id: alicia
    name: Alicia
    tone: concise, technical, anti-hype
    audience: self-hosters and homelabbers
stringers:
  - id: tip-line
    name: Tip line
    kind: tip
outlets:
  - id: discord-test
    name: "Discord #news-test"
    description: test channel for a general audience
    role: publish
    driver: mcp
    voice: alicia
    endpoint: beacon
    tool: discord-mcp__send_embed
    args:
      channelId: "1514993197082742814"
      timestamp: true
      footer: "{{story.url}}"
      title:
        slot: text
        label: Headline
        max: 256
      description:
        slot: markdown
        label: Body
        max: 4096
        primary: true
`

let dir: string
let handle: DbHandle
let app: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'newsdesk-api-'))
  handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)
  await setPassword(handle.db, 'correct horse battery')
  app = await buildApp({
    db: handle.db,
    sessionSecret: 'test-secret',
    publicDir: join(dir, 'no-public'),
    logLevel: 'silent',
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'correct horse battery' },
  })
  expect(res.statusCode).toBe(200)
  const cookie = res.cookies.find((c) => c.name === 'nd_session')
  expect(cookie).toBeDefined()
  return `nd_session=${cookie!.value}`
}

describe('auth', () => {
  it('rejects a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.cookies.find((c) => c.name === 'nd_session')).toBeUndefined()
  })

  it('accepts the right password and reports the session', async () => {
    const cookie = await login()
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })
    expect(me.json()).toEqual({ authenticated: true, passwordRequired: true })
  })

  it('refuses a forged session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { cookie: 'nd_session=%7B%22v%22%3A1%7D.forged' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('guards the config endpoints', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/config', payload: { yaml: VALID_YAML } })).statusCode,
    ).toBe(401)
  })
})

describe('config round trip', () => {
  it('saves a valid config and reads it back', async () => {
    const cookie = await login()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { cookie },
      payload: { yaml: VALID_YAML },
    })
    expect(put.statusCode).toBe(200)

    const get = await app.inject({ method: 'GET', url: '/api/v1/config', headers: { cookie } })
    const body = get.json()
    expect(body.issues).toEqual([])
    expect(body.config.outlets[0].id).toBe('discord-test')
    expect(body.config.outlets[0].args.channelId).toBe('1514993197082742814')
    expect(body.ingestToken).toBeTypeOf('string')
  })

  it('refuses a config whose publish outlet does not pin its destination', async () => {
    const cookie = await login()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { cookie },
      payload: { yaml: VALID_YAML.replace('      channelId: "1514993197082742814"\n', '') },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().issues).toContainEqual({
      path: 'outlets.discord-test.args.channelId',
      message: expect.stringContaining('must pin its destination'),
    })
  })

  it('validates without writing', async () => {
    const cookie = await login()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/config/validate',
      headers: { cookie },
      payload: { yaml: VALID_YAML },
    })
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.issues).toEqual([])
    // Both renderings come back: the Configuration screen converts between its
    // forms and its editor through this call rather than serialising itself.
    expect(body.config.outlets[0].id).toBe('discord-test')
    expect(body.yaml).toContain('discord-test')
    expect(readConfig(handle.db).charter).toBe('')
  })

  it('accepts a config object as well as a document, and reports shape errors by path', async () => {
    const cookie = await login()
    const { parse } = await import('yaml')
    const config = parse(VALID_YAML) as Record<string, unknown>

    const ok = await app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { cookie },
      payload: { config },
    })
    expect(ok.statusCode).toBe(200)
    expect(readConfig(handle.db).outlets[0]?.id).toBe('discord-test')

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/config/validate',
      headers: { cookie },
      payload: { config: { ...config, voices: [{ id: 'x', name: '', tone: 't', audience: 'a' }] } },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().issues[0].path).toBe('voices.0.name')
  })

  it('reports a YAML syntax error rather than throwing', async () => {
    const cookie = await login()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/config/validate',
      headers: { cookie },
      payload: { yaml: 'charter: "unterminated' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('could not parse')
  })

  it('appends a charter version only when the text changes', async () => {
    const cookie = await login()
    const put = async (yaml: string) =>
      app.inject({ method: 'PUT', url: '/api/v1/config', headers: { cookie }, payload: { yaml } })

    await put(VALID_YAML)
    await put(VALID_YAML)
    const afterTwoIdentical = handle.sqlite.prepare('select count(*) as n from charter').get() as { n: number }
    expect(afterTwoIdentical.n).toBe(1)

    await put(VALID_YAML.replace('general audience.', 'developer audience.'))
    const afterChange = handle.sqlite.prepare('select count(*) as n from charter').get() as { n: number }
    expect(afterChange.n).toBe(2)
  })

  it('refuses to remove an outlet that publications reference', async () => {
    const cookie = await login()
    await app.inject({ method: 'PUT', url: '/api/v1/config', headers: { cookie }, payload: { yaml: VALID_YAML } })

    handle.sqlite
      .prepare(
        "insert into stories (id,title,summary,status,dedup_verdict) values ('s1','t','s','PLACED','NEW')",
      )
      .run()
    handle.sqlite
      .prepare(
        "insert into publications (id,story_id,outlet_id,status,origin) values ('p1','s1','discord-test','PUBLISHED','managing-editor')",
      )
      .run()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { cookie },
      payload: { yaml: VALID_YAML.replace(/outlets:[\s\S]*$/, 'outlets: []\n') },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().issues).toContainEqual({
      path: 'outlets',
      message: expect.stringContaining('cannot remove outlet'),
    })
  })
})

describe('first-boot config import', () => {
  it('seeds from config.yaml when unconfigured, and ignores it afterwards', () => {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, VALID_YAML)

    expect(importConfigFileOnFirstBoot(handle.db, file).imported).toBe(true)
    expect(readConfig(handle.db).outlets).toHaveLength(1)

    // Second call is a no-op: the database is the source of truth now, so a
    // stale file can never compete with an outlet edited in the UI.
    writeFileSync(file, VALID_YAML.replace('discord-test', 'something-else'))
    expect(importConfigFileOnFirstBoot(handle.db, file).imported).toBe(false)
    expect(readConfig(handle.db).outlets[0]?.id).toBe('discord-test')
  })

  it('does not seed a config that fails validation', () => {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, VALID_YAML.replace('      channelId: "1514993197082742814"\n', ''))
    const result = importConfigFileOnFirstBoot(handle.db, file)
    expect(result.imported).toBe(false)
    expect(result.issues).toContainEqual({
      path: 'outlets.discord-test.args.channelId',
      message: expect.stringContaining('must pin its destination'),
    })
  })
})

describe('healthz', () => {
  it('answers without a session and reports configured state', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, configured: false, endpoints: [] })
  })
})
