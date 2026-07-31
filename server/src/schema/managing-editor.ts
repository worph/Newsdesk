import { z } from 'zod'
import type { ToolSchema } from '../ports/inference/types.js'

/**
 * The managing editor's vocabulary, generated from the live outlet list so an unknown
 * destination is impossible rather than merely validated.
 *
 * The tool calls in ARCHITECTURE.md section 5.1 are expressed here as one JSON
 * object, because the day-one driver cannot be handed a tool schema. The shape
 * is a faithful transcription — `open_story` with its nested `duplicate_of` /
 * `update_of` / `needs_context` / `propose_placement`, or `no_story` — so the
 * tool-calling driver can emit the same result without anything downstream
 * changing.
 *
 * Note what is absent: no significance score. Placement IS the judgement, and
 * zero placements on a story is the newsworthiness gate.
 */

export const DEDUP_VERDICTS = ['NEW', 'DUPLICATE', 'UPDATE'] as const

export interface OutletChoice {
  id: string
  name: string
  description: string
  role: string
  voiceSummary?: string
}

/**
 * The result's shape, defined once with a plain string `outlet_id` so the type
 * is stable. `managingEditorResultSchema` below narrows that key to a generated
 * enum; enum members are strings, so the validated value still satisfies this.
 */
const placementShape = z.object({
  outlet_id: z.string(),
  reason: z.string().min(1, 'a placement needs a reason — it is shown beside the toggle at review'),
  angle: z.string().optional(),
})

const storyShape = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  url: z.string().optional(),
  verdict: z.enum(DEDUP_VERDICTS).default('NEW'),
  /** Required by checkVerdictLinks when the verdict links an earlier story. */
  related_story_id: z.string().optional(),
  dedup_reason: z.string().optional(),
  needs_context: z.string().optional(),
  label: z.string().optional(),
  placements: z.array(placementShape).default([]),
})

const resultShape = z.object({
  stories: z.array(storyShape).default([]),
  no_story_reason: z.string().optional(),
})

export type ManagingEditorResult = z.infer<typeof resultShape>
export type ManagingEditorStory = ManagingEditorResult['stories'][number]

/**
 * Build the result validator. `outletIds` becomes an enum, so a placement to a
 * destination that does not exist fails validation and is fed back for
 * correction rather than reaching a database row.
 */
export function managingEditorResultSchema(outletIds: string[]): z.ZodType<ManagingEditorResult> {
  const outletId =
    outletIds.length > 0
      ? z.enum(outletIds as [string, ...string[]])
      : // No outlets configured: any placement is wrong, so accept none.
        z.never()

  return z.object({
    stories: z
      .array(storyShape.extend({ placements: z.array(placementShape.extend({ outlet_id: outletId })).default([]) }))
      .default([]),
    no_story_reason: z.string().optional(),
  }) as unknown as z.ZodType<ManagingEditorResult>
}

/**
 * A `DUPLICATE` or `UPDATE` verdict is only reviewable if it says what it
 * matched. Checked after parsing rather than in the schema so the message can
 * name the offending story, and so the retry gets something actionable.
 */
export function checkVerdictLinks(result: ManagingEditorResult, knownStoryIds: Set<string>): string[] {
  const problems: string[] = []

  for (const story of result.stories) {
    if (story.verdict === 'NEW') continue

    if (!story.related_story_id) {
      problems.push(
        `story "${story.title}" is ${story.verdict} but names no related_story_id — a verdict that cannot be checked is not reviewable`,
      )
      continue
    }
    if (!knownStoryIds.has(story.related_story_id)) {
      problems.push(
        `story "${story.title}" claims ${story.verdict} of "${story.related_story_id}", which is not one of the stories it was shown`,
      )
    }
  }

  return problems
}

/** The same vocabulary as real tools, for a driver that can be handed schemas. */
export function managingEditorTools(outlets: OutletChoice[]): ToolSchema[] {
  const outletIds = outlets.map((t) => t.id)

  return [
    {
      name: 'open_story',
      description:
        'Open a story found in the filing. Call once per distinct story. A filing may contain none, one, or several.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A headline naming what happened.' },
          summary: {
            type: 'string',
            description: 'What happened, factually. This is the writers’ basis — no persuasion, no voice.',
          },
          url: { type: 'string', description: 'The canonical link, if the filing carried one.' },
          verdict: {
            type: 'string',
            enum: [...DEDUP_VERDICTS],
            description:
              'NEW if never told. DUPLICATE if already told — terminal. UPDATE if a genuine follow-up to an earlier story.',
          },
          related_story_id: {
            type: 'string',
            description: 'Required for DUPLICATE and UPDATE: the id of the earlier story, from the list provided.',
          },
          dedup_reason: { type: 'string', description: 'Why this verdict. Recorded and reviewed.' },
          needs_context: {
            type: 'string',
            description: 'Set only if the story cannot be judged without something the filing did not carry.',
          },
          label: {
            type: 'string',
            description: 'A coarse label to sort the queue. Cosmetic — it never filters.',
          },
        },
        required: ['title', 'summary', 'verdict'],
        additionalProperties: false,
      },
    },
    {
      name: 'propose_placement',
      description:
        'Propose that a story runs at a destination. Zero placements is the newsworthiness gate — propose none if it does not clear the bar for any audience.',
      parameters: {
        type: 'object',
        properties: {
          outlet_id: {
            type: 'string',
            enum: outletIds,
            description: 'Which destination. Only these exist.',
          },
          reason: { type: 'string', description: 'Why it belongs here. Shown beside the toggle at review.' },
          angle: {
            type: 'string',
            description: 'Optional note to the writer: what to lead with for this audience.',
          },
        },
        required: ['outlet_id', 'reason'],
        additionalProperties: false,
      },
    },
    {
      name: 'no_story',
      description: 'The filing contains nothing worth opening a story for. This is a success, not a failure.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  ]
}

/** Compact shape hint for the text driver — the same contract, in prose. */
export function managingEditorShapeHint(outletIds: string[]): string {
  const ids = outletIds.map((id) => `"${id}"`).join(' | ') || '(no outlets configured)'
  return [
    '{',
    '  "stories": [',
    '    {',
    '      "title": string,',
    '      "summary": string,            // factual basis for the writers, no voice',
    '      "url": string?,               // canonical link if the filing carried one',
    '      "verdict": "NEW" | "DUPLICATE" | "UPDATE",',
    '      "related_story_id": string?,  // REQUIRED for DUPLICATE and UPDATE',
    '      "dedup_reason": string?,      // why that verdict',
    '      "needs_context": string?,     // only if it cannot be judged as filed',
    '      "label": string?,             // coarse, sorts the queue, never filters',
    `      "placements": [{ "outlet_id": ${ids}, "reason": string, "angle": string? }]`,
    '    }',
    '  ],',
    '  "no_story_reason": string?        // when "stories" is empty',
    '}',
  ].join('\n')
}
