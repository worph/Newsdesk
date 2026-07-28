import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, schema } from '../src/db/index.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

let dir: string
let handle: ReturnType<typeof openDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsdesk-test-'))
  handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)
})

afterEach(() => {
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

async function seedTarget() {
  const { db } = handle
  await db.insert(schema.personas).values({
    id: 'alicia',
    name: 'Alicia',
    voice: 'concise',
    audience: 'self-hosters',
  })
  await db.insert(schema.targets).values({
    id: 'discord-test',
    name: 'Discord #news-test',
    description: 'test channel',
    personaId: 'alicia',
    tool: 'discord-mcp__send_embed',
    argsSpec: JSON.stringify({ channelId: '1514993197082742814' }),
  })
  await db.insert(schema.stories).values({
    id: 'story-1',
    title: 'A release',
    summary: 'something shipped',
    status: 'ROUTED',
    dedupVerdict: 'NEW',
  })
}

describe('migrations', () => {
  it('applies cleanly and creates every table', () => {
    const names = handle.sqlite
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r: any) => r.name as string)
    for (const expected of [
      'charter',
      'chat_messages',
      'draft_versions',
      'events',
      'inference_calls',
      'jobs',
      'mcp_endpoints',
      'personas',
      'publications',
      'push_subscriptions',
      'settings',
      'sources',
      'stories',
      'story_submissions',
      'submissions',
      'targets',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('enables WAL and foreign keys', () => {
    expect(String(handle.sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('the story x target ledger', () => {
  it('is unique per (story, target)', async () => {
    const { db } = handle
    await seedTarget()
    await db.insert(schema.publications).values({
      id: 'pub-1',
      storyId: 'story-1',
      targetId: 'discord-test',
      status: 'PROPOSED',
      origin: 'director',
    })
    await expect(
      db.insert(schema.publications).values({
        id: 'pub-2',
        storyId: 'story-1',
        targetId: 'discord-test',
        status: 'PROPOSED',
        origin: 'human',
      }),
    ).rejects.toThrow(/UNIQUE/i)
  })

  it('rejects a publication pointing at a target that does not exist', async () => {
    const { db } = handle
    await seedTarget()
    await expect(
      db.insert(schema.publications).values({
        id: 'pub-3',
        storyId: 'story-1',
        targetId: 'nowhere',
        status: 'PROPOSED',
        origin: 'director',
      }),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })
})

describe('submissions', () => {
  it('accepts two submissions carrying the same content — dedup is not a key lookup', async () => {
    const { db } = handle
    await db.insert(schema.sources).values([
      { id: 'github', name: 'GitHub stringer', kind: 'report' },
      { id: 'korben', name: 'korben', kind: 'timeline' },
    ])
    const text = 'WireGuard Easy Host v15.3.0 shipped'
    await db.insert(schema.submissions).values([
      { id: 'sub-1', sourceId: 'github', kind: 'report', text, status: 'RECEIVED' },
      { id: 'sub-2', sourceId: 'korben', kind: 'timeline', text, status: 'RECEIVED' },
    ])
    const rows = await db.select().from(schema.submissions)
    expect(rows).toHaveLength(2)
  })
})
