export interface ConfigIssue {
  path: string
  message: string
}

export interface EndpointHealth {
  id: string
  name: string
  url: string
  status: 'ok' | 'unauthorized' | 'unreachable' | 'error'
  detail?: string
  latencyMs?: number
}

export interface Health {
  ok: boolean
  version: string
  configured: boolean
  endpoints: EndpointHealth[]
}

export interface OAuthSummary {
  status: 'connected' | 'expired' | 'pending' | 'disconnected'
  connectedAt?: string
  scope?: string
  hasRefreshToken: boolean
  warning?: string
}

export interface McpEndpointRow {
  id: string
  name: string
  url: string
  oauth: OAuthSummary
}

/**
 * The configuration as the forms edit it. Declared here rather than imported
 * from @newsdesk/shared for the same reason every other type in this file is:
 * the browser wants the shape, not zod. The server remains the authority —
 * anything built here is validated by `parseConfig` before it is stored.
 */
export interface Voice {
  id: string
  name: string
  tone: string
  audience: string
  rules?: string
  examples?: string
}

export type StringerKind = 'report' | 'timeline' | 'snapshot' | 'tip'

export interface Stringer {
  id: string
  name: string
  kind: StringerKind
  enabled: boolean
  hint?: string
}

/** Read-only in the forms until the outlet editor lands; see IMPLEMENTATION 5.2. */
export interface Outlet {
  id: string
  name: string
  description: string
  role: 'publish' | 'notify'
  driver: 'mcp' | 'webhook' | 'builtin'
  enabled: boolean
  voice?: string
  endpoint?: string
  tool?: string
  destination_key?: string
  args: Record<string, unknown>
}

export interface AppConfig {
  charter: string
  mcp_endpoints: Array<{ id: string; name: string; url: string }>
  voices: Voice[]
  stringers: Stringer[]
  outlets: Outlet[]
  /** Untouched by the forms — round-tripped so saving cannot drop it. */
  reporting?: unknown
}

export interface ConfigPayload {
  yaml: string
  config: AppConfig
  issues: ConfigIssue[]
  ingestToken: string
}

/** Either the typed object the forms build or the document the editor holds. */
export type ConfigInput = { config: AppConfig } | { yaml: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: ConfigIssue[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? response.statusText, body.issues ?? [])
  }
  return body as T
}

export interface FilingRow {
  id: string
  stringerId: string
  stringerName: string | null
  kind: string
  status: string
  outcome: string | null
  filedAt: string | null
  receivedAt: string
  textLength: number
  consideredChars: number
}

/** The story file the reporter produced. See docs/pitch-and-reporting.md section 7. */
export interface Dossier {
  headline: string
  brief: string
  angle: string | null
  /** Every claim here cites a page the desk actually retrieved. */
  sourced: Array<{ claim: string; url: string; as_of: string | null }>
  chronology: Array<{ when: string; what: string; url: string | null }>
  unknowns: string[]
  /** Model background knowledge. Undated, unverified, deliberately kept apart. */
  recall: Array<{ claim: string }>
  body: string | null
}

export interface DossierSource {
  id: string
  url: string
  title: string | null
  via: 'tip' | 'search'
  query: string | null
  ok: boolean
  chars: number | null
  fetchedAt: string
}

export interface FilingDetail extends Omit<FilingRow, 'textLength' | 'consideredChars'> {
  text: string
  considered: string | null
  dossier: Dossier | null
  reportedAt: string | null
  refs: Record<string, unknown> | null
}

export interface TipTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface EventRow {
  id: number
  at: string
  level: 'debug' | 'info' | 'warn' | 'error'
  actor: string
  code: string
  message: string
  detail: unknown
}

export interface StoryPlacement {
  id: string
  outletId: string
  outletName: string | null
  status: string
  origin: string
  placementReason: string | null
  angle: string | null
}

export interface StoryRow {
  id: string
  title: string
  summary: string
  url: string | null
  status: string
  dedupVerdict: string
  dedupReason: string | null
  relatedStoryId: string | null
  relatedTitle: string | null
  label: string | null
  dropReason: string | null
  holdReason: string | null
  createdAt: string
  sourceCount: number
  placements: StoryPlacement[]
}

export interface StoryDetail {
  story: StoryRow & { comparedIds: string[]; proposedPlacements: unknown[]; body: string | null }
  filings: Array<{
    id: string
    stringerId: string
    stringerName: string | null
    kind: string
    receivedAt: string
    considered: string | null
  }>
  placements: StoryPlacement[]
  related: { id: string; title: string; summary: string } | null
}

export interface JobRow {
  id: string
  kind: string
  refId: string
  status: string
  attempts: number
  runAfter: string
  lastError: string | null
  createdAt: string
}

export interface SlotDef {
  slot: 'text' | 'markdown' | 'image' | 'link'
  label: string
  max?: number
  optional: boolean
  primary: boolean
  hint?: string
}

export interface PayloadPreview {
  payload: Record<string, unknown>
  authored: string[]
  fixed: string[]
  missing: string[]
}

export interface PublicationDetail {
  publication: {
    id: string
    storyId: string
    outletId: string
    status: string
    origin: string
    placementReason: string | null
    angle: string | null
    slots: Record<string, string>
    payload: string | null
    error: string | null
    approvedAt: string | null
    publishedAt: string | null
  }
  story: { id: string; title: string; summary: string; url: string | null; dedupVerdict: string }
  outlet: { id: string; name: string; description: string; role: string; driver: string; tool: string | null }
  slotSpec: Record<string, SlotDef>
  preview: PayloadPreview
  siblings: Array<{ id: string; outletId: string; status: string }>
}

export interface DraftVersion {
  id: string
  publicationId: string
  slots: Record<string, string>
  origin: 'writer' | 'copy-desk' | 'human'
  createdAt: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  versionId: string | null
  createdAt: string
}

export const api = {
  /** `passwordRequired: false` — a gate or a dev stack signed you in, so there is nothing to sign out of. */
  me: () => request<{ authenticated: boolean; passwordRequired: boolean }>('/api/v1/auth/me'),
  login: (password: string) =>
    request<{ ok: true }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/v1/auth/logout', { method: 'POST' }),
  health: () => request<Health>('/healthz'),
  getConfig: () => request<ConfigPayload>('/api/v1/config'),
  validateConfig: (input: ConfigInput) =>
    request<{ ok: boolean; issues: ConfigIssue[]; config: AppConfig; yaml: string }>('/api/v1/config/validate', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  saveConfig: (input: ConfigInput) =>
    request<{ ok: true; yaml: string; config: AppConfig }>('/api/v1/config', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  rotateIngestToken: () =>
    request<{ ingestToken: string }>('/api/v1/config/ingest-token/rotate', { method: 'POST' }),

  listMcpEndpoints: () =>
    request<{ redirectUri: string; endpoints: McpEndpointRow[] }>('/api/v1/mcp/endpoints'),
  startOAuth: (id: string) =>
    request<{ status: 'connected' | 'redirect'; authorizationUrl?: string }>(
      `/api/v1/mcp/endpoints/${encodeURIComponent(id)}/oauth/start`,
      { method: 'POST' },
    ),
  forgetOAuth: (id: string) =>
    request<{ status: 'disconnected' }>(
      `/api/v1/mcp/endpoints/${encodeURIComponent(id)}/oauth/forget`,
      { method: 'POST' },
    ),

  listFilings: (params: { stringer?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.stringer) search.set('stringer', params.stringer)
    if (params.limit) search.set('limit', String(params.limit))
    const qs = search.toString()
    return request<{ filings: FilingRow[] }>(`/api/v1/filings${qs ? `?${qs}` : ''}`)
  },
  getFiling: (id: string) =>
    request<{ filing: FilingDetail; sources: DossierSource[] }>(`/api/v1/filings/${id}`),
  reportFiling: (id: string) =>
    request<{ queued: true }>(`/api/v1/filings/${id}/report`, { method: 'POST' }),
  postTip: (body: { text: string; url?: string }) =>
    request<{ result: { id: string; note: string } }>('/api/v1/tips', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  assistTip: (body: { text: string; history: TipTurn[]; message: string }) =>
    request<{ reply: string; text: string }>('/api/v1/tips/assist', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listStories: (params: { status?: string; q?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.status) search.set('status', params.status)
    if (params.q) search.set('q', params.q)
    if (params.limit) search.set('limit', String(params.limit))
    const qs = search.toString()
    return request<{ stories: StoryRow[] }>(`/api/v1/stories${qs ? `?${qs}` : ''}`)
  },
  getStory: (id: string) => request<StoryDetail>(`/api/v1/stories/${id}`),
  addPlacement: (id: string, body: { outlet_id: string; reason?: string }) =>
    request<{ id: string }>(`/api/v1/stories/${id}/placements`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rerunStory: (id: string) =>
    request<{ queued: number }>(`/api/v1/stories/${id}/rerun`, { method: 'POST' }),
  listJobs: () => request<{ stats: Record<string, number>; jobs: JobRow[] }>('/api/v1/jobs'),
  getPublication: (id: string) => request<PublicationDetail>(`/api/v1/publications/${id}`),
  savePublication: (id: string, slots: Record<string, string>) =>
    request<{ slots: Record<string, string>; versionId: string }>(`/api/v1/publications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ slots }),
    }),
  listVersions: (id: string) =>
    request<{ versions: DraftVersion[] }>(`/api/v1/publications/${id}/versions`),
  revertPublication: (id: string, versionId: string) =>
    request<{ slots: Record<string, string> }>(`/api/v1/publications/${id}/revert`, {
      method: 'POST',
      body: JSON.stringify({ version_id: versionId }),
    }),
  getPayload: (id: string) =>
    request<PayloadPreview & { frozen: boolean }>(`/api/v1/publications/${id}/payload`),
  approvePublication: (id: string) =>
    request<{ status: string; payload: Record<string, unknown> }>(
      `/api/v1/publications/${id}/approve`,
      { method: 'POST' },
    ),
  rejectPublication: (id: string, reason?: string) =>
    request<{ status: string }>(`/api/v1/publications/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  retryPublication: (id: string) =>
    request<{ queued: boolean }>(`/api/v1/publications/${id}/retry`, { method: 'POST' }),
  listChat: (id: string) => request<{ messages: ChatMessage[] }>(`/api/v1/publications/${id}/chat`),
  sendChat: (id: string, message: string) =>
    request<{ reply: string; slots: Record<string, string>; versionId: string }>(
      `/api/v1/publications/${id}/chat`,
      { method: 'POST', body: JSON.stringify({ message }) },
    ),
  pushKey: () => request<{ publicKey: string }>('/api/v1/push/key'),
  subscribePush: (body: { endpoint: string; keys: { p256dh: string; auth: string }; ua?: string }) =>
    request<{ id: string }>('/api/v1/push/subscribe', { method: 'POST', body: JSON.stringify(body) }),
  unsubscribePush: (endpoint: string) =>
    request<{ ok: true }>('/api/v1/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  listEvents: (params: { level?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.level) search.set('level', params.level)
    if (params.limit) search.set('limit', String(params.limit))
    const qs = search.toString()
    return request<{ events: EventRow[] }>(`/api/v1/events${qs ? `?${qs}` : ''}`)
  },
}
