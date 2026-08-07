import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { ADMIN_TOOLS, type AdminTool } from '../admin/registry.js'

/**
 * The tool catalogue, as the model reads it.
 *
 * Generated from the registry rather than written by hand, which is the whole
 * point of the registry existing: the list the model chooses from and the
 * validator that rejects its arguments are the same object, so they cannot
 * drift into disagreeing about what a tool takes.
 *
 * The schemas are rendered as JSON Schema by the same library the MCP SDK uses
 * for `tools/list`, so a model that has seen this desk over MCP sees the same
 * shapes here.
 */

/** Marked so the model knows the call will be offered rather than run. */
function needsConfirmation(entry: AdminTool): boolean {
  return typeof entry.confirmWith === 'function'
}

function renderTool(entry: AdminTool): string {
  const schema = zodToJsonSchema(z.object(entry.inputSchema), { $refStrategy: 'none' })

  return [
    `### ${entry.name}`,
    '',
    entry.description,
    ...(needsConfirmation(entry)
      ? [
          '',
          '**Changes or deletes configuration.** Calling this does not run it: it is offered to the',
          'operator, who confirms it themselves. Say what you propose and why, then stop.',
        ]
      : []),
    '',
    'Arguments:',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
  ].join('\n')
}

export function renderCatalogue(tools: AdminTool[] = ADMIN_TOOLS): string {
  return tools.map(renderTool).join('\n\n')
}

/** The names a dispatcher will accept, in the order the catalogue lists them. */
export function catalogueNames(tools: AdminTool[] = ADMIN_TOOLS): string[] {
  return tools.map((entry) => entry.name)
}
