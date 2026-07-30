import { isSlot, templateExpressions, type ArgsSpec } from '@newsdesk/shared'

/**
 * The published payload is `merge(literals, derived, approved slots)` — pure
 * data assembly with no inference anywhere in it.
 *
 * That is invariants 1 and 2 made structural rather than promised: if a model
 * could alter the payload after approval, the approval would mean nothing. The
 * merged object is frozen onto the publication row at approval and sent
 * verbatim, which is also what makes retry safe.
 *
 * See ARCHITECTURE.md invariants 1-3 and IMPLEMENTATION.md section 4.
 */

export interface StoryFacts {
  id: string
  title: string
  summary: string
  url?: string | null
}

export interface MergeContext {
  story: StoryFacts
  slots: Record<string, unknown>
  /** Injectable so a frozen payload is reproducible in tests. */
  now?: Date
}

/** Resolve one `{{ ... }}` expression against the allowed roots. */
function resolveExpression(expr: string, context: MergeContext): string | undefined {
  const path = expr.trim().split('.')
  const root = path[0]

  if (root === 'now') return (context.now ?? new Date()).toISOString()

  const source =
    root === 'story'
      ? (context.story as unknown as Record<string, unknown>)
      : root === 'slots'
        ? context.slots
        : undefined

  if (!source) return undefined

  let value: unknown = source
  for (const key of path.slice(1)) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }

  if (value === null || value === undefined) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Substitute every `{{ ... }}` in a derived string. An expression that
 * resolves to nothing becomes an empty string rather than the literal
 * `{{story.url}}` — leaking template syntax into a published message is worse
 * than an absent value.
 */
export function renderTemplate(template: string, context: MergeContext): string {
  let out = template
  for (const expr of templateExpressions(template)) {
    const value = resolveExpression(expr, context) ?? ''
    out = out.split(`{{${expr}}}`).join(value)
    // Tolerate the spaced form the config schema also accepts.
    out = out.split(`{{ ${expr} }}`).join(value)
  }
  return out
}

export class PayloadIncomplete extends Error {
  constructor(readonly missing: string[]) {
    super(`draft is missing required slot(s): ${missing.join(', ')}`)
    this.name = 'PayloadIncomplete'
  }
}

/**
 * Build the object that will actually be sent.
 *
 * Keys come from configuration, never from a model: a literal is passed
 * through, a derived string is rendered from story facts, and a slot takes the
 * authored value. A slot the writer left empty is dropped when optional and
 * refuses the merge when not.
 */
export function mergePayload(args: ArgsSpec, context: MergeContext): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const missing: string[] = []

  for (const [key, spec] of Object.entries(args)) {
    if (isSlot(spec)) {
      const value = context.slots[key]
      const filled = typeof value === 'string' ? value.trim() : value

      if (filled === undefined || filled === null || filled === '') {
        if (!spec.optional) missing.push(key)
        continue
      }
      payload[key] = filled
      continue
    }

    if (typeof spec === 'string' && templateExpressions(spec).length > 0) {
      const rendered = renderTemplate(spec, context)
      // A derived value that resolved to nothing is omitted rather than sent
      // as an empty string, which some bridges render as a blank field.
      if (rendered !== '') payload[key] = rendered
      continue
    }

    // A literal: the destination lives here, pinned in configuration.
    payload[key] = spec
  }

  if (missing.length > 0) throw new PayloadIncomplete(missing)

  return payload
}

/**
 * What the review screen shows in "what will be sent", split so the editor can
 * see at a glance which values they authored and which are fixed by
 * configuration.
 */
export interface PayloadPreview {
  payload: Record<string, unknown>
  authored: string[]
  fixed: string[]
  missing: string[]
}

export function previewPayload(args: ArgsSpec, context: MergeContext): PayloadPreview {
  const authored: string[] = []
  const fixed: string[] = []
  const missing: string[] = []

  for (const [key, spec] of Object.entries(args)) {
    if (isSlot(spec)) {
      const value = context.slots[key]
      const filled = typeof value === 'string' ? value.trim() : value
      if (filled === undefined || filled === null || filled === '') {
        if (!spec.optional) missing.push(key)
      } else {
        authored.push(key)
      }
    } else {
      fixed.push(key)
    }
  }

  let payload: Record<string, unknown> = {}
  try {
    payload = mergePayload(args, context)
  } catch (err) {
    if (!(err instanceof PayloadIncomplete)) throw err
    // Preview an incomplete draft anyway: seeing the gap is the point.
    const relaxed: ArgsSpec = Object.fromEntries(
      Object.entries(args).map(([key, spec]) =>
        isSlot(spec) && missing.includes(key) ? [key, { ...spec, optional: true }] : [key, spec],
      ),
    )
    payload = mergePayload(relaxed, context)
  }

  return { payload, authored, fixed, missing }
}
