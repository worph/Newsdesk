import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'
import { openDb, runMigrations, schema, type Db } from '../src/db/index.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

/**
 * A migrated database on disk, cleaned up when the test finishes.
 *
 * On disk rather than in memory because WAL, foreign keys and the transaction
 * behaviour the pipeline relies on are what we want under test — an in-memory
 * database would quietly exercise something else.
 */
export function openTestDb(): { db: Db; sqlite: ReturnType<typeof openDb>['sqlite'] } {
  const dir = mkdtempSync(join(tmpdir(), 'newsdesk-test-'))
  const handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)

  onTestFinished(() => {
    handle.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  return handle
}

/** The minimum configuration the managing editor needs: a charter, a voice, a target, a source. */
export function seedDesk(db: Db, overrides: { charter?: string } = {}): void {
  db.insert(schema.charter)
    .values({
      text: overrides.charter ?? 'Self-hosting, privacy and homelab news goes to Discord.',
      author: 'test',
    })
    .run()

  db.insert(schema.mcpEndpoints).values({ id: 'beacon', name: 'beacon', url: 'http://beacon/mcp/' }).run()

  db.insert(schema.voices)
    .values({
      id: 'alicia',
      name: 'Alicia',
      tone: 'concise, technical, anti-hype',
      audience: 'self-hosters running a personal cloud',
      rules: null,
      examples: null,
    })
    .run()

  db.insert(schema.stringers)
    .values({ id: 'korben', name: 'korben.info', kind: 'timeline', enabled: true, hint: 'self-hosting only' })
    .run()

  db.insert(schema.targets)
    .values({
      id: 'discord-test',
      name: 'Discord',
      description: 'Test channel for self-hosters: releases and curated links.',
      role: 'publish',
      driver: 'mcp',
      enabled: true,
      voiceId: 'alicia',
      endpointId: 'beacon',
      tool: 'discord-mcp__send_embed',
      destinationKey: null,
      argsSpec: JSON.stringify({
        channelId: '1514993197082742814',
        timestamp: true,
        footer: '{{story.url}}',
        title: { slot: 'text', label: 'Headline', max: 256, optional: false, primary: false },
        description: { slot: 'markdown', label: 'Body', max: 4096, optional: false, primary: true },
      }),
    })
    .run()
}

export { schema }
