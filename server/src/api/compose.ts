import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'

/**
 * The desk's own byline: a piece you wrote yourself, placed by hand.
 *
 * This is a front door, not a second pipeline. It manufactures exactly the rows
 * the rest of the desk already knows how to publish — one story, one
 * publication per destination — and then gets out of the way: the same review
 * editor, the same copy desk, the same slot spec and char limits, the same
 * payload merge, the same approval gate, the same schedule, the same ledger.
 * Nothing downstream can tell a manual publication from a written one, which is
 * the point. What differs is only who authored the slots.
 *
 * Two rules hold it in place:
 *
 *  1. **No inference on this path.** Not one call. A manual send is what you
 *     reach for when the wire is quiet or the agent is busy or broken, so it
 *     must work with inference entirely unavailable. The copy desk is still
 *     there per destination, but only if you open it.
 *  2. **No copy is authored here.** The publications are created blank and each
 *     one is written on its own review screen, against its own outlet's slots.
 *     Seeding them all from one document would be this file quietly deciding
 *     that every destination takes the same words, which is exactly the
 *     judgement the per-outlet identity exists to make.
 */

const composeBody = z.object({
  title: z.string().min(1),
  /**
   * What this is, in a line. It goes in the desk's record rather than in any
   * post — the copy desk reads it as context, and it is what the managing
   * editor compares against when a stringer files the same thing next week.
   * Falls back to the title rather than being required: a manual send should
   * not open with a form.
   */
  summary: z.string().optional(),
  url: z.string().optional(),
  outlet_ids: z.array(z.string().min(1)).min(1),
  urgency: z.enum(['breaking', 'normal', 'evergreen']).optional(),
})

export function registerComposeRoutes(app: FastifyInstance, db: Db): void {
  app.post('/api/v1/compose', { preHandler: requireSession }, async (request, reply) => {
    const parsed = composeBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'a title and at least one destination are required' })
    }
    const { title, summary, url, urgency } = parsed.data

    // Order is the editor's, duplicates are not a request for two rows — and
    // the unique index on (story, outlet) would refuse them anyway.
    const wanted = [...new Set(parsed.data.outlet_ids)]

    const outlets = db.select().from(schema.outlets).where(inArray(schema.outlets.id, wanted)).all()
    const found = new Map(outlets.map((outlet) => [outlet.id, outlet]))

    const unknown = wanted.filter((id) => !found.has(id))
    if (unknown.length > 0) {
      return reply.code(422).send({ error: `unknown destination(s): ${unknown.join(', ')}` })
    }

    // Refused here rather than at the gate: a disabled outlet cannot be
    // approved, so creating a row you would have to write before discovering
    // that would be the desk wasting your time.
    const disabled = wanted.filter((id) => !found.get(id)?.enabled)
    if (disabled.length > 0) {
      return reply.code(422).send({ error: `switched off: ${disabled.join(', ')}` })
    }

    const storyId = randomUUID()
    const created = wanted.map((outletId) => ({ id: randomUUID(), outletId }))

    db.transaction((tx) => {
      tx.insert(schema.stories)
        .values({
          id: storyId,
          title,
          summary: summary?.trim() || title,
          url: url?.trim() || null,
          // PLACED because it is: you placed it. There is no proposal to accept
          // and no gate to pass at the story level — the decisions live on the
          // publications, one per destination, exactly as they always do.
          status: 'PLACED',
          // NEW without a comparison, because none was made. Saying anything
          // else would put a judgement in the record that nobody formed.
          dedupVerdict: 'NEW',
          dedupReason: 'written at the desk — no wire report to deduplicate',
          origin: 'desk',
          proposedPlacements: null,
        })
        .run()

      for (const publication of created) {
        tx.insert(schema.publications)
          .values({
            id: publication.id,
            storyId,
            outletId: publication.outletId,
            // Open for writing immediately: no writer is coming, so there is
            // nothing for a PROPOSED row to be waiting on. Approval still
            // refuses until the required slots are filled, which is what makes
            // an unwritten destination impossible to send by accident.
            status: 'AWAITING_APPROVAL',
            origin: 'human',
            placementReason: 'written and placed at the desk',
            angle: null,
            slots: null,
            payload: null,
            ...(urgency ? { urgency } : {}),
          })
          .run()
      }
    })

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'COMPOSED',
      storyId,
      message: `wrote "${title}" for ${wanted.length} destination(s): ${wanted.join(', ')}`,
    })

    return reply.code(201).send({
      storyId,
      publications: created.map((publication) => ({
        ...publication,
        outletName: found.get(publication.outletId)?.name ?? publication.outletId,
      })),
    })
  })
}
