import { randomUUID } from 'node:crypto'
import type { ArgsSpec } from '@newsdesk/shared'
import { asc, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import { listChat, runCopyDesk } from '../pipeline/copy-desk.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { mergePayload, PayloadIncomplete, previewPayload } from '../render/payload.js'
import { authoringKeys } from '../schema/slots.js'

/**
 * The gate. `approve` is the only path to the wire, and it freezes the merged
 * payload onto the row before anything is queued — so what is sent is exactly
 * what was approved, and a retry re-sends those bytes rather than rebuilding
 * them.
 */

const slotsBody = z.object({ slots: z.record(z.string(), z.string()) })
const rejectBody = z.object({ reason: z.string().min(1).optional() })
const revertBody = z.object({ version_id: z.string().min(1) })

interface Loaded {
  publication: typeof schema.publications.$inferSelect
  story: typeof schema.stories.$inferSelect
  target: typeof schema.targets.$inferSelect
  args: ArgsSpec
}

function load(db: Db, id: string): Loaded | undefined {
  const publication = db.select().from(schema.publications).where(eq(schema.publications.id, id)).get()
  if (!publication) return undefined
  const story = db.select().from(schema.stories).where(eq(schema.stories.id, publication.storyId)).get()
  const target = db.select().from(schema.targets).where(eq(schema.targets.id, publication.targetId)).get()
  if (!story || !target) return undefined
  return { publication, story, target, args: JSON.parse(target.argsSpec) as ArgsSpec }
}

function slotsOf(publication: typeof schema.publications.$inferSelect): Record<string, string> {
  return publication.slots ? (JSON.parse(publication.slots) as Record<string, string>) : {}
}

function mergeContext(loaded: Loaded, slots: Record<string, string>) {
  return {
    story: {
      id: loaded.story.id,
      title: loaded.story.title,
      summary: loaded.story.summary,
      url: loaded.story.url,
    },
    slots,
  }
}

export function registerPublicationRoutes(
  app: FastifyInstance,
  db: Db,
  enqueuePublish?: (publicationId: string) => void,
  driver?: () => InferenceDriver,
): void {
  app.get('/api/v1/publications/:id/chat', { preHandler: requireSession }, async (request) => {
    const { id } = request.params as { id: string }
    return { messages: listChat(db, id) }
  })

  /**
   * One turn with the copy desk. It returns a reply and the whole updated
   * draft, which replaces the slots wholesale — a partial patch would silently
   * drop whatever it left out.
   */
  app.post('/api/v1/publications/:id/chat', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ message: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'message required' })
    if (!driver) return reply.code(503).send({ error: 'no inference is wired on this instance' })

    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    if (loaded.publication.status === 'PUBLISHED') {
      return reply.code(409).send({ error: 'this has already been published' })
    }

    try {
      const result = await runCopyDesk(db, driver(), id, parsed.data.message)
      return result
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/v1/publications/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })

    const slots = slotsOf(loaded.publication)
    const preview = previewPayload(loaded.args, mergeContext(loaded, slots))

    // Sibling routes: the review surface must make it unmistakable that
    // approving one destination does not ship the others.
    const siblings = db
      .select({
        id: schema.publications.id,
        targetId: schema.publications.targetId,
        status: schema.publications.status,
      })
      .from(schema.publications)
      .where(eq(schema.publications.storyId, loaded.publication.storyId))
      .all()

    return {
      publication: { ...loaded.publication, slots },
      story: loaded.story,
      target: {
        id: loaded.target.id,
        name: loaded.target.name,
        description: loaded.target.description,
        role: loaded.target.role,
        driver: loaded.target.driver,
        tool: loaded.target.tool,
      },
      // Only the authoring slots are reviewable; literals and derived values
      // appear in the payload preview instead.
      slotSpec: Object.fromEntries(
        authoringKeys(loaded.args).map((key) => [key, loaded.args[key]]),
      ),
      preview,
      siblings,
    }
  })

  app.get('/api/v1/publications/:id/versions', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const versions = db
      .select()
      .from(schema.draftVersions)
      .where(eq(schema.draftVersions.publicationId, id))
      // Insertion order: several versions can share a millisecond, and a
      // random-UUID tiebreaker would shuffle the history.
      .orderBy(sql`rowid desc`)
      .all()
    return reply.send({ versions: versions.map((v) => ({ ...v, slots: JSON.parse(v.slots) })) })
  })

  app.get('/api/v1/publications/:id/payload', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })

    // Once frozen, show the frozen bytes — not a fresh merge that might differ.
    if (loaded.publication.payload) {
      return { payload: JSON.parse(loaded.publication.payload), frozen: true }
    }
    const preview = previewPayload(loaded.args, mergeContext(loaded, slotsOf(loaded.publication)))
    return { ...preview, frozen: false }
  })

  /** Save edited slots. Every save is a version, so nothing is ever lost. */
  app.patch('/api/v1/publications/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = slotsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'slots required' })

    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    if (loaded.publication.status === 'PUBLISHED') {
      return reply.code(409).send({ error: 'this has already been published' })
    }

    // Only declared slots may be written: a key outside the spec would be an
    // argument configuration never offered.
    const allowed = new Set(authoringKeys(loaded.args))
    const unknown = Object.keys(parsed.data.slots).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      return reply.code(422).send({ error: `not authoring slots: ${unknown.join(', ')}` })
    }

    const slots = { ...slotsOf(loaded.publication), ...parsed.data.slots }
    const versionId = randomUUID()

    db.transaction((tx) => {
      tx.insert(schema.draftVersions)
        .values({ id: versionId, publicationId: id, slots: JSON.stringify(slots), origin: 'human' })
        .run()
      tx.update(schema.publications)
        .set({ slots: JSON.stringify(slots) })
        .where(eq(schema.publications.id, id))
        .run()
    })

    return { slots, versionId }
  })

  app.post('/api/v1/publications/:id/revert', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = revertBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'version_id required' })

    const version = db
      .select()
      .from(schema.draftVersions)
      .where(eq(schema.draftVersions.id, parsed.data.version_id))
      .get()
    if (!version || version.publicationId !== id) {
      return reply.code(404).send({ error: 'no such version for this publication' })
    }

    const versionId = randomUUID()
    db.transaction((tx) => {
      // Reverting appends rather than rewinds: the history stays append-only.
      tx.insert(schema.draftVersions)
        .values({ id: versionId, publicationId: id, slots: version.slots, origin: 'human' })
        .run()
      tx.update(schema.publications)
        .set({ slots: version.slots })
        .where(eq(schema.publications.id, id))
        .run()
    })

    return { slots: JSON.parse(version.slots), versionId }
  })

  /**
   * The gate. Freezes the merged payload and queues the send. Nothing else in
   * the system may move a publication to PUBLISHED.
   */
  app.post('/api/v1/publications/:id/approve', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })

    if (loaded.publication.status === 'PUBLISHED') {
      return reply.code(409).send({ error: 'this has already been published' })
    }
    if (loaded.publication.status === 'REJECTED') {
      return reply.code(409).send({ error: 'this was spiked — reopen it before approving' })
    }
    if (!loaded.target.enabled) {
      return reply.code(422).send({ error: `target "${loaded.target.id}" is disabled` })
    }

    let payload: Record<string, unknown>
    try {
      payload = mergePayload(loaded.args, mergeContext(loaded, slotsOf(loaded.publication)))
    } catch (err) {
      if (err instanceof PayloadIncomplete) {
        return reply.code(422).send({ error: err.message, missing: err.missing })
      }
      throw err
    }

    db.update(schema.publications)
      .set({
        status: 'APPROVED',
        // Frozen here and sent verbatim. This is what makes publish idempotent
        // and retry safe, and it is why no inference runs after this point.
        payload: JSON.stringify(payload),
        approvedAt: new Date().toISOString(),
        error: null,
      })
      .where(eq(schema.publications.id, id))
      .run()

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'APPROVED',
      storyId: loaded.publication.storyId,
      publicationId: id,
      message: `approved for ${loaded.target.name}`,
      detail: { payload },
    })

    if (enqueuePublish) enqueuePublish(id)

    return reply.code(202).send({ status: 'APPROVED', payload, queued: Boolean(enqueuePublish) })
  })

  app.post('/api/v1/publications/:id/reject', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = rejectBody.safeParse(request.body ?? {})
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    if (loaded.publication.status === 'PUBLISHED') {
      return reply.code(409).send({ error: 'this has already been published' })
    }

    const reason = parsed.success ? parsed.data.reason : undefined

    // A switched-off proposal leaves a REJECTED row rather than disappearing:
    // that row is half of the override diff.
    db.update(schema.publications)
      .set({ status: 'REJECTED', error: reason ?? null })
      .where(eq(schema.publications.id, id))
      .run()

    logEvent(db, {
      level: 'info',
      actor: 'human',
      code: 'ROUTE_REJECTED',
      storyId: loaded.publication.storyId,
      publicationId: id,
      message: `spiked for ${loaded.target.name}${reason ? `: ${reason}` : ''}`,
    })

    return { status: 'REJECTED' }
  })

  /** Re-send the frozen payload after a delivery failure. No re-merge. */
  app.post('/api/v1/publications/:id/retry', { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = load(db, id)
    if (!loaded) return reply.code(404).send({ error: 'no such publication' })
    if (!loaded.publication.payload) {
      return reply.code(422).send({ error: 'nothing was ever approved for this destination' })
    }
    if (loaded.publication.status === 'PUBLISHED') {
      return reply.code(409).send({ error: 'this has already been published' })
    }
    if (!enqueuePublish) return reply.code(503).send({ error: 'no publisher is wired on this instance' })

    enqueuePublish(id)
    return reply.code(202).send({ queued: true })
  })

  app.get('/api/v1/publications', { preHandler: requireSession }, async (request) => {
    const query = z
      .object({ status: z.string().optional(), limit: z.coerce.number().int().positive().max(200).optional() })
      .safeParse(request.query)

    const status = query.success ? query.data.status : undefined
    const base = db
      .select({
        id: schema.publications.id,
        storyId: schema.publications.storyId,
        storyTitle: schema.stories.title,
        targetId: schema.publications.targetId,
        targetName: schema.targets.name,
        status: schema.publications.status,
        origin: schema.publications.origin,
        routeReason: schema.publications.routeReason,
        approvedAt: schema.publications.approvedAt,
        publishedAt: schema.publications.publishedAt,
        error: schema.publications.error,
      })
      .from(schema.publications)
      .leftJoin(schema.stories, eq(schema.publications.storyId, schema.stories.id))
      .leftJoin(schema.targets, eq(schema.publications.targetId, schema.targets.id))

    const rows = (status ? base.where(eq(schema.publications.status, status.toUpperCase())) : base)
      .orderBy(asc(schema.publications.approvedAt))
      .limit(query.success ? (query.data.limit ?? 100) : 100)
      .all()

    return { publications: rows }
  })
}
