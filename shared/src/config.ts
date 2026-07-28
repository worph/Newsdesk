import { z } from 'zod'
import {
  argsSpecSchema,
  isDerived,
  isSlot,
  primarySlotKey,
  slotsOf,
  TEMPLATE_ROOTS,
  templateExpressions,
  type ArgsSpec,
} from './slots.js'

const idSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lower-case, digits and hyphens')

export const SOURCE_KINDS = ['report', 'timeline', 'snapshot', 'idea'] as const
export const TARGET_ROLES = ['publish', 'notify'] as const
export const TARGET_DRIVERS = ['mcp', 'webhook', 'builtin'] as const

export const mcpEndpointSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  url: z.string().url(),
})

export const personaSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  voice: z.string().min(1),
  audience: z.string().min(1),
  rules: z.string().optional(),
  examples: z.string().optional(),
})

export const sourceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  kind: z.enum(SOURCE_KINDS),
  enabled: z.boolean().default(true),
  /** A narrowing note for noisy sources. Subordinate to the charter. */
  hint: z.string().optional(),
})

export const targetSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  /** The director reads this to decide what belongs here. */
  description: z.string().min(1),
  role: z.enum(TARGET_ROLES).default('publish'),
  driver: z.enum(TARGET_DRIVERS).default('mcp'),
  enabled: z.boolean().default(true),
  persona: idSchema.optional(),
  endpoint: idSchema.optional(),
  tool: z.string().min(1).optional(),
  /**
   * Explicit destination key, for a tool this build does not know about.
   * Required when the tool is unrecognised — see validateConfig.
   */
  destination_key: z.string().min(1).optional(),
  args: argsSpecSchema,
})

export const configSchema = z.object({
  charter: z.string().min(1, 'the charter is the routing policy — it cannot be empty'),
  mcp_endpoints: z.array(mcpEndpointSchema).default([]),
  personas: z.array(personaSchema).default([]),
  sources: z.array(sourceSchema).default([]),
  targets: z.array(targetSchema).default([]),
})

export type McpEndpoint = z.infer<typeof mcpEndpointSchema>
export type Persona = z.infer<typeof personaSchema>
export type Source = z.infer<typeof sourceSchema>
export type Target = z.infer<typeof targetSchema>
export type Config = z.infer<typeof configSchema>

/**
 * Destination arguments are OPTIONAL in the live MCP schemas — `channelId` and
 * `chatId` are absent from their `required` lists — so an omitted destination
 * does not error, it silently posts to whatever default the bridge is
 * configured with. That is the worst failure this system can produce and it
 * needs no model involvement to happen, so a publish target that does not pin
 * its destination as a literal must fail validation at save time.
 *
 * Verified against the live Beacons 2026-07-28; see IMPLEMENTATION.md 5.2.1.
 */
export const KNOWN_DESTINATION_KEYS: Readonly<Record<string, string>> = {
  'discord-mcp__send_embed': 'channelId',
  'discord-mcp__send_message': 'channelId',
  'telegram-mcp__send_message': 'chatId',
  'telegram-mcp__send_photo': 'chatId',
  'nextcloud-talk-mcp__talk_send_message': 'token',
}

export interface ConfigIssue {
  path: string
  message: string
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  return [...dupes]
}

function checkTemplates(args: ArgsSpec, path: string, issues: ConfigIssue[]): void {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || !isDerived(value)) continue
    for (const expr of templateExpressions(value)) {
      const root = expr.split(/[.[]/, 1)[0]
      if (!root || !(TEMPLATE_ROOTS as readonly string[]).includes(root)) {
        issues.push({
          path: `${path}.args.${key}`,
          message: `unknown template root "${root ?? ''}" — expected one of ${TEMPLATE_ROOTS.join(', ')}`,
        })
      }
    }
  }
}

function checkDestination(target: Target, issues: ConfigIssue[]): void {
  const path = `targets.${target.id}`
  if (target.role !== 'publish' || target.driver !== 'mcp') return

  const key = target.destination_key ?? (target.tool ? KNOWN_DESTINATION_KEYS[target.tool] : undefined)
  if (!key) {
    issues.push({
      path,
      message:
        `tool "${target.tool ?? '(none)'}" is not a known destination-bearing tool — ` +
        'declare `destination_key` explicitly so the destination can be checked. ' +
        'An unpinned destination silently posts to the bridge default.',
    })
    return
  }

  const value = target.args[key]
  if (value === undefined) {
    issues.push({
      path: `${path}.args.${key}`,
      message: `publish target must pin its destination "${key}" as a literal — omitting it posts to the bridge default`,
    })
    return
  }
  if (isSlot(value)) {
    issues.push({
      path: `${path}.args.${key}`,
      message: `destination "${key}" must be a literal, not an authoring slot — a model must never write an address`,
    })
    return
  }
  if (isDerived(value)) {
    issues.push({
      path: `${path}.args.${key}`,
      message: `destination "${key}" must be a literal, not a derived template`,
    })
    return
  }
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({
      path: `${path}.args.${key}`,
      message: `destination "${key}" must be a non-empty string`,
    })
  }
}

/**
 * Semantic validation on top of the shape check. These are errors, not
 * warnings — a config that fails any of them must not be saved.
 */
export function validateConfig(config: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = []

  for (const [label, ids] of [
    ['mcp_endpoints', config.mcp_endpoints.map((e) => e.id)],
    ['personas', config.personas.map((p) => p.id)],
    ['sources', config.sources.map((s) => s.id)],
    ['targets', config.targets.map((t) => t.id)],
  ] as const) {
    for (const dupe of duplicates([...ids])) {
      issues.push({ path: label, message: `duplicate id "${dupe}"` })
    }
  }

  const personaIds = new Set(config.personas.map((p) => p.id))
  const endpointIds = new Set(config.mcp_endpoints.map((e) => e.id))

  for (const target of config.targets) {
    const path = `targets.${target.id}`

    if (target.persona !== undefined && !personaIds.has(target.persona)) {
      issues.push({ path: `${path}.persona`, message: `unknown persona "${target.persona}"` })
    }
    if (target.role === 'publish' && target.persona === undefined) {
      issues.push({ path: `${path}.persona`, message: 'a publish target needs a persona to write in' })
    }

    if (target.driver === 'mcp') {
      if (!target.tool) {
        issues.push({ path: `${path}.tool`, message: 'an mcp target needs a tool' })
      }
      if (!target.endpoint) {
        issues.push({ path: `${path}.endpoint`, message: 'an mcp target needs an endpoint' })
      } else if (!endpointIds.has(target.endpoint)) {
        issues.push({ path: `${path}.endpoint`, message: `unknown endpoint "${target.endpoint}"` })
      }
    }

    const slots = slotsOf(target.args)
    if (target.role === 'publish' && slots.length === 0) {
      issues.push({ path: `${path}.args`, message: 'a publish target needs at least one authoring slot' })
    }
    const primaries = slots.filter(({ def }) => def.primary)
    if (primaries.length > 1) {
      issues.push({
        path: `${path}.args`,
        message: `at most one slot may be primary — found ${primaries.map((p) => p.key).join(', ')}`,
      })
    }
    if (slots.length > 0 && primaries.length === 0) {
      issues.push({
        path: `${path}.args`,
        message: 'exactly one slot must be primary — it is the document the editor and assistant work on',
      })
    }

    checkTemplates(target.args, path, issues)
    checkDestination(target, issues)
  }

  return issues
}

export interface ParsedConfig {
  config: Config
  issues: ConfigIssue[]
}

/** Shape check then semantic check. Throws only on a shape failure. */
export function parseConfig(input: unknown): ParsedConfig {
  const config = configSchema.parse(input)
  return { config, issues: validateConfig(config) }
}

export { primarySlotKey, slotsOf }
