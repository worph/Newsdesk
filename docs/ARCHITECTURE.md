# Newsdesk — Architecture

> The model. What Newsdesk owns, what it delegates, and the invariants that must not be broken.
> Companion documents: [`README.md`](./README.md) (what and why), [`IMPLEMENTATION.md`](./IMPLEMENTATION.md)
> (stack, schema, API, surfaces, milestones).
>
> Status: design of record, 2026-07-28. Pre-code — nothing here has been built yet.

---

## 1. The one-sentence model

**Newsdesk owns editorial state and editorial decisions. It owns nothing about protocols,
credentials, inference, or delivery.**

Everything that needs an API key, an OAuth dance, a browser, or a protocol client lives outside the
app and reaches it through one of three ports. This is a deliberate constraint, not an accident of
staging: it is what keeps the app small enough to finish and stable enough not to rot when GitHub
changes an endpoint.

The trade it makes, stated honestly: **Newsdesk's capability set is exactly "what your n8n and your
Beacon can already do."** It cannot ingest a stringer nobody has wired up, and it cannot publish to
a destination that has no MCP server or webhook. In exchange it never carries integration
maintenance.

## 2. The newsroom metaphor, taken literally

The whole design falls out of the roles.

| Role | Who plays it | Responsibility |
|---|---|---|
| **Stringers** | external n8n workflows | have the credentials, go and look, **file reports** — inclusively, with evidence |
| **The Reporter** | a bounded loop inside the app | for a tip filed by someone with no credentials, **goes and looks**: searches, opens pages, files a dossier |
| **The Managing Editor** | one LLM call inside the app | reads reports, **finds the stories**, kills duplicates, decides where each one runs |
| **Writers** | one LLM call per destination | fill that destination's authoring slots, in its voice |
| **The Editor** | you | rewrite anything, approve or spike each piece individually |
| **The Press** | MCP outlets | dumbly send exactly what was approved |

The load-bearing division: **stringers file, the managing editor kills.** A stringer's prompt must
never be asked to judge newsworthiness — it says "report anything plausibly interesting."
Newsworthiness lives in exactly one place, the charter, inside the app. Split it across two systems
and you end up tuning relevance in two prompts and never knowing which one dropped the story.

## 3. The pipeline in one line

> **Config generates the tool schemas · tools enforce the shape · the human edits the slots ·
> publish merges and sends.**

Every mechanism below is an elaboration of that sentence. Model calls happen only on the way *in*
(finding stories, filling slots, helping you edit). Everything from approval to the press is
deterministic.

## 4. The three ports

```
┌─────────────────────┐      ┌───────────────────────────────────┐      ┌──────────────────────┐
│   INGEST (external) │      │             NEWSDESK              │      │  DELIVERY (external) │
│                     │      │                                   │      │                      │
│  n8n stringer ──────┼─────▶│  ① managing editor                │─────▶│  discord-mcp         │
│    GitHub (creds)   │ HTTP │       (find + dedup + place)      │ MCP  │  telegram-mcp        │
│  n8n stringer ──────┼─────▶│  ② writers          (fill slots)  │─────▶│  nextcloud-talk-mcp  │
│    RSS              │ push │  ③ editor           (review UI)   │      │  …future…            │
│  tip line (internal)┼──────│  ④ press            (merge + send)│      └──────────────────────┘
│  future: MCP pull   │      │           audit · error log       │
└─────────────────────┘      └─────────────────┬─────────────────┘
                                               │ MCP
                                               ▼
                                    ┌──────────────────────┐
                                    │ INFERENCE (external) │
                                    │ API w/ tool calling  │
                                    │ or claude-code/Beacon│
                                    └──────────────────────┘
```

### 4.1 Ingest port — free-text reports

The unit crossing this port is a **filing**: free text filed by a stringer, at whatever depth that
stringer works in. It is explicitly *not* a normalized news item, and it carries no required
identifier.

A filing can be a **report** ("here is what happened in this codebase this week, with evidence
and links"), a **timeline** (entries with dates and descriptions), or a **snapshot** (current state,
no history).

```
POST /api/v1/filings          Authorization: Bearer <ingest token>
{
  "stringer_id": "github-yundera-root",
  "kind":      "report",                         // report | timeline | snapshot | tip
  "text":      "…free text, any depth…",
  "refs":      { "url": "...", "sha": "..." },   // optional, opportunistic
  "filed_at":  "2026-07-28T09:12:00Z"
}
```

Two pieces of cheap deterministic work happen before any inference, purely to keep the expensive
judgement small: **timeline** stringers carry a watermark so entries at or before the last
considered timestamp are not re-examined, and **snapshot** stringers are diffed against the previous
snapshot so the managing editor is handed the *change*, not the whole state. Neither is a
deduplication authority — they are an economy measure, and a stringer fitting neither shape simply
skips them.

**Enrichment is a stringer concern.** If a story will need the commit body, the linked pull request,
or an app's metadata, the stringer — which has the credentials — fetches it and writes it into the
report. Newsdesk never fetches. A report too thin to write from truthfully produces a story marked
`HELD`: visible with its reason, re-runnable, never fabricated around.

*Later, not v1:* a **callback interface** letting the managing editor ask a stringer for more
depth on a specific point, and a **pull driver** where a stringer names an MCP tool and a response
mapping. Both are additive; push-only covers day one.

### 4.2 Inference port — one operation, two capability levels

One operation: **a request in, a validated result out.** No sessions, no streaming, no side effects.

Drivers differ in *how* the result is constrained, and the port models this as a capability rather
than forking the pipeline:

| Driver capability | How results are constrained | Example |
|---|---|---|
| **tool calling** (preferred) | the model calls generated tools; the schema enforces the vocabulary | OpenAI-standard API, direct Anthropic API |
| **text only** (fallback) | the same prompt asks for JSON; the app validates and retries once with the parse error | `claude-code__query_claude` via Beacon |

The prompts are identical. The adapter either reads tool arguments or parses JSON out of text.

**Why tool calling is worth preferring:** the schemas are *generated from live configuration*, so a
model cannot name an outlet that does not exist, cannot omit a required slot, cannot exceed a slot's
length, and cannot return malformed JSON. That deletes a class of failure rather than handling it.

**Why the text driver still matters:** `claude-code` behind Beacon bills against an account already
paid for rather than metered tokens, which is why it is the day-one driver for our own deployment.
It is also effectively single-session and returns `409 Conflict` on overlap, so the queue runs at
concurrency 1 with backoff and jitter — work waits in `PENDING` rather than failing. That replaces
the previous system's staggered cron, preflight-polling node, and error-reclassification logic with
two lines of configuration.

Three call sites, and only three: **managing editor**, **writer**, **copy desk**.

### 4.3 Delivery port — dynamic outlets, authored slots

An **outlet** is a configuration row, not code. Adding a destination means deploying an MCP server
(or pointing at a webhook) and inserting a row.

Each key in an outlet's `args` is one of three things:

| Kind | Who sets it | Visible at review? |
|---|---|---|
| **literal** | configuration | no |
| **derived** | a template expression over the story | no |
| **slot** | the writer fills it, the human edits it | **yes — the slots *are* the review surface** |

```yaml
# discord-news   (schema verified against the live Beacon, 2026-07-28)
tool: discord-mcp__send_embed
args:
  channelId:   "1516814412244193380"                          # literal — always pin, see below
  timestamp:   true                                           # literal
  footer:      "{{story.url}}"                                # derived — send_embed has no url param
  title:       { slot: text,     label: Headline, max: 256 }
  description: { slot: markdown, label: Body, max: 4096, primary: true }
```

```yaml
# telegram-broadcast
tool: telegram-mcp__send_message
args:
  chatId: "-5333649854"                                       # literal — always pin, see below
  disablePreview: true                                        # works, though absent from the advertised schema
  text: { slot: markdown, label: Post, max: 4096, primary: true }
```

⚠️ **Both tools treat their destination argument as optional** — `channelId` and `chatId` are not in
their `required` lists, so an omitted destination silently falls back to whatever default the bridge
is configured with. An outlet's `args_spec` must therefore **always pin the destination as a
literal**, and outlet validation must refuse to save a `publish` outlet whose destination key is
missing. This is invariant 3 with teeth: the danger is not only a model writing an address, it is
*nobody* writing one.

**Authorship is inverted on purpose.** A model does not emit the payload with some fields marked
reviewable; the configuration declares the slots and the model fills only those. If the writer
emitted the whole object it would author `channelId` — and a model that picks the destination can
put an internal note in a public channel, which no amount of reviewing catches when the reviewer is
reading a document rather than JSON. **Destination is configuration. Content is authored.**

One declaration drives three things: the writer's tool schema, the review UI, and the published
payload. `primary: true` marks the slot that gets the full editor and the copy desk; other slots —
the headline among them — render as fields above it. That is what keeps the review screen stable across a four-key Discord
embed and a one-key Telegram message — it is always *a document plus a few fields*.

Three further properties:

**Notification is delivery.** The "drafts are waiting" ping is an outlet with `role: notify`. The
same `telegram-mcp` server can be an approval notifier and a publish destination with no special
casing. Because the notification is only a deep link into the app, it needs no buttons, no callback
routing, and no bridge — removing the most fragile component of the previous system.

**Rendering happens before approval, never after.** In the previous pipeline the Telegram broadcast
was generated at publish time from a prompt in a bridge config, so the text reaching Telegram had
*never been read by a human* — only the Discord version had. Newsdesk closes that hole structurally.

**The `driver` field is the portability escape hatch.** `mcp` reuses Beacon and keeps credentials
out of the app — that is the deployment we run. `webhook` (a Discord incoming-webhook URL, one
field) and `builtin` exist so the app can be installed from a store without an MCP bus. Same
contract, different transport. A genuinely multi-step delivery (upload media, then post referencing
it) is not an agent problem — it is an n8n webhook outlet. Stringers are n8n on the way in;
complicated deliveries are n8n on the way out.

## 5. The managing editor

One inference call per filing, answering three questions: is there a story here, have we already
told it, and where does each one run.

### 5.1 Tool vocabulary

```
open_story(title, summary) -> story_ref
    duplicate_of(story, existing_story_id, reason)      # terminal; links the earlier story
    update_of(story, existing_story_id, reason)         # continues; links it as context
    hold_for(story, what_is_missing)                    # held for the editor
    propose_placement(story, outlet_id, reason, angle?)     # zero or more
no_story(reason)                                         # nothing in this filing
```

These map one-to-one onto database rows. **Zero `propose_placement` calls on a story is the
newsworthiness gate** — there is no separate gating mechanism, and a drop reason is the same field
as a placement reason.

`propose_placement` parameters, and what was deliberately left out:

- `outlet_id` — an enum generated from the live outlet list, so an unknown destination is impossible
  rather than merely validated.
- `reason` — shown beside the placement toggle in review.
- `angle` — an optional note to the writer ("lead on the security implication; this audience runs it
  in production"). The managing editor has just read the charter and knows *why* the story belongs
  here; passing that on is free and is the difference between drafts that differ in tone and drafts
  that differ in what they lead with.
- **No significance score.** A global scalar was always a proxy for "does this clear the bar for
  **this* audience", which the managing editor can now answer per destination directly, since it
   reads each outlet's description. Scores are not calibrated between runs, and a filter on one is a
   false sense of control. Placement *is* the judgement. A coarse label may exist to sort the queue
   for a human; it never filters.

### 5.2 Deduplication is semantic, bounded, and reviewable

A key constraint catches the same door twice; it cannot catch **the same story arriving through a
different door**. The same release can reach the desk from a GitHub stringer, an RSS feed, and
someone's tip — different wording, different depth, no shared identifier.

| Verdict | Meaning | Consequence |
|---|---|---|
| `NEW` | not told before | proceed to placement |
| `DUPLICATE` | already told | dropped, **with the earlier story linked**, visible in the spiked view |
| `UPDATE` | a genuine follow-up | proceed, earlier story linked as context for the writer |

`UPDATE` is not a technicality — a point release after a feature launch, a correction, a second
commit finishing something announced half-done. Only a reader tells that from a duplicate, and it is
frequently the better piece.

**Redundancy across stringers is a feature.** Two filings judged to be the same story attach to
**one story with two sources**, better founded than either alone. That is the payoff for dropping
key-based dedup.

**Guardrails**, because a double publish is the most visible failure this system can produce:

- the comparison set is **every story from the last 30 days**, included wholesale — at one to three
  stories a day that is a couple of thousand tokens, so no embeddings, no vector store, no retrieval
  layer. Similarity search becomes worth building at roughly ten times this volume, not before.
- every verdict carries a reason and the ids it was compared against, recorded and reviewable
- the review surface always shows related stories, so the editor is the last line of defence
- a `DUPLICATE` drop is visible in the spiked view, never silent

### 5.3 The charter

Placement policy is expressed the way a newsroom expresses judgement: **as prose, in one place.** A
single editable text field, the standing brief a section editor would give:

> GitHub commits and dev-facing changes go to #dev: developers, technical register, what changed and
> why it matters to someone building on the platform. AppStore app releases go to #news for a general
> public: what the app is, who it is for, what is new. Curated external links go to SN news, audience
> French self-hosters. Anything touching internals that is not public-ready goes to Nextcloud Talk,
> internal only.

- **The charter is prose; the vocabulary is data.** Outlet ids come from the schema, not the text.
- **Proposals, never decisions.** Every placement is a toggle with the managing editor's reason
  beside it. Placements can be switched off, and outlets the managing editor did not propose can be
  switched on.
- **Overrides are kept.** What the managing editor proposed is stored beside what you decided,
  forever. That diff is the highest-value data the system produces and it is actionable without any
  training: the charter editor shows recent overrides beside the text, so the guidance gets
  tightened by the person whose judgement is being encoded.

Per-stringer `hint` survives as a narrowing note for noisy stringers, subordinate to the charter.

## 6. Flow and state

```
   filing       managing editor           writers          editor          press
 ──────────▶ text ─────────▶ stories ──────▶ slots ────────▶ approved ──────▶ sent
                  │             │          per outlet      per outlet      per outlet
                  │             ├─ DUPLICATE ─▶ spiked, earlier story linked
                  │             └─ no placements ─▶ spiked, reason recorded
                  └─ nothing in it ─▶ filing closed, "no story" (a success)
```

**Filing** — `RECEIVED` → `PROCESSING` → `PROCESSED` | `FAILED`. A processed filing that
yielded nothing is a success and says so.

**Story** — `PROPOSED` → `PLACED` | `DROPPED` | `HELD` → `CLOSED`. Links to every filing
that contributed to it, and to the earlier story it duplicates or updates.

**Publication** (one row per story × outlet — this *is* the ledger) — `PROPOSED` → `DRAFTING` →
`AWAITING_APPROVAL` → `APPROVED` | `SCHEDULED` → `PUBLISHED`, with `REJECTED` and `FAILED` terminal.

Approval is **per outlet**. A story running on a public Discord channel and in an internal Nextcloud
Talk room produces two drafts, two chat threads, and two independent decisions. The review surface
must make it unmistakable that approving one does not ship the other.

### Approving to a time

Approval commits to *when*, not only *whether*. `SCHEDULED` is `APPROVED` with a date on it: the
payload is frozen at the same moment and by the same code, and only the instant the queue hands it
to the wire moves. Approving with no time is the original behaviour and still sends immediately.

The mechanism is the queue and nothing else. Job rows already carry `run_after` and the worker only
claims jobs whose time has come, so a scheduled post is a job dated forward. It survives a restart
for free — a waiting job is `PENDING`, and the boot-time reclaim only touches `RUNNING` rows.

`SCHEDULED` closes the desk exactly as `APPROVED` does, and for a sharper reason: the payload was
frozen hours before it will be sent, so an edit that appeared to take would be the widest possible
gap between what the screen shows and what goes out. The way back is **withdraw**, which deletes the
queued job and clears the frozen payload — clearing it is what genuinely reopens the row, since a
re-approval must re-freeze. Withdrawal is reliable while the scheduled time is still in the future;
a job the worker has already claimed cannot be recalled, so the publish handler re-reads the row and
declines quietly rather than parking a failed job for what the human asked for.

**Who decides the time.** The managing editor supplies one enum per placement — `urgency`:
`breaking` | `normal` | `evergreen` — and nothing else. That is the only part of scheduling which is
a judgement: whether a story goes stale by morning is something only a reader of it can say. The
slot itself is arithmetic over the outlet's `cadence` (posting window, days, minimum spacing, daily
cap) and what that outlet already owes the calendar, so it is computed in code, deterministically
and with tests, rather than spent on an inference call. The proposal is computed when a human opens
the review screen and is **never stored**: `scheduled_for` only ever holds a commitment, and a
proposal measured against a calendar that has since filled up would be worse than none.

Every transition is written to an append-only event log with a timestamp and an actor (`system` or
`human`). The audit trail is not bolted on; it is the same rows the UI reads.

## 7. Voices and writing

A **voice** is voice, audience, and rules, stored once and referenced by outlets, so several
destinations share one and it is edited in a single place.

The writer's tool schema is **generated from the outlet's slots**:

```
submit_draft(title: string≤256, description: string≤4096, image?: string)   # discord-news
submit_draft(text: string≤4096)                                             # telegram-broadcast
```

so a writer cannot return a shape that will not publish — no missing field, no over-length body, no
invented key. Writing is **per outlet** rather than one canonical draft adapted N ways: at this
volume quality is worth more than saved calls, and the shared story keeps the versions factually
aligned. The managing editor's `angle` rides along as guidance.

## 8. Review — an editable document with the copy desk a click away

The review surface is the product. It behaves like a document with a conversation attached, not a
form with a robot in it.

- **The decision is at the top, the copy under it, the context below that.** Approve, send now, save
  and spike sit above the fold; the placement's reason, the story and the sibling placements read as
  material for that decision rather than as the page.
- **The primary slot is a live document.** Directly typeable markdown, opened rendered — reading is
  what the screen is for and editing is the exception. One toggle flips the headline and the body
  together, so the two never disagree about which mode you are in. What you save is what ships.
- **The copy desk edits in place.** "shorter", "lead with the security fix", "three headlines" — the
  document updates as you talk. It opens on request rather than sitting beside the document, because
  most drafts are read and approved without asking it anything.
- **Every change is a version.** Copy-desk edits and manual saves both snapshot, so any revision is
  one click from undone. That is where safety lives, rather than an accept/reject ceremony on every
  suggestion.
- **"What will be sent" is visible.** A panel showing the merged payload — literals, derived values,
  and approved slots — so what you approve is those exact bytes. Publishing is then `send(stored
  payload)`, which also makes retry safe.

Two hard rules on the copy desk: **it has no tools and no side effects** (it reads the draft and the
conversation and returns text; it cannot publish, cannot change placements, cannot fetch), and **it
operates only before approval.**

## 9. Invariants

Breaking one of these breaks the product, not just a feature.

1. **Nothing is published without an explicit human approval of that exact payload, for that exact
   outlet.**
2. **No inference runs between approval and send.** Publishing is a merge of stored configuration
   and approved slot values. If a model could alter the payload after approval, the approval would
   mean nothing. Scheduling stretches that gap from seconds to hours, which makes the invariant
   more valuable rather than less: the bytes are fixed at approval and the only thing a schedule
   moves is the clock. Changing what is sent means withdrawing and approving again.
3. **The model never authors a destination — or a call.** Channel ids, endpoints, and placement keys
   are literals in configuration. Models fill slots and propose placements from a generated enum;
   they never write an address. The same holds for the reporter's tools: which tool, which endpoint
   and which argument shape are literals, and the model supplies only a query string or a number
   from a catalogue the desk built.
4. **Ingested text is data, never instructions.** Reports, feed bodies, submitted tips **and pages
   the reporter retrieved** are attacker-influenced. They enter prompts quoted, delimited, and
   labelled untrusted; a model's output becomes a database row, never an action; a human stands
   between every model output and every external effect. Drafts are sanitized on render, never
   injected as HTML.
   *This is why the desk holds the reporting tools rather than handing them to the model: a model
   browsing freely takes instructions from pages nobody logged.*
5. **Deduplication is the managing editor's judgement, bounded and reviewable** — a bounded
   comparison window, a recorded reason, the related story linked, and the editor as last check.
6. **A drop is recorded and visible.** Silence and "nothing happened" must never look alike.
7. **The internal log is authoritative; external alerting is best-effort.** If Beacon is down,
   alerts cannot go out through Beacon — so the app must be fully diagnosable from its own error
   screen with every port broken.
8. **Newsdesk stores no third-party credentials.** Only its own session secrets, its ingest token,
   and its push keys.
9. **Single instance.** Scheduler and queue state live in the database so restarts resume cleanly,
   and the app is never run as two replicas.
10. **A citation exists because the desk retrieved the page.** Sourced claims in a dossier are
   validated against `dossier_sources` before it is stored; anything else is recorded as unverified
   recall and logged. Without this the reporting phase would launder model recall into something
   downstream reads as reported.

## 10. What lives outside, and where

| Concern | Where it lives | Why |
|---|---|---|
| GitHub credentials, repository digging, report writing | n8n stringer (calling an LLM MCP) | the credentials are already there, and we want them there |
| RSS fetching and parsing | n8n stringer | same node, same workflow style |
| Browser-driven stringers (future) | Beacon `chrome-mcp` | needs a real browser, not a library |
| LLM account and billing | `claude-code` behind Beacon, or an API key | account billing versus metered tokens is a driver choice |
| Discord / Telegram / Nextcloud credentials | their MCP servers | already deployed, already scoped |
| Multi-step or exotic delivery | an n8n webhook outlet | symmetry with stringers; no agent needed |
| Scheduling of Newsdesk's own work | Newsdesk | it owns its clock; n8n does not orchestrate it |
| Tip capture | Newsdesk | no protocol, no credentials, and it wants to be one tap on a phone |

The existing `telegram-news-idea` chat continues to work as an ordinary push stringer while people
are used to it; the internal tip line is a shortcut, not a replacement.

## 11. Deployment shape

One container, one SQLite file on a mounted volume, no sidecars. Reachable over HTTPS (an `nsl.sh`
subdomain in our deployment), which the PWA and web push both require. Packaged for the Yundera
AppStore with an `x-casaos` block; usable as a plain `docker compose up` anywhere else. Backup is
copying one file.

## 12. Open questions

- `discord-mcp` and `telegram-mcp` argument shapes are **confirmed** (see `IMPLEMENTATION.md`
  §5.2.1). `nextcloud-talk-mcp` argument keys remain unknown — that Beacon exposes descriptions
  without schemas — and need one live test call before the internal outlet is configured. Discovered
  schemas stay an authoring aid, never an outbound validator.
- Comparison window: 30 days fixed, or per-stringer. (Leaning global and configurable.)
- Retention: do filings and drafts prune, or is the archive permanent? (Leaning permanent — the
  volume is small and the archive is the audit trail.)
- Charter versioning: full history or last-write-wins? (Leaning history.)
- Whether a slot type beyond `text` / `markdown` / `image` / `link` is needed in v1.
