# Stringers — how to file to Newsdesk

> A **stringer** is anything outside Newsdesk that goes and looks at something and files a report:
> an n8n workflow, a cron script, a bookmarklet. Stringers hold the credentials and speak the
> protocols; Newsdesk holds none and speaks neither.
>
> Companion documents: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) section 4.1 (the ingest port),
> [`../IMPLEMENTATION.md`](../IMPLEMENTATION.md) section 5.1.

---

## The one rule

**Stringers file inclusively. The managing editor kills.**

A stringer's prompt must never be asked to judge newsworthiness — it says *"report anything
plausibly interesting, with evidence."* Newsworthiness lives in exactly one place, the charter,
inside the app. Split that judgement across two systems and you end up tuning relevance in two
prompts, in two places, never knowing which one dropped the story.

The other half of the rule: **never invent.** Report only what the code, the diff, or the page
actually says. A thin report is fine — it becomes a story marked `HELD`, visible with its reason.
A confident-sounding invented one poisons a draft.

## The contract

```
POST /api/v1/filings
Authorization: Bearer <ingest token from the Configuration screen>
Content-Type: application/json

{
  "stringer_id": "github-appstore",     // must already exist in Configuration
  "kind":      "report",              // optional; defaults to the stringer's kind
  "text":      "…free text, any depth…",
  "refs":      { "url": "…" },        // optional, opportunistic
  "filed_at":  "2026-07-28T09:12:00Z" // optional
}
```

An **array** is accepted too, and is the normal shape for a feed:

```json
[{ "stringer_id": "korben", "text": "…" }, { "stringer_id": "korben", "text": "…" }]
```

Responses: `201` with a `results` array, `422` when *nothing* landed (every row named an unknown
stringer), `401` on a bad token, `400` on a malformed body. A mixed batch still returns `201` and
keeps its good rows — one bad row never loses the others.

**Stringers keep no state.** No cursor, no last-seen id, no dedup table. Re-filing an overlapping
window every run is expected and safe. That is deliberate: it is what lets a stringer stay dumb, and
it is why the desk, not the producer, is the authority on what is new.

## Kinds, and what each gets before the managing editor sees it

Newsdesk does a little cheap deterministic work before spending an LLM call. None of it is
deduplication — that is the managing editor's semantic judgement — it only avoids re-reading
material.

| `kind` | What you file | What the desk does |
|---|---|---|
| `report` | a written report, any depth | nothing; considered whole |
| `timeline` | dated entries | keeps only entries after the source's watermark, then advances it |
| `snapshot` | the current state of something | diffs against the previous snapshot and considers only the change |
| `tip` | a human note | nothing; considered whole |

Two baselines, so a fresh source never floods the desk:

- the **first timeline** filing considers only the most recent entry and reports how many older ones
  it skipped
- the **first snapshot** is recorded as a baseline and considers nothing — there is no change yet

Both are visible in the Wire rather than silent.

### Writing a timeline so it can be trimmed

Each entry must **begin with an ISO date** — optionally behind a bullet, heading or quote marker.
The parser is deliberately narrow, because guessing at loose date formats produces silent
mis-trimming:

```
- 2026-07-20 Something shipped
  Continuation lines belong to the entry above.
## 2026-07-21T09:12:00Z Also fine
* [2026-07-22] And this
```

Text before the first dated line is a preamble and is never dropped. If **no** dates are recognised
the whole filing is considered and the Wire says so — loud, rather than silently dropping the
source.

---

## Stringer 1 — GitHub, via an LLM MCP

n8n already holds the GitHub credential, so the digging happens there and the desk consumes only
the written report.

```
Schedule (hourly)
  → GitHub node(s): commits / releases since the last run  [GitHub credential lives here]
  → MCP node: ask an LLM to write a report
  → HTTP Request: POST /api/v1/filings   { stringer_id: "github-appstore", kind: "report" }
```

The report-writing prompt, roughly:

> You are a stringer for a news desk. Below are commits and releases from a repository and its public
> submodules. **Write a report** of what changed, naming each change, what it affects, and linking the
> commit or release. Include anything plausibly interesting — the desk decides what is newsworthy, not
> you. Do not invent anything not present in the material. If nothing of substance changed, say so in
> one line.

Fetch whatever the desk will need to write truthfully — release body, commit detail, a linked pull
request, an app's `x-casaos` metadata — and put it in the report. **Newsdesk never fetches.**

## Stringer 2 — RSS

```
Schedule (every 30 min)
  → RSS Read node
  → Code node: format entries as "- <ISO date> <title>\n  <summary>\n  <link>"
  → HTTP Request: POST /api/v1/filings   { stringer_id: "korben", kind: "timeline" }
```

Where the feed carries only a summary, fetch the article and include its text — the relevance
judgement is much better with the real body than with a teaser.

## Stringer 3 — Telegram ideas

The old n8n pipeline had a `telegram-idea` source: someone @-mentions the bot in an ideas group and
that message enters the pipeline as a human-curated item with no newsworthiness gate of its own.
This is the same thing, filed as a **`tip`** — a human note, considered whole, and reported before
the managing editor reads it, which is where the old flow's "WebFetch any links in the idea" step
now lives.

```
Schedule (hourly)
  → HTTP Request: Beacon `tools/call` → telegram-mcp__get_chat_history  [the bot token lives here]
  → Code node: keep the messages that @-mention the bot, strip the mention, build a dedup key
  → Remove Duplicates (seen in previous executions)
  → HTTP Request: POST /api/v1/filings  { stringer_id: "telegram-news-idea", kind: "tip" }
```

Three things about it are worth knowing before you copy it:

- **The @mention is the ingest signal, not a convention.** Group privacy is on, so the bot only
  ever receives messages that name it. Filtering on the mention costs nothing and keeps the rule
  true if privacy is ever turned off.
- **`get_chat_history` returns a rendered transcript, not JSON** — a `[YYYY-MM-DD HH:MM] sender:
  text` line per message, with continuation lines carrying no prefix, and no message ids at all.
  The parser must fold continuation lines into the message above them, and the dedup key can only
  be timestamp + sender + text.
- **This stringer keeps state, and it is the exception.** A `tip` is considered whole: there is no
  watermark to trim it against and no cursor in the Telegram history to ask for "since". Without
  the `removeItemsSeenInPreviousExecutions` node every idea would be re-filed every hour and burn a
  reporting run each time. The desk would still catch them as duplicates — semantically, one LLM
  call later — which is exactly the cost the deterministic pre-pass exists to avoid.

A second tip stringer is the reason the tip line names its stringer: `POST /api/v1/tips` refuses to
guess between two of them, and the in-app form shows which one it is filing to.

---

## Doing it without n8n

Everything above is just an HTTP POST. Development never has to wait for a workflow to exist.

```bash
TOKEN=…   # Configuration screen
BASE=http://localhost:8080

# A report
curl -s -X POST "$BASE/api/v1/filings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "stringer_id": "github-appstore",
    "kind": "report",
    "text": "WireGuardEasyHost v15.3.0 shipped. Adds a one-click client QR export and fixes a crash when the LAN interface changes name. https://github.com/Yundera/AppStore/releases/tag/wireguardeasyhost-v15.3.0"
  }'

# A timeline, filed as a batch — overlap with the previous run is fine
curl -s -X POST "$BASE/api/v1/filings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[{
    "stringer_id": "korben",
    "kind": "timeline",
    "text": "- 2026-07-27 Un guide pour auto-héberger son cloud\n  https://korben.info/...\n- 2026-07-28 Le retour des NAS maison\n  https://korben.info/..."
  }]'

# A snapshot — only the diff against the previous one is considered
curl -s -X POST "$BASE/api/v1/filings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"stringer_id": "appstore-state", "kind": "snapshot", "text": "immich 1.141.0\njellyfin 10.11.11\nnextcloud 31.0.2"}'

# A tip (session cookie or the ingest token). `stringer_id` is optional with a
# single tip stringer and required once there are two — see Stringer 3 above.
curl -s -X POST "$BASE/api/v1/tips" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text": "worth writing about", "url": "https://example.com/post", "stringer_id": "tip-line"}'
```

Then open **Wire** to see what landed, what was considered, and why anything was trimmed.

## Failure modes, and where they show

| Symptom | Where to look |
|---|---|
| `401` | the ingest token — rotate it on the Configuration screen and update the stringer |
| `422`, `unknown source "x"` | the source is not in Configuration, or the id differs |
| Filed but `considered: false` | normal for a baseline, an unchanged snapshot, or an already-seen window — the Wire gives the reason |
| Filed, source disabled | stored rather than dropped, and marked as such; enable the source in Configuration |
| Nothing arriving at all | the Wire is empty — the problem is upstream, in the stringer or its schedule |
