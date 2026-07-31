import { z } from 'zod'

/**
 * A target's `args` mirror the arguments of the MCP tool it calls. Each key is
 * one of three things:
 *
 *   literal   a scalar pinned in configuration      "1516814412244193380"
 *   derived   a template over the story             "{{story.url}}"
 *   slot      authored by the writer, edited by you { slot: markdown, ... }
 *
 * Authorship is inverted on purpose: the configuration declares which keys are
 * authoring slots and a model only ever fills those. A model that could emit
 * the whole argument object would author the destination, and a reviewer
 * reading a document rather than JSON would never catch it.
 *
 * See ARCHITECTURE.md section 4.3.
 */

export const SLOT_TYPES = ['text', 'markdown', 'image', 'link'] as const
export type SlotType = (typeof SLOT_TYPES)[number]

export const slotDefSchema = z.object({
  slot: z.enum(SLOT_TYPES),
  label: z.string().min(1, 'a slot needs a label — it is what the editor sees'),
  max: z.number().int().positive().optional(),
  optional: z.boolean().default(false),
  /** At most one per target: the slot that gets the full editor and the copy desk. */
  primary: z.boolean().default(false),
  /** Guidance passed through to the writer prompt. */
  hint: z.string().optional(),
})
export type SlotDef = z.infer<typeof slotDefSchema>

/** Literal scalars are pinned in config and never shown at review. */
export const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type Literal = z.infer<typeof literalSchema>

export const argValueSchema = z.union([slotDefSchema, literalSchema])
export type ArgValue = z.infer<typeof argValueSchema>

export const argsSpecSchema = z.record(z.string(), argValueSchema)
export type ArgsSpec = z.infer<typeof argsSpecSchema>

export function isSlot(value: ArgValue): value is SlotDef {
  return typeof value === 'object' && value !== null && 'slot' in value
}

// Built fresh per call: a shared global regex carries `lastIndex` between
// test() and matchAll(), and matchAll clones that state — which silently
// skips matches.
const templateRe = (): RegExp => /\{\{\s*([^}]+?)\s*\}\}/g

/**
 * A string carrying `{{ ... }}` is derived rather than literal. Deliberately
 * not a type predicate: a plain string is a perfectly good literal, so
 * narrowing `!isDerived(x)` to "not a string" would be wrong.
 */
export function isDerived(value: ArgValue): boolean {
  return typeof value === 'string' && templateRe().test(value)
}

/** Roots a derived expression may read from. */
export const TEMPLATE_ROOTS = ['story', 'slots', 'now'] as const

export function templateExpressions(value: string): string[] {
  const found: string[] = []
  for (const match of value.matchAll(templateRe())) {
    const expr = match[1]
    if (expr) found.push(expr)
  }
  return found
}

export function slotsOf(args: ArgsSpec): Array<{ key: string; def: SlotDef }> {
  return Object.entries(args)
    .filter((entry): entry is [string, SlotDef] => isSlot(entry[1]))
    .map(([key, def]) => ({ key, def }))
}

export function primarySlotKey(args: ArgsSpec): string | undefined {
  return slotsOf(args).find(({ def }) => def.primary)?.key
}
