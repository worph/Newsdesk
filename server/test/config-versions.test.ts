import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  ConfigRejected,
  configToYaml,
  getConfigVersion,
  listConfigVersions,
  previewRestore,
  readConfig,
  restoreConfigVersion,
  writeConfig,
} from '../src/config/store.js'
import type { Db } from '../src/db/index.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * The safety net under every configuration change, including the ones the
 * error assistant proposes. What matters is that the snapshot is of the state
 * being replaced rather than the state replacing it, that a refused restore
 * writes nothing at all, and that the one loss a restore cannot undo is said
 * out loud before anyone clicks.
 */

function configWith(db: Db, mutate: (config: ReturnType<typeof readConfig>) => void) {
  const config = readConfig(db)
  mutate(config)
  return config
}

describe('snapshotting a write', () => {
  it('stores the configuration as it was BEFORE the write', () => {
    const { db } = openTestDb()
    seedDesk(db)

    writeConfig(db, configWith(db, (config) => { config.outlets[0]!.name = 'Discord renamed' }), 'ui')

    const versions = listConfigVersions(db)
    expect(versions).toHaveLength(1)
    // The snapshot is the way back, so it must hold the old name, not the new.
    // Read through getConfigVersion: the list omits the document on purpose,
    // and asserting against a field the list does not carry would pass for the
    // wrong reason.
    const stored = getConfigVersion(db, versions[0]!.id)!
    expect(stored.yaml).toContain('Discord')
    expect(stored.yaml).not.toContain('Discord renamed')
    expect(readConfig(db).outlets[0]?.name).toBe('Discord renamed')
  })

  it('mints one version for a change and none for a save that changed nothing', () => {
    const { db } = openTestDb()
    seedDesk(db)

    writeConfig(db, readConfig(db), 'ui')
    expect(listConfigVersions(db)).toHaveLength(1)

    // The Config screen saves the whole document every time it is pressed. A
    // pass over the forms that changed nothing must not look like a change.
    writeConfig(db, readConfig(db), 'ui')
    expect(listConfigVersions(db)).toHaveLength(1)
  })

  /**
   * The id has to come back from the write itself.
   *
   * Reading it afterwards as "the newest row" is wrong in exactly the case the
   * check above creates: a write that changed nothing mints no row, so the
   * newest row belongs to some earlier, unrelated change — and anything that
   * linked to it would be offering an undo of the wrong thing.
   */
  it('returns the id of the version it took, and null when it took none', () => {
    const { db } = openTestDb()
    seedDesk(db)

    const renamed = writeConfig(db, configWith(db, (config) => { config.outlets[0]!.name = 'Renamed' }), 'ui')
    expect(renamed.versionId).toBe(listConfigVersions(db)[0]!.id)

    // What is deduplicated is the snapshot, not the write: this one records
    // the renamed state, which no row holds yet, so it is a version of its own
    // even though it changes nothing.
    const recorded = writeConfig(db, readConfig(db), 'ui')
    expect(recorded.versionId).toBe(listConfigVersions(db)[0]!.id)
    expect(recorded.versionId).not.toBe(renamed.versionId)

    // Now the newest row already says this, so there is nothing to take — and
    // the null is what stops a caller linking an undo to the row above, which
    // belongs to a different change.
    const noop = writeConfig(db, readConfig(db), 'ui')
    expect(noop.versionId).toBeNull()
    expect(listConfigVersions(db)).toHaveLength(2)
  })

  it('records the author and the reason it was given', () => {
    const { db } = openTestDb()
    seedDesk(db)

    writeConfig(
      db,
      configWith(db, (config) => { config.outlets[0]!.enabled = false }),
      'assistant',
      'before remedy 4 — disable the failing outlet',
    )

    expect(listConfigVersions(db)[0]).toMatchObject({
      author: 'assistant',
      reason: 'before remedy 4 — disable the failing outlet',
    })
  })

  it('rolls the snapshot back with the write when the write fails', () => {
    const { db } = openTestDb()
    seedDesk(db)
    db.insert(schema.filings)
      .values({ id: 'f1', stringerId: 'korben', kind: 'timeline', text: 'x', status: 'RECEIVED' })
      .run()

    // Removing a stringer that filings reference is refused by `inUse`.
    expect(() =>
      writeConfig(db, configWith(db, (config) => { config.stringers = [] }), 'ui'),
    ).toThrow(ConfigRejected)

    expect(listConfigVersions(db)).toHaveLength(0)
  })
})

describe('restoring a version', () => {
  it('brings back an outlet that was removed', () => {
    const { db } = openTestDb()
    seedDesk(db)

    const before = configToYaml(readConfig(db))
    writeConfig(db, configWith(db, (config) => { config.outlets = [] }), 'ui')
    expect(readConfig(db).outlets).toHaveLength(0)

    const version = listConfigVersions(db)[0]!
    restoreConfigVersion(db, version.id)

    expect(readConfig(db).outlets).toHaveLength(1)
    expect(configToYaml(readConfig(db))).toBe(before)
  })

  it('snapshots the state it is replacing, so a restore can itself be undone', () => {
    const { db } = openTestDb()
    seedDesk(db)

    writeConfig(db, configWith(db, (config) => { config.outlets[0]!.name = 'Second' }), 'ui')
    const first = listConfigVersions(db)[0]!

    restoreConfigVersion(db, first.id)
    const versions = listConfigVersions(db)

    expect(versions).toHaveLength(2)
    // The newest snapshot says what it was taken ahead of.
    expect(versions[0]?.restoredFromId).toBe(first.id)
    expect(getConfigVersion(db, versions[0]!.id)?.yaml).toContain('Second')
  })

  /**
   * Restoring the version that is already current changes nothing, so no
   * snapshot is taken — and a stamp written to "the newest row" would land on
   * a row some earlier change created, permanently labelling it as the way
   * back from a restore it has nothing to do with. The operator can then click
   * it.
   */
  it('stamps nothing when there was no snapshot to stamp', () => {
    const { db } = openTestDb()
    seedDesk(db)

    // A save that changed nothing: the row it minted holds the state the desk
    // is still in, so restoring it is a no-op and takes no snapshot of its own.
    writeConfig(db, readConfig(db), 'ui')
    const taken = listConfigVersions(db)[0]!
    expect(taken.restoredFromId).toBeNull()

    restoreConfigVersion(db, taken.id)

    const versions = listConfigVersions(db)
    expect(versions).toHaveLength(1)
    // Nothing was taken, so nothing is stamped — and above all the row does not
    // end up naming itself as the thing it was taken ahead of.
    expect(versions[0]!.id).toBe(taken.id)
    expect(versions[0]!.restoredFromId).toBeNull()
  })

  it('is refused, and writes nothing, when it would orphan a publication', () => {
    const { db } = openTestDb()
    seedDesk(db)

    // Add a second outlet, so the snapshot taken here is one WITHOUT it.
    writeConfig(
      db,
      configWith(db, (config) => {
        config.outlets.push({ ...config.outlets[0]!, id: 'discord-two', name: 'Second channel' })
      }),
      'ui',
    )
    const beforeSecondOutlet = listConfigVersions(db)[0]!

    // Something now depends on the outlet that version does not have.
    db.insert(schema.stories)
      .values({ id: 's1', title: 't', summary: 's', status: 'PLACED', dedupVerdict: 'NEW' })
      .run()
    db.insert(schema.publications)
      .values({ id: 'p1', storyId: 's1', outletId: 'discord-two', status: 'PUBLISHED', origin: 'human' })
      .run()

    const versionsBefore = listConfigVersions(db).length
    expect(() => restoreConfigVersion(db, beforeSecondOutlet.id)).toThrow(ConfigRejected)

    // Refused before the transaction opens, so nothing moved — not the
    // configuration, and not the history either.
    expect(readConfig(db).outlets).toHaveLength(2)
    expect(listConfigVersions(db)).toHaveLength(versionsBefore)
  })

  it('reports the refusal on the preview, before anyone clicks', () => {
    const { db } = openTestDb()
    seedDesk(db)

    writeConfig(
      db,
      configWith(db, (config) => {
        config.outlets.push({ ...config.outlets[0]!, id: 'discord-two', name: 'Second channel' })
      }),
      'ui',
    )
    const version = listConfigVersions(db)[0]!

    db.insert(schema.stories)
      .values({ id: 's1', title: 't', summary: 's', status: 'PLACED', dedupVerdict: 'NEW' })
      .run()
    db.insert(schema.publications)
      .values({ id: 'p1', storyId: 's1', outletId: 'discord-two', status: 'PUBLISHED', origin: 'human' })
      .run()

    const preview = previewRestore(db, version.id)!
    expect(preview.issues.length).toBeGreaterThan(0)
    expect(preview.issues.map((issue) => issue.message).join(' ')).toContain('discord-two')
  })
})

describe('the loss a restore cannot undo', () => {
  it('warns that a removed endpoint takes its authorization with it', () => {
    const { db } = openTestDb()
    seedDesk(db)
    db.update(schema.mcpEndpoints)
      .set({ auth: JSON.stringify({ oauth: { accessToken: 'sekrit' } }) })
      .where(eq(schema.mcpEndpoints.id, 'beacon'))
      .run()

    // Snapshot taken while only "beacon" existed, so restoring it would drop
    // the endpoint added after — and that one is connected.
    writeConfig(
      db,
      configWith(db, (config) => {
        config.mcp_endpoints.push({ id: 'other', name: 'Other beacon', url: 'http://other/mcp/' })
      }),
      'ui',
    )
    const beforeOther = listConfigVersions(db)[0]!
    db.update(schema.mcpEndpoints)
      .set({ auth: JSON.stringify({ oauth: { accessToken: 'second-token' } }) })
      .where(eq(schema.mcpEndpoints.id, 'other'))
      .run()

    const preview = previewRestore(db, beforeOther.id)!
    expect(preview.issues).toHaveLength(0)
    // It would go through — which is exactly why the warning has to be here.
    expect(preview.warnings.join(' ')).toContain('Other beacon')
    expect(preview.warnings.join(' ')).toContain('connect it again')
  })

  it('keeps the token on an endpoint that survives the restore', () => {
    const { db } = openTestDb()
    seedDesk(db)
    db.update(schema.mcpEndpoints)
      .set({ auth: JSON.stringify({ oauth: { accessToken: 'sekrit' } }) })
      .where(eq(schema.mcpEndpoints.id, 'beacon'))
      .run()

    writeConfig(db, configWith(db, (config) => { config.outlets[0]!.name = 'Renamed' }), 'ui')
    restoreConfigVersion(db, listConfigVersions(db).at(-1)!.id)

    // The upsert in writeConfig sets only name and url, deliberately — this is
    // what makes an ordinary restore survivable at all.
    const row = db.select().from(schema.mcpEndpoints).where(eq(schema.mcpEndpoints.id, 'beacon')).get()
    expect(row?.auth).toContain('sekrit')
  })

  it('never copies the token into the history', () => {
    const { db } = openTestDb()
    seedDesk(db)
    db.update(schema.mcpEndpoints)
      .set({ auth: JSON.stringify({ oauth: { accessToken: 'sekrit' } }) })
      .where(eq(schema.mcpEndpoints.id, 'beacon'))
      .run()

    writeConfig(db, configWith(db, (config) => { config.outlets[0]!.name = 'Renamed' }), 'ui')

    for (const version of listConfigVersions(db)) {
      expect(version.summary).not.toContain('sekrit')
    }
    const stored = db.select().from(schema.configVersions).all()
    expect(stored.map((row) => row.yaml).join(' ')).not.toContain('sekrit')
  })
})

/**
 * The fields that say how a browser publish finishes have to survive the round
 * trip, because the Configuration screen writes the whole document on every
 * save. A field that read back as absent would silently revert an outlet to
 * `tethered` — or, worse, lose the `requires_human` line that is the only thing
 * standing between a destination and publishing itself.
 */
describe('a browser outlet through the store', () => {
  function asBrowserOutlet(config: ReturnType<typeof readConfig>) {
    const outlet = config.outlets[0]!
    config.browser_engines = [{ id: 'sidecar', name: 'browser', api_base: 'http://browser:9746', viewer: 'novnc' }]
    outlet.driver = 'browser'
    outlet.engine = 'sidecar'
    outlet.tool = undefined
    outlet.endpoint = undefined
    outlet.args = {
      url: 'https://example.test/page',
      body: { slot: 'text', label: 'Post', primary: true },
    }
    outlet.recipe =
      '## Stage\nfill: div.editor <- body\n## Hand over\nPress Post.\n## Verify\nread: a.link -> url'
  }

  it('keeps the mode and the requires-human line across a write and a read', () => {
    const { db } = openTestDb()
    seedDesk(db)

    writeConfig(
      db,
      configWith(db, (config) => {
        asBrowserOutlet(config)
        config.outlets[0]!.publish = 'detached'
        config.outlets[0]!.requires_human = true
      }),
      'ui',
    )

    const outlet = readConfig(db).outlets[0]!
    expect(outlet.publish).toBe('detached')
    expect(outlet.requires_human).toBe(true)
    expect(configToYaml(readConfig(db))).toContain('publish: detached')
  })

  it('leaves an outlet that never declared a mode without one', () => {
    // Absent has to stay absent rather than becoming an explicit `tethered`:
    // the default lives in one function, and a document that grew the field on
    // its own would make every save look like a change.
    const { db } = openTestDb()
    seedDesk(db)

    writeConfig(db, configWith(db, asBrowserOutlet), 'ui')

    const outlet = readConfig(db).outlets[0]!
    expect(outlet.publish).toBeUndefined()
    expect(outlet.requires_human).toBeUndefined()
    expect(configToYaml(readConfig(db))).not.toContain('publish:')
  })
})
