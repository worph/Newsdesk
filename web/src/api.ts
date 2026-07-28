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

export interface ConfigPayload {
  yaml: string
  config: unknown
  issues: ConfigIssue[]
  ingestToken: string
}

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

export interface SubmissionRow {
  id: string
  sourceId: string
  sourceName: string | null
  kind: string
  status: string
  outcome: string | null
  filedAt: string | null
  receivedAt: string
  textLength: number
  consideredChars: number
}

export interface SubmissionDetail extends Omit<SubmissionRow, 'textLength' | 'consideredChars'> {
  text: string
  considered: string | null
  refs: Record<string, unknown> | null
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

export const api = {
  me: () => request<{ authenticated: boolean }>('/api/v1/auth/me'),
  login: (password: string) =>
    request<{ ok: true }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/v1/auth/logout', { method: 'POST' }),
  health: () => request<Health>('/healthz'),
  getConfig: () => request<ConfigPayload>('/api/v1/config'),
  validateConfig: (yaml: string) =>
    request<{ ok: boolean; issues: ConfigIssue[] }>('/api/v1/config/validate', {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),
  saveConfig: (yaml: string) =>
    request<{ ok: true; yaml: string }>('/api/v1/config', {
      method: 'PUT',
      body: JSON.stringify({ yaml }),
    }),
  rotateIngestToken: () =>
    request<{ ingestToken: string }>('/api/v1/config/ingest-token/rotate', { method: 'POST' }),

  listSubmissions: (params: { source?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.source) search.set('source', params.source)
    if (params.limit) search.set('limit', String(params.limit))
    const qs = search.toString()
    return request<{ submissions: SubmissionRow[] }>(`/api/v1/submissions${qs ? `?${qs}` : ''}`)
  },
  getSubmission: (id: string) => request<{ submission: SubmissionDetail }>(`/api/v1/submissions/${id}`),
  postIdea: (body: { text: string; url?: string }) =>
    request<{ result: { id: string; note: string } }>('/api/v1/ideas', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listEvents: (params: { level?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.level) search.set('level', params.level)
    if (params.limit) search.set('limit', String(params.limit))
    const qs = search.toString()
    return request<{ events: EventRow[] }>(`/api/v1/events${qs ? `?${qs}` : ''}`)
  },
}
