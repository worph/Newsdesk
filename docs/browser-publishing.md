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
> Status: **implemented** — human-click outlets end to end, plus the sign-in handoff (§8). Written
> 2026-08-02 against the working tree and against `sandbox/browser-mcp` at the same date; §12's
> phase-1 items needed no changes to that container after all (see the note there). Autonomous
> outlets and model-assisted navigation remain design only, and configuration refuses the first of
> them at save time rather than half-supporting it.

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
| `## Signed out` | optional. `when:` selectors that exist **only** on a login page — see §8. |
| `## Stage` | everything up to a filled composer. The agent may act here. |
| `## Hand over` | where the agent stops and what the human is expected to do. **Its presence is what makes an outlet human-click.** |
| `## Verify` | optional. Absent means the desk cannot confirm the send — see §5. |

**Where a recipe is edited:** it is a field on the outlet, so it lives with the rest of
configuration — the **Advanced (YAML) editor** on the Configuration screen, or the assistant. The
forms half of that screen renders outlets as read-only cards; a recipe is prose and arguably belongs
there, which is the obvious next improvement.

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

The live view is a **per-tab screencast**, not a remote desktop: `Page.startScreencast` streams the
target Newsdesk is working in, and taps come back as `Input.dispatch*` on that same tab.

That distinction is not cosmetic. x11vnc serves a *screen*, so on a browser other clients also use,
an operator saw whichever window was raised — silently the wrong page. And on a phone the desktop
was unusable: at 390px, "actual size" showed the top-left corner of a 1280x800 framebuffer — tab
strip, address bar, a `--no-sandbox` warning — with the login form off-screen to the right.

**Clicking here is not a lesser kind of clicking.** A tap on the canvas and a click inside a VNC
session reach the page as the same `Input.dispatchMouseEvent`, so nothing about the human-presses-
the-button property changes. What the viewer owes the operator is *seeing*, and a tab reflows into
a phone where a desktop never could.

Because the desk drives this browser as well as watching it, the viewer can ask **where** something
is — `POST /frame` returns an element's page-space bounds — and put it on screen. "Find the field"
beats panning around a desktop hunting for a login form, and no generic remote desktop can offer it.

**noVNC survives as break-glass**, behind a "something looks wrong" toggle, for what a single tab
structurally cannot show: Chrome's own UI, native dialogs, a file picker. Passkeys remain impossible
through any of it — a platform authenticator is bound to its device — which is why routine sign-in
wants a different answer than a viewer.

| | server | local |
|---|---|---|
| driving | sidecar `browser-mcp` REST | `chrome-devtools` MCP |
| fill + read-back | `/api/action` + `/api/evaluate` | CDP |
| viewport | per-tab screencast, proxied under the desk's session | none needed |

Chrome stays **headful on Xvfb**. `--headless=new` is close to a real browser but not identical,
and this publishes to real destinations; the display simply stopped being the interface.

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

Sessions are preflighted, never merely recovered from. When a slot comes due the desk navigates to
the pinned page and looks for anything the recipe's `## Signed out` section says exists **only** on a
login page:

```markdown
## Signed out
Docmost bounces an unauthenticated visit to /login, where the email field is
the one thing a signed-in page never has.
when: input#email[type="email"]
```

A marker rather than the opposite test, because "signed in" has no reliable shape while every login
page has something a signed-in page does not. Declaring nothing means the destination is never
checked — the desk does not invent a login requirement for a public page.

On failure the publication goes `NEEDS_AUTH`, a push notification deep-links the operator into **the
same viewport** pointed at the site's own login page, they sign in, and press *I'm signed in*. That
claim is **checked, not believed**: the desk re-probes before returning the row to `AWAITING_SEND`,
because publishing into a login page is exactly what this state exists to prevent. One mechanism,
two uses.

⚠️ **The probe must let the page settle.** A single-page app answers the navigation and *then*
decides it needs a login — Docmost renders both the `/login` redirect and the form about a second
later — so a check made the instant navigation resolves sees the signed-in page it is about to stop
being. The probe polls for the marker over a short window, which costs nothing on the signed-out
path and a few seconds once per hand-over on the healthy one.

`NEEDS_AUTH` is visible, nags on the same schedule as a hand-over, and gives its slot up the same
way. It must never quietly consume one.

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

**Phase 1 needed none of it.** Three findings made the container's code fine as it stands:

- its REST surface (`/api/navigate`, `/api/action` with click/type/waitFor/getText, `/api/evaluate`,
  `/api/screenshot`, `/api/vnc-password`) is enough to run a recipe, prove the bytes and serve a
  viewer;
- it exposes **no tab-creating tool**, so the orphan-tab leak feared below cannot happen through it;
- `USER_DATA_DIR` is `/tmp/chrome-profile`, so the profile is mounted from compose without touching
  the image, and `IDLE_TTL_MS` is already an environment variable.

The lease therefore lives in Newsdesk (`ports/delivery/browser/lease.ts`) rather than in the
container — correct rather than expedient, because the sidecar is Newsdesk's own and the desk is
single-instance by invariant 9.

**Still worth doing in `browser-mcp` itself, for the shared instance:**

| # | Change | Why |
|---|---|---|
| 1 | **Mount the Chrome profile on a volume** in its own compose file | every image update or `docker compose down` logs the shared browser out of every site. Newsdesk's sidecar already does this; the shared one does not. |
| 2 | **Sweep orphan tabs** — `src/browser-client.ts:42` always takes `pages()[0]` | anything a tab-creating client opens is invisible to every surface and leaks for the life of the process |
| 3 | `POST /api/lease` with a pool size | only matters for the *shared* instance, where Claude Code sessions and Newsdesk would otherwise contend. Newsdesk's own sidecar needs no arbitration. |
| 4 | Kill Chrome on release, not only on idle | §9 |

**Not optional, and already done in this repo's compose:** the sidecar's API port is never
published. It is unauthenticated full browser control, plus a VNC password endpoint, in front of
live logged-in sessions.

Optionally, and only if §7 lanes are ever needed: a configurable CDP bind address, defaulting to
loopback. Exposed on the Newsdesk-internal network only — never on the shared `mcp-network`, because
CDP is unauthenticated and whoever reaches it owns every session in the profile.

## 13. Open questions

- Whether `## Hand over` should be able to name *which* button, or stay pure prose for the operator
  to read.
- Whether the cadence proposer should know browser outlets cost operator attention, and space them
  differently from outlets that send themselves.
