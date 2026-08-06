import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { registerAdminTools } from '../admin/tools.js'
import { secretEquals } from '../auth.js'
import type { Db } from '../db/index.js'
import { getSetting, SETTING } from '../settings.js'

/**
 * The desk administered over MCP.
 *
 * It sits at `/mcp` rather than under `/api/` on purpose: `/mcp` is what a
 * beaconify sidecar announces and proxies by default, and it keeps this
 * surface visibly separate from the API the browser drives.
 *
 * **Stateless.** `sessionIdGenerator: undefined`, and a fresh server and
 * transport per request. An aggregator in front of us fetches `tools/list` on
 * its own schedule and proxies calls from clients it never tells us about, so
 * there is no conversation here to keep — and a session id we handed out would
 * be one the proxy has no way to give back.
 *
 * **Authentication is a bearer, not the session cookie.** The cookie belongs
 * to a browser; the caller here is a sidecar. The token is its own setting,
 * separate from the ingest token, because that one is pasted into every
 * stringer workflow — see settings.ts.
 *
 * The trust boundary is the network, and it is worth being plain about it: a
 * caller holding this token can rewrite the charter, repoint every outlet and
 * delete configuration. Beaconify carries the token in `BEACONIFY_AUTH` and
 * should be the only thing on the mesh network that has it.
 */

const JSON_RPC_METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'this endpoint is stateless — use POST' },
  id: null,
}

/**
 * The bearer check.
 *
 * Rejections go to the process log rather than the desk's own event log. A
 * sidecar configured with the wrong token re-fetches `tools/list` on a timer,
 * so a row per attempt would bury the log that exists to be readable — and the
 * operator's fix is on the Settings screen, not in the log.
 */
export function requireAdminMcpToken(db: Db) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const expected = getSetting(db, SETTING.adminMcpToken) ?? ''
    if (!presented || !expected || !secretEquals(presented, expected)) {
      request.log.warn({ ip: request.ip }, 'rejected an MCP call with a bad or missing token')
      await reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'invalid administration token' },
        id: null,
      })
    }
  }
}

export function registerAdminMcpRoutes(app: FastifyInstance, db: Db, version: string): void {
  const preHandler = requireAdminMcpToken(db)

  app.post('/mcp', { preHandler }, async (request, reply) => {
    const server = new McpServer(
      { name: 'newsdesk', version },
      {
        instructions:
          'Administration for a Newsdesk editorial desk: the configuration document, its restore points, the operations log and health. Read get_config first. Prefer the upsert_* tools over write_config, which replaces the whole document and deletes whatever is missing from it. This surface cannot approve, publish or spike anything — a human does that at the desk.',
      },
    )
    registerAdminTools(server, db, { version })

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    // Per-request objects, so they have to be torn down per request too —
    // otherwise every call leaks a server and its registered tools.
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    // Fastify must be told the response is no longer its to send, before
    // anything is written to the raw socket.
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })

  // A stateless server has no stream to resume and no session to delete. Both
  // are answered rather than left to the SPA's catch-all, which would hand a
  // confused client an HTML page.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', { preHandler }, async (_request, reply) =>
      reply.code(405).send(JSON_RPC_METHOD_NOT_ALLOWED),
    )
  }
}
