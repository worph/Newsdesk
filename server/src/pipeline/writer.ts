import { randomUUID } from 'node:crypto'
import type { ArgsSpec } from '@newsdesk/shared'
import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import { runStructured } from '../ports/inference/structured.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { fillPrompt, loadPrompt } from '../prompts/load.js'
import { notifyDraftReady } from '../push.js'
import { slotsShapeHint, slotsZodSchema } from '../schema/slots.js'

/**
 * One draft per publication — per story AND per target, because a story
 * running in two places is two pieces of writing, two chat threads and two
 * independent decisions.
 *
 * The writer fills declared slots and nothing else. It never sees the
 * destination, never assembles the payload, and its output becomes a database
 * row that a human still has to approve.
 */

export interface DraftContext {
  prompt: string
  args: ArgsSpec
}

function renderVoice(db: Db, voiceId: string | null): string {
  if (!voiceId) return '(no voice configured — write plainly and factually)'
  const voice = db.select().from(schema.voices).where(eq(schema.voices.id, voiceId)).get()
  if (!voice) return '(voice missing — write plainly and factually)'

  return [
    `name: ${voice.name}`,
    `tone: ${voice.tone}`,
    `audience: ${voice.audience}`,
    ...(voice.rules ? ['', 'rules:', voice.rules.trim()] : []),
    ...(voice.examples ? ['', 'examples:', voice.examples.trim()] : []),
  ].join('\n')
}

function renderMaterial(db: Db, storyId: string): string {
  const links = db
    .select()
    .from(schema.storySubmissions)
    .where(eq(schema.storySubmissions.storyId, storyId))
    .all()

  if (links.length === 0) return '(no source material was kept for this story)'

  const submissions = db
    .select()
    .from(schema.submissions)
    .where(inArray(schema.submissions.id, links.map((l) => l.submissionId)))
    .all()

  return submissions
    .map((submission) => `--- filed by ${submission.stringerId} ---\n${submission.considered ?? submission.text}`)
    .join('\n\n')
}

export function buildDraftContext(db: Db, publicationId: string): DraftContext {
  const publication = db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, publicationId))
    .get()
  if (!publication) throw new Error(`publication "${publicationId}" not found`)

  const story = db.select().from(schema.stories).where(eq(schema.stories.id, publication.storyId)).get()
  if (!story) throw new Error(`story "${publication.storyId}" not found`)

  const target = db.select().from(schema.targets).where(eq(schema.targets.id, publication.targetId)).get()
  if (!target) throw new Error(`target "${publication.targetId}" not found`)

  const args = JSON.parse(target.argsSpec) as ArgsSpec

  const related = story.relatedStoryId
    ? db.select().from(schema.stories).where(eq(schema.stories.id, story.relatedStoryId)).get()
    : undefined

  const prompt = fillPrompt(loadPrompt('writer'), {
    VOICE: renderVoice(db, target.voiceId),
    TARGET: [`name: ${target.name}`, '', target.description.trim()].join('\n'),
    STORY: [
      `title: ${story.title}`,
      ...(story.url ? [`url: ${story.url}`] : []),
      '',
      story.summary,
    ].join('\n'),
    RELATED:
      related && story.dedupVerdict === 'UPDATE'
        ? [
            '',
            '### This story follows on from an earlier one',
            '',
            `title: ${related.title}`,
            related.summary,
            '',
            'Write it as a follow-up: assume the earlier piece was read, and lead with what is new.',
          ].join('\n')
        : '',
    ANGLE: publication.angle?.trim() || '(no specific angle — lead with what matters most to this audience)',
    MATERIAL: renderMaterial(db, publication.storyId),
    SLOTS: slotsShapeHint(args),
  })

  return { prompt, args }
}

export interface DraftResult {
  slots: Record<string, string>
  versionId: string
}

/** Run the writer for one publication and store the draft as a version. */
export async function draftPublication(
  db: Db,
  driver: InferenceDriver,
  publicationId: string,
): Promise<DraftResult> {
  const context = buildDraftContext(db, publicationId)

  db.update(schema.publications)
    .set({ status: 'DRAFTING' })
    .where(eq(schema.publications.id, publicationId))
    .run()

  let slots: Record<string, string>
  try {
    slots = await runStructured(db, driver, {
      purpose: 'writer',
      refId: publicationId,
      prompt: context.prompt,
      schema: slotsZodSchema(context.args),
      shapeHint: slotsShapeHint(context.args),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.update(schema.publications)
      .set({ status: 'FAILED', error: message })
      .where(eq(schema.publications.id, publicationId))
      .run()
    logEvent(db, {
      level: 'error',
      code: 'DRAFT_FAILED',
      publicationId,
      message: `the writer could not produce a usable draft: ${message}`,
    })
    throw err
  }

  const versionId = randomUUID()
  db.transaction((tx) => {
    tx.insert(schema.draftVersions)
      .values({ id: versionId, publicationId, slots: JSON.stringify(slots), origin: 'writer' })
      .run()
    tx.update(schema.publications)
      .set({ slots: JSON.stringify(slots), status: 'AWAITING_APPROVAL', error: null })
      .where(eq(schema.publications.id, publicationId))
      .run()
  })

  logEvent(db, {
    level: 'info',
    code: 'DRAFT_READY',
    publicationId,
    message: 'a draft is waiting for approval',
  })

  // Best-effort: a push that cannot go out must never fail the draft that is
  // already safely stored.
  const written = db
    .select({ title: schema.stories.title })
    .from(schema.publications)
    .leftJoin(schema.stories, eq(schema.publications.storyId, schema.stories.id))
    .where(eq(schema.publications.id, publicationId))
    .get()
  await notifyDraftReady(db, publicationId, written?.title ?? 'A story is ready').catch(() => undefined)

  return { slots, versionId }
}

/** Registered against the queue's `write` kind. */
export function writerHandler(driver: () => InferenceDriver) {
  return async (db: Db, refId: string): Promise<void> => {
    await draftPublication(db, driver(), refId)
  }
}
