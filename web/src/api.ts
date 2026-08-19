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

/**
 * The Start routine's answer.
 *
 * Every field is decided on the server — the summary sentence, the action list,
 * the reason inference is unavailable. There are no frontend tests, so anything
 * that could be got wrong lives where a test can reach it.
 */
export interface DeskStatus {
  actions: DeskAction[]
  total: number
  overdue: number
  health: Health
  /** False on a desk that has never been configured at all. */
  configured: boolean
  /** Counts, in the same words the log uses: "2 outlets, 1 stringer, …". */
  summary: string
  inference: { available: true } | { available: false; reason: string }
}

/** One turn in the administrator chat. Tool calls are turns too. */
export interface AdminMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName: string | null
  toolInput: unknown
  ok: boolean | null
  /** Set on a proposed destructive call: what must be typed to run it. */
  confirmWith: string | null
  /** The restore point this call created, if it made one. */
  versionId: number | null
  createdAt: string
}

export interface AdminConversation {
  threadId: string | null
  messages: AdminMessage[]
  /** A turn is in flight. The stream may have been dropped; the rows are here. */
  running: boolean
  inference: { available: true } | { available: false; reason: string }
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
  driver: 'mcp' | 'webhook' | 'builtin' | 'browser'
  enabled: boolean
  voice?: string
  endpoint?: string
  tool?: string
  destination_key?: string
  args: Record<string, unknown>
  /** browser driver only. */
  engine?: string
  recipe?: string
  /** How a publish here finishes. Absent reads as `tethered`. */
  publish?: PublishMode
  /** This destination's terms require a person; `auto` is refused for it. */
  requires_human?: boolean
}

/** Mirrors PUBLISH_MODES in @newsdesk/shared — see docs/browser-publishing.md §4.1. */
export type PublishMode = 'auto' | 'tethered' | 'detached'

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

/** One restore point: what the configuration was, just before a write changed it. */
export interface ConfigVersion {
  id: number
  at: string
  author: string
  reason: string | null
  sha256: string
  restoredFromId: number | null
  summary: string
}

export interface RestorePreview {
  id: number
  at: string
  /** Why this cannot be restored at all. Empty means it would go through. */
  issues: ConfigIssue[]
  /** Why you might not want to, even though it would go through. */
  warnings: string[]
  currentYaml: string
  versionYaml: string
}

/**
 * One proposal from the error assistant.
 *
 * `risk` and `confirmWith` are decided by the server from the remedy's kind
 * and the fields it touches. The browser never computes either — a client that
 * decided a channel-id change was "safe" would change nothing about how it is
 * applied.
 */
export interface Remedy {
  id: string
  kind: string
  risk: 'safe' | 'high'
  title: string
  rationale: string
  payload: Record<string, unknown>
  status: 'PROPOSED' | 'APPLIED' | 'DISMISSED' | 'FAILED'
  appliedAt: string | null
  error: string | null
  /** What must be typed back to apply it. Null for the ordinary tier. */
  confirmWith: string | null
}

export interface AssistSession {
  id: string
  eventId: number
  at: string
  status: string
  diagnosis: string | null
  confidence: 'high' | 'medium' | 'low' | null
  /** Proposals the desk refused after the model returned them, and why. */
  rejected: { title: string; reason: string }[]
  remedies: Remedy[]
}

export interface AssistStatus {
  available: boolean
  reason?: string
  canRestart: boolean
}

export interface AppliedResult {
  status: 'applied'
  kind: string
  outcome: string
  next?: { action: 'authorize-endpoint' | 'wait-for-restart'; id?: string }
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error'

export type EventCategory =
  | 'pipeline'
  | 'delivery'
  | 'queue'
  | 'editorial'
  | 'config'
  | 'ports'
  | 'system'
  | 'other'

/**
 * A row of the operations log, with the entities already resolved server-side.
 *
 * `category` and `assistable` are computed on the server rather than derived
 * here on purpose: there are no frontend tests, so every rule that could be
 * got wrong lives where a test can reach it.
 */
export interface EventRow {
  id: number
  at: string
  level: EventLevel
  actor: string
  code: string
  category: EventCategory
  /** Whether the error assistant has anything to offer on this code. */
  assistable: boolean
  message: string
  detail: unknown
  storyId: string | null
  /** Null when the story is gone; `storyId` is still shown in that case. */
  storyTitle: string | null
  publicationId: string | null
  outletId: string | null
  outletName: string | null
}

export interface EventQuery {
  minLevel?: EventLevel
  category?: EventCategory
  actor?: 'system' | 'human'
  q?: string
  before?: number
  limit?: number
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

/**
 * A placement as the story screen sees it: the proposal plus everything needed
 * to decide on it there, without opening the editor.
 *
 * All of it is computed by the server per request. `ready` in particular is the
 * gate's own condition rather than a status check the browser reinvents — a
 * button offering a decision the desk will refuse is worse than one that is off
 * with a reason.
 */
export interface StoryPlacementDetail extends StoryPlacement {
  /** Committed. Set only once this placement has been approved for a time. */
  scheduledFor: string | null
  urgency: string | null
  /** When the desk proposes to send it, and why that time. Null once settled. */
  schedule: { at: string; reason: string } | null
  ready: boolean
  /** Slots still blank, which is why `ready` is false. */
  missing: string[]
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
  /** 'managing-editor' | 'desk' — read off the wire, or written here. */
  origin: string
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
  placements: StoryPlacementDetail[]
  related: { id: string; title: string; summary: string } | null
  /** The desk's zone, so a proposed time reads as it does on the calendar. */
  timezone: string
}

/** What an approve-all came to, destination by destination. */
export interface BulkApproval {
  approved: Array<{ id: string; outlet: string; scheduledFor: string | null }>
  skipped: Array<{ id: string; outlet: string; reason: string }>
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

/**
 * One of the destinations this story runs in. `written` is what lets a strip of
 * them work as navigation for a piece being written destination by
 * destination — a blank one must look blank without opening it.
 */
export interface Sibling {
  id: string
  outletId: string
  outletName: string | null
  status: string
  written: boolean
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
    scheduledFor: string | null
    urgency: string | null
    publishedAt: string | null
    /** Set once a `detached` publish has filed something at the destination. */
    draftUrl: string | null
    /** verified | attested | edited — how the desk knows it went out. */
    evidence: string | null
    stagedAt: string | null
  }
  story: {
    id: string
    title: string
    summary: string
    url: string | null
    dedupVerdict: string
    origin: string
  }
  outlet: {
    id: string
    name: string
    description: string
    role: string
    driver: string
    tool: string | null
    /** Null for every non-browser driver. */
    publish: PublishMode | null
    requiresHuman: boolean
  }
  slotSpec: Record<string, SlotDef>
  preview: PayloadPreview
  siblings: Sibling[]
  /**
   * The send time the desk suggests, computed for this request. Null once the
   * publication has settled — there is nothing left to propose.
   */
  scheduleProposal: { at: string; reason: string } | null
  /** The desk's timezone, so times read the same here as they do in the cadence. */
  timezone: string
}

/** One planned or completed send, as the Calendar page draws it. */
export interface CalendarEntry {
  id: string
  storyId: string
  storyTitle: string | null
  outletId: string
  outletName: string | null
  driver: string | null
  /**
   * For a browser outlet, what its slot means: `auto` is a send time like any
   * other, the hand-over modes are when it is put in front of a person. Null for
   * every other driver. Resolved on the server — the web app cannot read the
   * shared defaults.
   */
  mode: PublishMode | null
  status: string
  urgency: string | null
  scheduledFor: string | null
  publishedAt: string | null
  error: string | null
  /** When it goes out, or when it did. What the entry is placed by. */
  at: string
}

/**
 * One publication as it appears in a list: enough to decide whether to open it
 * without opening it.
 */
export interface PublicationRow {
  id: string
  storyId: string
  storyTitle: string | null
  storySummary: string | null
  storyCreatedAt: string | null
  /** 'desk' means you wrote it: a blank draft here is unstarted, not broken. */
  storyOrigin: string | null
  outletId: string
  outletName: string | null
  status: string
  origin: string
  placementReason: string | null
  approvedAt: string | null
  publishedAt: string | null
  error: string | null
  /** The opening of the primary slot: what was actually written. */
  preview: string | null
}

/**
 * One thing the desk is waiting on you for.
 *
 * Deliberately pre-digested by the server: the verb, the sentence and the link
 * are decided there, so the screen is a list and nothing more. Anything it had
 * to work out for itself would be a second place the wording could drift from
 * what the notification said.
 */
export type ActionKind = 'sign-in' | 'publish' | 'fix' | 'approve' | 'write' | 'place' | 'answer'

export interface DeskAction {
  id: string
  kind: ActionKind
  title: string
  where: string | null
  verb: string
  because: string
  href: string
  /** The desk is already late: a slot that has passed, or a send that broke. */
  overdue: boolean
  since: string | null
}

export interface DraftVersion {
  id: string
  publicationId: string
  slots: Record<string, string>
  origin: 'writer' | 'copy-desk' | 'human'
  createdAt: string
}

/**
 * A page composed in a real browser and handed to the operator.
 *
 * `handover` is the recipe's own prose — what the person is expected to press.
 * It is shown verbatim rather than summarised: the whole point of the cookbook
 * is that the instruction and what the desk did are one document.
 */
export interface StagedPage {
  publicationId: string
  outletName: string
  handover: string
  mode: PublishMode
  /**
   * The button the operator is being asked to press, when the recipe names one.
   * Advisory: the desk clicks it only under `auto`.
   */
  commitSelector: string | null
  screenshotPath: string | null
  stagedAt: string
  lease: { expiresAt: string }
  viewer: { kind: 'novnc'; path: string } | { kind: 'none' }
}

export interface BrowserBusyInfo {
  label: string
  publicationId: string
  since: string
}

export interface ViewerInfo {
  kind: 'screencast' | 'novnc' | 'none'
  /** screencast: where frames come from and where input goes back. */
  socket?: string
  /** screencast: where to ask an element's bounds, to point the view at it. */
  frame?: string
  pageId?: string
  /** Kept for break-glass — what a per-tab stream structurally cannot show. */
  novnc?: { url: string }
  /** Set when someone else's publish holds the browser. */
  heldBy?: string | null
}

export interface PublishTrace {
  id: string
  at: string
  phase: 'stage' | 'handover' | 'verify'
  action: string
  selector: string | null
  url: string | null
  ok: boolean
  detail: Record<string, unknown> | null
  screenshotPath: string | null
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
  postTip: (body: { text: string; url?: string; stringer_id?: string }) =>
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
  /**
   * Let every draft on a story through the gate at once. Each destination keeps
   * the time the desk proposed for it unless one is given here for all of them,
   * and each is approved on its own terms — what cannot go comes back in
   * `skipped` with the reason, and the rest still go.
   */
  approvePlacements: (id: string, scheduledFor?: string) =>
    request<BulkApproval>(`/api/v1/stories/${id}/placements/approve`, {
      method: 'POST',
      body: JSON.stringify(scheduledFor ? { scheduled_for: scheduledFor } : {}),
    }),
  /**
   * Write and place a piece yourself. Creates the story and one blank
   * publication per destination, then hands you to the normal review editor —
   * one per destination, each written, approved and sent on its own.
   */
  compose: (body: {
    title: string
    summary?: string
    url?: string
    outlet_ids: string[]
    urgency?: 'breaking' | 'normal' | 'evergreen'
  }) =>
    request<{
      storyId: string
      publications: Array<{ id: string; outletId: string; outletName: string }>
    }>('/api/v1/compose', { method: 'POST', body: JSON.stringify(body) }),
  rerunStory: (id: string) =>
    request<{ queued: number }>(`/api/v1/stories/${id}/rerun`, { method: 'POST' }),
  /** The other answer to a held story: the question is not worth answering. */
  dropStory: (id: string, reason?: string) =>
    request<{ status: 'DROPPED' }>(`/api/v1/stories/${id}/drop`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  listJobs: () => request<{ stats: Record<string, number>; jobs: JobRow[] }>('/api/v1/jobs'),
  listPublications: (params: { status?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.status) search.set('status', params.status)
    if (params.limit) search.set('limit', String(params.limit))
    const qs = search.toString()
    return request<{ publications: PublicationRow[] }>(`/api/v1/publications${qs ? `?${qs}` : ''}`)
  },
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
  /**
   * Approve, and optionally say when. Omitting the time sends immediately —
   * the behaviour approval always had, and what the "Send now" button uses.
   */
  approvePublication: (id: string, scheduledFor?: string) =>
    request<{ status: string; payload: Record<string, unknown>; scheduledFor: string | null }>(
      `/api/v1/publications/${id}/approve`,
      { method: 'POST', body: JSON.stringify(scheduledFor ? { scheduled_for: scheduledFor } : {}) },
    ),
  /** Pull a scheduled send back. Reopens the draft for editing. */
  withdrawPublication: (id: string) =>
    request<{ status: string }>(`/api/v1/publications/${id}/withdraw`, { method: 'POST' }),
  /** Move a scheduled send. Changes when the approved bytes go out, never what they are. */
  reschedulePublication: (id: string, scheduledFor: string) =>
    request<{ status: string; scheduledFor: string }>(`/api/v1/publications/${id}/schedule`, {
      method: 'PATCH',
      body: JSON.stringify({ scheduled_for: scheduledFor }),
    }),
  /** Everything waiting on a person, ordered by what is most overdue. */
  listActions: () =>
    request<{ actions: DeskAction[]; total: number; overdue: number }>('/api/v1/actions'),
  /**
   * What the desk would tell someone who just sat down.
   *
   * Runs no inference, so it answers with every port broken — which is the
   * only reason it is safe to hang a landing screen off it.
   */
  deskStatus: () => request<DeskStatus>('/api/v1/admin-chat/status', { method: 'POST' }),
  /** The conversation as it stands — also the way back after a dropped stream. */
  adminChat: () => request<AdminConversation>('/api/v1/admin-chat'),
  /**
   * A command the desk answers itself — `/status`, `/new`, and one day more.
   *
   * No inference, so it still works when the administrator cannot. `/status`
   * is written server-side and comes back as ordinary turns; `/new` replaces
   * the conversation instead, and says so by carrying the `threadId` of the
   * one it started.
   */
  adminCommand: (command: string) =>
    request<{ messages: AdminMessage[]; threadId?: string }>('/api/v1/admin-chat/command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
  /** Put the visible conversation away. The rows are kept, not deleted. */
  clearAdminChat: () =>
    request<{ threadId: string; messages: AdminMessage[] }>('/api/v1/admin-chat', { method: 'DELETE' }),
  /**
   * Agree to a call the chat proposed but would not make.
   *
   * Sends the message id, never the payload: the server reads the tool and the
   * arguments off the row and re-validates them, so what happens is what the
   * desk agreed to rather than what this page says.
   */
  confirmAdminChat: (messageId: string, confirm: string) =>
    request<{ ok: boolean; message: AdminMessage }>('/api/v1/admin-chat/confirm', {
      method: 'POST',
      body: JSON.stringify({ messageId, confirm }),
    }),
  getTimezone: () => request<{ timezone: string; detected: string }>('/api/v1/settings/timezone'),
  setTimezone: (timezone: string) =>
    request<{ timezone: string }>('/api/v1/settings/timezone', {
      method: 'PUT',
      body: JSON.stringify({ timezone }),
    }),
  getMcpToken: () => request<{ token: string }>('/api/v1/settings/mcp-token'),
  rotateMcpToken: () =>
    request<{ token: string }>('/api/v1/settings/mcp-token/rotate', { method: 'POST' }),
  getCalendar: (from: string, to: string) =>
    request<{ entries: CalendarEntry[]; timezone: string }>(
      `/api/v1/calendar?${new URLSearchParams({ from, to })}`,
    ),
  rejectPublication: (id: string, reason?: string) =>
    request<{ status: string }>(`/api/v1/publications/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  retryPublication: (id: string) =>
    request<{ queued: boolean }>(`/api/v1/publications/${id}/retry`, { method: 'POST' }),

  // ── browser publishing ────────────────────────────────────────────────────
  /**
   * Compose the page. Called when the operator opens the live view, not when
   * the slot came — nothing holds the browser while a person is being waited
   * for. A 409 means someone else's publish has it.
   */
  stagePublication: (id: string) =>
    request<StagedPage>(`/api/v1/publications/${id}/stage`, { method: 'POST' }),
  /** They pressed the destination's own button. */
  markSent: (id: string) =>
    request<{ status: string; evidence: 'verified' | 'attested'; externalUrl: string | null }>(
      `/api/v1/publications/${id}/sent`,
      { method: 'POST' },
    ),
  /**
   * Put the destination's login page in front of the operator and hold the
   * browser while they use it. The viewer alone is not enough: the browser
   * starts lazily, and nothing else points it at this outlet.
   */
  openSignIn: (id: string) =>
    request<{ url: string; lease: { expiresAt: string } }>(
      `/api/v1/publications/${id}/open-sign-in`,
      { method: 'POST' },
    ),
  /**
   * "I've signed in." The desk goes and looks rather than taking your word —
   * publishing into a login page is what this whole state prevents.
   */
  confirmSignedIn: (id: string) =>
    request<{ signedIn: boolean }>(`/api/v1/publications/${id}/signed-in`, { method: 'POST' }),
  /** They did not. The slot survives; the browser is given back. */
  markNotSent: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/publications/${id}/not-sent`, { method: 'POST' }),
  keepBrowserAlive: (id: string) =>
    request<{ held: boolean }>(`/api/v1/publications/${id}/keepalive`, { method: 'POST' }),
  getViewer: (id: string) => request<ViewerInfo>(`/api/v1/browser/viewer/${id}`),
  listTraces: (id: string) =>
    request<{ traces: PublishTrace[] }>(`/api/v1/publications/${id}/traces`),
  listChat: (id: string) => request<{ messages: ChatMessage[] }>(`/api/v1/publications/${id}/chat`),
  sendChat: (id: string, message: string) =>
    request<{ reply: string; slots: Record<string, string>; versionId: string }>(
      `/api/v1/publications/${id}/chat`,
      { method: 'POST', body: JSON.stringify({ message }) },
    ),
  pushKey: () => request<{ publicKey: string }>('/api/v1/push/key'),
  /** What the desk believes, so Settings can disagree with what the browser believes. */
  pushStatus: () => request<{ publicKey: string; devices: number }>('/api/v1/push/status'),
  testPush: () =>
    request<{ subscribers: number; delivered: number; dropped: number; failed: number }>(
      '/api/v1/push/test',
      { method: 'POST' },
    ),
  subscribePush: (body: { endpoint: string; keys: { p256dh: string; auth: string }; ua?: string }) =>
    request<{ id: string }>('/api/v1/push/subscribe', { method: 'POST', body: JSON.stringify(body) }),
  unsubscribePush: (endpoint: string) =>
    request<{ ok: true }>('/api/v1/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  assistStatus: () => request<AssistStatus>('/api/v1/assist/status'),
  getAssist: (eventId: number) =>
    request<{ session: AssistSession | null }>(`/api/v1/events/${eventId}/assist`),
  runAssist: (eventId: number) =>
    request<{ session: AssistSession }>(`/api/v1/events/${eventId}/assist`, { method: 'POST' }),
  applyRemedy: (id: string, confirm?: string) =>
    request<AppliedResult>(`/api/v1/remedies/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify(confirm ? { confirm } : {}),
    }),
  dismissRemedy: (id: string) =>
    request<{ status: string }>(`/api/v1/remedies/${id}/dismiss`, { method: 'POST' }),
  listConfigVersions: () => request<{ versions: ConfigVersion[] }>('/api/v1/config/versions'),
  previewConfigRestore: (id: number) =>
    request<RestorePreview>(`/api/v1/config/versions/${id}/preview`),
  restoreConfigVersion: (id: number) =>
    request<{ ok: true; yaml: string }>(`/api/v1/config/versions/${id}/restore`, { method: 'POST' }),
  listEvents: (params: EventQuery = {}) => {
    const search = new URLSearchParams()
    if (params.minLevel) search.set('minLevel', params.minLevel)
    if (params.category) search.set('category', params.category)
    if (params.actor) search.set('actor', params.actor)
    if (params.q) search.set('q', params.q)
    if (params.before !== undefined) search.set('before', String(params.before))
    if (params.limit) search.set('limit', String(params.limit))
    const qs = search.toString()
    return request<{ events: EventRow[]; nextCursor: number | null }>(
      `/api/v1/events${qs ? `?${qs}` : ''}`,
    )
  },
}

/**
 * Say something to the administrator, and watch the turn happen.
 *
 * Not part of `api` above, because it cannot be: `request()` buffers the whole
 * body before returning, and the point of this endpoint is that the steps
 * arrive as they land. `EventSource` is no use either — it only does GET.
 *
 * The stream is a view, never the record. Every event here corresponds to a row
 * the server already wrote, so a dropped connection loses nothing: call
 * `api.adminChat()` and the conversation is all there.
 */
export async function streamAdminTurn(
  message: string,
  handlers: {
    onMessage: (message: AdminMessage) => void
    onDone?: () => void
    onError?: (error: string) => void
  },
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/v1/admin-chat/messages', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
    ...(signal ? { signal } : {}),
  })

  // A refusal answers JSON rather than opening a stream — no inference wired,
  // or this conversation is already thinking.
  if (!response.ok) {
    const text = await response.text()
    const body = text ? (JSON.parse(text) as { error?: string }) : {}
    throw new ApiError(response.status, body.error ?? response.statusText)
  }
  if (!response.body) throw new ApiError(500, 'the desk sent no stream')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Events are separated by a blank line; anything after the last one is a
    // partial frame and stays in the buffer until the rest of it arrives.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      const event = /^event: (.+)$/m.exec(frame)?.[1]
      const data = frame.slice(frame.indexOf('data: ') + 6)
      // Heartbeats are comment frames and carry no event line.
      if (!event) continue

      if (event === 'message') handlers.onMessage(JSON.parse(data) as AdminMessage)
      else if (event === 'done') handlers.onDone?.()
      else if (event === 'error') handlers.onError?.((JSON.parse(data) as { error: string }).error)
    }
  }
}
