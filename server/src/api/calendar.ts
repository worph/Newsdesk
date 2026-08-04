import { publishModeOf, type PublishMode } from '@newsdesk/shared'
import { and, eq, gte, lte, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { getTimezone } from '../settings.js'

/**
 * The schedule, past and future, as one list.
 *
 * Planned and published are the same question asked in two tenses — "what does
 * this outlet's week look like" — so they are one query rather than two
 * screens. A row is on the calendar if it has committed to a time or if it
 * actually went out; everything still awaiting a decision belongs on the story
 * it came from, where the decision is made — a backlog is not a calendar.
 */

const range = z.object({
  from: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), 'not a date'),
  to: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), 'not a date'),
})

/** A month view plus its overhanging weeks, with room to spare. */
const MAX_DAYS = 120

export function registerCalendarRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/v1/calendar', { preHandler: requireSession }, async (request, reply) => {
    const parsed = range.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'from and to are required, as dates' })
    }

    const from = new Date(parsed.data.from)
    const to = new Date(parsed.data.to)
    if (to.getTime() < from.getTime()) {
      return reply.code(400).send({ error: 'to is before from' })
    }
    if (to.getTime() - from.getTime() > MAX_DAYS * 24 * 60 * 60_000) {
      return reply.code(422).send({ error: `ask for at most ${MAX_DAYS} days at a time` })
    }

    const start = from.toISOString()
    const end = to.toISOString()

    const rows = db
      .select({
        id: schema.publications.id,
        storyId: schema.publications.storyId,
        storyTitle: schema.stories.title,
        outletId: schema.publications.outletId,
        outletName: schema.outlets.name,
        /**
         * What a browser slot *means* depends on how the outlet finishes, and
         * there are three answers rather than two. Under `auto` it is a send
         * time like any other. Under a hand-over mode it is when the post is put
         * in front of a person, who publishes it whenever they get to it — which
         * may be hours later. Entries that mean different things must not look
         * alike, so both travel with the entry and the mode is resolved here
         * rather than in the web app, which cannot read the shared defaults.
         */
        driver: schema.outlets.driver,
        publish: schema.outlets.publish,
        status: schema.publications.status,
        urgency: schema.publications.urgency,
        scheduledFor: schema.publications.scheduledFor,
        publishedAt: schema.publications.publishedAt,
        error: schema.publications.error,
      })
      .from(schema.publications)
      .leftJoin(schema.stories, eq(schema.publications.storyId, schema.stories.id))
      .leftJoin(schema.outlets, eq(schema.publications.outletId, schema.outlets.id))
      .where(
        or(
          and(gte(schema.publications.scheduledFor, start), lte(schema.publications.scheduledFor, end)),
          and(gte(schema.publications.publishedAt, start), lte(schema.publications.publishedAt, end)),
        ),
      )
      .all()

    /**
     * A published row keeps its scheduled time on the row, so sort and place by
     * what actually happened where that is known. Otherwise the entry would sit
     * on the day it was meant to go out rather than the day it did — a calendar
     * that quietly disagrees with the outlet is worse than no calendar.
     */
    const entries = rows
      .map(({ publish, ...row }) => ({
        ...row,
        mode:
          row.driver === 'browser'
            ? publishModeOf({ publish: (publish ?? undefined) as PublishMode | undefined })
            : null,
        at: row.publishedAt ?? row.scheduledFor,
      }))
      .filter((row): row is typeof row & { at: string } => Boolean(row.at))
      // A post scheduled inside the range but sent just outside it lands on the
      // day it was sent, which may be the next month. Re-filter so the answer
      // always matches the window that was asked for.
      .filter((row) => row.at >= start && row.at <= end)
      .sort((a, b) => a.at.localeCompare(b.at))

    return { entries, timezone: getTimezone(db) }
  })
}
