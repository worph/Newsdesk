import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { readConfig } from '../src/config/store.js'
import type { Db } from '../src/db/index.js'
import { listEvents, logEventReturning } from '../src/events.js'
import type { InferenceDriver } from '../src/ports/inference/types.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * The assistant end to end: refusals before it runs, what it stores, and the
 * one thing that must always hold — that applying a proposal reads the row the
 * server validated, never the request body.
 */

function scripted(...answers: string[]): InferenceDriver & { prompts: string[] } {
  const prompts: string[] = []
  return {
    name: 'scripted',
    capabilities: { toolCalling: false },
    prompts,
    async run(request) {
      prompts.push(request.prompt)
      const next = answers.shift()
      if (next === undefined) throw new Error('the scripted driver ran out of answers')
      if (next === '__throw__') throw new Error('beacon unreachable')
      return { text: next }
    },
  }
}

let app: FastifyInstance
let db: Db
let cookie: string
let driver: InferenceDriver | undefined
let published: string[]
let restarted: number

async function boot(options: { withDriver?: boolean } = { withDriver: true }) {
  const handle = openTestDb()
  db = handle.db
  seedDesk(db)
  await setPassword(db, 'test-password')
  published = []
  restarted = 0

  app = await buildApp({
    db,
    sessionSecret: 'test-secret-value-at-least-32-characters',
    publicDir: '/nonexistent',
    logLevel: 'silent',
    receiveOptions: {
      ...(options.withDriver ? { driver: () => driver! } : {}),
      enqueuePublish: (id) => published.push(id),
      enqueueManagingEditor: () => {},
      enqueueReporter: () => {},
      restart: () => {
        restarted++
      },
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
  cookie = login.headers['set-cookie'] as string
}

function seedFailure(): number {
  db.insert(schema.stories)
    .values({ id: 's1', title: 'Aptero 1.4', summary: 'A release.', status: 'PLACED', dedupVerdict: 'NEW' })
    .run()
  db.insert(schema.publications)
    .values({
      id: 'p1',
      storyId: 's1',
      outletId: 'discord-test',
      status: 'FAILED',
      origin: 'managing-editor',
      payload: JSON.stringify({ title: 'x', description: 'y' }),
      error: 'HTTP 401',
    })
    .run()

  return logEventReturning(db, {
    level: 'error',
    code: 'PUBLISH_FAILED',
    storyId: 's1',
    publicationId: 'p1',
    message: 'could not send to Discord',
    detail: {
      outletId: 'discord-test',
      outletName: 'Discord',
      driver: 'mcp',
      tool: 'discord-mcp__send_embed',
      endpointId: 'beacon',
      httpStatus: 401,
      error: 'Unauthorized',
    },
  })!
}

const RETRY_ANSWER = JSON.stringify({
  diagnosis: 'The Beacon answered 401. Its token has expired.',
  confidence: 'high',
  remedies: [
    {
      kind: 'retry_publication',
      title: 'Send the approved payload again',
      rationale: 'The bytes were frozen at approval and the failure was transport-level.',
      publicationId: 'p1',
    },
  ],
})

beforeEach(async () => {
  await boot()
})

describe('before the assistant runs', () => {
  it('refuses without a session', async () => {
    const id = seedFailure()
    const response = await app.inject({ method: 'POST', url: `/api/v1/events/${id}/assist` })
    expect(response.statusCode).toBe(401)
  })

  it('answers 503 when no inference is wired', async () => {
    await boot({ withDriver: false })
    const id = seedFailure()

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${id}/assist`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(503)

    // And the screen can find that out before it draws the button.
    const status = (
      await app.inject({ method: 'GET', url: '/api/v1/assist/status', headers: { cookie } })
    ).json() as { available: boolean; reason: string }
    expect(status.available).toBe(false)
    expect(status.reason).toContain('no inference')
  })

  /**
   * The Beacon used to serve one query at a time, and this refused with a 409
   * while any job held it. It runs queries in parallel now, so the button has
   * to work at the moment it is most wanted — which is precisely when the
   * pipeline is busy failing and retrying.
   */
  it('diagnoses while a job is running rather than refusing', async () => {
    const id = seedFailure()
    db.insert(schema.jobs)
      .values({ id: 'j1', kind: 'publish', refId: 'p1', status: 'RUNNING', attempts: 1 })
      .run()

    driver = scripted(RETRY_ANSWER)
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${id}/assist`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
  })

  it('refuses an entry with nothing to act on', async () => {
    const id = logEventReturning(db, { level: 'info', code: 'PUBLISHED', message: 'sent to Discord' })!
    driver = scripted(RETRY_ANSWER)

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${id}/assist`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(422)
  })

  it('answers 502 and logs it when the driver throws', async () => {
    const id = seedFailure()
    driver = scripted('__throw__', '__throw__')

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${id}/assist`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(502)
    // Invariant 7: when the assistant is down, the log still says so itself.
    expect(listEvents(db).events.map((row) => row.code)).toContain('ASSIST_FAILED')
  })
})

describe('a diagnosis', () => {
  it('is stored, so a refresh keeps it', async () => {
    const id = seedFailure()
    driver = scripted(RETRY_ANSWER)

    const first = (
      await app.inject({ method: 'POST', url: `/api/v1/events/${id}/assist`, headers: { cookie } })
    ).json() as { session: { diagnosis: string; remedies: { id: string }[] } }
    expect(first.session.remedies).toHaveLength(1)

    const reloaded = (
      await app.inject({ method: 'GET', url: `/api/v1/events/${id}/assist`, headers: { cookie } })
    ).json() as { session: { diagnosis: string } | null }
    expect(reloaded.session?.diagnosis).toBe(first.session.diagnosis)
  })

  it('drops a remedy that names something which does not exist', async () => {
    const id = seedFailure()
    driver = scripted(
      JSON.stringify({
        diagnosis: 'x',
        confidence: 'low',
        remedies: [
          { kind: 'retry_publication', title: 'Retry', rationale: 'r', publicationId: 'ghost' },
          { kind: 'no_action', title: 'Wait', rationale: 'r' },
        ],
      }),
    )

    const body = (
      await app.inject({ method: 'POST', url: `/api/v1/events/${id}/assist`, headers: { cookie } })
    ).json() as { session: { remedies: { kind: string }[]; rejected: { reason: string }[] } }

    expect(body.session.remedies.map((remedy) => remedy.kind)).toEqual(['no_action'])
    expect(body.session.rejected[0]?.reason).toContain('ghost')
  })

  it('marks a literal change high risk however the model described it', async () => {
    const id = seedFailure()
    driver = scripted(
      JSON.stringify({
        diagnosis: 'x',
        confidence: 'high',
        remedies: [
          {
            kind: 'propose_literal_change',
            title: 'Correct the tool name',
            rationale: 'r',
            changes: [
              { target: 'outlet', id: 'discord-test', field: 'tool', value: 'discord-mcp__send_message' },
            ],
          },
        ],
      }),
    )

    const body = (
      await app.inject({ method: 'POST', url: `/api/v1/events/${id}/assist`, headers: { cookie } })
    ).json() as { session: { remedies: { risk: string; confirmWith: string }[] } }

    expect(body.session.remedies[0]?.risk).toBe('high')
    expect(body.session.remedies[0]?.confirmWith).toBe('discord-test')
  })
})

describe('applying a proposal', () => {
  async function propose(answer: string) {
    const id = seedFailure()
    driver = scripted(answer)
    const body = (
      await app.inject({ method: 'POST', url: `/api/v1/events/${id}/assist`, headers: { cookie } })
    ).json() as { session: { remedies: { id: string; risk: string }[] } }
    return body.session.remedies[0]!
  }

  it('does the work and logs that it did', async () => {
    const remedy = await propose(RETRY_ANSWER)

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/remedies/${remedy.id}/apply`,
      headers: { cookie },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(published).toEqual(['p1'])
    expect(listEvents(db).events.map((row) => row.code)).toContain('REMEDY_APPLIED')
  })

  it('refuses to apply the same proposal twice', async () => {
    const remedy = await propose(RETRY_ANSWER)
    const apply = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/remedies/${remedy.id}/apply`,
        headers: { cookie },
        payload: {},
      })

    expect((await apply()).statusCode).toBe(200)
    expect((await apply()).statusCode).toBe(409)
    expect(published).toEqual(['p1'])
  })

  it('answers 404 for a proposal that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/remedies/not-a-remedy/apply',
      headers: { cookie },
      payload: {},
    })
    expect(response.statusCode).toBe(404)
  })

  const LITERAL_ANSWER = JSON.stringify({
    diagnosis: 'The tool name is wrong.',
    confidence: 'high',
    remedies: [
      {
        kind: 'propose_literal_change',
        title: 'Correct the tool name',
        rationale: 'The endpoint has no tool by that name.',
        changes: [
          { target: 'outlet', id: 'discord-test', field: 'tool', value: 'discord-mcp__send_message' },
        ],
      },
    ],
  })

  it('will not apply a high-risk change without the typed confirmation', async () => {
    const remedy = await propose(LITERAL_ANSWER)
    expect(remedy.risk).toBe('high')

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/remedies/${remedy.id}/apply`,
      headers: { cookie },
      payload: {},
    })

    expect(response.statusCode).toBe(422)
    expect(readConfig(db).outlets[0]?.tool).toBe('discord-mcp__send_embed')
  })

  it('will not accept the wrong confirmation either', async () => {
    const remedy = await propose(LITERAL_ANSWER)

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/remedies/${remedy.id}/apply`,
      headers: { cookie },
      payload: { confirm: 'something-else' },
    })

    expect(response.statusCode).toBe(422)
    expect(readConfig(db).outlets[0]?.tool).toBe('discord-mcp__send_embed')
  })

  it('applies it with the right confirmation, and leaves a restore point', async () => {
    const remedy = await propose(LITERAL_ANSWER)

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/remedies/${remedy.id}/apply`,
      headers: { cookie },
      payload: { confirm: 'discord-test' },
    })

    expect(response.statusCode).toBe(200)
    expect(readConfig(db).outlets[0]?.tool).toBe('discord-mcp__send_message')

    // The way back, taken automatically and named after the remedy.
    const versions = db.select().from(schema.configVersions).all()
    expect(versions).toHaveLength(1)
    expect(versions[0]?.author).toBe('assistant')
    expect(versions[0]?.reason).toContain(remedy.id)
    expect(versions[0]?.yaml).toContain('discord-mcp__send_embed')
  })

  const RESTART_ANSWER = JSON.stringify({
    diagnosis: 'The queue is wedged on a handler that no longer exists.',
    confidence: 'medium',
    remedies: [{ kind: 'propose_restart', title: 'Restart the desk', rationale: 'r' }],
  })

  describe('the restart remedy', () => {
    /**
     * Only offered where stopping the process brings it back. Under compose
     * that is the restart policy; under `tsx watch` it is just the desk going
     * away, which is why the remedy is dropped rather than shown there.
     */
    it('is not even proposed where a restart would not come back', async () => {
      delete process.env['NEWSDESK_RESTARTABLE']
      process.env['NEWSDESK_RESTARTABLE'] = '0'

      const id = seedFailure()
      driver = scripted(RESTART_ANSWER)
      const body = (
        await app.inject({ method: 'POST', url: `/api/v1/events/${id}/assist`, headers: { cookie } })
      ).json() as { session: { remedies: unknown[]; rejected: { reason: string }[] } }

      expect(body.session.remedies).toHaveLength(0)
      expect(body.session.rejected[0]?.reason).toContain('cannot restart itself')
    })

    it('needs the typed confirmation, then stops the process', async () => {
      process.env['NEWSDESK_RESTARTABLE'] = '1'
      const id = seedFailure()
      driver = scripted(RESTART_ANSWER)

      const body = (
        await app.inject({ method: 'POST', url: `/api/v1/events/${id}/assist`, headers: { cookie } })
      ).json() as { session: { remedies: { id: string; risk: string; confirmWith: string }[] } }
      const remedy = body.session.remedies[0]!
      expect(remedy.risk).toBe('high')

      const refused = await app.inject({
        method: 'POST',
        url: `/api/v1/remedies/${remedy.id}/apply`,
        headers: { cookie },
        payload: {},
      })
      expect(refused.statusCode).toBe(422)
      expect(restarted).toBe(0)

      const applied = await app.inject({
        method: 'POST',
        url: `/api/v1/remedies/${remedy.id}/apply`,
        headers: { cookie },
        payload: { confirm: remedy.confirmWith },
      })
      expect(applied.statusCode).toBe(200)

      // Scheduled just after the reply, so the browser hears back before the
      // process goes away.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(restarted).toBe(1)

      delete process.env['NEWSDESK_RESTARTABLE']
    })
  })

  it('can be dismissed instead, and then not applied', async () => {
    const remedy = await propose(RETRY_ANSWER)

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/remedies/${remedy.id}/dismiss`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200)

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/remedies/${remedy.id}/apply`,
      headers: { cookie },
      payload: {},
    })
    expect(response.statusCode).toBe(409)
    expect(published).toEqual([])
  })
})
