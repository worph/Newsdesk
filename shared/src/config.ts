import { z } from 'zod'
import {
  argsSpecSchema,
  CALL_TEMPLATE_ROOTS,
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

export const STRINGER_KINDS = ['report', 'timeline', 'snapshot', 'tip'] as const
export const OUTLET_ROLES = ['publish', 'notify'] as const
export const OUTLET_DRIVERS = ['mcp', 'webhook', 'builtin'] as const

export const mcpEndpointSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  url: z.string().url(),
})

export const voiceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  tone: z.string().min(1),
  audience: z.string().min(1),
  rules: z.string().optional(),
  examples: z.string().optional(),
})

export const stringerSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  kind: z.enum(STRINGER_KINDS),
  enabled: z.boolean().default(true),
  /** A narrowing note for noisy stringers. Subordinate to the charter. */
  hint: z.string().optional(),
})

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time of day is HH:MM on a 24-hour clock')

/**
 * When an outlet posts, as opposed to what it posts.
 *
 * This is a rhythm, not a queue policy: the desk proposes the next slot that
 * fits and a human always sees it before it is committed. Every field is
 * optional because an outlet that says nothing should behave exactly as it did
 * before scheduling existed — any day, any hour, on demand.
 */
export const cadenceSchema = z.object({
  /** IANA zone. Falls back to the desk-wide timezone setting. */
  timezone: z.string().min(1).optional(),
  /** 0 = Sunday. Omitted means every day. */
  days: z.array(z.number().int().min(0).max(6)).optional(),
  window: z.object({ from: hhmm, to: hhmm }).optional(),
  min_gap_minutes: z.number().int().positive().max(10_080).optional(),
  max_per_day: z.number().int().positive().max(100).optional(),
})

export const outletSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  /** The managing editor reads this to decide what belongs here. */
  description: z.string().min(1),
  role: z.enum(OUTLET_ROLES).default('publish'),
  driver: z.enum(OUTLET_DRIVERS).default('mcp'),
  enabled: z.boolean().default(true),
  voice: idSchema.optional(),
  endpoint: idSchema.optional(),
  tool: z.string().min(1).optional(),
  /**
   * Explicit destination key, for a tool this build does not know about.
   * Required when the tool is unrecognised — see validateConfig.
   */
  destination_key: z.string().min(1).optional(),
  args: argsSpecSchema,
  /** The posting rhythm. Absent means "whenever it is approved". */
  cadence: cadenceSchema.optional(),
})

/**
 * A tool the reporter may call, declared exactly like an outlet — because it is
 * the same thing pointed inward. The desk calls it; the model only supplies the
 * one value that fills `{{ call.query }}` or `{{ call.url }}`.
 *
 * The argument shape lives here rather than in code because the desk cannot
 * know whether a given server wants `q`, `query` or `search_term`, and guessing
 * would make the phase work only for the servers we happened to test.
 */
export const REPORTING_DRIVERS = ['mcp', 'http'] as const

export const reportingToolSchema = z.object({
  /** `http` exists because a search engine is an HTTP API, not an MCP server. */
  driver: z.enum(REPORTING_DRIVERS).default('mcp'),
  /** mcp: which endpoint and which tool. */
  endpoint: idSchema.optional(),
  tool: z.string().min(1).optional(),
  /**
   * http: the address, which is ALWAYS a literal — see validateConfig. Only
   * `args` may interpolate, so nothing the model produces can decide which
   * host the desk talks to.
   */
  url: z.string().url().optional(),
  method: z.enum(['GET', 'POST']).default('GET'),
  args: argsSpecSchema,
})

/**
 * The reporting phase. Absent means the phase does not run at all and tips go
 * straight to the managing editor, exactly as they did before.
 *
 * Both lists are ordered and read as a fallback chain: the first candidate that
 * answers wins, so a slow-but-reliable browser tool earns last place rather
 * than no place. Listing a tool here IS the authorization to call it — the desk
 * calls it unattended, which is safe precisely because the model never names a
 * tool.
 */
export const reportingSchema = z.object({
  enabled: z.boolean().default(true),
  /** Which filing kinds get reported. Tips only, by default. */
  kinds: z.array(z.enum(STRINGER_KINDS)).default(['tip']),
  max_rounds: z.number().int().positive().max(10).default(3),
  max_fetches: z.number().int().positive().max(50).default(8),
  timeout_seconds: z.number().int().positive().max(600).default(60),
  /** After this, the reporter files what it has rather than holding the queue. */
  wall_clock_seconds: z.number().int().positive().max(3600).default(480),
  search: z.array(reportingToolSchema).default([]),
  fetch: z.array(reportingToolSchema).default([]),
})

export const configSchema = z.object({
  charter: z.string().min(1, 'the charter is the placement policy — it cannot be empty'),
  mcp_endpoints: z.array(mcpEndpointSchema).default([]),
  voices: z.array(voiceSchema).default([]),
  stringers: z.array(stringerSchema).default([]),
  outlets: z.array(outletSchema).default([]),
  reporting: reportingSchema.optional(),
})

export type Cadence = z.infer<typeof cadenceSchema>
export type McpEndpoint = z.infer<typeof mcpEndpointSchema>
export type Voice = z.infer<typeof voiceSchema>
export type Stringer = z.infer<typeof stringerSchema>
export type Outlet = z.infer<typeof outletSchema>
export type ReportingTool = z.infer<typeof reportingToolSchema>
export type Reporting = z.infer<typeof reportingSchema>
export type Config = z.infer<typeof configSchema>

/**
 * Destination arguments are OPTIONAL in the live MCP schemas — `channelId` and
 * `chatId` are absent from their `required` lists — so an omitted destination
 * does not error, it silently posts to whatever default the bridge is
 * configured with. That is the worst failure this system can produce and it
 * needs no model involvement to happen, so a publish outlet that does not pin
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

function checkTemplates(
  args: ArgsSpec,
  path: string,
  issues: ConfigIssue[],
  roots: readonly string[] = TEMPLATE_ROOTS,
): void {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || !isDerived(value)) continue
    for (const expr of templateExpressions(value)) {
      const root = expr.split(/[.[]/, 1)[0]
      if (!root || !roots.includes(root)) {
        issues.push({
          path: `${path}.args.${key}`,
          message: `unknown template root "${root ?? ''}" — expected one of ${roots.join(', ')}`,
        })
      }
    }
  }
}

/**
 * A reporting tool is checked more tightly than an outlet: no authoring slots (a
 * model never fills a reporting argument), only the `call` root, and the role's
 * own variable must actually appear — a search tool that never interpolates
 * `{{ call.query }}` would run the same constant search forever and look like
 * it was working.
 */
function checkReportingTool(
  tool: ReportingTool,
  role: 'search' | 'fetch',
  index: number,
  endpointIds: Set<string>,
  issues: ConfigIssue[],
): void {
  const path = `reporting.${role}[${index}]`

  if (tool.driver === 'http') {
    if (!tool.url) {
      issues.push({ path: `${path}.url`, message: 'an http reporting tool needs a url' })
    } else if (templateExpressions(tool.url).length > 0) {
      // The host is the one thing that must not move. Interpolating here would
      // let a query string decide what the desk connects to.
      issues.push({
        path: `${path}.url`,
        message: 'the url must be a literal — put the variable part in args, never in the address',
      })
    }
  } else {
    if (!tool.tool) {
      issues.push({ path: `${path}.tool`, message: 'an mcp reporting tool needs a tool' })
    }
    if (!tool.endpoint) {
      issues.push({ path: `${path}.endpoint`, message: 'an mcp reporting tool needs an endpoint' })
    } else if (!endpointIds.has(tool.endpoint)) {
      issues.push({ path: `${path}.endpoint`, message: `unknown endpoint "${tool.endpoint}"` })
    }
  }

  for (const { key } of slotsOf(tool.args)) {
    issues.push({
      path: `${path}.args.${key}`,
      message:
        'a reporting argument cannot be an authoring slot — the desk fills these, not a model',
    })
  }

  checkTemplates(tool.args, path, issues, CALL_TEMPLATE_ROOTS)

  const variable = role === 'search' ? 'call.query' : 'call.url'
  const usesVariable = Object.values(tool.args).some(
    (value) =>
      typeof value === 'string' &&
      templateExpressions(value).some((expr) => expr.trim() === variable),
  )
  if (!usesVariable) {
    issues.push({
      path: `${path}.args`,
      message: `a ${role} tool must interpolate "{{ ${variable} }}" somewhere in its arguments — without it every call would be identical`,
    })
  }
}

function checkReporting(config: Config, endpointIds: Set<string>, issues: ConfigIssue[]): void {
  const reporting = config.reporting
  if (!reporting || !reporting.enabled) return

  if (reporting.search.length === 0 && reporting.fetch.length === 0) {
    issues.push({
      path: 'reporting',
      message: 'reporting is enabled but declares no search or fetch tools — it could do nothing',
    })
  }

  reporting.search.forEach((tool, i) => checkReportingTool(tool, 'search', i, endpointIds, issues))
  reporting.fetch.forEach((tool, i) => checkReportingTool(tool, 'fetch', i, endpointIds, issues))
}

/**
 * A cadence that cannot be satisfied is worse than none: the proposer would
 * walk its whole search horizon and hand back a slot a month out, which reads
 * as a bug rather than as configuration. Catch the unsatisfiable shapes here,
 * where the message can name the field.
 */
function checkCadence(outlet: Outlet, issues: ConfigIssue[]): void {
  const cadence = outlet.cadence
  if (!cadence) return
  const path = `outlets.${outlet.id}.cadence`

  if (cadence.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: cadence.timezone })
    } catch {
      issues.push({
        path: `${path}.timezone`,
        message: `"${cadence.timezone}" is not a timezone this runtime knows — use an IANA name like "Europe/Paris"`,
      })
    }
  }

  if (cadence.days !== undefined) {
    if (cadence.days.length === 0) {
      issues.push({ path: `${path}.days`, message: 'no days means the outlet could never post — omit the field for every day' })
    }
    for (const day of duplicates(cadence.days.map(String))) {
      issues.push({ path: `${path}.days`, message: `day ${day} is listed twice` })
    }
  }

  const window = cadence.window
  if (window && window.from >= window.to) {
    // Lexical comparison is exact for zero-padded HH:MM, and it is the same
    // check the proposer makes. A window that wraps midnight is not supported:
    // say so rather than silently posting nothing.
    issues.push({
      path: `${path}.window`,
      message: `"${window.from}" is not before "${window.to}" — a window that wraps midnight is not supported, use two outlets or widen the window`,
    })
  }

  if (window && cadence.min_gap_minutes !== undefined) {
    const minutes = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5))
    const span = minutes(window.to) - minutes(window.from)
    if (cadence.min_gap_minutes > span && (cadence.max_per_day ?? 2) > 1) {
      issues.push({
        path: `${path}.min_gap_minutes`,
        message: `a ${cadence.min_gap_minutes}-minute gap does not fit twice in a ${span}-minute window — set max_per_day: 1 if one post a day is what you mean`,
      })
    }
  }
}

function checkDestination(outlet: Outlet, issues: ConfigIssue[]): void {
  const path = `outlets.${outlet.id}`
  if (outlet.role !== 'publish' || outlet.driver !== 'mcp') return

  const key = outlet.destination_key ?? (outlet.tool ? KNOWN_DESTINATION_KEYS[outlet.tool] : undefined)
  if (!key) {
    issues.push({
      path,
      message:
        `tool "${outlet.tool ?? '(none)'}" is not a known destination-bearing tool — ` +
        'declare `destination_key` explicitly so the destination can be checked. ' +
        'An unpinned destination silently posts to the bridge default.',
    })
    return
  }

  const value = outlet.args[key]
  if (value === undefined) {
    issues.push({
      path: `${path}.args.${key}`,
      message: `publish outlet must pin its destination "${key}" as a literal — omitting it posts to the bridge default`,
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
 * `parseMode` and a slot's `format` are one decision written in two places, and
 * a mismatch is invisible until a real send fails — which on Telegram is a 400
 * that spikes the whole message, not a formatting blemish.
 *
 * Nothing here is Telegram-aware beyond the argument name: an outlet that pins
 * `parseMode` is talking to a bridge that parses the message text, and a model
 * never escapes its prose for a delimiter grammar. So the only workable pairing
 * is `parseMode: HTML` with `format: telegram-html` on every prose slot, and
 * every other combination is a configuration bug caught at save time.
 *
 * `Markdown`/`MarkdownV2` cost yunderalabs a publish on 2026-08-01: a body
 * containing `AUTH_HASH` opened an italic entity that never closed.
 */
function checkParseMode(outlet: Outlet, issues: ConfigIssue[]): void {
  const path = `outlets.${outlet.id}`
  const parseMode = outlet.args.parseMode
  const mode = typeof parseMode === 'string' && !isDerived(parseMode) ? parseMode : undefined

  // Slots whose text the destination parses. A url or an image address is
  // carried in its own argument and never read as markup.
  const prose = slotsOf(outlet.args).filter(
    ({ def }) => def.slot === 'markdown' || def.slot === 'text',
  )

  if ((mode === 'Markdown' || mode === 'MarkdownV2') && prose.length > 0) {
    issues.push({
      path: `${path}.args.parseMode`,
      message:
        `"${mode}" cannot carry written copy — every _ * \` [ in the message is a delimiter that ` +
        'must be closed, so one snake_case word fails the send. Use `parseMode: HTML` and give ' +
        `${prose.map((p) => p.key).join(', ')} \`format: telegram-html\`.`,
    })
    return
  }

  if (mode === 'HTML') {
    for (const { key, def } of prose) {
      if (def.format !== 'telegram-html') {
        issues.push({
          path: `${path}.args.${key}`,
          message:
            'this slot is sent as HTML but is not converted to it — add `format: telegram-html`, ' +
            'or the markup shows up as raw text and an unescaped < fails the send.',
        })
      }
    }
  }

  for (const { key, def } of slotsOf(outlet.args)) {
    if (def.format === 'telegram-html' && mode !== 'HTML') {
      issues.push({
        path: `${path}.args.${key}`,
        message: `\`format: telegram-html\` needs \`parseMode: HTML\` pinned on the outlet — ${
          mode ? `this one pins "${mode}"` : 'this one pins none'
        }, so the tags would be shown rather than read.`,
      })
    }
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
    ['voices', config.voices.map((p) => p.id)],
    ['stringers', config.stringers.map((s) => s.id)],
    ['outlets', config.outlets.map((t) => t.id)],
  ] as const) {
    for (const dupe of duplicates([...ids])) {
      issues.push({ path: label, message: `duplicate id "${dupe}"` })
    }
  }

  const voiceIds = new Set(config.voices.map((p) => p.id))
  const endpointIds = new Set(config.mcp_endpoints.map((e) => e.id))

  for (const outlet of config.outlets) {
    const path = `outlets.${outlet.id}`

    if (outlet.voice !== undefined && !voiceIds.has(outlet.voice)) {
      issues.push({ path: `${path}.voice`, message: `unknown voice "${outlet.voice}"` })
    }
    if (outlet.role === 'publish' && outlet.voice === undefined) {
      issues.push({ path: `${path}.voice`, message: 'a publish outlet needs a voice to write in' })
    }

    if (outlet.driver === 'mcp') {
      if (!outlet.tool) {
        issues.push({ path: `${path}.tool`, message: 'an mcp outlet needs a tool' })
      }
      if (!outlet.endpoint) {
        issues.push({ path: `${path}.endpoint`, message: 'an mcp outlet needs an endpoint' })
      } else if (!endpointIds.has(outlet.endpoint)) {
        issues.push({ path: `${path}.endpoint`, message: `unknown endpoint "${outlet.endpoint}"` })
      }
    }

    const slots = slotsOf(outlet.args)
    if (outlet.role === 'publish' && slots.length === 0) {
      issues.push({ path: `${path}.args`, message: 'a publish outlet needs at least one authoring slot' })
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
        message: 'exactly one slot must be primary — it is the document the editor and the copy desk work on',
      })
    }

    checkTemplates(outlet.args, path, issues)
    checkDestination(outlet, issues)
    checkParseMode(outlet, issues)
    checkCadence(outlet, issues)
  }

  checkReporting(config, endpointIds, issues)

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
