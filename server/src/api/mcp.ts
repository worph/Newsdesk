import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import {
  finishOAuth,
  forgetOAuth,
  OAuthFlowError,
  readOAuthState,
  resolveRedirectBase,
  startOAuth,
  summarise,
} from '../ports/mcp/oauth.js'

/**
 * The interactive half of the OAuth port: the operator's browser does the part
 * the desk cannot do for itself.
 *
 * See server/src/ports/mcp/oauth.ts for the flow and why it has to be
 * interactive at all.
 */

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
})

/**
 * A minimal page for the popup the operator started the flow in. It reports to
 * the window that opened it and closes; if it was not opened as a popup —
 * someone pasted the URL, or the browser blocked `window.close` — the text
 * still says what happened.
 */
function callbackPage(ok: boolean, detail: string): string {
  const title = ok ? 'Endpoint connected' : 'Connection failed'
  const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 30rem; padding: 0 1rem; }
  h1 { font-size: 1.1rem; }
  .detail { color: #555; }
  .bad { color: #b00020; }
</style>
<h1>${escape(title)}</h1>
<p class="detail${ok ? '' : ' bad'}">${escape(detail)}</p>
<p class="detail">You can close this window.</p>
<script>
  try { window.opener && window.opener.postMessage({ type: 'newsdesk-oauth', ok: ${ok} }, '*') } catch (e) {}
  setTimeout(function () { try { window.close() } catch (e) {} }, ${ok ? 800 : 4000})
</script>`
}

export function registerMcpRoutes(app: FastifyInstance, db: Db, publicUrl?: string): void {
  const redirectBase = resolveRedirectBase(publicUrl)

  /** Every endpoint with its connection state — what the Settings screen lists. */
  app.get('/api/v1/mcp/endpoints', { preHandler: requireSession }, async () => {
    const rows = db.select().from(schema.mcpEndpoints).all()
    return {
      redirectUri: `${redirectBase.replace(/\/+$/, '')}/api/v1/mcp/oauth/callback`,
      endpoints: rows.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.url,
        oauth: summarise(readOAuthState(row.auth)),
      })),
    }
  })

  /**
   * Start the flow. Returns the URL the browser must visit; the desk cannot
   * follow it itself, which is the whole reason this is interactive.
   */
  app.post<{ Params: { id: string } }>(
    '/api/v1/mcp/endpoints/:id/oauth/start',
    { preHandler: requireSession },
    async (request, reply) => {
      try {
        const authorizationUrl = await startOAuth(db, request.params.id, redirectBase)
        if (!authorizationUrl) {
          // Stored tokens already satisfy the endpoint — nothing to authorize.
          return { status: 'connected' as const }
        }
        logEvent(db, {
          level: 'info',
          code: 'mcp.oauth.started',
          actor: 'human',
          message: `authorization started for endpoint "${request.params.id}"`,
        })
        return { status: 'redirect' as const, authorizationUrl }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logEvent(db, {
          level: 'error',
          code: 'mcp.oauth.failed',
          message: `could not start authorization for "${request.params.id}": ${message}`,
          detail: { endpoint: request.params.id, phase: 'start' },
        })
        return reply.code(err instanceof OAuthFlowError ? 400 : 502).send({ error: message })
      }
    },
  )

  /**
   * Where the authorization server sends the browser back.
   *
   * Unauthenticated by design: this is a top-level navigation the desk did not
   * initiate, and its CSRF defence is the single-use `state` minted at start
   * and compared in constant time. Requiring a session cookie here would add a
   * failure mode (a proxy or browser that drops it on a cross-site redirect)
   * without adding a barrier an attacker could not already pass.
   */
  app.get('/api/v1/mcp/oauth/callback', async (request, reply) => {
    const parsed = callbackQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).type('text/html').send(callbackPage(false, 'malformed callback'))
    }
    const { code, state, error, error_description: description } = parsed.data

    if (error) {
      const detail = description ? `${error}: ${description}` : error
      logEvent(db, {
        level: 'error',
        code: 'mcp.oauth.failed',
        message: `the authorization server refused: ${detail}`,
        detail: { phase: 'callback' },
      })
      return reply.code(400).type('text/html').send(callbackPage(false, detail))
    }
    if (!code || !state) {
      return reply
        .code(400)
        .type('text/html')
        .send(callbackPage(false, 'the callback carried no authorization code'))
    }

    try {
      const endpoint = await finishOAuth(db, state, code, redirectBase)
      const summary = summarise(readOAuthState(db
        .select({ auth: schema.mcpEndpoints.auth })
        .from(schema.mcpEndpoints)
        .where(eq(schema.mcpEndpoints.id, endpoint.id))
        .get()?.auth))

      logEvent(db, {
        level: summary.warning ? 'warn' : 'info',
        code: 'mcp.oauth.connected',
        actor: 'human',
        message: summary.warning
          ? `endpoint "${endpoint.id}" connected without a refresh token`
          : `endpoint "${endpoint.id}" connected`,
        detail: { endpoint: endpoint.id, hasRefreshToken: summary.hasRefreshToken },
      })
      // A connection with no refresh token works now and stops working later,
      // so it is said plainly on the page rather than buried in the log.
      const detail = summary.warning
        ? `${endpoint.name} is connected, but ${summary.warning}.`
        : `${endpoint.name} is connected.`
      return reply.type('text/html').send(callbackPage(true, detail))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logEvent(db, {
        level: 'error',
        code: 'mcp.oauth.failed',
        message: `token exchange failed: ${message}`,
        detail: { phase: 'exchange' },
      })
      return reply.code(400).type('text/html').send(callbackPage(false, message))
    }
  })

  /** Drop the tokens and the registration. The next connect starts clean. */
  app.post<{ Params: { id: string } }>(
    '/api/v1/mcp/endpoints/:id/oauth/forget',
    { preHandler: requireSession },
    async (request, reply) => {
      const row = db
        .select({ id: schema.mcpEndpoints.id })
        .from(schema.mcpEndpoints)
        .where(eq(schema.mcpEndpoints.id, request.params.id))
        .get()
      if (!row) return reply.code(404).send({ error: 'unknown endpoint' })

      forgetOAuth(db, request.params.id)
      logEvent(db, {
        level: 'info',
        code: 'mcp.oauth.forgotten',
        actor: 'human',
        message: `disconnected endpoint "${request.params.id}"`,
      })
      return { status: 'disconnected' as const }
    },
  )
}
