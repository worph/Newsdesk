# Newsdesk

**A self-hosted editorial desk for automated news.** Stringers push in, an LLM proposes what is
worth saying and where it should go, a human edits and approves each piece, and only then does
anything get published.

> Status: **design / pre-code.** Nothing is implemented yet. This repo currently holds the three
> documents that pin down the design: this README (what and why), [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> (the model), and [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) (how we build it).

---

## What it is

Newsdesk is the **spine** of a news pipeline: registry, deduplication, placement, drafting,
review, approval, and audit trail. It is deliberately **not** an integration platform.

```
   INGEST                    NEWSDESK                        DELIVERY
 (external)                                                 (external)
┌──────────────┐    ┌─────────────────────────────┐    ┌───────────────────┐
│ n8n webhook  │    │  dedup · triage · placement  │    │ discord-mcp       │
│  (GitHub)    │───▶│  drafting · review UI · PWA  │───▶│ telegram-mcp      │
│ n8n webhook  │    │  approval · audit · errors   │    │ nextcloud-talk-mcp│
│  (RSS)       │    └──────────────┬──────────────┘    │ …future outlets…  │
│ tip line ────┼──────────┐        │                   └───────────────────┘
└──────────────┘          │  INFERENCE (external)
                          │  claude-code via Beacon
                          ▼
                    SQLite on /data
```

Three ports, all external, all pluggable:

| Port | What crosses it | Day-1 implementation |
|---|---|---|
| **Ingest** | free-text reports | authenticated `POST /api/v1/filings` — n8n owns the credentials and the protocols |
| **Inference** | text in, JSON/text out | `claude-code__query_claude` over MCP via Beacon |
| **Delivery** | rendered payloads | MCP tool calls via Beacon (`discord-mcp`, `telegram-mcp`, `nextcloud-talk-mcp`) |

**Newsdesk holds no third-party credentials.** No GitHub token, no Discord token, no Telegram
token, no LLM API key. Every credential stays where it already lives — in n8n and in the MCP
servers behind Beacon.

## The concept

It is a newsroom, and the roles are the design:

1. **Stringers file reports.** External n8n workflows have the credentials, go and look, and file
   **free text** — a written report on a codebase, a dated list of entries, or a snapshot of some
   current state. Depth is the stringer's business. They report inclusively and never judge.
2. **The managing editor reads the wire.** One LLM call, working from a global *editorial
   charter*, finds the stories in a report, decides whether each one is **new, a duplicate, or a
   follow-up to something already told**, and proposes where each should run — one call to
   `propose_placement` per destination, with a reason. No story in a report is a normal, successful
   outcome, and zero placements on a story *is* the newsworthiness gate.
3. **Duplicates die here, semantically.** The same release can reach the desk from a GitHub report,
   an RSS feed, and someone's tip, with no shared identifier. The managing editor compares against
   every story from the last 30 days and links what it matches. Two reports of the same event become
   **one story with two sources** — better founded than either alone.
4. **Writers draft per destination.** Each proposed placement gets its own draft in that
   destination's voice. The same change can run on a public Discord channel in a public voice *and*
   in an internal Nextcloud Talk room in a dry technical one.
5. **You edit.** A live markdown document, read as it will publish until you ask to edit it, with the
   copy desk a click away — "shorter", "lead with the security fix", "three headline options" —
   updating the document in place, every revision versioned and revertible.
6. **You approve, per destination, and say when.** Each placement is approved or spiked
   independently, and approval commits to a send time — the desk proposes the next slot that fits
   that destination's posting hours and what it already owes the calendar, and you overrule it or
   send immediately.
7. **The press prints** exactly the bytes you approved, at the moment you approved them for. No
   inference runs after approval.

The whole pipeline in one line: **config generates the tool schemas · tools enforce the shape · the
human edits the slots · publish merges and sends.**

## What makes it different

The market is full of tools that publish. Newsdesk's value is upstream of publishing:

- **A relevance gate that learns from you.** Every override — a placement you added, removed, or a
  draft you rewrote — is stored next to what the model proposed. The desk shows you your recent
  overrides next to the charter so you can tighten the prose and watch the override rate fall.
- **Placement as editorial policy, not configuration.** You write the rules the way a newsroom
  writes a style guide, in prose. The model applies them; you keep the veto.
- **Stringers can overlap on purpose.** Because deduplication is a judgement and not a key lookup,
  you can point three stringers at the same territory and get one well-sourced story instead of
  three posts or a pile of configuration.
- **An auditable trail.** Every item, every drop with its reason, every proposal, every override,
  every publish — rows in a database you own, not hidden state in a SaaS.
- **Self-hosted, credential-free, single container.**

## What it is not

- Not an integration platform. It speaks no protocol other than HTTP and MCP.
- Not a scheduler for other systems. It owns its own clock — including when its own posts go out —
  and nothing else's.
- Not multi-tenant. One desk, one team.
- Not a publisher for the big social platforms. Platform OAuth and API churn are exactly the
  maintenance tax this design refuses to carry — add an outlet through MCP instead.

## Status and roadmap

| Milestone | Contents |
|---|---|
| **M0** | container skeleton, SQLite, auth, health |
| **M1** | filings, watermark/snapshot diffing, the raw wire; n8n stringers for GitHub and RSS |
| **M2** | outlets, voices, charter, the managing editor → stories with dedup verdicts and placements |
| **M3** | per-outlet writing, review editor, approve → publish via `discord-mcp` |
| **M4** | copy desk beside the document, versions and revert |
| **M5** | PWA: install, Android web push, share target, tip line |
| **M6** | error log, run log, override review |
| **M7** | migration off the existing Docmost/Telegram/n8n pipeline |
| **M8** | posting schedule: approve to a time, per-outlet cadence, withdraw, calendar |

See [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for the detail.

## Background

Newsdesk replaces an existing working system: an hourly n8n cron drives a stateless `claude-code`
agent that polls stringers, gates them, drafts articles, writes them to Docmost pages, and asks for
approval through Telegram inline buttons before posting to Discord. That system proved the concept
and taught us three things:

- Docmost was serving as a database it cannot be, with no place to record a decision, a reason, or
  a relationship between two stories.
- The publish logic lived inside a Telegram bridge's prompt template, outside version control.
- Deduplication worked per stringer and therefore could not see the same story arriving through a
  different door — which is the failure that actually matters once stringers overlap.

Newsdesk keeps the parts that were right — nothing auto-posts, a skip is a success, ingested text
is data and never instructions, all durable state is inspectable — and gives them a real
foundation. Design history lives in the `bot/marketing/` docs of the content workspace.

## License

TBD.
