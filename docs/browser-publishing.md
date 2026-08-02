# Browser publishing — a delivery driver for destinations with no API

> **Question asked:** not every destination has an MCP server or an API. Can the desk publish by
> driving a real browser — an LLM following a written cookbook, an operator finishing the job?
>
> **Short answer:** yes, and it costs less of the design than it looks like it should. The frozen
> payload never passes through the model; the model navigates and the desk types. For most outlets a
> human clicks the destination's own Publish button, which is both the safety property and the legal
> posture. Publishing becomes a fourth `driver` value and nothing upstream of delivery changes.
>
> Companion documents: [`architecture.md`](./architecture.md) sections 4.3 (the delivery port) and 9
> (invariants), [`dev-stack.md`](./dev-stack.md) (how the stack is composed).
>
> Status: **design — nothing here is implemented.** Written 2026-08-02 against the working tree,
> and against `sandbox/browser-mcp` at the same date.

---

## 1. What it is for

An outlet whose destination has no MCP bridge and no webhook: a LinkedIn company page, a forum, a
customer portal, an internal tool behind a login. The recipe is prose, the browser is real, and the
operator is in the loop.

It does **not** change what Newsdesk is. It is a transport, added beside `mcp` / `webhook` /
`builtin`, and it inherits the whole pipeline above it unchanged: placement, per-outlet writing,
review, approval, payload freezing, scheduling, the ledger.

⚠️ It does not reopen the big social platforms. LinkedIn is in scope **because a human presses the
button** — automated posting to platforms that forbid it stays out, and the driver's design makes
that distinction structural rather than a policy note.

## 2. The bytes rule

> **The model drives the chrome. The desk supplies the copy.**

The model reads the cookbook and navigates: it finds the composer, the field, the button. It is
never handed the approved text and asked to type it, because a model that retypes prose can
paraphrase it.

Instead the driver fills the field itself with the frozen payload, then **reads the field back and
byte-compares against `publications.payload`**. A mismatch aborts before anything is clicked and
parks the publication `FAILED` with the trace.

That is invariant 2 kept structurally rather than promised, and it is the same shape as invariant 3
elsewhere in the desk: the desk holds the resource, the model supplies only a coordinate. It needs
no capability the browser container does not already have — `POST /api/action` fills, `POST
/api/evaluate` reads back.

## 3. The cookbook

A recipe is **plain text, edited like any other prose in the desk**, with assistant help. It is not
a recorded macro and there is no replay engine: UI changes are absorbed by editing English.

Three reserved headings give the driver its anchors. Everything else is free prose.

```markdown
## Stage
Go to https://www.linkedin.com/company/yundera/admin/page-posts/published/
Click "Start a post" — the composer opens as a modal.
The body goes in the contenteditable div inside that modal.

## Hand over
Stop once the body is filled. The operator reads it and clicks "Post" in the modal.

## Verify
The new post appears at the top of the published list; its permalink is the
timestamp link on the first card.
```

| Section | Meaning |
|---|---|
| `## Stage` | everything up to a filled composer. The agent may act here. |
| `## Hand over` | where the agent stops and what the human is expected to do. **Its presence is what makes an outlet human-click.** |
| `## Verify` | optional. Absent means the desk cannot confirm the send — see §5. |

Two rules the validator enforces:

- **The recipe never contains the text to publish.** It names the field; the desk injects the value.
- **The recipe never chooses the destination.** Channel, page and account stay `args_spec` literals,
  exactly as for an MCP outlet. Invariant 3 does not bend because the transport changed.

## 4. Flow — stage on open, not on slot

Scheduling works exactly as it does for every other outlet: the payload is frozen at approval and a
slot is committed. What differs is *when the browser gets involved*.

For a human-click outlet, staging at slot time would occupy the single browser lane from 09:00 until
whenever the operator gets to it. So the browser is not touched until they do:

```
slot fires    → status AWAITING_SEND, push notification. No browser touched.
operator taps → the desk takes the browser lease
              → runs ## Stage: navigate, fill, read back, byte-compare
              → ~20s behind a progress indicator
              → the live view appears on the composed post
operator      → reads it, clicks the destination's own Publish button
              → confirms "Sent" in the desk → PUBLISHED, lease released
```

An outlet with no `## Hand over` section is autonomous: stage, commit and verify all run at the
slot, and the lease is held for seconds.

**The calendar must say which kind it is.** For a browser outlet a slot is *when it is put in front
of you*, not when it goes out. Two slots that mean different things must not render alike —
invariant 6's spirit applied to the schedule.

**Nag and expiry.** Nothing technical is held during the wait, so expiry is purely editorial:

| When | What happens |
|---|---|
| slot | notify |
| +30 min | re-notify |
| +2 h | re-notify, then stop nagging |
| +12 h (per-outlet) | log `SEND_EXPIRED`, clear `scheduled_for`, return to `APPROVED` |

An expired post is **not** spiked and does not need re-approval — the frozen payload is untouched,
so it simply wants a new slot from a human who can judge whether the news still holds. A post due at
09:00 that nobody touched by 21:00 has usually missed its window; firing it stale at 08:00 tomorrow
is worse than asking.

## 5. Evidence, retries and the double-post problem

A browser publish has no idempotency key. The dangerous window is between the operator's click and
the desk recording it.

**Published rows therefore carry the grade of their evidence:**

| Grade | Means |
|---|---|
| `verified` | the `## Verify` section ran and the desk found the post, with its permalink in `external_url` |
| `attested` | no verify section; the operator confirmed in the desk that they sent it |

Both are legitimate outcomes. What is not legitimate is the two being indistinguishable in the
ledger — the optional-verify decision must be visible, not a silent gap.

**Browser outlets never auto-retry.** A failure parks `FAILED` with the trace and the last
screenshot, and a human decides. On a human-initiated retry:

- with a verify section, **verify runs first**. If the post is already there, the row becomes
  `PUBLISHED (verified)` and nothing is re-sent.
- without one, the desk says plainly that it cannot tell, and offers *it posted* (→ `attested`) or
  *it did not, retry*.

## 6. The viewport

On the server the live view is **noVNC, iframed inside the desk under the desk's own session auth**.
The browser container already serves it: `/vnc` (assets) and `/vnc/websockify` (proxied socket) on
its API port, with `/api/vnc-password` handing out the per-boot password. Newsdesk fetches the
password server-side and proxies the whole surface, so the container itself is never reachable.

The view is **interactive, not read-only**. Clicking the destination's real button is the point of
the feature, and CDP/X-dispatched input arrives at the page as a trusted event — the click is
genuinely a human's, merely transported.

Locally, where the operator is sitting in front of the browser, there is no viewport: the engine is
`chrome-devtools` MCP against a real Chrome and the desk skips the iframe. The engine is
configuration, and the local path is an option that must never dictate the design.

| | server | local |
|---|---|---|
| driving | sidecar `browser-mcp` `/mcp` | `chrome-devtools` MCP |
| fill + read-back | `/api/action`, `/api/evaluate` | CDP |
| viewport | noVNC, proxied | none needed |

## 7. Concurrency — one lane, queued

The desk asks for a **lane**, not a tab:

```
POST /api/lease  { owner: "newsdesk:pub_01H…", ttlMs }
  → 200 { leaseId, viewerUrl, expiresAt }
  → 409 { heldBy, since }        # queue behind it, and say so in the UI
```

The pool size is **1**. Because staging happens on open, two publications waiting for approval do
not contend at all — the real contention is two operators tapping at the same moment, on a product
that is explicitly one desk and one team. The honest UI is a line saying who holds it.

Raising the pool later changes nothing in Newsdesk: it already asks for a lane and receives a viewer
URL.

**One profile for every outlet.** Each outlet has one account and no outlet shares a site with
another account, so a single cookie jar — one browser, exactly as a person's browser works — is
correct rather than merely convenient. It is also what makes §9's kill-on-release cheap and what
rules out the multi-display option below. The one thing that would reverse it is a second account on
a site the profile is already logged into; nothing on the roadmap needs that.

**If lanes are ever needed, they are CDP screencast targets — not more VNC displays.** `x11vnc`
serves a *display*, so multi-VNC means either N Chrome processes with N `--user-data-dir`s (which
splits the cookie jar and makes you log into each site once per lane) or `x11vnc -id`, which cannot
render menus, file dialogs and account choosers because they are separate X windows — precisely the
moments a viewer is needed. `Page.startScreencast` is per *target*: one Chrome, one profile, N tabs,
N streams. noVNC keeps a permanent job as the escape hatch for what lives outside the page.

## 8. Authentication

Sessions are preflighted, never merely recovered from. A cheap `session_alive` check (navigate, look
for a selector) runs at approval and again shortly before a slot. On failure the publication goes
`NEEDS_AUTH`, a push notification deep-links the operator into **the same viewport**, they log in,
and the desk re-checks and resumes. One mechanism, two uses.

`NEEDS_AUTH` is visible and must never quietly consume a slot.

## 9. Resources and cleanup

Chrome is RAM-hungry and the container's session state is precious, so the two are worth separating:
`clearSessionState()` in the browser container deletes only tab-restore files — **cookies live in
the profile and survive a restart**. That makes the simplest cleanup policy also the best one.

- **Kill Chrome when the lease is released.** Zero leak surface, and the 2–5s cold start hides
  inside the staging wait the operator is already watching. Keep it warm only while another
  `AWAITING_SEND` row is pending.
- **Sweep orphan tabs on release** — close everything but page 0 and return it to `about:blank`.
- **Low idle TTL** (~15 min, not 2 h). Most of the day the sidecar should have no Chrome at all.
- **Cap the container** at ~2 GB, keeping `shm_size: 2gb` — Chrome crashes without it.

Budget: ~250 MB baseline plus 300–500 MB for a heavy SPA, for a couple of minutes a few times a day.

## 10. What the trace records

A `publish_traces` table, mirroring `dossier_sources` and existing for the same reason — an audit
claim is only worth something if a row exists because the thing actually happened.

One row per step: `publication_id`, `at`, `phase` (stage | handover | verify), `action` (navigate |
fill | click | read | screenshot), `url`, `selector`, `ok`, `detail`. Plus:

- **every URL the agent loaded.** The agent is on live pages full of other people's text; invariant
  4 says a model browsing freely takes instructions from pages nobody logged. This is the log.
- **the byte comparison, explicitly** — a hash of the frozen payload and a hash of what was read
  back. That row is the evidence invariant 2 held.
- **screenshots at three fixed moments**: after navigation, after fill and verification (this is the
  one the notification shows), and after verify. Files on `/data`, path in the row, pruned at 90
  days; the rows themselves are permanent like the rest of the archive.

## 11. Invariant amendments

Two need editing in [`architecture.md`](./architecture.md) §9 before this ships:

**8 — credentials.** Today: *"Newsdesk stores no third-party credentials."* Browser sessions live in
a container volume the app starts, stops and drives. The letter survives; the spirit needs stating:

> *Newsdesk stores no third-party credentials. A browser sidecar may hold live sessions in its own
> volume, which the app can drive but never read.*

**2 — no inference between approval and send.** It holds, but only because of §2 above, and the
reason should be written down where the invariant is: inference may operate the *transport*; the
payload is filled by the desk and byte-checked before anything is clicked.

Deployment shape (§11, *"one container, no sidecars"*) also needs a caveat: browser outlets require
a sidecar, and the plain single-container install simply does not offer that driver.

## 12. What the browser container needs

`sandbox/browser-mcp` is already most of this sidecar — Xvfb, headed Chromium, x11vnc, noVNC, a REST
surface and an MCP surface over one browser. The shared yunderalabs instance is **busy with other
work**, so Newsdesk runs its **own instance of the same image** — not a fork. Every change below
belongs upstream, config-gated and defaulted off, so the shared instance is unaffected and the
sidecar turns them on.

**Worth doing now, independent of Newsdesk:**

| # | Change | Why |
|---|---|---|
| 1 | **Mount the Chrome profile on a volume.** `USER_DATA_DIR` currently lives in the container's writable layer and `docker-compose.yml` mounts nothing. | Every image update or `docker compose down` logs the browser out of every site. This is actively costing logins today. |
| 2 | **Sweep orphan tabs.** `src/browser-client.ts:42` always takes `pages()[0]`; anything the LLM opens is invisible to every surface and leaks for the life of the process. | A real leak, not a hypothetical. |

**Needed before the first browser outlet goes live:**

| # | Change | Why |
|---|---|---|
| 3 | `POST /api/lease` with a pool size (default 1), returning a per-lease viewer URL | Newsdesk, Claude Code sessions and anything else on `mcp-network` share one tab with no arbitration today |
| 4 | Keep-alive while a lease is held; configurable idle TTL | so a long login handoff is not reaped mid-flow |
| 5 | Close-non-first-page and optional kill-on-release | §9 |
| 6 | Do **not** publish the API port on the host for the sidecar | it is unauthenticated full browser control, plus a VNC password endpoint, in front of live logged-in sessions. Newsdesk is the only door. |

Optionally, and only if §7 lanes are ever needed: a configurable CDP bind address, defaulting to
loopback. Exposed on the Newsdesk-internal network only — never on the shared `mcp-network`, because
CDP is unauthenticated and whoever reaches it owns every session in the profile.

## 13. Open questions

- Whether `## Hand over` should be able to name *which* button, or stay pure prose for the operator
  to read.
- Whether the cadence proposer should know browser outlets cost operator attention, and space them
  differently from outlets that send themselves.
