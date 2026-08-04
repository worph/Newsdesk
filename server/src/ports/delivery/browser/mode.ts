import { publishModeOf, type PublishMode } from '@newsdesk/shared'
import type { schema } from '../../../db/index.js'
import { McpError } from '../../mcp/client.js'

/**
 * How a browser publish finishes, resolved from the outlet.
 *
 * One function so the default lives in one place. It used to be inferred from
 * whether the recipe had a `## Hand over` section, which made the answer a
 * property of a prose document — readable only by parsing it, and wrong for any
 * destination that saves as you type. See docs/browser-publishing.md §3.
 */

export type { PublishMode }

type Outlet = typeof schema.outlets.$inferSelect

/**
 * The mode this outlet publishes in.
 *
 * `requires_human` is checked here as well as at save time, and the duplication
 * is deliberate. Validation covers configuration written through the desk; this
 * covers a row written round it — a restored snapshot, a hand-edited database, a
 * build where the two disagree. The one thing that must never happen quietly is
 * a destination whose terms require a person publishing without one, so the
 * check lives at the point of use rather than only at the point of entry.
 */
export function resolveMode(outlet: Pick<Outlet, 'id' | 'publish' | 'requiresHuman'>): PublishMode {
  const mode = publishModeOf({ publish: (outlet.publish ?? undefined) as PublishMode | undefined })

  if (mode === 'auto' && outlet.requiresHuman) {
    throw new McpError(
      `outlet "${outlet.id}" is marked as requiring a person, so it must not publish by itself`,
      false,
    )
  }

  return mode
}

/** Does the desk itself press this destination's send button? */
export function committedByDesk(mode: PublishMode): boolean {
  return mode === 'auto'
}
