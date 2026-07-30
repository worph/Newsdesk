import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { runStructured } from '../ports/inference/structured.js'
import { fillPrompt, loadPrompt } from '../prompts/load.js'
import {
  checkVerdictLinks,
  directorResultSchema,
  directorShapeHint,
  type DirectorResult,
} from '../schema/director.js'

/**
 * One inference call per submission: is there a story, have we told it, where
 * does it run. The result becomes rows — never an action — and a human stands
 * between it and anything leaving the building.
 *
 * See ARCHITECTURE.md section 5.
 */

/** Days of stories included wholesale for comparison. No embeddings at this volume. */
export const COMPARISON_WINDOW_DAYS = 30

export interface DirectorContext {
  prompt: string
  targetIds: string[]
  knownStoryIds: Set<string>
}

function personaSummary(db: Db, personaId: string | null): string | undefined {
  if (!personaId) return undefined
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get()
  if (!persona) return undefined
  return `${persona.voice}; for ${persona.audience}`
}

function renderTargets(db: Db): { text: string; ids: string[] } {
  const targets = db.select().from(schema.targets).where(eq(schema.targets.enabled, true)).all()

  if (targets.length === 0) {
    return { text: '(no destinations are configured — propose no routes)', ids: [] }
  }

  const text = targets
    .map((target) => {
      const voice = personaSummary(db, target.personaId)
      return [
        `### ${target.id}`,
        `name: ${target.name}`,
        `role: ${target.role}`,
        ...(voice ? [`voice: ${voice}`] : []),
        '',
        target.description.trim(),
      ].join('\n')
    })
    .join('\n\n')

  return { text, ids: targets.map((t) => t.id) }
}

function renderRecentStories(db: Db, windowDays: number): { text: string; ids: Set<string> } {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const recent = db
    .select()
    .from(schema.stories)
    .where(gte(schema.stories.createdAt, since))
    .orderBy(desc(schema.stories.createdAt))
    .all()

  if (recent.length === 0) {
    return { text: '(nothing told yet — every story here is necessarily NEW)', ids: new Set() }
  }

  const text = recent
    .map((story) =>
      [
        `### ${story.id}`,
        `date: ${story.createdAt}`,
        `title: ${story.title}`,
        `status: ${story.status}`,
        `summary: ${story.summary}`,
      ].join('\n'),
    )
    .join('\n\n')

  return { text, ids: new Set(recent.map((s) => s.id)) }
}

export function buildDirectorContext(
  db: Db,
  submission: { id: string; sourceId: string; considered: string | null; text: string },
  windowDays = COMPARISON_WINDOW_DAYS,
): DirectorContext {
  const source = db.select().from(schema.sources).where(eq(schema.sources.id, submission.sourceId)).get()
  const charterRow = db.select().from(schema.charter).orderBy(desc(schema.charter.id)).limit(1).get()
  const targets = renderTargets(db)
  const recent = renderRecentStories(db, windowDays)

  const sourceLines = [
    `id: ${submission.sourceId}`,
    ...(source ? [`name: ${source.name}`, `kind: ${source.kind}`] : []),
    ...(source?.hint
      ? [
          '',
          `Narrowing note for this source (subordinate to the charter): ${source.hint}`,
        ]
      : []),
  ].join('\n')

  const prompt = fillPrompt(loadPrompt('director'), {
    CHARTER: charterRow?.text.trim() ?? '(no charter written yet — do not route anything)',
    TARGETS: targets.text,
    SOURCE: sourceLines,
    WINDOW_DAYS: String(windowDays),
    RECENT_STORIES: recent.text,
    // The trimmed slice is what the director sees. Falling back to the whole
    // text would silently undo the watermark on a source we misread.
    SUBMISSION: submission.considered ?? submission.text,
  })

  return { prompt, targetIds: targets.ids, knownStoryIds: recent.ids }
}

export interface AppliedResult {
  storyIds: string[]
  routed: number
  dropped: number
  outcome: string
}

/**
 * Turn the director's answer into rows. Every branch here is one of the tool
 * calls in ARCHITECTURE.md section 5.1, and every drop leaves a visible reason
 * — silence and "nothing happened" must never look alike.
 */
export interface ApplyOptions {
  /**
   * Called for each publication the director proposed, inside the same
   * transaction — so a queued draft job can never reference a publication
   * that was rolled back.
   */
  enqueueWriter?: (publicationId: string) => void
}

export function applyDirectorResult(
  db: Db,
  submissionId: string,
  result: DirectorResult,
  options: ApplyOptions = {},
): AppliedResult {
  const storyIds: string[] = []
  let routed = 0
  let dropped = 0

  db.transaction((tx) => {
    for (const story of result.stories) {
      const id = randomUUID()
      const isDuplicate = story.verdict === 'DUPLICATE'
      const needsContext = Boolean(story.needs_context)
      const hasRoutes = story.routes.length > 0

      // A duplicate is terminal. Otherwise a story with no routes is spiked —
      // that IS the newsworthiness gate, not a separate mechanism.
      const status = isDuplicate
        ? 'DROPPED'
        : needsContext
          ? 'NEEDS_CONTEXT'
          : hasRoutes
            ? 'ROUTED'
            : 'DROPPED'

      const dropReason = isDuplicate
        ? (story.dedup_reason ?? 'duplicate of an earlier story')
        : !hasRoutes && !needsContext
          ? 'no destination clears the bar for this story'
          : null

      tx.insert(schema.stories)
        .values({
          id,
          title: story.title,
          summary: story.summary,
          body: null,
          url: story.url ?? null,
          status,
          dedupVerdict: story.verdict,
          dedupReason: story.dedup_reason ?? null,
          relatedStoryId: story.related_story_id ?? null,
          comparedIds: JSON.stringify(story.related_story_id ? [story.related_story_id] : []),
          label: story.label ?? null,
          dropReason,
          // Kept verbatim so the override diff — what was proposed versus what
          // the editor decided — survives any later edit to the publications.
          proposedRoutes: JSON.stringify(story.routes),
        })
        .run()

      tx.insert(schema.storySubmissions).values({ storyId: id, submissionId }).run()
      storyIds.push(id)

      // Redundancy across sources is the payoff for dropping key-based dedup:
      // the filing also attaches to the story it duplicates, so that story now
      // cites two sources and is better founded than either alone. The dropped
      // row above still exists, so the match stays visible in the spiked view.
      if (isDuplicate && story.related_story_id) {
        tx.insert(schema.storySubmissions)
          .values({ storyId: story.related_story_id, submissionId })
          .onConflictDoNothing()
          .run()
      }

      if (status === 'DROPPED') {
        dropped++
      }

      // A duplicate proposes nothing: it is already told. A NEEDS_CONTEXT
      // story keeps its routes so the editor can release it once answered.
      if (!isDuplicate) {
        for (const route of story.routes) {
          const publicationId = randomUUID()
          tx.insert(schema.publications)
            .values({
              id: publicationId,
              storyId: id,
              targetId: route.target_id,
              status: 'PROPOSED',
              origin: 'director',
              routeReason: route.reason,
              angle: route.angle ?? null,
              slots: null,
              payload: null,
            })
            .run()
          // A story held for context is not ready to be written yet.
          if (!needsContext) options.enqueueWriter?.(publicationId)
          routed++
        }
      }
    }
  })

  // Events after the transaction: the log is authoritative, but a logging
  // failure must not roll back work that actually happened.
  for (const [index, story] of result.stories.entries()) {
    const id = storyIds[index]
    if (!id) continue

    if (story.verdict === 'DUPLICATE') {
      logEvent(db, {
        level: 'info',
        code: 'STORY_DUPLICATE',
        storyId: id,
        message: `"${story.title}" duplicates ${story.related_story_id ?? 'an earlier story'}`,
        detail: { reason: story.dedup_reason, relatedStoryId: story.related_story_id },
      })
    } else if (story.routes.length === 0 && !story.needs_context) {
      logEvent(db, {
        level: 'info',
        code: 'STORY_SPIKED',
        storyId: id,
        message: `"${story.title}" was opened but routed nowhere`,
        detail: { summary: story.summary },
      })
    } else {
      logEvent(db, {
        level: 'info',
        code: 'STORY_OPENED',
        storyId: id,
        message: `"${story.title}" → ${story.routes.map((r) => r.target_id).join(', ') || 'held for context'}`,
        detail: { verdict: story.verdict, routes: story.routes },
      })
    }
  }

  const outcome =
    result.stories.length === 0
      ? `no story — ${result.no_story_reason ?? 'nothing in this filing'}`
      : `${result.stories.length} story/stories: ${routed} route(s) proposed, ${dropped} spiked`

  return { storyIds, routed, dropped, outcome }
}

/** Run the director over one submission and record the outcome. */
export async function directSubmission(
  db: Db,
  driver: InferenceDriver,
  submissionId: string,
  options: ApplyOptions & { windowDays?: number } = {},
): Promise<AppliedResult> {
  const windowDays = options.windowDays ?? COMPARISON_WINDOW_DAYS
  const submission = db
    .select()
    .from(schema.submissions)
    .where(eq(schema.submissions.id, submissionId))
    .get()

  if (!submission) throw new Error(`submission "${submissionId}" not found`)

  const context = buildDirectorContext(db, submission, windowDays)

  let result: DirectorResult
  try {
    result = await runStructured(db, driver, {
      purpose: 'director',
      refId: submissionId,
      prompt: context.prompt,
      schema: directorResultSchema(context.targetIds),
      shapeHint: directorShapeHint(context.targetIds),
    })
  } catch (err) {
    db.update(schema.submissions)
      .set({ status: 'FAILED', outcome: err instanceof Error ? err.message : String(err) })
      .where(eq(schema.submissions.id, submissionId))
      .run()
    throw err
  }

  // A verdict linking a story it was never shown is not reviewable, so it is
  // downgraded to NEW rather than written as an unverifiable claim.
  const problems = checkVerdictLinks(result, context.knownStoryIds)
  if (problems.length > 0) {
    logEvent(db, {
      level: 'warn',
      code: 'DIRECTOR_VERDICT_UNLINKED',
      message: `downgraded ${problems.length} unverifiable verdict(s) to NEW`,
      detail: { submissionId, problems },
    })
    result = {
      ...result,
      stories: result.stories.map((story) =>
        story.verdict !== 'NEW' &&
        (!story.related_story_id || !context.knownStoryIds.has(story.related_story_id))
          ? {
              ...story,
              verdict: 'NEW' as const,
              dedup_reason: `[unverifiable ${story.verdict} claim discarded] ${story.dedup_reason ?? ''}`.trim(),
              ...(story.related_story_id ? { related_story_id: undefined } : {}),
            }
          : story,
      ),
    }
  }

  const applied = applyDirectorResult(db, submissionId, result, options)

  db.update(schema.submissions)
    .set({ status: 'PROCESSED', outcome: applied.outcome })
    .where(eq(schema.submissions.id, submissionId))
    .run()

  return applied
}

/** Registered against the queue's `direct` kind. */
export function directorHandler(driver: () => InferenceDriver, options: ApplyOptions = {}) {
  return async (db: Db, refId: string): Promise<void> => {
    await directSubmission(db, driver(), refId, options)
  }
}

export { and }
