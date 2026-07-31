import { randomUUID } from 'node:crypto'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.js'
import { schema } from '../../db/index.js'
import { secretEquals } from '../../auth.js'

/**
 * OAuth 2.1 for endpoints that no longer take a pasted token.
 *
 * The desk is a daemon with a human attached: it cannot complete an
 * authorization code flow on its own, but the operator is sitting in front of
 * a browser when they configure an endpoint. So the flow runs once,
 * interactively, and the refresh token it yields is what keeps the desk
 * working unattended afterwards. `beacon-yunderalabs.nsl.sh` advertises
 * `authorization_code` and `refresh_token` and NO `client_credentials`, so
 * there is no headless alternative to offer.
 *
 * Everything the flow produces lives in `mcp_endpoints.auth` as JSON. That
 * column is deliberately not part of the YAML configuration — `writeConfig`
 * only ever writes `name` and `url` — so pushing a new config cannot wipe a
 * connection.
 *
 * See IMPLEMENTATION.md section 5.2.
 */

/** The `oauth` half of the `auth` column. */
export interface OAuthState {
  /** What dynamic client registration gave us, or a statically configured client. */
  client?: OAuthClientInformationFull
  tokens?: OAuthTokens
  /** PKCE verifier, live only between `start` and `callback`. */
  codeVerifier?: string
  /** Single-use CSRF token, live only between `start` and `callback`. */
  state?: string
  startedAt?: string
  connectedAt?: string
  /**
   * Set when the authorization server issued no refresh token. The access
   * token then dies in an hour or so with no way to renew it, and the only fix
   * is a human reconnecting — which is worth saying out loud rather than
   * discovering at 3am. See `noteRefreshToken`.
   */
  warning?: string
}

/** Reading and writing the `oauth` object inside the endpoint's auth blob. */
export function readOAuthState(raw: string | null | undefined): OAuthState {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { oauth?: OAuthState }
    return parsed?.oauth ?? {}
  } catch {
    return {}
  }
}

/**
 * Merge `patch` into the stored oauth state, preserving any sibling keys
 * (`bearer`, `headers`) the operator may also have set. A key set to
 * `undefined` is removed.
 */
export function writeOAuthState(db: Db, endpointId: string, patch: Partial<OAuthState>): OAuthState {
  const row = db
    .select({ auth: schema.mcpEndpoints.auth })
    .from(schema.mcpEndpoints)
    .where(eq(schema.mcpEndpoints.id, endpointId))
    .get()

  let blob: Record<string, unknown> = {}
  try {
    const parsed = row?.auth ? (JSON.parse(row.auth) as unknown) : {}
    if (typeof parsed === 'object' && parsed !== null) blob = parsed as Record<string, unknown>
  } catch {
    // An unparseable blob is replaced rather than allowed to block a reconnect.
  }

  const next: OAuthState = { ...((blob.oauth as OAuthState | undefined) ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key as keyof OAuthState]
    else (next as Record<string, unknown>)[key] = value
  }

  blob.oauth = next
  db.update(schema.mcpEndpoints)
    .set({ auth: JSON.stringify(blob) })
    .where(eq(schema.mcpEndpoints.id, endpointId))
    .run()
  return next
}

export interface EndpointRow {
  id: string
  name: string
  url: string
  auth: string | null
}

function loadEndpoint(db: Db, endpointId: string): EndpointRow | undefined {
  return db
    .select({
      id: schema.mcpEndpoints.id,
      name: schema.mcpEndpoints.name,
      url: schema.mcpEndpoints.url,
      auth: schema.mcpEndpoints.auth,
    })
    .from(schema.mcpEndpoints)
    .where(eq(schema.mcpEndpoints.id, endpointId))
    .get()
}

/**
 * The scope we ask for when nothing better is advertised.
 *
 * Only a fallback: SDK 1.30 implements the spec's scope selection (SEP-835),
 * which prefers the `WWW-Authenticate` scope, then the protected resource
 * metadata's `scopes_supported`, and reaches this only if both are silent.
 * The live Beacon advertises `["mcp","offline_access"]`, so in practice the
 * resource decides. `offline_access` matters either way — the SDK appends
 * `prompt=consent` when it is present, without which an OIDC server silently
 * declines to issue a refresh token.
 */
export const FALLBACK_SCOPE = 'mcp offline_access'

/**
 * An `OAuthClientProvider` whose storage is one endpoint row.
 *
 * The SDK drives: it calls these methods while running discovery, dynamic
 * registration, the authorization request and token exchange. Nothing here
 * makes protocol decisions — it is storage plus one piece of plumbing
 * (`redirectToAuthorization`, which on a server captures the URL instead of
 * navigating to it).
 */
export class EndpointOAuthProvider implements OAuthClientProvider {
  /** Captured by `redirectToAuthorization`, read by `startAuthorization`. */
  authorizationUrl?: URL

  constructor(
    private readonly db: Db,
    private readonly endpointId: string,
    private readonly redirectBase: string,
  ) {}

  get redirectUrl(): string {
    return `${this.redirectBase.replace(/\/+$/, '')}${CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Newsdesk',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // The AS advertises `none`, and a public client with PKCE means there is
      // no client secret for the desk to hold.
      token_endpoint_auth_method: 'none',
      scope: FALLBACK_SCOPE,
    }
  }

  private read(): OAuthState {
    return readOAuthState(loadEndpoint(this.db, this.endpointId)?.auth)
  }

  state(): string {
    const value = randomUUID()
    writeOAuthState(this.db, this.endpointId, { state: value, startedAt: new Date().toISOString() })
    return value
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.read().client
  }

  saveClientInformation(client: OAuthClientInformationFull): void {
    writeOAuthState(this.db, this.endpointId, { client })
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    writeOAuthState(this.db, this.endpointId, {
      tokens,
      connectedAt: new Date().toISOString(),
      ...noteRefreshToken(tokens),
    })
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    writeOAuthState(this.db, this.endpointId, { codeVerifier })
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier
    if (!verifier) throw new Error('no PKCE verifier stored — start the flow again')
    return verifier
  }
}

/**
 * A token response with no refresh token is not an error, but it does mean the
 * connection has an expiry the operator has not been told about.
 *
 * Beacon hit this against the same authorization server and traced it to a
 * missing `prompt=consent`; SDK 1.30 sends that itself, so reaching here now
 * means the server declined offline access for some other reason. Either way
 * the failure is silent unless we record it.
 */
export function noteRefreshToken(tokens: OAuthTokens): Pick<OAuthState, 'warning'> {
  if (tokens.refresh_token) return { warning: undefined }
  return {
    warning:
      'the authorization server issued no refresh token, so this connection expires and must be reconnected by hand',
  }
}

export const CALLBACK_PATH = '/api/v1/mcp/oauth/callback'

export type ConnectionStatus = 'connected' | 'expired' | 'pending' | 'disconnected'

export interface OAuthSummary {
  status: ConnectionStatus
  connectedAt?: string
  scope?: string
  hasRefreshToken: boolean
  warning?: string
}

export function summarise(state: OAuthState): OAuthSummary {
  const tokens = state.tokens
  if (!tokens?.access_token) {
    return {
      status: state.state ? 'pending' : 'disconnected',
      hasRefreshToken: false,
      ...(state.warning ? { warning: state.warning } : {}),
    }
  }
  // Without a refresh token an expired access token is terminal, so it is
  // reported as expired rather than connected. With one, the SDK renews on
  // demand and the connection is still good.
  const expired = isExpired(state) && !tokens.refresh_token
  return {
    status: expired ? 'expired' : 'connected',
    hasRefreshToken: Boolean(tokens.refresh_token),
    ...(state.connectedAt ? { connectedAt: state.connectedAt } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(state.warning ? { warning: state.warning } : {}),
  }
}

function isExpired(state: OAuthState): boolean {
  const { tokens, connectedAt } = state
  if (!tokens?.expires_in || !connectedAt) return false
  const issued = Date.parse(connectedAt)
  if (Number.isNaN(issued)) return false
  return Date.now() > issued + tokens.expires_in * 1000
}

/** True if this endpoint is meant to authenticate over OAuth at all. */
export function usesOAuth(raw: string | null | undefined): boolean {
  const state = readOAuthState(raw)
  return Boolean(state.client || state.tokens || state.state)
}

export class OAuthFlowError extends Error {}

/**
 * Begin the flow: discovery, dynamic registration and a built authorization
 * URL, all driven by the SDK. Returns the URL for the operator's browser, or
 * `null` when stored tokens already satisfy the endpoint.
 */
export async function startOAuth(
  db: Db,
  endpointId: string,
  redirectBase: string,
): Promise<string | null> {
  const endpoint = loadEndpoint(db, endpointId)
  if (!endpoint) throw new OAuthFlowError(`unknown endpoint "${endpointId}"`)

  const provider = new EndpointOAuthProvider(db, endpointId, redirectBase)
  const result = await auth(provider, { serverUrl: endpoint.url })
  if (result === 'AUTHORIZED') return null
  if (!provider.authorizationUrl) {
    throw new OAuthFlowError('the authorization server produced no authorization URL')
  }
  return provider.authorizationUrl.toString()
}

/**
 * Find the endpoint a callback belongs to by its `state`.
 *
 * `state` is the CSRF boundary for the callback, which is why it is compared
 * in constant time and consumed on use. The callback deliberately does not
 * also demand a session cookie: it is a top-level navigation initiated by the
 * authorization server, and an unguessable single-use token is exactly the
 * defence OAuth specifies for it.
 */
export function endpointForState(db: Db, state: string): EndpointRow | undefined {
  if (!state) return undefined
  const rows = db
    .select({
      id: schema.mcpEndpoints.id,
      name: schema.mcpEndpoints.name,
      url: schema.mcpEndpoints.url,
      auth: schema.mcpEndpoints.auth,
    })
    .from(schema.mcpEndpoints)
    .all()

  return rows.find((row) => {
    const stored = readOAuthState(row.auth).state
    return Boolean(stored) && secretEquals(stored as string, state)
  })
}

/** Exchange the authorization code for tokens and clear the one-shot flow state. */
export async function finishOAuth(
  db: Db,
  state: string,
  code: string,
  redirectBase: string,
): Promise<EndpointRow> {
  const endpoint = endpointForState(db, state)
  if (!endpoint) throw new OAuthFlowError('unknown or already-used state')

  const provider = new EndpointOAuthProvider(db, endpoint.id, redirectBase)
  try {
    const result = await auth(provider, { serverUrl: endpoint.url, authorizationCode: code })
    if (result !== 'AUTHORIZED') {
      throw new OAuthFlowError('the authorization server did not complete the exchange')
    }
  } finally {
    // The verifier and state are single-use whether or not the exchange
    // worked; leaving them behind would let a replay through.
    writeOAuthState(db, endpoint.id, { state: undefined, codeVerifier: undefined })
  }
  return endpoint
}

/** Drop the tokens and the registration, so the next connect starts clean. */
export function forgetOAuth(db: Db, endpointId: string): void {
  writeOAuthState(db, endpointId, {
    client: undefined,
    tokens: undefined,
    codeVerifier: undefined,
    state: undefined,
    startedAt: undefined,
    connectedAt: undefined,
    warning: undefined,
  })
}

/** The access token to present, if we hold one. */
export function bearerFor(raw: string | null | undefined): string | undefined {
  return readOAuthState(raw).tokens?.access_token
}

/**
 * Where the authorization server sends the operator's browser back to.
 *
 * It must match the URI registered at DCR time exactly, so it cannot be
 * guessed from an inbound request — behind a reverse proxy that would be the
 * internal address. `NEWSDESK_PUBLIC_URL` is the one place it is configured;
 * the default suits a desk reached directly on localhost in development.
 */
export function resolveRedirectBase(explicit?: string): string {
  return explicit ?? process.env.NEWSDESK_PUBLIC_URL ?? 'http://localhost:8080'
}

/**
 * Turn an endpoint row into a ref the MCP client can use, attaching an OAuth
 * provider when the row has a connection. Rows still using a static bearer are
 * returned untouched, so nothing changes for endpoints that never moved.
 */
export function attachAuth<T extends { id: string; name: string; url: string; auth?: string | null }>(
  db: Db,
  row: T,
  redirectBase?: string,
): T & { authProvider?: EndpointOAuthProvider } {
  if (!usesOAuth(row.auth)) return row
  return {
    ...row,
    authProvider: new EndpointOAuthProvider(db, row.id, resolveRedirectBase(redirectBase)),
  }
}
