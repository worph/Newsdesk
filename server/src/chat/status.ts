import { listActions } from '../api/actions.js'
import { describeConfig, isUnconfigured, readConfig } from '../config/store.js'
import type { Db } from '../db/index.js'
import { checkHealth, type Health } from '../health.js'
import type { InferenceDriver } from '../ports/inference/types.js'

/**
 * What the desk would tell someone who just sat down.
 *
 * Computed without asking a model anything: three database reads and a probe
 * that reports rather than throws. That is what lets it answer with the Beacon
 * down, the endpoint signed out, or nothing configured at all — and it is why
 * `/status` is a command the desk answers itself rather than a question put to
 * the administrator, who may well be the thing that is broken.
 *
 * One computation, two renderings: the JSON below feeds the /now screen, and
 * `renderStatusReport` turns the same values into the line a chat reads back.
 */

export interface InferenceState {
  available: boolean
  reason?: string
}

export interface DeskStatus {
  actions: ReturnType<typeof listActions>
  total: number
  overdue: number
  health: Health
  configured: boolean
  summary: string
  inference: InferenceState
}

/**
 * Whether a turn could actually run, not merely whether a factory was passed.
 *
 * `driver` is always wired; what decides the answer is the configuration it
 * reads, and `createInferenceDriver` throws when there is no endpoint, when the
 * configured one has been deleted, or when there are several and none was
 * chosen. Reporting a factory that throws on its first call as available would
 * have a brand-new desk claim it could think.
 */
export function inferenceState(driver?: () => InferenceDriver): InferenceState {
  if (!driver) return { available: false, reason: 'no inference is wired on this instance' }
  try {
    driver()
    return { available: true }
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function deskStatus(
  db: Db,
  version: string,
  options: { probeTimeoutMs?: number; driver?: () => InferenceDriver } = {},
): Promise<DeskStatus> {
  const actions = listActions(db)
  const health = await checkHealth(db, version, options.probeTimeoutMs)

  return {
    actions,
    total: actions.length,
    overdue: actions.filter((action) => action.overdue).length,
    health,
    configured: !isUnconfigured(db),
    summary: describeConfig(readConfig(db)),
    inference: inferenceState(options.driver),
  }
}

/**
 * The same status, as something to read in a conversation.
 *
 * Written on the server for the reason every other decided string is: there are
 * no frontend tests, so the wording lives where a test can reach it. Short on
 * purpose — a status that fills the screen is the thing the operator asked to
 * stop seeing.
 */
export function renderStatusReport(status: DeskStatus): string {
  const lines: string[] = []

  lines.push(status.configured ? status.summary : 'No charter yet, so nothing can be placed.')

  const broken = status.health.endpoints.filter((endpoint) => endpoint.status !== 'ok')
  if (status.health.endpoints.length === 0) {
    lines.push('No endpoints, so nothing can be reached.')
  } else if (broken.length === 0) {
    lines.push(`Every endpoint answering (${status.health.endpoints.length}).`)
  } else {
    lines.push(
      `Not answering: ${broken.map((endpoint) => `${endpoint.name} (${endpoint.status})`).join(', ')}.`,
    )
  }

  if (!status.inference.available) {
    lines.push(`No inference: ${status.inference.reason}.`)
  }

  if (status.total === 0) {
    lines.push('Nothing is waiting on you.')
  } else {
    const overdue = status.overdue > 0 ? `, ${status.overdue} overdue` : ''
    lines.push(`${status.total} waiting on you${overdue} — see Needs you.`)
    // Enough to recognise, not the whole list; the screen that owns that is
    // one tap away and says it better.
    for (const action of status.actions.slice(0, 3)) {
      lines.push(`  · ${action.verb}: ${action.title}`)
    }
  }

  return lines.join('\n')
}
