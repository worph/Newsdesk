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

async function seedOutlet() {
  const { db } = handle
  await db.insert(schema.voices).values({
    id: 'alicia',
    name: 'Alicia',
    tone: 'concise',
    audience: 'self-hosters',
  })
  await db.insert(schema.outlets).values({
    id: 'discord-test',
    name: 'Discord #news-test',
    description: 'test channel',
    voiceId: 'alicia',
    tool: 'discord-mcp__send_embed',
    argsSpec: JSON.stringify({ channelId: '1514993197082742814' }),
  })
  await db.insert(schema.stories).values({
    id: 'story-1',
    title: 'A release',
    summary: 'something shipped',
    status: 'PLACED',
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
      'voices',
      'publications',
      'push_subscriptions',
      'settings',
      'stringers',
      'stories',
      'story_filings',
      'filings',
      'outlets',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('enables WAL and foreign keys', () => {
    expect(String(handle.sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('the story x outlet ledger', () => {
  it('is unique per (story, outlet)', async () => {
    const { db } = handle
    await seedOutlet()
    await db.insert(schema.publications).values({
      id: 'pub-1',
      storyId: 'story-1',
      outletId: 'discord-test',
      status: 'PROPOSED',
      origin: 'managing-editor',
    })
    await expect(
      db.insert(schema.publications).values({
        id: 'pub-2',
        storyId: 'story-1',
        outletId: 'discord-test',
        status: 'PROPOSED',
        origin: 'human',
      }),
    ).rejects.toThrow(/UNIQUE/i)
  })

  it('rejects a publication pointing at an outlet that does not exist', async () => {
    const { db } = handle
    await seedOutlet()
    await expect(
      db.insert(schema.publications).values({
        id: 'pub-3',
        storyId: 'story-1',
        outletId: 'nowhere',
        status: 'PROPOSED',
        origin: 'managing-editor',
      }),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })
})

describe('filings', () => {
  it('accepts two filings carrying the same content — dedup is not a key lookup', async () => {
    const { db } = handle
    await db.insert(schema.stringers).values([
      { id: 'github', name: 'GitHub stringer', kind: 'report' },
      { id: 'korben', name: 'korben', kind: 'timeline' },
    ])
    const text = 'WireGuard Easy Host v15.3.0 shipped'
    await db.insert(schema.filings).values([
      { id: 'sub-1', stringerId: 'github', kind: 'report', text, status: 'RECEIVED' },
      { id: 'sub-2', stringerId: 'korben', kind: 'timeline', text, status: 'RECEIVED' },
    ])
    const rows = await db.select().from(schema.filings)
    expect(rows).toHaveLength(2)
  })
})
