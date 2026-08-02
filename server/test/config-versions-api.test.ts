import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { readConfig, writeConfig } from '../src/config/store.js'
import type { Db } from '../src/db/index.js'
import { listEvents } from '../src/events.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

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

function renameOutlet(name: string) {
  const config = readConfig(db)
  config.outlets[0]!.name = name
  writeConfig(db, config, 'ui')
}

describe('the configuration history over HTTP', () => {
  it('refuses without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/versions' })).statusCode).toBe(401)
  })

  it('lists a version once something has changed', async () => {
    renameOutlet('Renamed')

    const body = (
      await app.inject({ method: 'GET', url: '/api/v1/config/versions', headers: { cookie } })
    ).json() as { versions: Array<{ id: number; author: string; summary: string }> }

    expect(body.versions).toHaveLength(1)
    expect(body.versions[0]?.author).toBe('ui')
    expect(body.versions[0]?.summary).toContain('1 outlet')
  })

  it('restores, and logs it as something a human did', async () => {
    renameOutlet('Renamed')
    const id = (
      (await app.inject({ method: 'GET', url: '/api/v1/config/versions', headers: { cookie } }))
        .json() as { versions: Array<{ id: number }> }
    ).versions[0]!.id

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/config/versions/${id}/restore`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(readConfig(db).outlets[0]?.name).toBe('Discord')

    const codes = listEvents(db).events.map((row) => row.code)
    expect(codes).toContain('CONFIG_RESTORED')
    expect(listEvents(db).events.find((row) => row.code === 'CONFIG_RESTORED')?.actor).toBe('human')
  })

  it('answers 404 for a version that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/config/versions/999/restore',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('answers 422 with issues when the restore is refused, and changes nothing', async () => {
    // A version from before a second outlet existed…
    const config = readConfig(db)
    config.outlets.push({ ...config.outlets[0]!, id: 'discord-two', name: 'Second channel' })
    writeConfig(db, config, 'ui')

    const id = (
      (await app.inject({ method: 'GET', url: '/api/v1/config/versions', headers: { cookie } }))
        .json() as { versions: Array<{ id: number }> }
    ).versions[0]!.id

    // …which something now depends on.
    db.insert(schema.stories)
      .values({ id: 's1', title: 't', summary: 's', status: 'PLACED', dedupVerdict: 'NEW' })
      .run()
    db.insert(schema.publications)
      .values({ id: 'p1', storyId: 's1', outletId: 'discord-two', status: 'PUBLISHED', origin: 'human' })
      .run()

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/config/versions/${id}/restore`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(422)
    expect((response.json() as { issues: unknown[] }).issues.length).toBeGreaterThan(0)
    expect(readConfig(db).outlets).toHaveLength(2)
  })

  it('previews the warning before the restore that would cause it', async () => {
    const config = readConfig(db)
    config.mcp_endpoints.push({ id: 'other', name: 'Other beacon', url: 'http://other/mcp/' })
    writeConfig(db, config, 'ui')

    // The warning is about losing an authorization, so there has to be one to
    // lose — an unconnected endpoint being removed costs nothing and is not
    // warned about, deliberately.
    db.update(schema.mcpEndpoints)
      .set({ auth: JSON.stringify({ oauth: { accessToken: 'sekrit' } }) })
      .where(eq(schema.mcpEndpoints.id, 'other'))
      .run()

    const id = (
      (await app.inject({ method: 'GET', url: '/api/v1/config/versions', headers: { cookie } }))
        .json() as { versions: Array<{ id: number }> }
    ).versions[0]!.id

    const preview = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/config/versions/${id}/preview`,
        headers: { cookie },
      })
    ).json() as { warnings: string[]; issues: unknown[] }

    expect(preview.issues).toHaveLength(0)
    expect(preview.warnings.join(' ')).toContain('Other beacon')
  })
})
