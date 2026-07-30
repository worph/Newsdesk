import { isSlot, slotsOf, type ArgsSpec, type SlotDef } from '@newsdesk/shared'
import { z } from 'zod'
import type { ToolSchema } from '../ports/inference/types.js'

/**
 * One spec drives three things: the writer's tool schema, the review surface,
 * and the published payload. Generating all of them from `args_spec` is what
 * makes an over-length or missing value impossible rather than merely
 * validated after the fact.
 *
 * See IMPLEMENTATION.md section 4.
 */

function slotJsonSchema(def: SlotDef): Record<string, unknown> {
  const description = [def.label, def.hint].filter(Boolean).join(' — ')

  const base: Record<string, unknown> = { type: 'string', description }
  if (def.max !== undefined) base.maxLength = def.max

  switch (def.slot) {
    case 'image':
    case 'link':
      // `format` is advisory in JSON Schema, so the Zod side below is what
      // actually rejects a non-URL.
      return { ...base, format: 'uri' }
    case 'markdown':
      return { ...base, description: `${description} (markdown)` }
    default:
      return base
  }
}

/** JSON Schema for `submit_draft`, generated from the target's authoring slots. */
export function slotsJsonSchema(args: ArgsSpec): Record<string, unknown> {
  const slots = slotsOf(args)
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const { key, def } of slots) {
    properties[key] = slotJsonSchema(def)
    if (!def.optional) required.push(key)
  }

  return {
    type: 'object',
    properties,
    required,
    // The writer fills declared slots and nothing else. An extra key would be
    // a model authoring an argument that configuration did not offer it.
    additionalProperties: false,
  }
}

/** The matching validator, which is what actually enforces the spec. */
export function slotsZodSchema(args: ArgsSpec): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const { key, def } of slotsOf(args)) {
    let field: z.ZodTypeAny = z.string()
    if (def.slot === 'image' || def.slot === 'link') {
      field = z.string().url(`${def.label} must be a URL`)
    }
    if (def.max !== undefined) {
      field = (field as z.ZodString).max(def.max, `${def.label} must be at most ${def.max} characters`)
    }
    if (!def.optional) {
      field = (field as z.ZodString).min(1, `${def.label} is required`)
    } else {
      field = field.optional()
    }
    shape[key] = field
  }

  return z.object(shape).strict() as unknown as z.ZodType<Record<string, string>>
}

export function submitDraftTool(args: ArgsSpec): ToolSchema {
  return {
    name: 'submit_draft',
    description: 'Submit the draft for this destination. Fill every required slot.',
    parameters: slotsJsonSchema(args),
  }
}

/** A compact shape hint for a driver that cannot be handed a real schema. */
export function slotsShapeHint(args: ArgsSpec): string {
  const lines = slotsOf(args).map(({ key, def }) => {
    const bits: string[] = [def.slot]
    if (def.max !== undefined) bits.push(`max ${def.max} chars`)
    if (def.optional) bits.push('optional')
    if (def.primary) bits.push('the main document')
    const hint = def.hint ? ` — ${def.hint}` : ''
    return `  "${key}": string   // ${def.label} (${bits.join(', ')})${hint}`
  })
  return `{\n${lines.join('\n')}\n}`
}

/** Keys the editor may author, in a stable order. Literals and derived values are not among them. */
export function authoringKeys(args: ArgsSpec): string[] {
  return Object.entries(args)
    .filter(([, value]) => isSlot(value))
    .map(([key]) => key)
}
