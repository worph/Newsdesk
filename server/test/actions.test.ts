import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { listActions } from '../src/api/actions.js'
import type { Db } from '../src/db/index.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * The action list.
 *
 * What is being tested is an editorial judgement rather than a query: which of
 * these does a person have to do *first*. A screen that got this wrong would be
 * the Queue again — correct, complete, and no help at 09:04 on a phone.
 */

function story(db: Db, title: string, options: { status?: string; createdAt?: string; hold?: string; origin?: string } = {}) {
  const id = randomUUID()
  db.insert(schema.stories)
    .values({
      id,
      title,
      summary: 'A summary.',
      status: options.status ?? 'PLACED',
      dedupVerdict: 'NEW',
      holdReason: options.hold ?? null,
      origin: options.origin ?? 'managing-editor',
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .run()
  return id
}

function publication(
  db: Db,
  storyId: string,
  status: string,
  options: { slots?: Record<string, string>; outletId?: string } = {},
) {
  const id = randomUUID()
  db.insert(schema.publications)
    .values({
      id,
      storyId,
      outletId: options.outletId ?? 'discord-test',
      status,
      origin: 'managing-editor',
      slots: options.slots ? JSON.stringify(options.slots) : null,
      payload: status === 'AWAITING_APPROVAL' ? null : '{}',
    })
    .run()
  return id
}

describe('what needs a person', () => {
  it('puts what is held up above what is merely waiting', () => {
    const { db } = openTestDb()
    seedDesk(db)

    const a = story(db, 'Placed story', { createdAt: '2026-01-01T00:00:00.000Z' })
    const b = story(db, 'Draft story', { createdAt: '2026-01-02T00:00:00.000Z' })
    const c = story(db, 'Signed out story', { createdAt: '2026-01-03T00:00:00.000Z' })
    const d = story(db, 'Due story', { createdAt: '2026-01-04T00:00:00.000Z' })

    publication(db, b, 'AWAITING_APPROVAL', { slots: { description: 'Written.' } })
    publication(db, c, 'NEEDS_AUTH')
    publication(db, d, 'AWAITING_SEND')

    const kinds = listActions(db).map((action) => action.kind)

    // Newest first here, deliberately: age does not outrank being held up. Only
    // story `a` still asks to be placed — the others already have drafts.
    expect(kinds).toEqual(['sign-in', 'publish', 'approve', 'place'])
    expect(listActions(db).slice(0, 2).every((action) => action.overdue)).toBe(true)
    expect(listActions(db).find((action) => action.kind === 'place')!.id).toBe(a)
  })

  it('tells a blank draft from one that is written', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const mine = story(db, 'I started this', { origin: 'desk' })
    const theirs = story(db, 'The writer finished this')

    publication(db, mine, 'AWAITING_APPROVAL', { slots: { description: '   ' } })
    publication(db, theirs, 'AWAITING_APPROVAL', { slots: { description: 'Words.' } })

    const byKind = Object.fromEntries(listActions(db).map((a) => [a.kind, a.title]))
    expect(byKind.write).toBe('I started this')
    expect(byKind.approve).toBe('The writer finished this')
  })

  it('leaves work the writer has not reached alone', () => {
    // A blank draft from the managing editor is queued for the writer, not for
    // a person. Listing it would ask someone to do a job that is about to
    // happen by itself.
    const { db } = openTestDb()
    seedDesk(db)
    publication(db, story(db, 'Writer is on it'), 'AWAITING_APPROVAL')

    expect(listActions(db)).toEqual([])
  })

  it('does not ask you to place a story whose drafts already exist', () => {
    // The same job under two verbs is exactly the noise this screen removes.
    const { db } = openTestDb()
    seedDesk(db)
    const s = story(db, 'Already placed')
    publication(db, s, 'AWAITING_APPROVAL', { slots: { description: 'Written.' } })

    expect(listActions(db).map((a) => a.kind)).toEqual(['approve'])
  })

  it('does not ask you to place a story that has already gone out', () => {
    // Its status is still PLACED — the story lifecycle does not close it — but
    // there is nothing left for a person to do, and finished work on a to-do
    // list is the worst noise of all.
    const { db } = openTestDb()
    seedDesk(db)
    publication(db, story(db, 'Sent yesterday'), 'PUBLISHED')

    expect(listActions(db)).toEqual([])
  })

  it('carries the reason a story is held, because that is the whole ask', () => {
    const { db } = openTestDb()
    seedDesk(db)
    story(db, 'Too thin', { status: 'HELD', hold: 'the filing named no version number' })

    const [action] = listActions(db)
    expect(action).toMatchObject({
      kind: 'answer',
      verb: 'Fill the gap',
      because: 'the filing named no version number',
    })
  })

  it('sends each kind where it can actually be acted on', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const s = story(db, 'One story')
    const id = publication(db, s, 'AWAITING_SEND')

    const [action] = listActions(db)
    // A publish-by-hand wants the browser, not the editor.
    expect(action!.href).toBe(`/review/${id}/live`)
  })

  it('is empty when there is genuinely nothing to do', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const s = story(db, 'Done', { status: 'CLOSED' })
    publication(db, s, 'PUBLISHED')

    expect(listActions(db)).toEqual([])
  })
})
