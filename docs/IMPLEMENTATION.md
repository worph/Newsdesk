# Newsdesk — Implementation Notes

> How we build it: stack, data model, API surface, integration contracts, UI surfaces, milestones.
> Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first — this document assumes its model and does not
> re-argue it.
>
> Status: proposal, 2026-07-28. Pre-code. Stack choices are recommendations, not decisions already
> taken; everything else follows from the agreed architecture.

---

## 1. Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node 22, TypeScript | first-party MCP SDK; two of the three ports are MCP |
| HTTP | Fastify | small, fast, good schema validation story |
| DB | SQLite (WAL) via `better-sqlite3` + Drizzle | single file, real constraints, no sidecar |
| Frontend | React + Vite + Tailwind | the review surface is the product; shared types with the API |
| Editor | CodeMirror 6 (markdown) + `markdown-it` preview | lighter and more predictable on mobile than a block editor |
| Scheduler | in-process, DB-backed job rows | app owns its clock; restarts resume |
| Push | `web-push` (VAPID) | Android and desktop; iOS explicitly out of scope |
| Container | multi-stage, single image serving API + static SPA | one container, one port |

Deferred decision. The requirements push toward: an MCP client on two ports, an OpenAI-standard
tool-calling client, a job queue, SQLite, and a React-class review UI that is the single largest
piece of work. Both the TypeScript and Python ecosystems have first-party SDKs for all of it, so the
tiebreaker is shared types between the API and the UI, which favours TypeScript. Nothing in the
design depends on it — decide at M0.

## 2. Repository layout

```
/                     README.md, ARCHITECTURE.md, IMPLEMENTATION.md
  server/
    src/
      db/             schema, migrations, queries
      ports/
        inference/    driver interface (+ capability flags)
                      drivers: openai-compatible, anthropic, mcp-claude-code
        delivery/     driver interface; drivers: mcp, webhook, builtin
        ingest/       HTTP handlers; watermark + snapshot diffing; (later) mcp-pull
        mcp/          shared MCP client, endpoint registry, tool discovery + catalogue cache
      pipeline/       director, writer, assistant, publisher, queue, scheduler
      schema/         slot spec -> tool schema generation; payload merge; validators
      api/            routes
      render/         slot rendering, sanitization, per-driver formatters
      prompts/        director.md, writer.md, assistant.md (versioned)
    test/             fixtures: submissions, recorded inference results, dedup regression set
  web/                React app, service worker, manifest
  deploy/
    Dockerfile
    docker-compose.yml            plain self-host
    docker-compose.yundera.yml    + x-casaos block for the AppStore
  scripts/
    seed-stories.ts               migration: import published stories as the initial corpus
```

## 3. Data model

SQLite. Timestamps are ISO-8601 UTC text. JSON columns hold driver-specific blobs.

```sql
-- configuration -------------------------------------------------------------
CREATE TABLE sources (
  id          TEXT PRIMARY KEY,          -- 'github-yundera-root', 'korben', 'idea-box'
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- 'report' | 'timeline' | 'snapshot' | 'idea'
  enabled     INTEGER NOT NULL DEFAULT 1,
  hint        TEXT,                      -- narrowing note, subordinate to the charter
  watermark   TEXT,                      -- JSON: last considered timestamp (timeline)
  last_snapshot TEXT,                    -- previous body (snapshot), for diffing
  created_at  TEXT NOT NULL
);

CREATE TABLE personas (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  voice TEXT NOT NULL, audience TEXT NOT NULL, rules TEXT, examples TEXT
);

CREATE TABLE mcp_endpoints (             -- Beacon aggregators and standalone servers
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,            -- 'yunderalabs beacon'
  url          TEXT NOT NULL,            -- http://beacon-backend:9300/mcp
  auth         TEXT,                     -- JSON, optional
  catalogue    TEXT,                     -- JSON: discovered servers/tools/schemas
  discovered_at TEXT,
  status       TEXT                      -- ok | unreachable | auth_error
);

CREATE TABLE targets (
  id          TEXT PRIMARY KEY,          -- 'discord-news', 'nextcloud-tech'
  name        TEXT NOT NULL,
  description TEXT NOT NULL,             -- the director reads this: what belongs here
  role        TEXT NOT NULL,             -- 'publish' | 'notify'
  driver      TEXT NOT NULL,             -- 'mcp' | 'webhook' | 'builtin'
  enabled     INTEGER NOT NULL DEFAULT 1,
  persona_id  TEXT REFERENCES personas(id),
  endpoint_id TEXT REFERENCES mcp_endpoints(id),
  tool        TEXT,                      -- 'discord-mcp__send_embed'
  args_spec   TEXT NOT NULL              -- JSON: each key is literal | derived | slot
);

CREATE TABLE charter (                   -- append-only; latest row wins
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL, created_at TEXT NOT NULL, author TEXT NOT NULL
);

-- content -------------------------------------------------------------------
CREATE TABLE submissions (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  considered  TEXT,                      -- the slice actually sent (post watermark/diff)
  refs        TEXT,                      -- JSON, opportunistic
  filed_at    TEXT, received_at TEXT NOT NULL,
  status      TEXT NOT NULL,             -- RECEIVED|PROCESSING|PROCESSED|FAILED
  outcome     TEXT                       -- 'no story' | '2 stories' | error summary
);

CREATE TABLE stories (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,           -- the writers' factual basis
  body          TEXT,                    -- assembled material
  url           TEXT,
  status        TEXT NOT NULL,           -- PROPOSED|ROUTED|DROPPED|NEEDS_CONTEXT|CLOSED
  dedup_verdict TEXT NOT NULL,           -- NEW | DUPLICATE | UPDATE
  dedup_reason  TEXT,
  related_story_id TEXT REFERENCES stories(id),
  compared_ids  TEXT,                    -- JSON: what the verdict was made against
  label         TEXT,                    -- coarse, cosmetic: sorts the queue, never filters
  drop_reason   TEXT,
  proposed_routes TEXT,                  -- JSON snapshot of the director's calls
  created_at    TEXT NOT NULL
);

CREATE TABLE story_submissions (         -- redundancy across sources is a feature
  story_id TEXT NOT NULL REFERENCES stories(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  PRIMARY KEY (story_id, submission_id)
);

CREATE TABLE publications (              -- the story x target ledger
  id           TEXT PRIMARY KEY,
  story_id     TEXT NOT NULL REFERENCES stories(id),
  target_id    TEXT NOT NULL REFERENCES targets(id),
  status       TEXT NOT NULL,            -- PROPOSED|DRAFTING|AWAITING_APPROVAL|APPROVED|PUBLISHED|REJECTED|FAILED
  origin       TEXT NOT NULL,            -- 'director' | 'human'
  route_reason TEXT,
  angle        TEXT,                     -- the director's note to the writer
  slots        TEXT,                     -- JSON: current authored values {title, description, image}
  payload      TEXT,                     -- JSON actually sent, merged and frozen at approval
  external_id  TEXT, external_url TEXT, error TEXT,
  approved_at  TEXT, published_at TEXT,
  UNIQUE (story_id, target_id)
);

CREATE TABLE draft_versions (            -- every assistant edit and manual save
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  slots TEXT NOT NULL,                   -- JSON snapshot
  origin TEXT NOT NULL,                  -- 'writer' | 'assistant' | 'human'
  created_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  role TEXT NOT NULL,                    -- 'user' | 'assistant'
  content TEXT NOT NULL,
  version_id TEXT REFERENCES draft_versions(id),
  created_at TEXT NOT NULL
);

-- operations ----------------------------------------------------------------
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- 'direct' | 'write' | 'publish'
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- PENDING|RUNNING|DONE|FAILED
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL
);

CREATE TABLE events (                    -- append-only audit + error log
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, level TEXT NOT NULL, actor TEXT NOT NULL,
  code TEXT NOT NULL,                    -- SUBMISSION_RECEIVED, STORY_DUPLICATE, ROUTE_OVERRIDDEN, PUBLISH_FAILED...
  story_id TEXT, publication_id TEXT, message TEXT NOT NULL, detail TEXT
);

CREATE TABLE inference_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, purpose TEXT NOT NULL, ref_id TEXT,
  duration_ms INTEGER, ok INTEGER NOT NULL, error TEXT
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL,
  ua TEXT, created_at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Notes:

- **No uniqueness constraint on incoming content.** Deduplication is the director's verdict, recorded
  on the story with its reason and the ids it compared against.
- `publications.slots` is the live authored state; `payload` is the merged, frozen object written at
  approval and sent verbatim — which is what makes publish idempotent and retry safe.
- `stories.proposed_routes` versus the `publications` rows is the **override diff**;
  `publications.origin` distinguishes a route the director proposed from one the editor added, and a
  switched-off proposal leaves a `REJECTED` row rather than disappearing.
- `submissions.considered` records exactly what was sent to the director after watermarking or
  snapshot diffing — essential when debugging "why was this missed?"
- FTS5 over `stories(title, summary)` when the corpus outgrows a wholesale prompt; not in v1.

## 4. The slot spec

A target's `args_spec` is a JSON object whose keys mirror the MCP tool's arguments. Each value is:

| Form | Example | Meaning |
|---|---|---|
| scalar | `"1516814412244193380"` | **literal** — fixed, never shown at review |
| `{{ … }}` string | `"{{story.url}}"` | **derived** — computed from the story |
| object with `slot` | `{ slot: markdown, … }` | **authoring slot** |

Slot fields: `slot` (`text` \| `markdown` \| `image` \| `link`), `label`, `max`, `optional`,
`primary` (at most one per target — gets the full editor and the assistant), `hint` (guidance passed
to the writer prompt).

One spec drives three things:

1. **Writer tool schema** — `submit_draft(...)` generated from the slots, so an over-length or
   missing value is impossible rather than merely validated.
2. **Review UI** — the slots are the reviewable surface; literals and derived values are not shown
   during review (they appear in the "what will be sent" panel).
3. **Published payload** — `merge(literals, derived, approved slots)`.

## 5. Integration contracts

### 5.1 n8n stringers

Two workflows on the existing n8n, each ending in an HTTP Request node posting free text.

- **GitHub stringer** — uses the existing GitHub credential and calls an LLM MCP to do the digging:
  survey the repository and its public submodules since the last run and **write a report** naming
  what changed, with evidence and links. The desk consumes only the report.
- **RSS stringer** — n8n RSS node; files entries as a timeline submission, with article text fetched
  where the feed carries only a summary.

Rules for stringer prompts: **file inclusively** ("report anything plausibly interesting, with
evidence" — never "decide what is newsworthy", that judgement belongs to the charter in one place);
**never invent**; depth is the source's business. Stringers keep no dedup state — re-filing
overlapping material is expected and safe.

### 5.2 MCP client, endpoints, and Beacon discovery

One shared MCP client serves both the inference port and `mcp`-driver targets. Endpoints are rows in
`mcp_endpoints`, so a deployment can point at a Beacon aggregator, several Beacons, or a standalone
server, without code changes.

**Discovery.** Against a Beacon aggregator the app enumerates what is actually available and caches
it as a catalogue:

- list servers and their tools — via Beacon's `overview` / `server_doc` / `tool_doc`, falling back to
  plain MCP `tools/list` for a non-Beacon endpoint
- store the result in `mcp_endpoints.catalogue` with `discovered_at`, refreshable from the UI
- surface it in the **target editor** as a picker: choose endpoint → server → tool → see its argument
  schema → build the `args_spec`

**The LLM glue lives here, at configuration time, not at publish time.** Given a tool's discovered
schema and a sample story, an assistant proposes an `args_spec` — which literals to pin, which keys
become slots, sensible labels and limits. You review and save it. After that the target is static
config and publishing stays deterministic.

Practical notes carried over from the current system:

- `claude-code__query_claude` is effectively single-session: **concurrency 1, retry with backoff and
  jitter on 409 / 502 / 503 / 504 / timeout**, generous per-call timeout (the current pipeline uses
  280s for publish-class calls).
- Beacon may advertise a **stale schema** (notably for `telegram-mcp`); arguments missing from the
  advertised schema still work. **Discovered schemas are an authoring aid, never an outbound
  validator** — send the `args_spec` as written.
- Endpoint health is part of `/healthz` and the log screen, per invariant 7.

### 5.2.1 Verified tool schemas (read from the live Beacons, 2026-07-28)

| Tool | Arguments | Required |
|---|---|---|
| `discord-mcp__send_embed` | `channelId`, `title`, `description`, `color` (number), `fields` (array), `footer`, `timestamp` (bool) | **`title` only** |
| `discord-mcp__send_message` | `channelId`, `text` | `text` only |
| `telegram-mcp__send_message` | `chatId`, `text`, `parseMode` (`Markdown` \| `HTML`) | `text` only |
| `telegram-mcp__send_photo` | `chatId`, `url`, `caption` | `url` only |
| `nextcloud-talk-mcp__talk_send_message` | conversation `token` + message text; **exact key names not exposed** | unknown |

Three findings that change the design:

1. **`send_embed` has no `url` parameter** (and no thumbnail). The canonical link must live inside
   `description` as a markdown link, or in `footer`. Earlier examples in these docs assumed a `url`
   key that does not exist.
2. **Destination arguments are optional in every one of these schemas.** `channelId` and `chatId` are
   absent from `required`, so an omitted destination falls back to a bridge-configured default. A
   `publish` target whose `args_spec` does not pin its destination as a literal **must fail
   validation at save time** — silently posting to a default channel is the worst failure this system
   can have, and it needs no model involvement to happen.
3. **Discovery quality varies by endpoint.** The yunderalabs Beacon returns full `inputSchema` objects
   per tool; the Yunderateam Beacon returns descriptions only, with no schema. So the target editor
   cannot assume schemas exist: when absent, fall back to manual key entry with the tool description
   shown, and let the propose-args assistant work from prose. `nextcloud-talk-mcp` is in this
   category — its argument keys need confirming with one live test call before the internal target
   is configured.

Also noted while reading: `telegram-mcp` exposes `ask` / `get_answer`, a human-in-the-loop question
primitive. Not needed — the PWA is the approval surface — but it is the mechanism the old bridge
approval was built on, and it should stay unused so there is exactly one gate.

### 5.2.2 Endpoint authentication, including OAuth

`mcp_endpoints.auth` is a JSON blob with three possible shapes, and it is **runtime-owned**: the
YAML configuration carries only `id`, `name` and `url`, and `writeConfig` updates only those two, so
pushing a new configuration can never wipe a credential.

| Shape | Meaning |
|---|---|
| `{ "bearer": "…" }` | a static token, sent as `Authorization: Bearer` |
| `{ "headers": { … } }` | arbitrary headers, for endpoints with their own scheme |
| `{ "oauth": { … } }` | an OAuth 2.1 connection: registered client, tokens, and the one-shot flow material |

**Why OAuth is interactive.** `beacon-yunderalabs.nsl.sh` moved off `?hash=` URLs to OAuth. Its
authorization server advertises `authorization_code`, `implicit` and `refresh_token` — and **no
`client_credentials`** — so there is no machine-to-machine grant a daemon could use unattended. The
desk therefore borrows the operator's browser exactly once; the refresh token that flow returns is
what keeps delivery working on its own afterwards. This is the one credential the desk holds, and it
is the desk's own delegated identity, not a third-party API key.

**The flow.** `@modelcontextprotocol/sdk` ≥ 1.30 drives the protocol; `ports/mcp/oauth.ts` only
supplies storage and the one piece a server cannot do (following a redirect):

1. `POST /api/v1/mcp/endpoints/:id/oauth/start` → the SDK reads the `WWW-Authenticate` challenge,
   fetches the protected-resource and authorization-server metadata, registers the desk dynamically
   (RFC 7591) as a **public client with PKCE `S256`** — there is no client secret to store — and
   builds the authorization URL, which is returned rather than followed.
2. The operator's browser completes the login in a popup.
3. `GET /api/v1/mcp/oauth/callback` exchanges the code and stores the tokens.

**The callback is unauthenticated by design.** It is a top-level navigation the desk did not
initiate, and its CSRF defence is the single-use `state` minted at step 1, compared in constant time
and consumed on use whether or not the exchange succeeded. Requiring a session cookie as well would
add a failure mode without adding a barrier an attacker could not already pass.

**Scope and the refresh token.** Scope selection follows SEP-835: the `WWW-Authenticate` scope, then
the resource's `scopes_supported`, then our configured fallback (`mcp offline_access`). The live
Beacon advertises `["mcp","offline_access"]`, so the resource decides and the request goes out as
`scope=mcp offline_access`. `offline_access` matters twice over — the SDK appends `prompt=consent`
whenever it is present, and **without that an OIDC server silently drops the scope and issues no
refresh token**, leaving a connection that dies an hour later with no way to renew it. Beacon hit
exactly this against the same authorization server and had to patch it by hand; SDK 1.30 sends it
for us. Because the failure is silent, `noteRefreshToken` records a warning on any token response
that arrives without a refresh token, and it is shown on the callback page and in Settings rather
than discovered in the middle of the night.

**Verified live against `beacon-yunderalabs.nsl.sh` on 2026-07-31** — discovery, dynamic
registration and the built authorization request, carrying `code_challenge_method=S256`,
`scope=mcp offline_access` and `prompt=consent`. Only the browser consent and token exchange remain
unverified, since by construction they need a human at a browser.

**Runtime.** `attachAuth` gives an endpoint row an `OAuthClientProvider` when it has a connection;
the SDK then owns the `Authorization` header and refreshes the access token when it expires. A
failure that means "no usable credential" surfaces as `McpError.needsAuth` — not retryable, because
waiting cannot help, but distinct from a broken call, because the fix is a human reconnecting.
`probeEndpoint` presents the stored token so a connected endpoint reads `ok` rather than
`unauthorized`, and never echoes it back into `/healthz`.

**Configuration.** `NEWSDESK_PUBLIC_URL` sets the origin the redirect URI is built from. It must
match what was registered, so it cannot be inferred from an inbound request when a reverse proxy
sits in front. Settings displays the resulting redirect URI.

### 5.3 Inference drivers

```ts
interface InferenceDriver {
  capabilities: { toolCalling: boolean }
  run(req: { prompt: string, tools?: ToolSchema[], expect?: JsonSchema }): Promise<Result>
}
```

- **openai-compatible / anthropic** — `toolCalling: true`. Generated tools constrain the output.
- **mcp-claude-code** — `toolCalling: false`. The same prompt asks for JSON; the app validates and
  retries once with the parse error included. Billing runs against an existing account rather than
  metered tokens, which is why it is the day-one driver for our deployment.

### 5.4 Prompts

Three templates in `server/src/prompts/`, each delimiting ingested content and labelling it
untrusted:

- **director** — charter, target catalogue (id, description, persona summary), source hint, the
  considered slice of the submission, and every story from the comparison window. Emits
  `open_story` / `duplicate_of` / `update_of` / `needs_context` / `propose_route` / `no_story`.
- **writer** — story summary and material, persona, the route's `angle`, slot definitions. Emits
  `submit_draft` with the generated schema.
- **assistant** — persona, current slots, conversation, editor's turn. Returns a reply and the full
  updated slots. Never a tool call against the world, never a partial patch.

## 6. API surface

All `/api/v1`. Session cookie for the UI; bearer token for ingest.

```
POST   /submissions                ingest (token). Free text. Object or array.
POST   /ideas                      internal idea box + PWA share target

GET    /stories?status=&q=         queue, spiked, archive (one endpoint, filtered)
GET    /stories/:id                story, contributing submissions, publications, related story
POST   /stories/:id/rerun          re-run the director
POST   /stories/:id/routes         add a route the director did not propose
GET    /submissions?status=        raw inbox, including "no story" outcomes

PATCH  /publications/:id           save slots (creates a version)
POST   /publications/:id/chat      { message } -> { reply, slots }
GET    /publications/:id/versions  history
POST   /publications/:id/revert    { version_id }
GET    /publications/:id/payload   the merged "what will be sent" object
POST   /publications/:id/approve   freeze payload -> deliver
POST   /publications/:id/reject    { reason }
POST   /publications/:id/retry     re-send the frozen payload

GET/PUT  /charter                  read latest / append new version
CRUD     /sources /targets /personas /mcp-endpoints
POST     /mcp-endpoints/:id/discover     refresh the tool catalogue
POST     /targets/propose-args           LLM proposes an args_spec from a tool schema
POST     /targets/:id/test               dry-run with a sample story

GET    /events?level=&since=       error and audit log
GET    /jobs                       queue state
GET    /stats/overrides            proposal-versus-decision diffs, for charter tuning
POST   /push/subscribe             web push registration
GET    /healthz                    liveness + per-port and per-endpoint reachability
```

## 7. UI surfaces

Eleven screens in four groups. Three of them carry ~90% of the daily use and are designed
mobile-first; the rest are configuration and forensics and may be desktop-leaning.

### A. The desk — daily, mobile-first

| # | Screen | Scope | Primary action |
|---|---|---|---|
| 1 | **Queue** (the gate) | everything awaiting a decision: stories with their per-target route chips, oldest first. Home screen; badge = publications in `AWAITING_APPROVAL` | open a story |
| 2 | **Review** | one publication: the primary slot as a document, other slots as fields, the director's reason and angle, assistant chat, version history, "what will be sent", related stories. Tabs across targets when a story has several routes | **approve** / spike |
| 3 | **Idea box** | one field plus optional link; also the landing page for the Android share sheet and the `?url=` deep link | submit |

The gate as a *concept* is enforced on screen 2 (approve is the only path to the wire); screen 1 is
just the list of things standing at it.

### B. What happened — weekly

| # | Screen | Scope | Primary action |
|---|---|---|---|
| 4 | **Stories** | one browser with filters: awaiting, spiked, needs-context, published. The spiked filter is where invariant 6 lives — every drop with its reason, and for a duplicate, the story it matched, side by side | search, reopen, re-run the director |

### C. Tuning — occasional

| # | Screen | Scope | Primary action |
|---|---|---|---|
| 5 | **Charter** | the prose, with recent overrides beside it (what the director proposed versus what you decided) and version history | edit the guidance |
| 6 | **Targets** | list and editor: endpoint → server → tool picker from the discovered catalogue, the `args_spec` builder with the propose-args assistant, persona, role, description, dry-run test | add or fix a destination |
| 7 | **Personas** | voice, audience, rules, examples | edit a voice |
| 8 | **Sources** | registry: kind, hint, enabled, ingest token, watermark state, last submission received | add a source, rotate a token |

### D. Operations — when something is wrong

| # | Screen | Scope | Primary action |
|---|---|---|---|
| 9 | **Inbox** | raw submissions as filed, including "no story" outcomes and what slice was actually considered. Answers "did the stringer even file?" | inspect, re-process |
| 10 | **Log** | events and errors, queue state, inference call history, per-endpoint health. Must be fully usable with every port broken (invariant 7) | diagnose |
| 11 | **Settings** | auth, push registration, inference driver and endpoint, comparison window, retention | configure |

**Navigation.** Mobile: bottom bar with Queue · Ideas · More, everything else behind More. Desktop:
sidebar with the four groups. **Deep links:** push notification → `/publications/:id`; Android share
sheet → `/ideas?url=…&text=…`.

**Responsive treatment of screen 2**, the one that matters: desktop puts document and chat side by
side with target tabs on top; mobile gives the document full width and the chat as a bottom sheet,
with targets as a swipeable tab strip. Slots other than the primary collapse into a header section
on mobile.

## 8. Frontend / PWA

Android and desktop only; iOS explicitly out of scope.

- installable manifest, plus a `share_target` declaration so Newsdesk appears in Android's share
  sheet and a shared link becomes an idea submission
- service worker for install and push only — no offline editing in v1 (a stale draft overwriting a
  published one is worse than an error message)
- web push via VAPID keys generated on first boot and stored in `settings`; the notification says how
  many drafts wait and deep-links to the publication
- HTTPS is mandatory for install and push — satisfied by the `nsl.sh` subdomain

## 9. Security

- **Auth**: single user (argon2 password) + session cookie, `SameSite=Lax`, secure. Optional OIDC
  later, which on Yundera can hang off the existing `casaos-oidc-bridge`.
- **Ingest token**: separate from the session, rotatable, scoped to `POST /submissions` and `/ideas`.
- **Prompt injection**: submission text is quoted, delimited, labelled untrusted. Model output
  becomes a row, never an action. A human approves before every external effect.
- **Destination integrity**: channel ids and endpoints are literals in `args_spec`; no model-authored
  value can reach a routing key (invariant 3).
- **Rendering**: slots are markdown, sanitized before preview, never injected as raw HTML.
- **Outbound**: only configured MCP endpoints and configured webhook URLs. No fetching of
  user-supplied URLs — that stays on the stringer side.

## 10. Milestones

**M0 — skeleton.** Container, SQLite + migrations, auth, `/healthz`, SPA shell, navigation.

**M1 — ingest.** `POST /submissions`, sources, watermark and snapshot diffing, Inbox screen. Wire the
two n8n stringers. *Exit: real GitHub reports and korben entries land, and re-filing an overlapping
window trims correctly.*

**M2 — the director.** MCP endpoints + discovery, targets with `args_spec`, personas, charter.
Inference port with both driver capabilities, job queue with backoff. Submissions become stories with
dedup verdicts, routes, reasons and angles. Queue and Stories screens. *Exit: the same release filed
by two different stringers produces one story with two sources, and a redundant re-file is caught as
`DUPLICATE` with an explanation you agree with.*

**M3 — write, review, publish.** Writer with generated `submit_draft` schemas, Review screen with
slots and versions, per-target approve/spike, payload freeze, delivery via the `mcp` driver,
`discord-mcp` target live. *Exit: end to end on a real release into a test Discord channel, with the
sent payload byte-identical to the approved one.*

**M4 — assistant.** Chat beside the document, in-place slot editing, version history and revert.

**M5 — PWA.** Install, Android web push, share target, Idea box.

**M6 — operations.** Log screen, override statistics beside the charter, target dry-run,
propose-args assistant.

**M7 — migration.** Seed the story corpus from what has already been published so nothing recent is
re-announced; run in parallel with the existing pipeline against a test channel; compare decisions
for a week; cut over; retire the n8n cron, the Telegram bridge tap-forward, and the Docmost run
pages.

M0–M3 is the real work and produces something usable. M4–M6 are additive. M7 is a day plus a week of
watching.

## 11. Testing

- **Fixtures over live calls.** Recorded submissions and recorded inference results; the pipeline is
  testable end to end without Beacon.
- **The dedup regression set is the load-bearing one**: pairs that are the same story in different
  words from different sources, pairs that are genuine follow-ups, and pairs that merely look
  similar, with expected verdicts — run against a charter and a corpus so prompt changes can be
  evaluated rather than guessed at.
- **Routing regression set**: stories with expected destinations.
- **Payload identity test**: approve, then assert the delivered arguments equal the frozen payload
  byte for byte. This is invariant 1 and 2 as an assertion.
- **Slot schema generation**: `args_spec` → tool schema → writer output → merge, round-tripped
  against a mock MCP client.

## 12. Decisions still open

1. Node/TypeScript versus Python/FastAPI (§1).
2. Comparison window for dedup: 30 days global, or per-source.
3. Retention and pruning; leaning permanent archive.
4. Charter history versus last-write-wins; leaning history.
5. Whether `role: notify` targets are configured per-target or as one global notification setting in
   v1.
6. Slot types beyond `text` / `markdown` / `image` / `link` for v1.
7. ~~Exact argument shapes for `discord-mcp` and `telegram-mcp`~~ — **resolved 2026-07-28**, see
   §5.2.1. Still open: `nextcloud-talk-mcp__talk_send_message` argument keys, which that Beacon does
   not expose; needs one live test call.
