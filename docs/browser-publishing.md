# Browser publishing — a delivery driver for destinations with no API

> **Question asked:** not every destination has an MCP server or an API. Can the desk publish by
> driving a real browser — an LLM following a written cookbook, an operator finishing the job?
>
> **Short answer:** yes, and it costs less of the design than it looks like it should. The frozen
> payload never passes through the model; the model navigates and the desk types. Where a destination
> requires it, a human clicks that destination's own Publish button — both the safety property and the
> legal posture, and since 2026-08-04 something the outlet *declares* rather than something the
> recipe's shape implies. Publishing becomes a fourth `driver` value and nothing upstream of delivery
> changes.
>
> Companion documents: [`architecture.md`](./architecture.md) sections 4.3 (the delivery port) and 9
> (invariants), [`dev-stack.md`](./dev-stack.md) (how the stack is composed).
>
> Status: **implemented** — hand-over outlets end to end, plus the sign-in handoff (§8). Written
> 2026-08-02 against the working tree and against `sandbox/browser-mcp` at the same date; §12's
> phase-1 items needed no changes to that container after all (see the note there).
>
> Updated 2026-08-03, working the first destination that files a *new page* rather than filling a
> composer (Docmost). Three things changed: `hover:` became a step verb (§3), the read-back learned
> to tell a form field from a block editor and compares each on its own terms (§2), and the sidecar
> gained two hard requirements on the browser image (§12).
>
> Updated 2026-08-04 — a design change rather than a lesson from a failure, though Docmost is what
> exposed it. Docmost has no publish button: it saves as the desk types. So the desk composed the
> page, *made it live*, and then asked a person to confirm they had sent it. The confirmation was a
> no-op dressed as a gate, and the ledger recorded `attested` — "on the operator's word" — for
> something the desk had done entirely by itself. §3 and §4 are rewritten around the fix: **how a
> publish finishes is a field on the outlet, not an inference from which sections the recipe happens
> to have**, and there are three ways it can finish rather than two (§4.1). §2 narrows what the
> byte-compare claims once a person is allowed to edit; §4.5 rebuilds nagging and expiry around how
> the desk is actually used. Design only: nothing marked `auto`, `tethered` or `detached` is built.

---

## 1. What it is for

An outlet whose destination has no MCP bridge and no webhook: a LinkedIn company page, a forum, a
customer portal, an internal tool behind a login. The recipe is prose, the browser is real, and the
operator is in the loop.

It does **not** change what Newsdesk is. It is a transport, added beside `mcp` / `webhook` /
`builtin`, and it inherits the whole pipeline above it unchanged: placement, per-outlet writing,
review, approval, payload freezing, scheduling, the ledger.

⚠️ It does not reopen the big social platforms. LinkedIn is in scope **because a human presses the
button** — automated posting to platforms that forbid it stays out.

That used to be structural in the strongest sense: an outlet was human-click because its recipe had a
`## Hand over` section, and the desk owned no code path that could press anything at all. Since §3 it
is a declaration — `publish:` on the outlet — and the honest thing is to say so rather than keep
claiming a guarantee that has moved. What replaces it is deliberately not a single word in a config
file: an outlet may also carry `requires_human: true`, which makes `publish: auto` a **save-time
error on that outlet forever after**. Flipping one enum is easy and shows up as a one-line diff in
the configuration history; deleting a line that says *this destination's terms require a person* is a
different act, and it is meant to read like one.

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

**What "byte-compares" means depends on the field, and the difference is worth stating.** A
`<textarea>` hands back the string it was given, so the comparison is exact. A block editor does
not: it parses what it is given into a document and renders *that* back, so Docmost returns a
paragraph break where the payload had a single newline. Comparing those raw fails on every rich
field over a difference that is not in the copy. The read therefore reports which kind of field it
read, and a rich one is compared with blank lines dropped from both sides — leaving the claim as
*every line of the approved text is on the page, in order, unaltered*, and dropping only paragraph
spacing, which that editor was never storing. Plain fields keep the exact comparison. The trace row
records which of the two it was, so the ledger never implies more than was checked.

**One consequence for configuration:** filling in one insertion is what makes the comparison
possible, and it is also why the editor's input rules never fire. Markdown typed this way is stored
as its own characters — `## Heading` becomes a paragraph reading `## Heading`. A rich destination
therefore wants a `text` slot and a hint saying so, not a `markdown` one. (This is the constraint
`## Format` in §13 is trying to lift, and it is worth reading the two together.)

### What the compare proves — and what it stops proving at hand-over

The comparison runs at the end of staging. Under `publish: auto` that is the end of the story:
nothing touches the page between the compare and the commit click, so the bytes that were approved
are the bytes that go out, and the trace row is proof of it.

Under a hand-over mode the page is the operator's from that moment, and **they may work on it for as
long as they like**. That is not hypothetical: publishing raw text into Medium's rich editor was
measured at roughly half an hour of manual work on a single post — bold, italic, headings, the
structure the destination expects and the plain-text payload does not carry. Real editorial work,
none of it done by the desk.

So the claim narrows, and the narrowing is the honest version rather than a weaker one:

- **What it proves:** the desk put the approved bytes on the page and altered nothing on the way.
  That is invariant 2, intact — no inference happened between approval and the page.
- **What it does not prove:** that what finally went out is what was approved. After hand-over the
  human is the authority, and their edits are editorial control, not inference. The invariant was
  never about stopping a person from editing their own post.

The consequence for the archive is concrete: **on confirmation the desk reads the filled fields once
more and stores what actually shipped**, alongside a diff against the frozen payload. A row where
those differ is graded `edited` (§5) and the ledger holds the artifact rather than a payload the
destination stopped matching half an hour ago. Without that read-back the desk would keep a record
that is merely plausible, which is the failure mode this whole document exists to avoid.

## 3. The cookbook

A recipe is **plain text, edited like any other prose in the desk**, with assistant help. It is not
a recorded macro and there is no replay engine: UI changes are absorbed by editing English.

Five reserved headings give the driver its anchors. Everything else is free prose.

```markdown
## Stage
Go to https://www.linkedin.com/company/yundera/admin/page-posts/published/
Click "Start a post" — the composer opens as a modal.
The body goes in the contenteditable div inside that modal.

## Hand over
Read the post, then press **Post** in the modal.

## Verify
The new post appears at the top of the published list; its permalink is the
timestamp link on the first card.
```

| Section | Meaning |
|---|---|
| `## Signed out` | optional. `when:` selectors that exist **only** on a login page — see §8. |
| `## Stage` | everything up to a filled composer. The agent may act here. Takes `wait:`, `hover:`, `click:`, `fill:`. **The byte-compare runs at the end of it.** |
| `## Commit` | optional. The click that actually sends. Takes `wait:` and `click:` — never `fill:`. Run by the desk only under `publish: auto`; inert under the hand-over modes, where the viewer uses its selector to point at the button. |
| `## Hand over` | prose: what the person is being asked to do. Required by the hand-over modes, refused under `auto`. |
| `## Verify` | takes `wait:` and `read:`. Required under `auto`; optional otherwise — absent means the desk cannot confirm the send, see §5. |

### Why `## Commit` is its own section

It would have been simpler to let the sending click sit at the end of `## Stage`, and it would have
been wrong. The byte-compare runs after the stage steps: put the click among them and the comparison
happens *after* the message is already out, which inverts §2 entirely. Docmost never surfaced this
because it has no button to click — the first destination that does (Telegram in browser mode, where
`## Commit` is one `click:` on the send arrow) would have shipped the bug on its first run.

So the ordering is the point of the section, not the tidiness: **stage, compare, and only then
commit.** A commit step never carries `fill:` for the same reason — no copy may enter after the
thing that proves the copy.

### The mode is a field, not a section

`## Hand over` used to be the switch: its presence made an outlet human-click, its absence made the
outlet autonomous, and autonomous was refused at save time. One signal was doing two unrelated jobs —
*who commits the send*, and *when the browser gets involved* — and for a destination like Docmost the
two answers disagree. Nobody presses anything there; the fill **is** the send. Making the desk stop
and ask afterwards did not make it safer, it only made the ledger say something untrue.

So the switch moves onto the outlet, where it can be read without parsing prose:

```yaml
publish: auto        # the desk stages, compares, commits and verifies. Nobody is asked.
publish: tethered    # the desk stages and holds the tab; you press in the viewer.
publish: detached    # the desk stages a durable draft, hands you the link, and lets go.
```

The three are §4.1. What matters here is that one recipe now serves more than one of them: a Telegram
outlet with a `## Commit` step is `auto` if you trust the desk to press send and `tethered` if you
would rather look first, and switching between the two is one word. Under `tethered` the commit steps
are never executed — they only tell the viewer which button to highlight.

`requires_human: true` (§1) is the counterweight: on an outlet that carries it, `publish: auto` is a
validation error, permanently.

### The per-story override

The outlet sets the default; the person approving a story may override it for that story alone — a
nullable column on `publications`, decided at the same moment as the slot. Routine release notes go
`auto` on a destination where something sensitive should still be read in the viewer first, and
forcing that choice to be made once per *destination* would mean choosing the more cautious setting
forever and then resenting it.

The override may always ask for **more** human involvement. It may ask for less only where the outlet
permits `auto` at all — an outlet with `requires_human` cannot be talked into it story by story.

`hover:` looks like a convenience and is not. Row-level controls — a page tree's "new child page"
button, a list row's menu — are routinely `visibility: hidden` until the pointer is on them, and
Playwright will not click what it cannot see. Without a hover step such a destination is not
awkward to write, it is unreachable: the click waits out its timeout for a button that never
becomes visible. Hover the row, then click what appeared, which is what a person does anyway.

**A `wait:` after a click must name something only the *next* page can have.** This is the sharpest
edge in the whole format, and it cost the Docmost News page: the recipe clicked "new child page" and
then waited for the title editor, which the page it was standing on already had. The wait returned
in 100ms, the desk typed the story into the parent, and Docmost — which saves as you type — kept it.
Creating and opening the child took 6.5s, and when it finally landed the editor unmounted for ~800ms,
which is the window the read-back failed in. The visible error was a missing selector; the damage was
a rewritten destination page, done before any of it was reported.

Two consequences worth carrying to the next recipe:

- Wait on a **state the origin page cannot be in** — an empty editor (`h1.is-editor-empty`), a
  URL-bound element, a control that only the new view renders. "The element exists" is not progress
  when the element also existed a moment ago.
- **A destination that autosaves has no dry run.** For those, a stage failure cannot promise the
  destination is untouched, and the desk should not be read as saying so.

**Where a recipe is edited:** it is a field on the outlet, so it lives with the rest of
configuration — the **Advanced (YAML) editor** on the Configuration screen, or the assistant. The
forms half of that screen renders outlets as read-only cards and links to Advanced, which is the
wrong shape for the one field on the outlet that is pure prose. Planned, in order:

- **the recipe as an editable field on the destination card.** Line-level errors come free: the
  validator already reports `outlets.<id>.recipe — line N: …`, so a debounced call to the existing
  check route is the whole feature. (The web app deliberately does not import `@newsdesk/shared` —
  types are mirrored in `api.ts` — so the parser stays on the server side of that call.)
- **a trial run** that executes the stage steps *but stops before the fills*, reporting which
  selectors resolved and how long each took. Safe even on a destination that autosaves, because
  nothing is typed, and it is the cheapest thing that would have caught the 6.5s failure below.
- **an Add destination button**, browser-first, that writes the outlet object the forms already
  round-trip through `writeConfig`. Worth being clear-eyed about what that does and does not fix: the
  barrier to a browser destination is not the YAML, it is knowing that the body goes in
  `.editor-container .ProseMirror[contenteditable="true"]`. The button that earns "user friendly" is
  the one after it — **pick the element in the live viewer and have the desk write the selector**,
  which needs nothing the sidecar lacks (`POST /frame` for bounds, `/api/evaluate` to derive it).

Rules the validator enforces:

- **The recipe never contains the text to publish.** It names the field; the desk injects the value.
- **The recipe never chooses the destination.** Channel, page and account stay `args_spec` literals,
  exactly as for an MCP outlet. Invariant 3 does not bend because the transport changed.
- **`## Commit` takes `wait:` and `click:` only.** No copy after the compare.
- **`auto` requires `## Verify`** — otherwise the desk writes a `PUBLISHED` row that neither a person
  nor a check ever witnessed, which is a grade §5 has no honest name for — and **refuses `## Hand
  over`**, because prose telling an operator what to press under an outlet that presses it itself is
  a contradiction rather than a harmless leftover.
- **The hand-over modes require `## Hand over`.** There has to be something to tell the person.
- **`requires_human: true` refuses `publish: auto`**, whatever the recipe says.

## 4. Flow — three ways a publish finishes

Everything above delivery is unchanged and identical for all four cases below: the managing editor
places, the writer drafts, **a person reviews the copy and commits a slot**, and the payload is
frozen at that approval. What `publish:` changes is only what happens after the slot fires.

```
  wire filing → managing editor → story PLACED
                                    └─ publications PROPOSED (one per destination)
                                         ↓ writer
                                    AWAITING_APPROVAL
                                         ↓
                                 ◆ HUMAN — review the copy, adjust placements, pick a slot
                                         ↓
                                 APPROVED / SCHEDULED   ▓ payload frozen ▓
                                         ↓ the slot fires
                                    delivery port ──► [ diverges ]
```

### 4.1 The three modes

| | the desk | you | the lane |
|---|---|---|---|
| `auto` | stages, compares, runs `## Commit`, verifies, publishes | nothing — you approved it and it went | held ~20–30 s, at the slot |
| `tethered` | stages when you open it, compares, stops | read it in the viewer, press the destination's button, confirm here | held while you are there; **re-staged** if it lapses |
| `detached` | stages a durable draft, records its link, lets go | finish it wherever you like, then come back and confirm | nothing held after staging |

### 4.2 What decides which — durable draft state

The tempting axis is how long the person takes, and it is the wrong one. **Assume a human's time is
unbounded.** They will open a post, get pulled away, and come back at midnight; the Medium case in §2
was half an hour of formatting and nothing says the next one is not three. No timer anywhere in this
design may be sized against human attention.

The axis that actually separates the two hand-over modes is *where the composed state lives*:

| | `tethered` | `detached` |
|---|---|---|
| composed state | the desk's tab only — nothing exists at the destination yet | a real draft at the destination, with a link |
| lease lapsed, Chrome reaped | **stage again.** Free: nothing was ever sent | **must not stage again** — that files a second draft |
| so what it needs | nothing. The 15-minute TTL is fine as it stands | the draft's identity recorded at stage time, and a refusal to re-stage |
| reopening the row | recomposes, ~20 s | hands back the same link, no browser at all |
| fits | Telegram, Discord — a composer whose content is local to the tab | Docmost (the page *is* the draft), Medium, LinkedIn |

Tethered is re-stageable **precisely because** it has no draft state — the same fact that forces it
to be tethered. So the failure that looked alarming under a 30-minute edit, Chrome being reaped
mid-review, is not a failure: you come back, it composes again, nothing was at risk. That is what
makes an unbounded human safe without raising a single timeout.

Detached is the one needing a guard, which is the opposite of the intuition. Staging creates
something real; staging twice creates two of them. Every reopened Docmost row would file another
untitled page under News. So a detached row stores the permalink read at stage time and never stages
again — see §5.

**The destination decides which hand-over is even possible. You decide between that and `auto`.**
Telegram and Discord have no draft to hand over, so a person who wants to see the post before it goes
gets `tethered` or nothing. Docmost and Medium can hand over a link, so a person who wants to spend
an hour on the formatting can have it.

### 4.3 Four worked examples

**Telegram — `driver: mcp`.** No browser, no lease, no lane.

```
slot fires → callTool(telegram-mcp__send_message, frozen payload) → PUBLISHED
```

Human: the review, and nothing else. Note the asymmetry — an MCP send carries **no evidence grade at
all**, so a browser `auto` publish with a `## Verify` section is better evidenced than this one.

**Telegram — `driver: browser`, `publish: auto`.** The case where `auto` is unambiguously safe:
nothing is committed until the click, so a stage failure leaves the destination untouched.

```
slot fires
   ├► lease · own tab · navigate to the pinned chat
   ├► probe "## Signed out"  ─── signed out ──► NEEDS_AUTH ──► ◆ HUMAN signs in ──► resume
   ├► ## Stage    wait / click / fill                      ← nothing sent yet
   ├► COMPARE     read back vs the frozen payload          ◄── the gate
   │                 └─ mismatch ──► FAILED. Nothing clicked, nothing published.
   ├► ## Commit   click the send arrow                     ← the desk presses it
   ├► ## Verify   read the message permalink
   └► PUBLISHED (verified) ──► push "sent to Telegram — <link>"
```

**Docmost — `driver: browser`, `publish: detached`, no `## Commit`.** The destination that started
all this. Filling *is* committing, so there is no button and no gate; what the desk hands over is a
finished page and a link.

```
slot fires
   ├► lease · tab · navigate to the pinned News page
   ├► ## Stage    hover the row · click + · wait on an EMPTY title · fill title · fill body
   │                            ▲
   │                  ▓ the page is live from here — Docmost saves as the desk types ▓
   ├► COMPARE     └─ mismatch ──► FAILED, **and the page exists anyway**: the row says so,
   │                              and names the untitled page to go and delete
   ├► ## Verify   read the new page's permalink
   ├► release the lane entirely
   └► push "filed on Docmost — <link>"          ◆ HUMAN edits it whenever, wherever
                                                ◆ HUMAN confirms here → PUBLISHED (verified | edited)
```

The compare here runs *after* the destination has been written. It proves what is on the page; it
cannot prevent it being there. That was already true before this rewrite — the only thing that
changes is that the desk stops implying otherwise with a button labelled *Sent*.

**LinkedIn — `driver: browser`, `publish: tethered`, `requires_human: true`.**

```
slot fires
   ├► probe "## Signed out"          ← the only browser work at the slot
   ├► AWAITING_SEND · notification carrying the approved copy, so the text can be
   │                   re-read without opening a browser at all
   │
   ◆ HUMAN opens it
   │     └► ~20 s: lease · tab · navigate · ## Stage · COMPARE · screenshot
   │          └─ compare mismatch ──► FAILED, and you get the error instead of a viewer
   │     └► the live view, on the composed post
   │
   ◆ same HUMAN reads it and presses LinkedIn's own **Post**      ← the safety property
   │
   ◆ same HUMAN confirms here
   │     └► re-read the fields · ## Verify ──► PUBLISHED (verified | attested | edited)
   │     └─ "not yet" ──► abandon: lane released, slot kept, reminders continue
```

Those are three bullets and **one tap, a spinner, then read–press–confirm**. Worth stating because
the shape misleads: opening the notification is what *causes* the composing. Nothing has been typed
into LinkedIn when the notification fires, so there is no earlier moment at which a person could
press Post — they would be pressing it on an empty composer. Staging at the slot instead would hold
the single lane from 09:00 until whenever they arrive, and §9's idle reaper would kill the tab long
before that.

And no, this is not a second review of the copy. **The text was read and approved at the review, and
frozen there.** What the viewer is for is the *page*.

| | review + slot | sign-in (conditional) | open & stage | press their button | confirm here |
|---|---|---|---|---|---|
| Telegram · mcp | ✔ | — | — | — | — |
| Telegram · browser `auto` | ✔ | ✔ | desk | **desk** (`## Commit`) | — |
| Docmost · `detached` | ✔ | ✔ | desk | n/a — autosave | ✔ |
| LinkedIn · `tethered` | ✔ | ✔ | ✔ | ✔ | ✔ |

**The calendar must say which of the three it is.** Under `auto` a browser slot is a real send time;
under the hand-over modes it is *when this is put in front of you*. Three meanings, and slots that
mean different things must not render alike — invariant 6's spirit applied to the schedule.

### 4.4 The batch, which is how this is actually used

The observed workflow is not one post at a time. It is: approve a batch in the morning, leave, let
the notifications pile up, sit down later and work through them. Four things follow, and the desk
already knows three of them elsewhere.

**Coalesce the notification.** `notifyHandoverDue` fires per publication and re-fires per publication
at +30 min and +2 h: six pending posts is eighteen chimes at eighteen different times. The comment on
`notifyPlacementsWaiting` already says why that is wrong — *"three chimes for one wire item is how a
person turns notifications off."* Hand-overs coalesce the same way, and the link goes to `/now`,
which is the screen built for exactly this, rather than to one publication's live view.

**Stage one ahead.** Six posts at ~20 s each is two minutes of staring at a spinner, spread through
the session. While you read #1 the desk should be composing #2 in its own tab — depth **2, not N**,
so no two tabs ever write to the same destination at once, and only the tab you are looking at is
streamed. See §7; it needs no change to the browser image.

**Confirming advances.** "Sent · next: 2 of 4", with the next page already composed and the browser
still warm. The batch is one session, and the UI should behave as though it knows that.

**Re-probe sign-in inside `stage()`.** The probe at the slot is a reading taken hours before anyone
acts on it, and `stage()` does not currently repeat it — the comment in `probeSignedIn` claims it
does. A session that lapsed in between therefore surfaces as a `wait:` timeout rather than
`NEEDS_AUTH`, and on an autosaving destination that is the difference between a clean stop and a
half-written page. Sessions lapse rarely enough that nothing else about §8 needs rescheduling; this is
five lines, not a mechanism.

### 4.5 Staleness, nagging and expiry

The old rule was a flat 12 hours from the slot, and the batch workflow breaks it in the obvious way:
approve at 09:00, sit down at 21:30, find that everything expired and gave up its slot. But the fix
is not a bigger number. The reframe is:

> **Expiry exists to stop something being sent unattended once it has gone stale. Only `auto` sends
> unattended.**

- **`auto` — a hard freshness window, taken from `urgency`.** The column is already on the row and is
  currently read only to propose a send time; breaking goes stale in hours, evergreen essentially
  never. Past the window the desk does not send: back to `APPROVED`, and it asks. This is the case
  that genuinely needs a deadline, because nobody is watching it fire.
- **`tethered` and `detached` — no expiry at all.** Nothing can go out without a person looking at
  it, and that person can see the date. What they need is not eviction but **visible staleness**:
  "approved 3 days ago" on the row, oldest first, and a one-tap spike. Silently withdrawing a post
  somebody was about to publish is a worse failure than a cluttered list.
- **Nags decay rather than stop.** Today: +30 min, +2 h, silence. Silence at two hours means a batch
  approved on Friday is invisible by Monday. Better: +30 min, +2 h, then once a day, always
  coalesced, never per row.
- **Nothing with work in flight expires.** A `tethered` row holding a live lane, or a `detached` row
  whose draft exists at the destination, is work in progress. Evicting it would orphan something
  real.

An expired `auto` post is **not** spiked and does not need re-approval — the frozen payload is
untouched, so it simply wants a new slot from a human who can judge whether the news still holds.

## 5. Evidence, retries and the double-post problem

A browser publish has no idempotency key. The dangerous window is between the operator's click and
the desk recording it.

**Published rows therefore carry the grade of their evidence:**

| Grade | Means |
|---|---|
| `verified` | the `## Verify` section ran and the desk found the post, with its permalink in `external_url` |
| `attested` | no verify section; the operator confirmed in the desk that they sent it |
| `edited` | verified or attested, **and the re-read at confirmation differed from the frozen payload** — the operator worked on the post after the desk composed it |

All three are legitimate outcomes. What is not legitimate is any two of them being indistinguishable
in the ledger: the optional-verify decision must be visible rather than a silent gap, and so must the
difference between *what was approved* and *what actually went out*. `edited` carries the diff, and
the archive keeps the text as shipped — see §2.

`edited` is impossible under `auto` by construction. If one ever appears there, something reached the
page between the compare and the commit, and that is a bug rather than an editorial decision.

**Browser outlets never auto-retry.** A failure parks `FAILED` with the trace and the last
screenshot, and a human decides. On a human-initiated retry:

- with a verify section, **verify runs first**. If the post is already there, the row becomes
  `PUBLISHED (verified)` and nothing is re-sent.
- without one, the desk says plainly that it cannot tell, and offers *it posted* (→ `attested`) or
  *it did not, retry*.

**A `detached` row must never stage twice.** Staging created something durable at the destination, so
a second run does not retry it — it files a second copy of it. The draft's link is recorded at stage
time and reopening the row returns that link rather than touching the browser. A retry on a detached
outlet is therefore only ever *verify again*, never *compose again*.

Which leaves one state with no clean ending, and it is better named than papered over. If a detached
draft is never finished, the desk cannot resolve it: deleting somebody's draft at their destination
is not a thing this system should ever do, and closing the row silently would leave a stray page
under News with nothing pointing at it. So the row parks as **`ABANDONED_DRAFT`**, keeps its link
forever, and says exactly that: *this exists at the destination, unfinished, and only you can decide
what happens to it.*

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

## 7. Concurrency — one lane, one ahead

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

**Depth 2, for staging one ahead.** §4.4 wants the desk composing the next post while you read the
current one, and that is the only reason to go past a pool of 1. Two is deliberate rather than a
step towards N: two tabs are never writing to the same destination at once, and only the tab being
looked at is streamed. `detached` needs none of it — it holds nothing once staged — so the depth
exists for `tethered` batches and for the `auto` publish that happens to fire while somebody is
mid-review.

This wants **no change to the browser image**. Every call in `session.ts` already carries a `pageId`
(`navigate`, `hover`, `click`, `fill`, `waitFor`, `readValue`, `screenshot`), `/api/pages` has existed
since 1.1.5, and the paragraph below already argues that lanes are tabs. The one thing standing in
the way is `lease.ts` holding exactly one publication per engine.

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

And the poll must treat a read that *errors* as "not yet", not as a failure. The redirect does not
merely change what a read returns; it destroys the context the read was issued into, so the
container answers `500` instead of an answer. Measured against the live desk, that was one run in
four. Letting it propagate turns "the browser is signed out" into "the publish crashed" — the one
outcome this check exists to prevent — so the window is the only authority: if the marker never
appears within it, the answer is a clean *signed in*, however many reads were swallowed getting
there.

`NEEDS_AUTH` is visible and nags on the same schedule as a hand-over (§4.5). It must never quietly
consume a slot.

⚠️ **The probe also belongs inside `stage()`, and is not there yet.** `probeSignedIn`'s comment says
stage re-checks; it does not. The slot-time reading can be hours old by the time anybody acts on it —
§4.4 — and without a repeat the desk discovers a lapsed session as a `wait:` that timed out. That is
a bad error message on a tethered outlet and a half-written page on an autosaving one.

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

⚠️ **None of these timers may be read as a bound on a person.** `LEASE_TTL_MS` is 15 minutes,
`IDLE_TTL_MS` is 15 minutes, and the live view renews the lease every 60 s *only while that screen is
open* — so an operator who spends half an hour formatting a post, in another window, gets Chrome
reaped underneath them. §4.2 is the answer and it is not a longer timeout: a `tethered` row simply
stages again, because nothing was ever at the destination to lose, and a `detached` row is not
holding anything in the first place. The timers stay small, which is what keeps the sidecar empty
most of the day.

## 10. What the trace records

A `publish_traces` table, mirroring `dossier_sources` and existing for the same reason — an audit
claim is only worth something if a row exists because the thing actually happened.

One row per step: `publication_id`, `at`, `phase` (signin | stage | commit | handover | verify),
`action` (navigate | hover | fill | click | read | compare | screenshot), `url`, `selector`, `ok`,
`detail`. Plus:

- **every URL the agent loaded.** The agent is on live pages full of other people's text; invariant
  4 says a model browsing freely takes instructions from pages nobody logged. This is the log.
- **the byte comparison, explicitly** — a hash of the frozen payload and a hash of what was read
  back. That row is the evidence invariant 2 held.
- **the second comparison, at confirmation** — the same two hashes taken again when the operator says
  it went out, and the diff when they differ. This is what makes `edited` a fact rather than a guess,
  and it is the only record of what a destination actually received once a person has worked on it.
  Under `auto` the two rows should be identical; a run where they are not is a bug worth an alert.
- **which step committed**, for an `auto` publish: the `## Commit` click is the moment the thing
  became public, and a trace that does not distinguish it from the clicks that opened a menu cannot
  answer the only question anybody asks after an incident.
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

The second half of that wants saying too, because §2 narrowed it. The invariant forbids **inference**
between approval and send; it has never forbidden **the operator** from editing their own post, and
under a hand-over mode they routinely will. So:

> *No inference happens between approval and send. A person may edit what the desk composed — that is
> editorial control, not inference — and when they do, the desk records what actually shipped and
> grades the row `edited`.*

Without that clause the invariant reads as a promise the hand-over modes cannot keep, and an
invariant nobody can keep gets quietly ignored instead of amended.

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

**`browser-mcp` 1.1.5 is the floor**, established while wiring Docmost up (2026-08-03). Three
things the sidecar needs, none of them in `1.1.4`:

- **`/api/pages`, the tab registry.** The desk opens a tab of its own for every publish, so a build
  without it fails at the first stage.
- **`hover`.** See §3 — without it, any control that appears under the pointer is unreachable.
- **the per-tab screencast**, which §6's viewer prefers over noVNC.
- **a `navigate` that survives a single-page app redirecting on arrival** (added after 1.1.5, found
  on the first real Docmost publish). Docmost serves the page and *then* bounces to `/login`, which
  breaks the call three different ways depending on where the redirect lands: `page.goto` rejects
  with "interrupted by another navigation", or with `net::ERR_ABORTED`, or it resolves and the
  following `page.title()` throws "Execution context was destroyed". All three are one event — the
  app went somewhere else — and all three used to surface as an HTTP 500 that parked the
  publication `FAILED`. Intermittently: 4 of 12 on one run, 0 of 12 on another, which is what a
  race looks like from the outside. The navigation is the result; the title is metadata about it
  and must never fail the call. Genuine failures (DNS, refused, timeout) still error, and the
  recipe's opening `wait:` remains the real check that the right page is up.

That is also why the shared `browsermcp` on yunderalabs cannot stand in for this container: it runs
`1.1.4`, so the answer is not merely "it is busy".

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

### `## Format` — the phase that is missing

The Medium measurement in §2 is not an argument against the design, it is a gap in it. Half an hour
went on bold, italic and headings: an LLM clicking toolbar buttons because the payload arrived as
plain text and the destination expects a formatted document.

Clicking **B** applies a *mark*. It never types copy. So a model doing that is doing precisely what
§2 already permits — driving the chrome — and it stays provable by the machinery that already exists:
**re-run the compare after the formatting pass and the text content must be byte-identical.** Only
the marks changed. A formatting pass that altered a character would be caught by the same check that
catches a bad fill.

That is the shape of a fifth section — model-assisted, no `fill:`, compare re-runs after it — and its
real payoff is upstream: it is what would let a rich destination take a `markdown` slot again instead
of Docmost's `text`-plus-a-hint-explaining-why-not. Today the writer's formatting intent is thrown
away at the browser boundary, and every rich destination pays for it in prose that reads flat.

Not now. Worth knowing that the three modes leave room for it, and that `## Commit` running *after*
the compare is what keeps that room open.

### Smaller ones

- Whether `## Hand over` should be able to name *which* button, or stay pure prose. `## Commit` now
  answers half of this — under a hand-over mode its selector is inert and exists only so the viewer
  can point at the button — but nothing forces an outlet to declare one.
- Whether the cadence proposer should know browser outlets cost operator attention, and space them
  differently from outlets that send themselves. `auto` sharpens this rather than settling it: the
  proposer would now need to know which *mode* an outlet is in, not merely which driver.
- Whether `detached` should offer to re-open its draft in the desk's viewer at all, or always send
  you to your own browser. Your own browser is better for the hour-long formatting case and useless
  when the destination's session lives only in the sidecar profile.
