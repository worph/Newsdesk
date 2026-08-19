# Newsdesk — The administrator chat

> The front page of the desk becomes a conversation with an administrator that holds the desk's own
> tools: it reads the configuration, proposes what to change, changes it, files a tip, and walks a
> new operator through first setup.
>
> **The shape in one line:** the desk owns the loop and the tools; the model only chooses which of
> them to call next.
>
> Companion documents: [`admin-mcp.md`](./admin-mcp.md) (the same tools, exposed outward over MCP),
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) §9 (the invariants), [`pitch-and-reporting.md`](./pitch-and-reporting.md)
> §4 (the steer loop this borrows its shape from).
>
> Status: **design — nothing here is implemented.** Written 2026-08-07 against the working tree.

---

## 1. Why a chat, and why the front page

Everything the desk can be configured to do is already reachable — through the Configuration screen,
through Settings, and through `POST /mcp`. What is missing is the part a screen cannot do: knowing
*what to do next*. A desk with one stringer and no outlet is fully configured and completely
useless, and nothing in the current UI says so. An operator who has just installed Newsdesk sees a
correct, empty Configuration form and no way in.

So the value is not "an LLM in a box". It is:

- **Onboarding.** A new desk is configured by conversation rather than by reading three documents.
- **Proactivity.** The desk says "two stringers, no outlets — nothing you file can go anywhere"
  before the operator discovers it by filing something.
- **One surface for the work that spans screens.** "Add a Discord outlet in the public voice, point
  the GitHub stringer at it, and file a tip about the release" is four screens today.

**It does not replace `/now`.** The comment at the top of `web/src/pages/Now.tsx` defends a specific
moment — a phone, 09:04, a notification that just chimed — and a chat is the wrong screen for it.
The action rows are rendered *inside* the chat page, from the same `listActions` the notification
uses, so the two can never describe the same job differently.

### 1.1 Where it lives

`/` is not a route today: `App.tsx` ends in `<Route path="*" element={<Navigate to="/now" />} />`,
so the bare URL falls through the catch-all. **The chat becomes a real route at `/`**, and the
catch-all keeps sending everything unrecognised to `/now`.

The split of who lands where is decided by the manifest rather than by the viewport, because the
manifest already knows something a media query does not — whether this person installed the app:

| Entry | Lands on | Who that is |
|---|---|---|
| `start_url` — the installed icon | `/now`, unchanged | the phone, just after a notification |
| `/` — typed hostname, bookmark | the chat | someone sitting down to work on the desk |
| push deep-links | `/review/:id`, `/stories/:id`, `/now` — unchanged | wherever the notification pointed |

**`"id": "/now"` in the manifest must not change.** It is the app's identity to the browser; editing
it makes an installed Newsdesk read as a *different* app, so the existing install stops updating and
a second icon appears. `start_url` could be moved and deliberately is not — the installed app is
exactly the 09:04 case, and this document is not going to argue with `Now.tsx` and then re-point the
one entry that comment is about.

So the manifest is untouched, the phone tab bar stays at four, `/now` keeps its badge and its URL,
and the only change is that `/` stops being a redirect.

## 2. The bootstrap paradox

The first thing an operator needs help with is configuring the thing that would help them. A chat
cannot onboard a desk that has no inference wired, because there is nothing to talk to.

So onboarding is two steps, and only the second is conversational:

**Step 1 — manual, no inference.** A single screen shown when `isUnconfigured(db)`
(`server/src/config/store.ts:502`) and no endpoint exists: paste a Beacon URL → connect (an OAuth
popup where the endpoint asks for it, because `server/src/ports/mcp/oauth.ts` cannot follow an
authorization URL from a server) → the desk calls `tools/list` and stores the result in the
endpoint's existing discovery cache (`discovered_at`, `server/src/db/schema.ts:22`) → if
`claude-code__query_claude` is among them, offer it as `inference_endpoint`.

That is a form, a probe, and one radio button. It must work with every other port broken.

**Step 2 — conversational.** The chat takes over with an empty configuration and drives the rest:
charter, voices, stringers, outlets. It has the same tools it will have forever; onboarding is not a
special mode, it is the ordinary chat talking to an empty desk.

## 3. The loop

The configured driver is `mcp-claude-code`, and it declares `capabilities: { toolCalling: false }`
(`server/src/ports/inference/claude-code.ts:22`). Prose in, prose out. The chat therefore runs the
loop itself:

```
  operator's message
        │
        ▼
  build prompt = system + catalogue + configuration digest + history + message
        │
        ▼
  runStructured → { say?, call? }        ← one JSON object, never free text
        │
        ├── call: execute it against the desk's own function, append the result, loop
        │
        └── no call: the turn is over, `say` is the reply
```

Three properties fall out of doing it this way, and they are the reason to do it this way:

1. **Every step is a real Newsdesk function call.** Not a suggestion the UI then has to interpret —
   `upsert_outlet` in the loop is the same `upsert_outlet` the MCP server exposes, which is the same
   `writeConfig` the Configuration screen calls. One definition of what a valid desk is.
2. **Every step is a log row.** The desk knows what it did to itself, which is exactly what an
   agent looping on the other side of the Beacon cannot give us.
3. **The driver stays swappable.** This is the bet `claude-code.ts:12` already states: *"everything
   built on top is written against the weaker guarantee, and the tool-calling driver then becomes a
   strict improvement rather than a rewrite."* The loop below is written against prose-in/prose-out;
   a driver with `toolCalling: true` replaces the JSON round-trip with native tool calls and nothing
   above it changes.

`server/src/pipeline/reporter.ts` already runs this exact shape — a steer step that answers with
indices into a catalogue the desk built, executed by the desk, fed back. The reporter is the
precedent; this is the same loop with a different catalogue and a human in the conversation.

### 3.1 Bounds

| Bound | Value | Why |
|---|---|---|
| Calls per turn | 8 | A turn that needs more than eight is a turn that has lost the plot. Stop and say so. |
| Turn timeout | 120 s | A human is waiting. Longer than the queue's ceiling would be a lie about who this is for. |
| History carried | last 20 messages + a configuration digest | The digest is `describeConfig` (`config/store.ts:327`), regenerated every turn, so the model never works from a stale copy it was shown ten messages ago. |
| Malformed answers | 2 retries, then fail the turn | `runStructured` already owns this; the retry is the same one the managing editor gets. |

A failed turn is a message in the thread saying what broke, not an exception. The log entry is
authoritative (invariant 7); the chat is a convenience over it.

### 3.2 Concurrency is no longer a reason to refuse

`server/src/pipeline/queue.ts:44` already records that the single-session constraint is gone and
the Beacon runs queries in parallel. `claude-code__check_status` confirms it — `available` is always
true, and capacity is memory rather than a lock.

**`assistPreflight` (`server/src/assist/run.ts:102`) has not caught up.** It still refuses with a
409 whenever any job is `RUNNING`, on the stated grounds that "there is only one agent". That is a
stale guard costing the assist button its availability today, and building a front-page chat behind
the same reasoning would make the whole page unusable whenever a publish job is in flight.

**Prerequisite: delete that check.** Keep the `!driver` 503 — "nothing is wired" is still true and
still worth saying.

## 4. The catalogue

The catalogue is **Newsdesk's own tools and nothing else.** Not the discovered tools of the
configured MCP endpoints, and not the agent's own filesystem and shell. The desk is what is being
administered; the inference engine is a language model that happens to live behind an agent, and
the fact that the agent can read files is not a capability we want in this conversation.

That is enforced structurally rather than by asking: **the desk executes only what it recognises.**
An answer naming a tool outside the catalogue is a malformed answer — logged, fed back once as an
error, and never executed. There is no path from the model's output to anything the desk did not
already build a handler for. (The prompt says so too, but the prompt is the courtesy; the
allowlist is the mechanism.)

### 4.1 Where it comes from

`server/src/admin/tools.ts` already *is* the catalogue — 21 tools, each a thin wrapper over
`config/store.ts` with its validation, its restore point, and its refusal to delete a stringer that
has filed. Today they are registered against an `McpServer`. The change is to lift the definitions
out of that registration:

```
admin/registry.ts    ← name, description, zod input schema, handler  (the definitions)
   ├── admin/tools.ts   registerAdminTools()  → MCP server            (existing caller)
   └── chat/loop.ts     catalogue + dispatch  → the chat              (new caller)
```

Two callers, one list. A tool added for the chat is reachable over MCP the same day, and a refusal
tightened in `config/store.ts` binds both without anyone remembering to mirror it. The input schemas
stay the real ones — `outletSchema`, `voiceSchema` and the rest straight from `shared/src/config.ts`
— so the catalogue the model reads and the validator that rejects it can never disagree.

### 4.2 What the chat adds

| Tool | What it does | Why it is not already there |
|---|---|---|
| `list_actions` | what the desk is waiting on the operator for | `listActions` exists (`api/actions.ts:182`); the MCP surface never needed it |
| `read_kb` | one document from the shipped operator KB, by topic | §7 |
| `read_publications` | what has actually been published, recently, per outlet | §6 — the one tool that reads editorial content |

Everything else is already written.

### 4.3 What it can decide, and what it cannot do

This section used to say the chat could not approve, publish or spike. **That changed, deliberately,
at the desk owner's request**: clearing sixty-three drafts one screen at a time is not a thing
anyone does, and a backlog that only grows stops being a list of what needs you. Three tools now
decide the fate of work rather than configure the desk:

| Tool | Does | Reversible |
|---|---|---|
| `spike_publications` | kills drafts waiting on a person, in bulk | yes — the spiked view keeps them |
| `drop_stories` | closes held stories nobody answered | yes — the question is kept with them |
| `approve_publications` | **freezes payloads and sends them** | no |

Two things make that safe enough to ship, and they only work together:

**The model proposes; a person runs it.** All three carry `confirmWith`, so `dispatch` refuses to
run them and writes an offer instead (§6). The word carries the count — `spike 12`, `publish all` —
because the count is the part of a bulk proposal that holds the consequence, and a confirmation that
did not name it would be agreement to the wrong thing.

**They are `chatOnly`.** The MCP adapter has no operator to ask and simply calls handlers, so
registering these there would be the same decisions with the gate removed, reachable by any agent
that can see the desk's Beacon. `admin/tools.ts` filters them out and `admin-mcp.md` still promises
what it always did.

What this costs is honest and worth writing down: **`approve_publications` means a person can
approve payloads they have not read.** Invariant 1 used to guarantee that could not happen and now
says what is actually true. Invariant 2 is untouched — no inference runs between approval and send,
so what goes out is still exactly the bytes the desk froze — and that is what stops this being a
model publishing prose it wrote a moment ago.

**It still cannot read editorial content.** The desk can decide the fate of a draft by id and cannot
read a word of it, which is the reason the prompt makes the chat say so every time it offers to
approve. The three things that need a browser the server does not have — authorising an endpoint
over OAuth, signing the publishing browser into a destination, changing the desk password — remain
out of reach for the same reasons `admin-mcp.md` gives.

### 4.4 One redaction

`get_settings` returns the ingest token in full (`admin/tools.ts:320`), and `admin-mcp.md` leans on
that deliberately: a caller holding the administration token could already file by POSTing to
`/api/v1/filings`, so the tool grants nothing new. That reasoning holds for a sidecar and breaks for
a browser — here the value would land in an `admin_messages.content` row and in a scrollback, and it
is the credential pasted into every n8n stringer workflow.

The chat needs the token for nothing; it files with `file_tip`. So **the registry entry carries a
`redactSecrets` flag the chat sets and the MCP server does not**, and the chat sees
`nsk_…3f2a` with a line pointing at Settings. Enough to answer *is it set* and *is this the one the
stringers hold*; not enough to leak. One tool, one definition, one boolean.

Note what this is *not*: a substituted-at-call-time placeholder. That pattern is for a secret the
desk sends outward, and by invariant 8 the desk holds none — Beaconify carries the administration
token so Newsdesk never presents one. The ingest token travels the other way: the desk issues it and
n8n presents it inbound. There is no call site to substitute at, only a display to redact.

## 5. The Start button

The chat opens with a status, and **the status is computed without inference.**

```
listActions(db)        → what needs a decision
checkHealth(db, ver)   → every endpoint, live
describeConfig(cfg)    → what exists and what is missing
```

Three deterministic calls. The model's only job is to say them well, and if it cannot — Beacon down,
endpoint unauthorised, nothing configured yet — **the page still renders the status**, as rows and a
health strip, with a line saying the assistant is unavailable. That is invariant 7 applied to the
front page: the desk must stay diagnosable with every port broken, and a landing page that goes
blank when the Beacon does would be the worst possible screen to lose.

Proactivity is the same trick. "Two stringers and no outlet", "the RSS stringer has not filed in
nine days", "this outlet has never published" are **rules over the configuration**, evaluated by the
desk. The chat renders them into a sentence and offers to fix them. There is no background
inference loop; the desk does not think while nobody is watching.

The button is advertised in the empty thread, because a chat with no visible affordance is a chat
nobody presses.

## 6. Reading content, and where invariant 4 lands

The administrator chat is **operator-driven**, and the operator is trusted. It is not the managing
editor and it does not inherit the editorial gate: it holds write tools over the whole
configuration, and that is the point of it.

Invariant 4 still has one narrow application here, and it is created by `read_publications`. Article
text is derived from filings, and filings are attacker-influenced. A tool that returns that text into
a context holding `write_config` is the one place in this design where untrusted bytes meet a write
capability.

The fix is not a gate on the operator. It is a fence around what the tool returns, and the desk
already owns it: `splitBundle` (`server/src/assist/run.ts:52`) splits what the desk knows about
itself from what came from outside, and wraps only the latter in untrusted markers. `read_publications`
returns through the same fence. The rest of the conversation — configuration, health, versions, the
action list — is the desk's own reading of its own database and is not fenced, which is what keeps
the marker meaningful rather than decorative.

Two supporting rules:

- **Content is read-only and summary-shaped.** Headline, outlet, when, status. Enough to answer
  "what have we been publishing"; not a channel for pasting a whole draft into the loop.
- **Destructive writes still confirm.** `write_config`, `restore_config_version` and
  `remove_config_entry` are marked destructive in the registry already; in the chat they render as a
  card with the before/after and a typed confirmation, reusing `riskOf` and `confirmationFor`
  (`shared/src/remedy.ts:172`). Not a gate on the operator's authority — a gate on a fat finger.

## 7. The knowledge base

The chat ships knowing how a Newsdesk works. That knowledge is **the documents in `docs/`, read on
demand**, not a preamble.

Preamble is the wrong shape twice over: these documents are long prose and would crowd out the
conversation, and a copy pasted into a prompt is a copy that drifts from the document it was copied
from. So:

- The system prompt carries an **index** — one line per document, what it answers.
- `read_kb(topic)` returns one of them, whole.
- The set is the shipped docs themselves, plus a small `docs/kb/` of operator-facing pages that have
  no other home (what a charter is for, how a voice differs from an outlet, what a stringer must
  file). Same mechanism as `server/src/prompts/*.md`: prose in markdown, copied into `dist` at build
  time, cached on first read.

A model that has read `stringers.md` before answering a question about stringers is worth more than
one carrying a paraphrase of it in every request.

## 8. Data model

`chat_messages` already exists but is publication-scoped — it is the copy desk's thread, keyed to a
draft (`server/src/db/schema.ts:361`). This needs its own:

```ts
export const adminThreads = sqliteTable('admin_threads', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull().default(now),
  /** Last message. The idle roll in 8.2 reads this and nothing else. */
  updatedAt: text('updated_at').notNull().default(now),
})

export const adminMessages = sqliteTable('admin_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => adminThreads.id),
  role: text('role').notNull(),               // user | assistant | tool
  content: text('content').notNull(),
  /** For role=tool: which catalogue entry, and what it was given. */
  toolName: text('tool_name'),
  toolInput: text('tool_input', { mode: 'json' }),
  ok: integer('ok', { mode: 'boolean' }),
  /** Set when this call produced a configuration version, so the thread links to the undo. */
  versionId: integer('version_id'),
  createdAt: text('created_at').notNull().default(now),
})
```

The tool turns are stored as messages rather than hidden, because the thread *is* the audit trail a
human reads. `versionId` is what makes "undo that" a link rather than a search.

Migrations are append-only — `npm run db:generate`, never a rewritten baseline.

### 8.1 One visible conversation, rolled on idle

There is a `thread_id`, and the operator never sees it. **The chat is the newest thread**: opening
the page shows the conversation you were in, and there is no list, no history to browse and no title
to maintain.

The roll is the whole mechanism. On a turn, if the newest thread's `updatedAt` is more than **8
hours** old, start a new one instead of appending. A working session is a day and overnight is a
real boundary, so the seam lands where a person would have put it.

The same roll can be asked for by hand — **`/new`**, or the *New conversation* button, which is the
same code path. That is not a thread list creeping in: it starts one and names none, and the
operator still holds no id. It exists because the reason to want a boundary usually arrives before
the eight hours do — the subject changed, and the last twenty messages are about the previous one.

This exists to keep §3.1 honest. The prompt carries the last 20 messages; in one unbounded rolling
thread that window is silently untrue — the outlet you set up three weeks ago is still visibly on
screen and the model can no longer see it. A boundary the operator does not manage but does
experience is the cheapest way to stop the screen lying about what the model knows.

Rolling costs almost nothing precisely because of §9: `{{CONFIG}}` and `{{STATUS}}` are regenerated
every turn. A new thread loses the *conversation*, never the desk's state.

Old threads are kept, not deleted — they record *why* a change was made, which a configuration
version cannot — and purged at **30 days**, the window the rest of the desk already uses. Nothing in
M9 surfaces them; they are read from the database when someone needs to know why.

### 8.2 Logging

Writes are already logged twice by `config/store.ts`: a `CONFIG_CHANGED` row and a configuration
version. The chat sets the author to `chat` (the MCP server uses `mcp`), so the Configuration
history screen shows who did what without a new concept.

Two new codes in `server/src/events.ts`, both category `config`:

| Code | Level | When |
|---|---|---|
| `CHAT_TOOL_FAILED` | `warn` | a catalogue call was refused or threw |
| `CHAT_TURN_FAILED` | `error` | the turn hit the call bound, the timeout, or two malformed answers |

A successful call needs no event of its own; the configuration version is the record.

## 9. Prompts

One new file, `server/src/prompts/admin-chat.md`, added to the `PromptName` union in
`prompts/load.ts`. Tokens:

| Token | Contents |
|---|---|
| `{{CATALOGUE}}` | the tool list, generated from the registry — never hand-maintained |
| `{{CONFIG}}` | `describeConfig` output, regenerated every turn |
| `{{STATUS}}` | actions + health, the same values the Start button renders |
| `{{KB_INDEX}}` | one line per KB document |
| `{{HISTORY}}` | the last 20 turns, tool turns included |
| `{{MESSAGE}}` | the operator's turn |

The prompt's substance, in the register the other prompts use: you are administering one desk for
the person you are talking to; you have these tools and nothing else; read before you write; change
one entry at a time and prefer the narrow tool over `write_config`; say what you are about to do
before you do it; when the configuration cannot do what they asked, say that instead of approximating
it.

And one section it must carry, because three of the tools decide the fate of work rather than
configure the desk (§4.3): **propose these, never claim them.** Say the count before the sweep, never
widen what was asked for, prefer the reversible decision, and — every time approval is offered — say
plainly that neither of you has read the copy, because nothing on this surface can. A model that
says "I have spiked them" when it has only offered to is the failure mode this section exists for.

## 10. API surface

| Route | Does |
|---|---|
| `GET /api/v1/admin-chat` | the current conversation — newest thread, or empty; rolls per §8.1 |
| `POST /api/v1/admin-chat/messages` | run one turn; SSE, so tool calls appear as they happen |
| `POST /api/v1/admin-chat/confirm` | run a proposed destructive call, by message id (§6) |
| `POST /api/v1/admin-chat/status` | the Start routine — no inference, no thread required |
| `POST /api/v1/admin-chat/command` | a command the desk answers itself — `/status`, `/new`; no inference |
| `DELETE /api/v1/admin-chat` | clear the visible conversation (starts a fresh thread; keeps the old rows) |
| `POST /api/v1/stories/:id/drop` | close a held story unanswered — the screen's half of `drop_stories` |

A command either answers *in* the conversation or *replaces* it, and the reply says which: `/status`
comes back as a pair of ordinary turns, `/new` comes back as the empty thread it just started,
carrying the `threadId` that only a roll has. `/new` and the `DELETE` are one function with two
doors, refusal included — neither will put away a conversation that is still writing rows into
itself, and both answer that with a 409.

No thread ids in the URLs, because §8.1 says the operator never holds one. The server picks the
thread; the client asks for "the conversation".

Session cookie, like every other `/api/v1` route. **The administration MCP token is not accepted
here** — that token belongs to a sidecar, and this surface is a browser at the desk.

The turn endpoint streams because a turn is up to eight tool calls and a silent spinner for ninety
seconds is indistinguishable from a hang. Streaming is also what replaces a step-through mode: each
call appears as it lands, and each one that produced a configuration version renders with an **Undo**
linking to that restore point. Watch-and-revert, with no suspended-turn machinery (§12).

`POST /api/v1/admin-chat/status` is deliberately a route of its own, so the front page can render
before any thread exists and while inference is down.

### 10.1 What the stream is, and what it is not

The transport was reconsidered before it was built. The alternative was the polling this codebase
already uses to watch something in flight (`Review.tsx`'s self-terminating `refetchInterval`), and it
is a closer fit than it looks: §8 requires every step to be a row anyway, so SSE is a second delivery
path over data that already has one. It was kept regardless — the steps arrive without a poll delay,
and a turn is long enough for that to be worth something. What follows is what makes keeping it
honest.

**The rows are the record; the stream is a view of them.** The loop writes the `admin_messages` row
and *then* emits it. The stream therefore cannot show a step the audit trail lacks, which is the
failure SSE invites and the reason the ordering is fixed rather than incidental.

**The turn is detached from the request.** It runs to completion whether or not anyone is listening,
so closing the tab does not abandon a half-finished sequence of configuration writes.
`reply.raw.on('close')` drops the listener and nothing else.

**Reconnect goes through `GET`, not through the stream.** There is no resume-from-offset and no
event ids to replay: a dropped connection, a reload or a slept phone recovers by asking for the
conversation, which returns every row written so far plus whether a turn is still running. Small, and
honest about what it does not do.

**A heartbeat every 15 s.** A step can be a minute apart and idle timeouts sit between the desk and
the browser; without it a working turn looks like a dead socket.

**A refusal is not a stream.** No inference wired answers `503` as JSON, and a second turn on a
conversation that is already thinking answers `409` — both before the socket is hijacked, so a client
gets an ordinary error rather than an empty event stream.

The cost is paid in one place: `app.inject()` buffers, so the stream is covered by a single
socket-level smoke test (`admin-chat-sse.test.ts`, following the precedent `admin-mcp.test.ts`
already set) while every property of the loop is unit-tested without it.

## 11. Where the invariants land

| Invariant | How it holds |
|---|---|
| 1 — nothing publishes without human approval | **weakened here, on purpose.** `approve_publications` releases many payloads on one confirmation, so approval is no longer per-payload and no longer after reading. The human survives; the reading does not. §4.3, and ARCHITECTURE.md invariant 1 |
| 2 — no inference between approval and send | untouched, and now load-bearing: a sweep freezes stored bytes, so what goes out is still never something a model wrote after approval |
| 6 — a drop is recorded and visible | a sweep names what it did not take and why — an id that moved between the proposal and the confirmation must not read the same as one that was handled |
| 3 — the model never authors a destination | it fills `outletSchema`, whose destination key is a validated literal; the same rule the writer gets |
| 4 — ingested text is data | only `read_publications` carries such text, fenced through `splitBundle`; §6 |
| 7 — the internal log is authoritative | the Start routine and the whole page render with every port down; §5 |
| 8 — no third-party credentials | **the reason the driver stays prose-in/prose-out.** A native tool-calling driver would mean an LLM API key in the desk. The desk-side loop gets tool calling out of the model it already reaches through the Beacon, holding nothing. |

Invariant 8 is worth stating as a decision rather than an accident: **the desk-side loop is not a
workaround for a weak driver, it is what lets the desk stay credential-free.** If a tool-calling
driver is ever added, it arrives with a credential and that invariant needs an explicit carve-out
first, in this document.

## 12. What we will not do

- **No background inference.** The desk does not think while nobody is watching. Proactivity is
  deterministic rules rendered conversationally; a chat that wakes up and reconfigures things is a
  different, worse product.
- **No agent-side loop.** Handing `query_claude` a `sessionId` and letting the agent drive Newsdesk's
  own `/mcp` through the Beacon would be less code and is genuinely tempting. It is rejected because
  the desk would stop knowing what was done to it, and because it would only work on a deployment
  wired exactly like ours.
- **No tools beyond the desk's own.** Not the configured endpoints' discovered tools, not the
  agent's shell. §4.
- **No step-through mode.** Confirming every safe call before it runs would make the turn resumable
  — pending-call state persisted in the thread, a loop that is a state machine rather than a
  function. That is a large part of 9b for something nobody has asked for, and the two things it
  would buy already exist: destructive calls confirm (§6), and every write leaves a numbered restore
  point the stream can link to (§10). Watch it land, undo the one you disliked.
- **No thread management.** One visible conversation, rolled on idle (§8.1). No list, no titles, no
  archive UI.
- **Not a replacement for the Configuration screen.** A form is better than a conversation for
  reading twelve fields at once, and the screen is what the chat's own changes must remain visible
  in.

## 13. Milestone

**M9**, after M8. Shippable in three slices:

| Slice | Contents |
|---|---|
| **9a** | ✅ delete the stale `assistPreflight` job check; extract `admin/registry.ts` with the `redactSecrets` flag; `list_actions`; `POST /admin-chat/status` and the Start card on `/now` — **no inference at all, and useful on its own** |
| **9b** | ✅ the loop, the two tables and the idle roll, the chat page at `/`, the prompt, the destructive-write confirmation, the streamed Undo links |
| **9c** | onboarding step 1 (the endpoint form) routed to when `isUnconfigured`; `read_kb` and `docs/kb/`; `read_publications` behind the fence; the 30-day thread purge |

9a and 9b shipped together on 2026-08-07. Two things were found while building them that this
document had not anticipated, both recorded here because they changed the code rather than the plan:

- **`writeConfig` could not say which restore point it had taken.** Both existing callers recovered
  it by reading the newest row, which is wrong whenever a write changes nothing — and the same
  mistake had `restoreConfigVersion` stamping an unrelated version as the way back from a restore,
  in the commonest case the restored row naming itself. It now returns `{ config, versionId }`, which
  is what §8's `versionId` column needed anyway.
- **A driver factory is not the same as working inference.** `POST /status` reported
  `available: true` on a desk with no endpoint at all, because the factory is always wired and only
  throws when called. It now constructs one and reports the port's own words.

9a is worth having whether or not the rest lands, which is the test of whether the slicing is real.
Nothing in any slice touches `manifest.webmanifest` (§1.1).

## 14. Testing

- **The catalogue is generated, so assert it.** A test that every registry entry has a description
  and a schema, and that the MCP server and the chat catalogue contain the same names.
- **Refusals round-trip.** A rejected write comes back as `ConfigIssue[]` with a path per problem;
  the loop must feed that back and the model must be able to fix and retry. Test with a deliberately
  invalid outlet.
- **The allowlist holds.** A canned answer naming `publish_now` is rejected, logged, and executes
  nothing.
- **The status routine runs with every port broken.** No endpoint, unreachable endpoint, no charter.
- **The fence survives.** A filing whose body contains instruction-shaped text reaches the prompt
  inside the untrusted block and nowhere else.

## 15. Decisions taken

Four questions were open when this document was first written. All four were settled on 2026-08-07,
recorded here with what decided them.

1. **One conversation, rolled on idle** — not a thread list. The operator sees one chat and manages
   nothing; the newest thread is the chat, and a new one starts after 8 hours idle. The deciding
   argument was not simplicity but honesty: the 20-message window in §3.1 is a lie inside one
   unbounded thread, and an idle roll makes the seam land where a person would have put it anyway.
   Old threads kept 30 days for the *why*. §8.1.
2. **`get_settings` is redacted in the chat**, in full over MCP — one registry entry, one
   `redactSecrets` flag. The chat needs the ingest token for nothing and would otherwise write it
   into a message row. §4.4.
3. **No step-through.** Stream the turn and put an Undo on each resulting configuration version. The
   two things step-through would buy already exist; what it would cost is a resumable loop. §12.
4. **The chat is `/`; the installed app still opens on `/now`.** Decided by the manifest rather than
   by preference: `"id": "/now"` cannot move without orphaning existing installs, and `start_url` is
   the *installed* app's entry — which is the 09:04 phone case `Now.tsx` is written for. `/` stops
   being a redirect; nothing else changes. §1.1.

### Still genuinely open

- **What the chat page shows on a phone.** It is reachable there (the sheet, or a header button) and
  the tab bar is not growing to five. Whether the action rows should also render inside the chat on
  a narrow screen, or only on a desk, is a layout question best answered by looking at it.
- **Whether `docs/kb/` is worth writing at all**, or whether the shipped design documents already
  answer everything an operator asks. Cheapest to find out by shipping 9b without it and reading
  what people ask the chat.
