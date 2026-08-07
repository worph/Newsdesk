import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Db } from '../db/index.js'
import type { ReceiveOptions } from '../ports/ingest/receive.js'
import { ADMIN_TOOLS, MCP_CALLER, type AdminToolContext } from './registry.js'

/**
 * The desk as an MCP server: administration, and nothing else.
 *
 * The tools themselves live in `registry.ts`, because the administrator chat
 * dispatches the same list in process. This file is only the adapter that puts
 * them on an `McpServer`, and it is deliberately thin — every decision about
 * what a tool takes, refuses or records belongs to the definition, not to the
 * transport carrying it.
 *
 * Two details here are load-bearing rather than stylistic:
 *
 *   `annotations` is spread conditionally. Seven tools pass none, and with
 *   `exactOptionalPropertyTypes` off, `annotations: undefined` type-checks and
 *   still adds the key at runtime — a change to what `tools/list` answers.
 *
 *   `versionId` is stripped. It is the chat's field for hanging an Undo on a
 *   message; a `CallToolResult` has nowhere to put it, and handing it to the
 *   SDK on the hope it is dropped is not the same as dropping it.
 */

export interface AdminToolOptions {
  /** Reported by `get_status`, and the only thing here that is not a row. */
  version: string
  /**
   * What a filed tip is handed on to. Absent means a tip is stored and goes no
   * further — which is what a desk with no inference does anyway, and is
   * better than refusing the tip.
   */
  receiveOptions?: ReceiveOptions
}

export function registerAdminTools(server: McpServer, db: Db, options: AdminToolOptions): void {
  const ctx: AdminToolContext = {
    db,
    version: options.version,
    ...(options.receiveOptions ? { receiveOptions: options.receiveOptions } : {}),
    // The full ingest token over MCP, and admin-mcp.md says why: a caller
    // holding the administration token could already file with it, so showing
    // it grants nothing. The chat is the surface that redacts.
    caller: MCP_CALLER,
  }

  for (const entry of ADMIN_TOOLS) {
    server.registerTool(
      entry.name,
      {
        title: entry.title,
        description: entry.description,
        inputSchema: entry.inputSchema,
        ...(entry.annotations ? { annotations: entry.annotations } : {}),
      },
      (async (input: never) => {
        const { versionId: _chatOnly, ...result } = await entry.handler(input, ctx)
        return result
      }) as never,
    )
  }
}
