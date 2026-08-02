import { describe, expect, it } from 'vitest'
import {
  categoryOf,
  codesInCategory,
  EVENT_CODES,
  isAssistable,
  listEvents,
  logEvent,
  logEventReturning,
  type EventCode,
} from '../src/events.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * The event vocabulary is what the Log screen filters on and what the error
 * assistant is handed, so the properties worth pinning are the ones a future
 * code addition could quietly break: that every code lands in a bucket, that
 * history written before the table existed is still findable, and that a
 * failing log write can never take down the operation it was observing.
 */

describe('the code table', () => {
  it('puts every declared code in a real category', () => {
    for (const code of Object.keys(EVENT_CODES) as EventCode[]) {
      expect(categoryOf(code), code).not.toBe('other')
    }
  })

  it('accounts for every code exactly once across the categories', () => {
    const categories = new Set(Object.values(EVENT_CODES).map((spec) => spec.category))
    const covered = [...categories].flatMap((category) => codesInCategory(category))
    expect(covered.sort()).toEqual((Object.keys(EVENT_CODES) as EventCode[]).sort())
  })

  it('keeps the dotted legacy codes, because stored rows carry them', () => {
    expect(categoryOf('mcp.oauth.failed')).toBe('ports')
    expect(isAssistable('mcp.oauth.failed')).toBe(true)
  })

  it('offers the assistant only where something could be remedied', () => {
    expect(isAssistable('PUBLISH_FAILED')).toBe(true)
    // A warn with no cause to fix: nobody registered a device, and a Fix
    // button here would teach people to ignore the one that matters.
    expect(isAssistable('PUSH_NO_DEVICES')).toBe(false)
    expect(isAssistable('PUBLISHED')).toBe(false)
  })
})

describe('a code the table has never heard of', () => {
  it('falls into a bucket rather than disappearing', () => {
    expect(categoryOf('STORY_SOMETHING_NEW')).toBe('pipeline')
    expect(categoryOf('WHAT_IS_THIS')).toBe('other')
  })

  it('is still returned by an unfiltered query', () => {
    const { db } = openTestDb()
    db.insert(schema.events)
      .values({ level: 'info', actor: 'system', code: 'LEGACY_CODE', message: 'written by an older build' })
      .run()

    expect(listEvents(db).events.map((row) => row.code)).toContain('LEGACY_CODE')
  })
})

describe('writing an event', () => {
  it('stores the message and the detail apart', () => {
    const { db } = openTestDb()
    logEvent(db, {
      level: 'error',
      code: 'JOB_FAILED',
      message: 'a publish job gave up after 3 attempts',
      detail: { jobId: 'job-1', kind: 'publish', refId: 'pub-1', attempts: 3, error: 'HTTP 401' },
    })

    const row = listEvents(db).events[0]
    expect(row?.message).toBe('a publish job gave up after 3 attempts')
    // The technical payload is in detail and nowhere else — this is the split
    // the whole log depends on.
    expect(row?.message).not.toContain('401')
    expect(row?.detail).toMatchObject({ error: 'HTTP 401', attempts: 3 })
    expect(row?.category).toBe('queue')
    expect(row?.assistable).toBe(true)
  })

  it('returns the row id, which is what links a remedy to its own apply', () => {
    const { db } = openTestDb()
    const id = logEventReturning(db, {
      level: 'info',
      code: 'STORY_RERUN',
      message: 'you re-queued 2 filings',
    })

    expect(id).toBeTypeOf('number')
    expect(listEvents(db).events[0]?.id).toBe(id)
  })

  it('never throws, so a locked database cannot fail the work it was observing', () => {
    const { db, sqlite } = openTestDb()
    sqlite.close()

    expect(() =>
      logEvent(db, { level: 'info', code: 'PUBLISHED', message: 'sent to Discord' }),
    ).not.toThrow()
    expect(logEventReturning(db, { level: 'info', code: 'PUBLISHED', message: 'sent to Discord' })).toBeNull()
  })
})

describe('filtering the log', () => {
  function seedLevels(db: ReturnType<typeof openTestDb>['db']) {
    logEvent(db, { level: 'debug', code: 'JOB_DEFERRED', message: 'a publish job is waiting its turn',
      detail: { jobId: 'j', kind: 'publish', refId: 'r', retryInSeconds: 30, reason: 'busy' } })
    logEvent(db, { level: 'info', code: 'PUBLISHED', message: 'sent to Discord' })
    logEvent(db, { level: 'warn', code: 'PUSH_NO_DEVICES', message: 'no device is registered' })
    logEvent(db, { level: 'error', code: 'PUBLISH_FAILED', message: 'could not send to Discord',
      detail: { outletId: 'discord-test', outletName: 'Discord', driver: 'mcp', error: 'HTTP 401' } })
  }

  it('reads minLevel as "this and worse", not "exactly this"', () => {
    const { db } = openTestDb()
    seedLevels(db)

    const levels = listEvents(db, { minLevel: 'warn' }).events.map((row) => row.level)
    expect(levels.sort()).toEqual(['error', 'warn'])
    expect(levels).not.toContain('info')
  })

  it('still supports an exact level, which is what the old callers asked for', () => {
    const { db } = openTestDb()
    seedLevels(db)
    expect(listEvents(db, { level: 'warn' }).events).toHaveLength(1)
  })

  it('filters by category through the code table', () => {
    const { db } = openTestDb()
    seedLevels(db)

    const delivery = listEvents(db, { category: 'delivery' }).events.map((row) => row.code)
    expect(delivery.sort()).toEqual(['PUBLISHED', 'PUBLISH_FAILED'])
  })

  it('searches the human sentence, which is the only part that is prose', () => {
    const { db } = openTestDb()
    seedLevels(db)
    expect(listEvents(db, { q: 'Discord' }).events).toHaveLength(2)
  })
})

describe('paging the log', () => {
  it('walks backwards by id without skipping or repeating a row', () => {
    const { db } = openTestDb()
    for (let i = 0; i < 10; i++) {
      logEvent(db, { level: 'info', code: 'PUBLISHED', message: `sent to outlet ${i}` })
    }

    const first = listEvents(db, { limit: 4 })
    expect(first.events).toHaveLength(4)
    expect(first.nextCursor).toBe(first.events[3]?.id)

    const second = listEvents(db, { limit: 4, before: first.nextCursor! })
    expect(second.events.map((row) => row.id)).not.toContain(first.events[3]?.id)

    const seen = [...first.events, ...second.events].map((row) => row.id)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('reports no cursor on the last page', () => {
    const { db } = openTestDb()
    logEvent(db, { level: 'info', code: 'PUBLISHED', message: 'sent to Discord' })
    expect(listEvents(db, { limit: 10 }).nextCursor).toBeNull()
  })

  /**
   * A row written while someone is paging must not shift the window. Paging on
   * `at` would; paging on the id cannot, which is the whole reason for it.
   */
  it('is not disturbed by a row written mid-scan', () => {
    const { db } = openTestDb()
    for (let i = 0; i < 6; i++) {
      logEvent(db, { level: 'info', code: 'PUBLISHED', message: `sent ${i}` })
    }

    const first = listEvents(db, { limit: 3 })
    logEvent(db, { level: 'info', code: 'PUBLISHED', message: 'sent while paging' })
    const second = listEvents(db, { limit: 3, before: first.nextCursor! })

    expect(second.events.map((row) => row.message)).not.toContain('sent while paging')
    expect(second.events).toHaveLength(3)
  })
})

describe('the entities on a row', () => {
  it('resolves the story title and the outlet name', () => {
    const { db } = openTestDb()
    seedDesk(db)
    db.insert(schema.stories)
      .values({
        id: 'story-1',
        title: 'Aptero 1.4 released',
        summary: 'A release.',
        status: 'PLACED',
        dedupVerdict: 'NEW',
      })
      .run()
    db.insert(schema.publications)
      .values({ id: 'pub-1', storyId: 'story-1', outletId: 'discord-test', status: 'PUBLISHED', origin: 'managing-editor' })
      .run()

    logEvent(db, {
      level: 'info',
      code: 'PUBLISHED',
      storyId: 'story-1',
      publicationId: 'pub-1',
      message: 'sent to Discord',
    })

    const row = listEvents(db).events[0]
    expect(row?.storyTitle).toBe('Aptero 1.4 released')
    expect(row?.outletName).toBe('Discord')
    expect(row?.outletId).toBe('discord-test')
  })

  /**
   * `events.story_id` carries no foreign key, so a row can outlive what it
   * points at. The screen must still have the id to show — an event that
   * renders blank is worse than one that renders ugly.
   */
  it('keeps the id when the story it points at is gone', () => {
    const { db } = openTestDb()
    logEvent(db, {
      level: 'info',
      code: 'STORY_SPIKED',
      storyId: 'story-that-never-existed',
      message: '"Something" was opened but placed nowhere',
    })

    const row = listEvents(db).events[0]
    expect(row?.storyId).toBe('story-that-never-existed')
    expect(row?.storyTitle).toBeNull()
  })
})
