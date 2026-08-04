import { asc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'

/**
 * What the desk is waiting on you for, as one list.
 *
 * Stories is the backlog you read when there is time: every story the desk
 * opened, the reason each was placed, the drafts under it. This is the opposite
 * screen — it answers "a notification just went off, what do I press" and
 * nothing else. One line per thing, one verb each, most-overdue first.
 *
 * The ordering is domain judgement rather than presentation, which is why it is
 * decided here: a publication whose slot has already passed is *late*, and a
 * draft nobody has read yet is merely waiting. A screen that mixed those would
 * be the backlog again.
 */

export const ACTION_KINDS = [
  'sign-in',
  'publish',
  'fix',
  'approve',
  'write',
  'place',
  'answer',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export interface DeskAction {
  id: string
  kind: ActionKind
  /** What it is, in a line: the story. */
  title: string
  /** Where it is going, when that is part of the ask. */
  where: string | null
  /** The one thing to press. */
  verb: string
  /** Why you, and why now. One short clause, never a paragraph. */
  because: string
  href: string
  /**
   * The desk is already late for this one — a slot that has passed, or a send
   * that broke. What separates "do this now" from "do this today".
   */
  overdue: boolean
  /** For "waiting since", and for oldest-first inside a band. */
  since: string | null
}

/**
 * Lower sorts first. Bands rather than a score: within a band the tie-break is
 * age, and any finer ranking would be a guess dressed up as a priority.
 */
const RANK: Record<ActionKind, number> = {
  'sign-in': 0,
  publish: 1,
  fix: 2,
  approve: 3,
  write: 4,
  answer: 5,
  place: 6,
}

const OVERDUE: ReadonlySet<ActionKind> = new Set(['sign-in', 'publish', 'fix'])

/** A publication waiting on a person, whatever it is waiting for. */
const OPEN_STATUSES = ['NEEDS_AUTH', 'AWAITING_SEND', 'FAILED', 'AWAITING_APPROVAL']

/** Has the writer — or you — actually put words in it yet? */
function written(slots: string | null): boolean {
  if (!slots) return false
  try {
    return Object.values(JSON.parse(slots) as Record<string, unknown>).some(
      (value) => typeof value === 'string' && value.trim() !== '',
    )
  } catch {
    return false
  }
}

interface PublicationRow {
  id: string
  status: string
  storyTitle: string | null
  storyId: string
  storyOrigin: string | null
  outletName: string | null
  outletId: string
  slots: string | null
  createdAt: string | null
  scheduledFor: string | null
}

/**
 * Is this row waiting on a person, or on the desk?
 *
 * An unwritten draft is normally the writer's job, still queued — putting it
 * here would ask someone to do work that is about to happen by itself. The
 * exception is a piece you started at the desk, which is blank on purpose and
 * will stay blank until you write it.
 */
function needsAPerson(row: PublicationRow): boolean {
  if (row.status !== 'AWAITING_APPROVAL') return true
  return written(row.slots) || row.storyOrigin === 'desk'
}

function publicationAction(row: PublicationRow): DeskAction {
  const where = row.outletName ?? row.outletId
  const title = row.storyTitle ?? row.storyId
  const base = { id: row.id, title, where, since: row.scheduledFor ?? row.createdAt }

  switch (row.status) {
    case 'NEEDS_AUTH':
      return {
        ...base,
        kind: 'sign-in',
        verb: 'Sign in',
        because: `the desk's browser is signed out of ${where}`,
        href: `/review/${row.id}/live`,
        overdue: true,
      }
    case 'AWAITING_SEND':
      return {
        ...base,
        kind: 'publish',
        verb: 'Publish it',
        because: `approved and due — ${where} needs you to press their button`,
        href: `/review/${row.id}/live`,
        overdue: true,
      }
    case 'FAILED':
      return {
        ...base,
        kind: 'fix',
        verb: 'Look at it',
        because: `the send to ${where} failed`,
        href: `/review/${row.id}`,
        overdue: true,
      }
    default:
      return written(row.slots)
        ? {
            ...base,
            kind: 'approve',
            verb: 'Review',
            because: `a draft for ${where} is ready to read`,
            href: `/review/${row.id}`,
            overdue: false,
          }
        : {
            ...base,
            kind: 'write',
            verb: 'Write it',
            because: `${where} is blank — you started this one yourself`,
            href: `/review/${row.id}`,
            overdue: false,
          }
  }
}

export function listActions(db: Db, limit = 100): DeskAction[] {
  const publications = db
    .select({
      id: schema.publications.id,
      status: schema.publications.status,
      storyId: schema.publications.storyId,
      storyTitle: schema.stories.title,
      outletId: schema.publications.outletId,
      outletName: schema.outlets.name,
      storyOrigin: schema.stories.origin,
      slots: schema.publications.slots,
      scheduledFor: schema.publications.scheduledFor,
      createdAt: schema.stories.createdAt,
    })
    .from(schema.publications)
    .leftJoin(schema.stories, eq(schema.publications.storyId, schema.stories.id))
    .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))
    .where(inArray(schema.publications.status, OPEN_STATUSES))
    .orderBy(asc(schema.stories.createdAt))
    .all()

  const stories = db
    .select({
      id: schema.stories.id,
      title: schema.stories.title,
      status: schema.stories.status,
      holdReason: schema.stories.holdReason,
      createdAt: schema.stories.createdAt,
    })
    .from(schema.stories)
    .where(inArray(schema.stories.status, ['PLACED', 'HELD']))
    .orderBy(asc(schema.stories.createdAt))
    .all()

  const live = publications.filter(needsAPerson)

  /**
   * A story whose destinations already exist has nothing left to place — the
   * drafts are the work now, and listing both would put the same job on the
   * screen twice under two different verbs. That is precisely the noise this
   * screen exists to remove; the story page still shows every placement in full.
   *
   * Every publication counts, not just the open ones: a story whose pieces have
   * all gone out is the most settled case there is, and asking to place it
   * again would be the screen's worst kind of noise — work that is finished.
   */
  const placed = new Set(
    db
      .selectDistinct({ storyId: schema.publications.storyId })
      .from(schema.publications)
      .all()
      .map((row) => row.storyId),
  )

  const actions: DeskAction[] = [
    ...live.map(publicationAction),
    ...stories
      .filter((story) => story.status === 'HELD' || !placed.has(story.id))
      .map((story) => ({
        id: story.id,
        title: story.title,
        where: null,
        since: story.createdAt,
        overdue: false,
        ...(story.status === 'HELD'
          ? {
              kind: 'answer' as const,
              verb: 'Fill the gap',
              // A held story is a question the desk could not answer for
              // itself, so the reason is the whole point of the row.
              because: story.holdReason ?? 'the filing was too thin to write from',
              href: `/stories/${story.id}`,
            }
          : {
              kind: 'place' as const,
              verb: 'Place it',
              because: 'the managing editor proposed where this runs',
              href: `/stories/${story.id}`,
            }),
      })),
  ]

  return actions
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.since ?? '').localeCompare(b.since ?? ''))
    .slice(0, limit)
}

export function registerActionRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/v1/actions', { preHandler: requireSession }, async () => {
    const actions = listActions(db)
    return {
      actions,
      /**
       * Counted here so the sidebar badge and this screen can never disagree —
       * a badge saying 3 over a list showing 2 is worse than no badge.
       */
      total: actions.length,
      overdue: actions.filter((action) => action.overdue).length,
    }
  })
}

export { OVERDUE }
