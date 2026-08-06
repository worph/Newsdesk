import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { readConfig } from '../src/config/store.js'
import { openDb, runMigrations, schema, type DbHandle } from '../src/db/index.js'
import { listEvents } from '../src/events.js'
import { SETTING, setSetting } from '../src/settings.js'
import { seedDesk } from './helpers.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const TOKEN = 'test-administration-token'

let dir: string
let handle: DbHandle
let app: FastifyInstance
let url: URL

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'newsdesk-admin-mcp-'))
  handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)
  seedDesk(handle.db)
  setSetting(handle.db, SETTING.adminMcpToken, TOKEN)

  app = await buildApp({
    db: handle.db,
    sessionSecret: 'test-secret',
    publicDir: join(dir, 'no-public'),
    logLevel: 'silent',
  })
  // A real socket rather than `inject`: the transport writes to the raw
  // response after `reply.hijack()`, which is exactly the wiring worth proving.
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  url = new URL(`http://127.0.0.1:${address.port}/mcp`)
})

afterEach(async () => {
  await app.close()
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

/** The text a tool returned, and whether it refused. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: { type: string; text?: string }[]
  }
  return {
    text: result.content.map((part) => part.text ?? '').join('\n'),
    isError: result.isError === true,
  }
}

describe('the administration token', () => {
  it('refuses a caller that presents no token', async () => {
    const client = new Client({ name: 'test', version: '0' })
    await expect(client.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow()
  })

  it('refuses a caller that presents the wrong token', async () => {
    await expect(connect('not-the-token')).rejects.toThrow()
  })

  it('does not accept the ingest token, which every stringer holds', async () => {
    setSetting(handle.db, SETTING.ingestToken, 'stringer-token')
    await expect(connect('stringer-token')).rejects.toThrow()
  })
})

describe('reading', () => {
  it('serves the configuration as YAML', async () => {
    const client = await connect()
    const { text } = await call(client, 'get_config')
    const payload = JSON.parse(text) as { yaml: string }
    expect(payload.yaml).toContain('discord-test')
    expect(payload.yaml).toContain('charter')
    await client.close()
  })

  it('offers administration tools and nothing that could publish', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).toContain('get_config')
    expect(names).toContain('set_charter')
    expect(names).toContain('write_config')
    // The human between every draft and every channel is the product; an
    // administration surface that could send would delete it.
    for (const forbidden of ['approve', 'publish', 'spike', 'send']) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false)
    }
    await client.close()
  })

  it('validates a candidate document without writing it', async () => {
    const client = await connect()
    const before = readConfig(handle.db)

    const { text } = await call(client, 'validate_config', { yaml: 'charter: ""\noutlets: []\n' })
    expect(JSON.parse(text).ok).toBe(false)
    expect(readConfig(handle.db)).toEqual(before)
    await client.close()
  })
})

describe('writing one entry at a time', () => {
  it('replaces the charter and leaves the rest of the desk alone', async () => {
    const client = await connect()
    const before = readConfig(handle.db)

    const { isError } = await call(client, 'set_charter', {
      charter: 'Only security releases run, and only on the internal channel.',
      reason: 'narrowing the desk for a week',
    })
    expect(isError).toBe(false)

    const after = readConfig(handle.db)
    expect(after.charter).toBe('Only security releases run, and only on the internal channel.')
    expect(after.outlets).toEqual(before.outlets)
    expect(after.voices).toEqual(before.voices)
    await client.close()
  })

  it('adds an outlet without the caller restating the document', async () => {
    const client = await connect()

    const { isError, text } = await call(client, 'upsert_outlet', {
      outlet: {
        id: 'discord-internal',
        name: 'Discord #internal',
        description: 'Internal room: dry technical notes for the team.',
        role: 'publish',
        driver: 'mcp',
        enabled: true,
        voice: 'alicia',
        endpoint: 'beacon',
        tool: 'discord-mcp__send_message',
        args: {
          channelId: '1514993197082742815',
          content: { slot: 'markdown', label: 'Body', max: 2000, primary: true },
        },
      },
      reason: 'adding the internal room',
    })
    expect(isError, text).toBe(false)

    const after = readConfig(handle.db)
    // The one that was already there survived — this is the whole reason the
    // upsert tools exist beside write_config.
    expect(after.outlets.map((outlet) => outlet.id).sort()).toEqual(['discord-internal', 'discord-test'])
    await client.close()
  })

  it('updates an entry in place rather than appending a second one', async () => {
    const client = await connect()
    const original = readConfig(handle.db).voices[0]!

    await call(client, 'upsert_voice', { voice: { ...original, tone: 'warmer, still anti-hype' } })

    const voices = readConfig(handle.db).voices
    expect(voices).toHaveLength(1)
    expect(voices[0]!.tone).toBe('warmer, still anti-hype')
    await client.close()
  })

  it('refuses to remove a stringer that has already filed, and says to disable it', async () => {
    handle.db
      .insert(schema.filings)
      .values({ id: 'f1', stringerId: 'korben', kind: 'timeline', text: 'a report', status: 'RECEIVED' })
      .run()

    const client = await connect()
    const { isError, text } = await call(client, 'remove_config_entry', {
      collection: 'stringers',
      id: 'korben',
    })

    expect(isError).toBe(true)
    expect(text).toContain('enabled: false')
    expect(readConfig(handle.db).stringers).toHaveLength(1)
    await client.close()
  })

  it('reports an id that is not there rather than silently doing nothing', async () => {
    const client = await connect()
    const { isError, text } = await call(client, 'remove_config_entry', {
      collection: 'outlets',
      id: 'never-existed',
    })
    expect(isError).toBe(true)
    expect(text).toContain('never-existed')
    await client.close()
  })
})

describe('writing the whole document', () => {
  it('rejects a document that does not validate, and writes nothing', async () => {
    const client = await connect()
    const before = readConfig(handle.db)

    const { isError } = await call(client, 'write_config', {
      yaml: 'charter: |\n  Everything runs.\noutlets:\n  - id: broken\n',
      reason: 'testing a bad document',
    })

    expect(isError).toBe(true)
    expect(readConfig(handle.db)).toEqual(before)
    await client.close()
  })

  it('leaves a restore point that rolls the change back', async () => {
    const client = await connect()
    const before = readConfig(handle.db).charter

    await call(client, 'set_charter', { charter: 'A charter written over MCP.' })
    const versions = JSON.parse((await call(client, 'list_config_versions')).text) as {
      versions: { id: number; author: string }[]
    }
    expect(versions.versions[0]!.author).toBe('mcp')

    const { isError } = await call(client, 'restore_config_version', { id: versions.versions[0]!.id })
    expect(isError).toBe(false)
    expect(readConfig(handle.db).charter).toBe(before)
    await client.close()
  })

  it('says in the log that an MCP client made the change', async () => {
    const client = await connect()
    await call(client, 'set_charter', { charter: 'Another charter.', reason: 'because' })

    const { events } = listEvents(handle.db, { category: 'config' })
    const row = events.find((event) => event.code === 'CONFIG_CHANGED')
    expect(row?.message).toContain('an MCP client')
    await client.close()
  })
})

describe('settings', () => {
  it('refuses a timezone the desk does not know', async () => {
    const client = await connect()
    const { isError } = await call(client, 'set_timezone', { timezone: 'Mars/Olympus' })
    expect(isError).toBe(true)
    await client.close()
  })

  it('sets a real one', async () => {
    const client = await connect()
    const { isError } = await call(client, 'set_timezone', { timezone: 'Europe/Paris' })
    expect(isError).toBe(false)
    expect(JSON.parse((await call(client, 'get_settings')).text).timezone).toBe('Europe/Paris')
    await client.close()
  })
})
