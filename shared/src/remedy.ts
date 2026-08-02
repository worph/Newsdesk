import { z } from 'zod'

/**
 * What the error assistant is allowed to propose.
 *
 * This file is the security boundary, not the prompt. The assistant reads
 * error detail that is attacker-influenced — MCP response bodies, text from
 * pages the reporter fetched, filing bodies someone else wrote — so nothing
 * here may depend on the model behaving. A remedy that does not parse against
 * one of these schemas is never stored, never previewed, and never offered.
 *
 * Two tiers, and the difference between them is not severity but reversibility
 * of *meaning*:
 *
 *   Safe changes alter how the desk behaves — an outlet stops receiving, a
 *   voice reads differently. They are one click.
 *
 *   High-risk changes alter *where content goes* or the running process: a
 *   tool name, a channel id, an argument spec, an endpoint URL, a restart.
 *   These are the literals architecture invariant 3 says a model never
 *   authors. They are allowed anyway, because a wrong tool name is one of the
 *   commonest real misconfigurations and diagnosing it without being able to
 *   fix it is half a feature — but they are shown as an exact before/after and
 *   require typing the entity id to confirm.
 *
 * `risk` is never read from the model or the client. The server derives it
 * from the kind and the field, and that derivation is `riskOf` below.
 */

export const REMEDY_KINDS = [
  'no_action',
  'retry_job',
  'retry_publication',
  'rerun_story',
  'report_filing',
  'disable_stringer',
  'disable_outlet',
  'reconnect_endpoint',
  'propose_config_change',
  'propose_literal_change',
  'propose_restart',
] as const

export type RemedyKind = (typeof REMEDY_KINDS)[number]

/**
 * Fields a safe config remedy may set. Everything absent from this list is
 * absent on purpose — most of all `id`, which is identity rather than
 * configuration, and `charter`, which is the editorial policy and the human's
 * alone.
 */
export const SAFE_CONFIG_FIELDS = {
  outlet: ['enabled', 'description', 'role', 'cadence.min_gap_minutes', 'cadence.max_per_day'],
  stringer: ['enabled', 'hint'],
  voice: ['tone', 'audience', 'rules'],
  reporting: ['enabled', 'max_rounds', 'max_fetches', 'timeout_seconds', 'wall_clock_seconds'],
} as const

/** Fields that decide where content goes. Allowed, but never quietly. */
export const LITERAL_CONFIG_FIELDS = {
  outlet: ['tool', 'destination_key', 'endpoint'],
  mcp_endpoint: ['url'],
} as const

const safeChange = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('outlet'),
    id: z.string().min(1),
    field: z.enum(SAFE_CONFIG_FIELDS.outlet),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    target: z.literal('stringer'),
    id: z.string().min(1),
    field: z.enum(SAFE_CONFIG_FIELDS.stringer),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    target: z.literal('voice'),
    id: z.string().min(1),
    field: z.enum(SAFE_CONFIG_FIELDS.voice),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    target: z.literal('reporting'),
    // The reporting block is a singleton, so there is no id to name.
    id: z.null().optional(),
    field: z.enum(SAFE_CONFIG_FIELDS.reporting),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
])

const literalChange = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('outlet'),
    id: z.string().min(1),
    field: z.enum(LITERAL_CONFIG_FIELDS.outlet),
    value: z.string().min(1),
  }),
  z.object({
    target: z.literal('mcp_endpoint'),
    id: z.string().min(1),
    field: z.enum(LITERAL_CONFIG_FIELDS.mcp_endpoint),
    value: z.string().min(1),
  }),
])

export type SafeConfigChange = z.infer<typeof safeChange>
export type LiteralConfigChange = z.infer<typeof literalChange>

/**
 * The proposal as the model returns it.
 *
 * `title` is the sentence on the button and `rationale` is why — both are the
 * model's prose and both are rendered as text, never as markup.
 */
const base = {
  title: z.string().min(1).max(140),
  rationale: z.string().min(1).max(1000),
}

export const remedySchema = z.discriminatedUnion('kind', [
  /**
   * Mandatory, not optional. A single-shot model asked "what remedies?" with
   * no legal way to say "none" will invent one, and an invented remedy on a
   * failure that needs a human is worse than no assistant at all.
   */
  z.object({ ...base, kind: z.literal('no_action') }),

  z.object({ ...base, kind: z.literal('retry_job'), jobId: z.string().min(1) }),
  z.object({ ...base, kind: z.literal('retry_publication'), publicationId: z.string().min(1) }),
  z.object({ ...base, kind: z.literal('rerun_story'), storyId: z.string().min(1) }),
  z.object({ ...base, kind: z.literal('report_filing'), filingId: z.string().min(1) }),
  z.object({ ...base, kind: z.literal('disable_stringer'), stringerId: z.string().min(1) }),
  z.object({ ...base, kind: z.literal('disable_outlet'), outletId: z.string().min(1) }),
  /** No write at all — it hands the human to the authorization flow. */
  z.object({ ...base, kind: z.literal('reconnect_endpoint'), endpointId: z.string().min(1) }),

  z.object({
    ...base,
    kind: z.literal('propose_config_change'),
    changes: z.array(safeChange).min(1).max(8),
  }),
  z.object({
    ...base,
    kind: z.literal('propose_literal_change'),
    changes: z.array(literalChange).min(1).max(4),
  }),
  z.object({ ...base, kind: z.literal('propose_restart') }),
])

export type Remedy = z.infer<typeof remedySchema>

export const assistResultSchema = z.object({
  /** One paragraph: what went wrong and why, in the operator's language. */
  diagnosis: z.string().min(1).max(2000),
  confidence: z.enum(['high', 'medium', 'low']),
  remedies: z.array(remedySchema).max(4),
})

export type AssistResult = z.infer<typeof assistResultSchema>

export type RemedyRisk = 'safe' | 'high'

/**
 * The tier a remedy belongs to, decided here and nowhere else.
 *
 * Derived from the kind rather than carried on it, so a model that returns
 * `risk: "safe"` next to a channel-id change is simply ignored — there is no
 * field for it to lie in.
 */
export function riskOf(remedy: Remedy): RemedyRisk {
  return remedy.kind === 'propose_literal_change' || remedy.kind === 'propose_restart' ? 'high' : 'safe'
}

/**
 * What a high-risk remedy asks the human to type back. Always an id already on
 * the proposal, so confirming means having read the thing that will change.
 */
export function confirmationFor(remedy: Remedy): string | null {
  if (remedy.kind === 'propose_literal_change') return remedy.changes[0]?.id ?? null
  if (remedy.kind === 'propose_restart') return 'restart'
  return null
}
