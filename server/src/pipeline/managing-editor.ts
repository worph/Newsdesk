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
  managingEditorResultSchema,
  managingEditorShapeHint,
  type ManagingEditorResult,
} from '../schema/managing-editor.js'
import { renderDossier, type Dossier } from './reporter.js'

/**
 * One inference call per filing: is there a story, have we told it, where
 * does it run. The result becomes rows — never an action — and a human stands
 * between it and anything leaving the building.
 *
 * See ARCHITECTURE.md section 5.
 */

/** Days of stories included wholesale for comparison. No embeddings at this volume. */
export const COMPARISON_WINDOW_DAYS = 30

export interface ManagingEditorContext {
  prompt: string
  outletIds: string[]
  knownStoryIds: Set<string>
}

function voiceSummary(db: Db, voiceId: string | null): string | undefined {
  if (!voiceId) return undefined
  const voice = db.select().from(schema.voices).where(eq(schema.voices.id, voiceId)).get()
  if (!voice) return undefined
  return `${voice.tone}; for ${voice.audience}`
}

function renderOutlets(db: Db): { text: string; ids: string[] } {
  const outlets = db.select().from(schema.outlets).where(eq(schema.outlets.enabled, true)).all()

  if (outlets.length === 0) {
    return { text: '(no destinations are configured — propose no placements)', ids: [] }
  }

  const text = outlets
    .map((outlet) => {
      const voice = voiceSummary(db, outlet.voiceId)
      return [
        `### ${outlet.id}`,
        `name: ${outlet.name}`,
        `role: ${outlet.role}`,
        ...(voice ? [`voice: ${voice}`] : []),
        '',
        outlet.description.trim(),
      ].join('\n')
    })
    .join('\n\n')

  return { text, ids: outlets.map((t) => t.id) }
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

/**
 * What the managing editor actually reads.
 *
 * A dossier that will not parse falls back to the filing as written, because a
 * corrupt blob must not cost us the tip. The dossier is rendered rather than
 * pasted as JSON so its sourced/recall split survives into the prompt — the
 * managing editor has to be able to tell a reported claim from the desk's
 * unverified memory before it decides there is a story.
 */
function renderFiling(filing: { considered: string | null; text: string; dossier?: string | null }): string {
  if (filing.dossier) {
    try {
      return renderDossier(JSON.parse(filing.dossier) as Dossier)
    } catch {
      // Fall through to the filing as written.
    }
  }
  return filing.considered ?? filing.text
}

export function buildManagingEditorContext(
  db: Db,
  filing: {
    id: string
    stringerId: string
    considered: string | null
    text: string
    dossier?: string | null
  },
  windowDays = COMPARISON_WINDOW_DAYS,
): ManagingEditorContext {
  const stringer = db.select().from(schema.stringers).where(eq(schema.stringers.id, filing.stringerId)).get()
  const charterRow = db.select().from(schema.charter).orderBy(desc(schema.charter.id)).limit(1).get()
  const outlets = renderOutlets(db)
  const recent = renderRecentStories(db, windowDays)

  const stringerLines = [
    `id: ${filing.stringerId}`,
    ...(stringer ? [`name: ${stringer.name}`, `kind: ${stringer.kind}`] : []),
    ...(stringer?.hint
      ? [
          '',
          `Narrowing note for this stringer (subordinate to the charter): ${stringer.hint}`,
        ]
      : []),
  ].join('\n')

  const prompt = fillPrompt(loadPrompt('managing-editor'), {
    CHARTER: charterRow?.text.trim() ?? '(no charter written yet — do not place anything)',
    OUTLETS: outlets.text,
    STRINGER: stringerLines,
    WINDOW_DAYS: String(windowDays),
    RECENT_STORIES: recent.text,
    // A reported filing is read as its dossier, which is what the desk went and
    // found rather than what arrived. Otherwise the trimmed slice: falling back
    // to the whole text would silently undo the watermark on a stringer we
    // misread.
    FILING: renderFiling(filing),
  })

  return { prompt, outletIds: outlets.ids, knownStoryIds: recent.ids }
}

export interface AppliedResult {
  storyIds: string[]
  placed: number
  dropped: number
  outcome: string
}

/**
 * Turn the managing editor's answer into rows. Every branch here is one of the tool
 * calls in ARCHITECTURE.md section 5.1, and every drop leaves a visible reason
 * — silence and "nothing happened" must never look alike.
 */
export interface ApplyOptions {
  /**
   * Called for each publication the managing editor proposed, inside the same
   * transaction — so a queued draft job can never reference a publication
   * that was rolled back.
   */
  enqueueWriter?: (publicationId: string) => void
}

export function applyManagingEditorResult(
  db: Db,
  filingId: string,
  result: ManagingEditorResult,
  options: ApplyOptions = {},
): AppliedResult {
  const storyIds: string[] = []
  let placed = 0
  let dropped = 0

  db.transaction((tx) => {
    for (const story of result.stories) {
      const id = randomUUID()
      const isDuplicate = story.verdict === 'DUPLICATE'
      const held = Boolean(story.hold_reason)
      const hasPlacements = story.placements.length > 0

      // A duplicate is terminal. Otherwise a story with no placements is spiked —
      // that IS the newsworthiness gate, not a separate mechanism.
      const status = isDuplicate
        ? 'DROPPED'
        : held
          ? 'HELD'
          : hasPlacements
            ? 'PLACED'
            : 'DROPPED'

      const dropReason = isDuplicate
        ? (story.dedup_reason ?? 'duplicate of an earlier story')
        : !hasPlacements && !held
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
          holdReason: story.hold_reason ?? null,
          // Kept verbatim so the override diff — what was proposed versus what
          // the editor decided — survives any later edit to the publications.
          proposedPlacements: JSON.stringify(story.placements),
        })
        .run()

      tx.insert(schema.storyFilings).values({ storyId: id, filingId }).run()
      storyIds.push(id)

      // Redundancy across sources is the payoff for dropping key-based dedup:
      // the filing also attaches to the story it duplicates, so that story now
      // cites two sources and is better founded than either alone. The dropped
      // row above still exists, so the match stays visible in the spiked view.
      if (isDuplicate && story.related_story_id) {
        tx.insert(schema.storyFilings)
          .values({ storyId: story.related_story_id, filingId })
          .onConflictDoNothing()
          .run()
      }

      if (status === 'DROPPED') {
        dropped++
      }

      // A duplicate proposes nothing: it is already told. A HELD story keeps
      // its placements so the editor can release it once answered.
      if (!isDuplicate) {
        for (const placement of story.placements) {
          const publicationId = randomUUID()
          tx.insert(schema.publications)
            .values({
              id: publicationId,
              storyId: id,
              outletId: placement.outlet_id,
              status: 'PROPOSED',
              origin: 'managing-editor',
              placementReason: placement.reason,
              angle: placement.angle ?? null,
              slots: null,
              payload: null,
            })
            .run()
          // A held story is not ready to be written yet.
          if (!held) options.enqueueWriter?.(publicationId)
          placed++
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
    } else if (story.placements.length === 0 && !story.hold_reason) {
      logEvent(db, {
        level: 'info',
        code: 'STORY_SPIKED',
        storyId: id,
        message: `"${story.title}" was opened but placed nowhere`,
        detail: { summary: story.summary },
      })
    } else {
      logEvent(db, {
        level: 'info',
        code: 'STORY_OPENED',
        storyId: id,
        message: `"${story.title}" → ${story.placements.map((r) => r.outlet_id).join(', ') || 'held'}`,
        detail: { verdict: story.verdict, placements: story.placements },
      })
    }
  }

  const outcome =
    result.stories.length === 0
      ? `no story — ${result.no_story_reason ?? 'nothing in this filing'}`
      : `${result.stories.length} story/stories: ${placed} placement(s) proposed, ${dropped} spiked`

  return { storyIds, placed, dropped, outcome }
}

/** Run the managing editor over one filing and record the outcome. */
export async function assignFiling(
  db: Db,
  driver: InferenceDriver,
  filingId: string,
  options: ApplyOptions & { windowDays?: number } = {},
): Promise<AppliedResult> {
  const windowDays = options.windowDays ?? COMPARISON_WINDOW_DAYS
  const filing = db
    .select()
    .from(schema.filings)
    .where(eq(schema.filings.id, filingId))
    .get()

  if (!filing) throw new Error(`filing "${filingId}" not found`)

  const context = buildManagingEditorContext(db, filing, windowDays)

  let result: ManagingEditorResult
  try {
    result = await runStructured(db, driver, {
      purpose: 'managing-editor',
      refId: filingId,
      prompt: context.prompt,
      schema: managingEditorResultSchema(context.outletIds),
      shapeHint: managingEditorShapeHint(context.outletIds),
    })
  } catch (err) {
    db.update(schema.filings)
      .set({ status: 'FAILED', outcome: err instanceof Error ? err.message : String(err) })
      .where(eq(schema.filings.id, filingId))
      .run()
    throw err
  }

  // A verdict linking a story it was never shown is not reviewable, so it is
  // downgraded to NEW rather than written as an unverifiable claim.
  const problems = checkVerdictLinks(result, context.knownStoryIds)
  if (problems.length > 0) {
    logEvent(db, {
      level: 'warn',
      code: 'MANAGING_EDITOR_VERDICT_UNLINKED',
      message: `downgraded ${problems.length} unverifiable verdict(s) to NEW`,
      detail: { filingId, problems },
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

  const applied = applyManagingEditorResult(db, filingId, result, options)

  db.update(schema.filings)
    .set({ status: 'PROCESSED', outcome: applied.outcome })
    .where(eq(schema.filings.id, filingId))
    .run()

  return applied
}

/** Registered against the queue's `direct` kind. */
export function managingEditorHandler(driver: () => InferenceDriver, options: ApplyOptions = {}) {
  return async (db: Db, refId: string): Promise<void> => {
    await assignFiling(db, driver(), refId, options)
  }
}

export { and }
