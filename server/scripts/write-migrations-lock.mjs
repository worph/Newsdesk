// Records the migrations that have shipped, so test/migrations.test.ts can
// refuse a rewrite of one. Run it (npm run db:lock --workspace server) after
// generating a NEW migration; if it wants to change an entry that is already
// there, that is the guard working — add a migration instead of editing one.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8'))

const lock = {
  comment:
    'Shipped migrations are immutable: drizzle decides what to apply from the journal timestamp alone, so rewriting one makes every existing database re-run it. Append new migrations; never edit these.',
  migrations: journal.entries.map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    sha256: createHash('sha256')
      .update(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf8'))
      .digest('hex'),
  })),
}

writeFileSync(join(drizzleDir, 'migrations.lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
console.log(`locked ${lock.migrations.length} migration(s)`)
