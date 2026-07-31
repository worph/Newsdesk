import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, schema } from '../src/db/index.js'
import { classifyError } from '../src/ports/mcp/client.js'
import {
  attachAuth,
  bearerFor,
  EndpointOAuthProvider,
  endpointForState,
  finishOAuth,
  forgetOAuth,
  noteRefreshToken,
  readOAuthState,
  resolveRedirectBase,
  summarise,
  usesOAuth,
  writeOAuthState,
} from '../src/ports/mcp/oauth.js'
import { probeEndpoint } from '../src/health.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

let dir: string
let handle: ReturnType<typeof openDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsdesk-oauth-'))
  handle = openDb(join(dir, 'test.db'))
  runMigrations(handle.db, migrationsFolder)
  handle.db
    .insert(schema.mcpEndpoints)
    .values({ id: 'beacon', name: 'beacon', url: 'http://127.0.0.1:1/mcp' })
    .run()
})

afterEach(() => {
  handle.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

function authOf(id = 'beacon'): string | null {
  return (
    handle.db
      .select({ auth: schema.mcpEndpoints.auth })
      .from(schema.mcpEndpoints)
      .all()
      .find((row) => row.auth !== undefined)?.auth ?? null
  )
}

describe('oauth state storage', () => {
  it('round-trips through the endpoint row', () => {
    writeOAuthState(handle.db, 'beacon', { tokens: { access_token: 'at', token_type: 'Bearer' } })
    expect(readOAuthState(authOf()).tokens?.access_token).toBe('at')
  })

  it('preserves a static bearer set alongside it', () => {
    // An operator may have both configured while migrating an endpoint across;
    // writing oauth state must not silently drop the other half of the blob.
    handle.db
      .update(schema.mcpEndpoints)
      .set({ auth: JSON.stringify({ bearer: 'legacy', headers: { 'x-trace': '1' } }) })
      .run()

    writeOAuthState(handle.db, 'beacon', { state: 'abc' })
    const blob = JSON.parse(authOf() as string)
    expect(blob.bearer).toBe('legacy')
    expect(blob.headers).toEqual({ 'x-trace': '1' })
    expect(blob.oauth.state).toBe('abc')
  })

  it('deletes a key when the patch sets it to undefined', () => {
    writeOAuthState(handle.db, 'beacon', { state: 'abc', codeVerifier: 'v' })
    writeOAuthState(handle.db, 'beacon', { state: undefined })
    const state = readOAuthState(authOf())
    expect(state.state).toBeUndefined()
    expect(state.codeVerifier).toBe('v')
  })

  it('replaces an unparseable blob rather than refusing to reconnect', () => {
    handle.db.update(schema.mcpEndpoints).set({ auth: 'not json' }).run()
    writeOAuthState(handle.db, 'beacon', { state: 'abc' })
    expect(readOAuthState(authOf()).state).toBe('abc')
  })

  it('forgetting clears the tokens and the registration', () => {
    writeOAuthState(handle.db, 'beacon', {
      tokens: { access_token: 'at', token_type: 'Bearer' },
      client: { client_id: 'cid', redirect_uris: ['https://desk/cb'] },
      connectedAt: '2026-07-31T00:00:00Z',
    })
    forgetOAuth(handle.db, 'beacon')
    expect(readOAuthState(authOf())).toEqual({})
    expect(usesOAuth(authOf())).toBe(false)
  })
})

describe('state is the callback CSRF boundary', () => {
  it('finds the endpoint a state belongs to', () => {
    writeOAuthState(handle.db, 'beacon', { state: 'the-state' })
    expect(endpointForState(handle.db, 'the-state')?.id).toBe('beacon')
  })

  it('matches nothing for a wrong, empty or partial state', () => {
    writeOAuthState(handle.db, 'beacon', { state: 'the-state' })
    expect(endpointForState(handle.db, 'wrong')).toBeUndefined()
    expect(endpointForState(handle.db, '')).toBeUndefined()
    // A prefix must not pass — the compare is over the whole value.
    expect(endpointForState(handle.db, 'the-')).toBeUndefined()
  })

  it('does not match an endpoint with no flow in progress', () => {
    expect(endpointForState(handle.db, 'anything')).toBeUndefined()
  })

  it('consumes the state even when the exchange fails, so a code cannot be replayed', async () => {
    writeOAuthState(handle.db, 'beacon', { state: 'the-state', codeVerifier: 'v' })
    // The endpoint is unroutable, so the exchange throws inside `auth()`; the
    // point is that the one-shot flow material is gone afterwards regardless.
    await expect(
      finishOAuth(handle.db, 'the-state', 'code-1', 'https://desk.example'),
    ).rejects.toThrow()

    const after = readOAuthState(authOf())
    expect(after.state).toBeUndefined()
    expect(after.codeVerifier).toBeUndefined()
    expect(endpointForState(handle.db, 'the-state')).toBeUndefined()
  })

  it('refuses a callback whose state matches no endpoint', async () => {
    await expect(
      finishOAuth(handle.db, 'never-issued', 'code-1', 'https://desk.example'),
    ).rejects.toThrow(/unknown or already-used state/)
  })

  it('mints a fresh state each time the provider is asked', () => {
    const provider = new EndpointOAuthProvider(handle.db, 'beacon', 'https://desk.example')
    const first = provider.state()
    const second = provider.state()
    expect(first).not.toBe(second)
    // Only the newest is live, so a stale authorization cannot be completed.
    expect(endpointForState(handle.db, first)).toBeUndefined()
    expect(endpointForState(handle.db, second)?.id).toBe('beacon')
  })
})

describe('the provider', () => {
  it('registers a redirect URI built from the configured public origin', () => {
    const provider = new EndpointOAuthProvider(handle.db, 'beacon', 'https://desk.example/')
    // The trailing slash must not produce a double slash: the registered URI
    // has to match the one sent later, byte for byte.
    expect(provider.redirectUrl).toBe('https://desk.example/api/v1/mcp/oauth/callback')
    expect(provider.clientMetadata.redirect_uris).toEqual([provider.redirectUrl])
  })

  it('asks to be a public client, so the desk holds no client secret', () => {
    const provider = new EndpointOAuthProvider(handle.db, 'beacon', 'https://desk.example')
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
    expect(provider.clientMetadata.grant_types).toContain('refresh_token')
  })

  it('requests offline access in its fallback scope', () => {
    // The SDK appends prompt=consent only when offline_access is present, and
    // without that an OIDC server issues no refresh token at all.
    const provider = new EndpointOAuthProvider(handle.db, 'beacon', 'https://desk.example')
    expect(provider.clientMetadata.scope).toContain('offline_access')
  })

  it('stores and returns the PKCE verifier, and refuses when there is none', () => {
    const provider = new EndpointOAuthProvider(handle.db, 'beacon', 'https://desk.example')
    expect(() => provider.codeVerifier()).toThrow(/verifier/)
    provider.saveCodeVerifier('v-123')
    expect(provider.codeVerifier()).toBe('v-123')
  })

  it('captures the authorization URL instead of navigating to it', () => {
    const provider = new EndpointOAuthProvider(handle.db, 'beacon', 'https://desk.example')
    provider.redirectToAuthorization(new URL('https://as.example/auth?x=1'))
    expect(provider.authorizationUrl?.toString()).toBe('https://as.example/auth?x=1')
  })
})

describe('a connection with no refresh token', () => {
  it('is recorded as a warning rather than passing silently', () => {
    expect(noteRefreshToken({ access_token: 'at', token_type: 'Bearer' }).warning).toMatch(
      /no refresh token/,
    )
  })

  it('clears the warning once one is issued', () => {
    expect(
      noteRefreshToken({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' }).warning,
    ).toBeUndefined()
  })

  it('reports expired once the access token has aged out', () => {
    const long_ago = new Date(Date.now() - 7200 * 1000).toISOString()
    const summary = summarise({
      tokens: { access_token: 'at', token_type: 'Bearer', expires_in: 3600 },
      connectedAt: long_ago,
    })
    expect(summary.status).toBe('expired')
    expect(summary.hasRefreshToken).toBe(false)
  })

  it('still reports connected past expiry when a refresh token can renew it', () => {
    const long_ago = new Date(Date.now() - 7200 * 1000).toISOString()
    const summary = summarise({
      tokens: { access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt' },
      connectedAt: long_ago,
    })
    expect(summary.status).toBe('connected')
  })
})

describe('connection summary', () => {
  it('is disconnected before anything happens, pending once a flow starts', () => {
    expect(summarise({}).status).toBe('disconnected')
    expect(summarise({ state: 'abc' }).status).toBe('pending')
  })

  it('is connected with a live token', () => {
    const summary = summarise({
      tokens: { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt', scope: 'mcp' },
      connectedAt: new Date().toISOString(),
    })
    expect(summary).toMatchObject({ status: 'connected', hasRefreshToken: true, scope: 'mcp' })
  })

  it('never carries the token itself', () => {
    const summary = summarise({ tokens: { access_token: 'super-secret', token_type: 'Bearer' } })
    expect(JSON.stringify(summary)).not.toContain('super-secret')
  })
})

describe('attaching auth to an endpoint ref', () => {
  it('leaves a static-bearer endpoint untouched', () => {
    handle.db.update(schema.mcpEndpoints).set({ auth: JSON.stringify({ bearer: 'tok' }) }).run()
    const row = handle.db.select().from(schema.mcpEndpoints).get()
    expect(attachAuth(handle.db, row!).authProvider).toBeUndefined()
  })

  it('attaches a provider once the endpoint has an oauth connection', () => {
    writeOAuthState(handle.db, 'beacon', { tokens: { access_token: 'at', token_type: 'Bearer' } })
    const row = handle.db.select().from(schema.mcpEndpoints).get()
    expect(attachAuth(handle.db, row!).authProvider).toBeInstanceOf(EndpointOAuthProvider)
  })

  it('falls back to localhost when no public URL is configured', () => {
    expect(resolveRedirectBase(undefined)).toMatch(/^https?:\/\//)
    expect(resolveRedirectBase('https://desk.example')).toBe('https://desk.example')
  })
})

describe('error classification', () => {
  it('marks an UnauthorizedError as needing auth, not as retryable', () => {
    const error = classifyError(new UnauthorizedError('token expired'))
    expect(error.needsAuth).toBe(true)
    expect(error.retryable).toBe(false)
    // The message has to say what the human should do; the queue cannot fix it.
    expect(error.message).toMatch(/reconnect/i)
  })

  it('marks a bare 401 as needing auth', () => {
    expect(classifyError(new Error('HTTP 401 Unauthorized')).needsAuth).toBe(true)
  })

  it('does not mark ordinary failures as needing auth', () => {
    expect(classifyError(new Error('HTTP 503 busy')).needsAuth).toBe(false)
    expect(classifyError(new Error('fetch failed')).needsAuth).toBe(false)
  })
})

describe('the health probe', () => {
  it('presents the stored access token', async () => {
    // Without this a connected endpoint reports unauthorized forever, which
    // would send the operator chasing a connection that is actually fine.
    let seen: string | null = null
    const server = await import('node:http').then((http) =>
      http.createServer((req, res) => {
        seen = req.headers.authorization ?? null
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
      }),
    )
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as { port: number }

    try {
      const result = await probeEndpoint({
        id: 'beacon',
        name: 'beacon',
        url: `http://127.0.0.1:${port}/mcp`,
        auth: JSON.stringify({ oauth: { tokens: { access_token: 'at-42', token_type: 'Bearer' } } }),
      })
      expect(seen).toBe('Bearer at-42')
      expect(result.status).toBe('ok')
      // The reply is rendered in the UI and must never carry the token.
      expect(JSON.stringify(result)).not.toContain('at-42')
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it('reads the token out of an oauth blob', () => {
    expect(bearerFor(JSON.stringify({ oauth: { tokens: { access_token: 'at' } } }))).toBe('at')
    expect(bearerFor(JSON.stringify({ bearer: 'static' }))).toBeUndefined()
    expect(bearerFor(null)).toBeUndefined()
  })
})
