# Feature study — a WYSIWYG copy editor for review

> **Question asked:** the review screen edits markdown in a textarea with a preview toggle. Could it
> instead work the way [MarkText](https://github.com/marktext/marktext) does — the document rendered
> as you type, no split pane, markdown still the thing on disk?
>
> **Short answer:** yes, and the mechanism is well understood. But the editor widget is not where the
> value is. The preview a reviewer approves against is *generic markdown*, not *what the destination
> will show*, and making that preview prettier without making it truer would make the screen more
> convincing and less honest. Fix the fidelity first; the editor second.
>
> Companion documents: [`architecture.md`](./architecture.md) sections 4.3 (slots) and 9
> (invariants), [`stringers.md`](./stringers.md) (who authors the text in the first place).
>
> Status: **study — nothing here is implemented.** Written 2026-08-02 against the working tree.

---

## 1. What exists today

One component does all document editing: `web/src/components/DocumentEditor.tsx`. It is a
`<textarea>` plus a `preview` boolean, and in preview it renders with markdown-it configured
`html: false, linkify: true, breaks: true`, injected through `dangerouslySetInnerHTML`. The
`html: false` is load-bearing — it is how invariant 4 ("drafts are sanitized on render, never
injected as HTML") is kept, and the comment above the call says so.

Two surfaces use it:

| Surface | Where | Mode |
|---|---|---|
| The primary slot of a publication | `CopyFields.tsx:128`, from `Review.tsx:215` | `monospace`, preview controlled by the parent |
| The tip line | `Tips.tsx:138` | prose font, owns its own preview toggle |

`CopyFields` lifts the preview flag on purpose so a rendered headline can never sit above a raw
body, and it defaults to *reading* except on a blank draft. That decision is sound and survives
every option below unchanged.

Everything else about a slot — the character counter, the `over` styling — is local to those two
components.

## 2. The constraint that governs the choice

**The stored slot value is markdown text, and the conversion to the destination's syntax is
server-side, per-outlet, and happens at merge time.**

`server/src/render/payload.ts:106`:

```ts
function formatSlotValue(def: SlotDef, value: string): string {
  if (def.format !== 'telegram-html') return value
  return def.slot === 'markdown' ? markdownToTelegramHtml(value) : escapeTelegramHtml(value)
}
```

That runs *before* approval freezes the payload, which is how invariant 2 holds: the editor reviews
the bytes that go out. Five things depend on the slot remaining a markdown **string**, not an HTML
blob and not a JSON document model:

1. **Payload merge** — the dispatch above, and `escapeTelegramHtml` for every non-markdown slot.
2. **Config validation** — `shared/src/config.ts:410` classifies `markdown` and `text` slots as
   "prose the destination parses" and rejects `parseMode: Markdown` against them. That check exists
   because `Markdown`/`MarkdownV2` cost yunderalabs a publish on 2026-08-01.
3. **Versions and revert** — `listVersions` / `revertPublication` diff and restore slot maps. A
   representation that re-serializes differently than it was stored makes every diff noisy.
4. **The copy desk** — the assistant writes markdown *into* the slots (`PublicationCopyDesk`,
   `onSlots`). Whatever the editor is, it must accept a model's markdown without argument.
5. **The wire renderer** — `server/src/render/telegram-html.ts` parses markdown source. It has no
   HTML input path and should not grow one.

So: **any editor we adopt keeps markdown as the value it emits.** That rules out an entire family of
otherwise-good editors and narrows the field usefully.

## 3. The finding — the preview is not the destination

`DocumentEditor` renders generic markdown. `markdownToTelegramHtml` emits the narrow subset Telegram
parses, flattening everything else. These are different renderings of the same source, and the
reviewer only ever sees the first one.

| Markdown construct | Preview shows | Telegram actually gets | Diverges? |
|---|---|---|---|
| `# Heading` | a large `<h1>` | `<b>Heading</b>` | **yes** — visual weight and hierarchy are invented |
| `- item` list | styled `<ul>`, browser bullets and indent | literal `• item` text lines | **yes** |
| Nested list | nested indent via CSS | `   • ` three-space indent, as text | **yes** |
| Table | a rendered `<table>` | `cell \| cell` lines | **yes** — badly |
| `![alt](src)` | an `<img>` | `alt (src)` — `send_message` shows no image | **yes** |
| `---` | a horizontal rule | a blank line | **yes** |
| Bare URL | autolinked (`linkify: true`) | plain text (`linkify: false`), re-linked by the *client* | agrees by coincidence |
| Single newline | `<br>` (`breaks: true`) | `breaks: false`, but `softbreak → '\n'` | agrees by coincidence |
| `**bold**`, `*em*`, `` `code` ``, `> quote`, links | as expected | `<b> <i> <code> <blockquote> <a>` | no |

The last two rows matter more than they look. Line breaks and bare links agree today through *two
different mechanisms* that were tuned independently — nobody wired them together, and nothing stops
one from drifting. They are not a guarantee, they are a coincidence with a good track record.

The headline is worse than the body here, incidentally: a `text` slot goes through
`escapeTelegramHtml` and is **never parsed**, deliberately — "a headline reading `4 * 3 > 10` is not
a request for formatting". But `CopyFields` renders a headline in preview as a plain string, so that
part is already honest. It is the *document* that lies.

### 3.1 The character counter counts the wrong string

`max` is displayed by both `Field` and `DocumentEditor` as `value.length` over the markdown source,
and it is **advisory only** — nothing on the server enforces it (`grep max server/src/render/payload.ts`
returns nothing). Telegram's 4096 limit applies to the *visible text after entity parsing*. So:

- `**bold**` is 8 source characters and 4 visible ones — the counter **over**-counts markup.
- A ten-item list adds `• ` ten times, and `![a](https://…)` expands to `a (https://…)` — the
  converted text can be **longer** than the source, so the counter **under**-counts too.

A draft can therefore read `3,900 / 4096` and fail the send, or read `4,100 / 4096` in red and be
perfectly fine. Nobody has hit this yet because drafts are short. It is the same class of bug as the
preview: a number computed on the source, presented as a fact about the destination.

## 4. Traps any WYSIWYG must clear

### 4.1 Round-trip normalization makes `dirty` lie

`Review.tsx:136`:

```ts
const dirty = JSON.stringify(draft) !== JSON.stringify(publication.slots)
```

Every WYSIWYG-over-markdown editor normalizes when it serializes: `-` becomes `*` (or the reverse),
emphasis markers unify, paragraphs reflow, trailing whitespace and hard-break spaces vanish, setext
headings become ATX. Load a stored draft into such an editor and it re-serializes on mount — with no
keystroke from anyone the publication reads **dirty**, the send bar offers to save, and every saved
version carries formatting churn the editor never touched.

This is the single most likely way a naive swap ships broken. Two acceptable answers:

- pick an editor whose idle round-trip is byte-stable for the subset we allow, and **test it** — a
  fixture of representative drafts in, same bytes out; or
- compare normalized forms in `dirty`, accepting that the first save rewrites the stored markdown.

The first is better. The second is a fallback, and it must be a deliberate decision recorded here,
not an accident discovered later.

### 4.2 The toolbar is a promise about the destination

An editor with a heading dropdown, a table button and an image button is telling the writer those
things exist. For a Telegram outlet they do not — they flatten. Offering them and then flattening
them is worse than the textarea, which at least never promised.

So the affordances must be derived from the slot, not from the editor's defaults. The information is
already in configuration: `SlotDef.format` says which wire syntax this slot converts to, and that
determines exactly what survives.

### 4.3 Mobile

`Review.tsx` and `CopyFields` are laid out with `md:` breakpoints throughout and the app ships as a
PWA — this screen is used on phones. `contenteditable` plus an Android IME is the classic failure
surface for rich editors (composition events, autocorrect, selection loss on rotate). A `<textarea>`
has none of those problems. Whatever we adopt, **source mode stays reachable**, and it is the
fallback when the rich editor fails to mount.

### 4.4 Invariant 4 does not get quieter

Today the sanitization argument is one line and one comment: `html: false`. A rich editor has more
surface — paste handlers, clipboard HTML, node specs. The rule does not change ("never injected as
HTML") but the amount of code that has to honour it grows, and the review burden with it. That is a
real cost to weigh, not a blocker.

## 5. Options considered

| Option | Document model | Round-trip | Constrainable | Weight (gz) | Verdict |
|---|---|---|---|---|---|
| **Improve the textarea** — toolbar, `Cmd-B` wraps `**`, side-by-side preview | markdown text | exact, trivially | n/a | ~0 | Good value, not what was asked |
| **CodeMirror 6 + markdown decorations** (Obsidian-ish: source stays, styled in place) | markdown text — *the buffer is the value* | exact by construction | yes | ~80 KB | Strong safe pick; markers stay visible |
| **Lexical + `@lexical/markdown`** | Lexical nodes; markdown via a **transformer list you supply** | good, needs a fixture test | **yes — the transformer list is the constraint** | ~45 KB | **Recommended** |
| **Milkdown** (ProseMirror + remark) | remark AST — closest to MarkText's actual model | cleanest of the rich options | yes, more work | ~120 KB+ | Best model, heaviest |
| **TipTap / ProseMirror + `tiptap-markdown`** | **HTML/PM nodes**; markdown is import/export | lossy at the edges | awkward | ~100 KB+ | **Avoid** — see 4.1 |

Current web dependencies are four packages (`react`, `react-dom`, `react-router-dom`,
`@tanstack/react-query`) plus `markdown-it`. Any of these is the largest thing we would add, which
is an argument for picking the smallest one that does the job.

**Why Lexical over Milkdown**, given Milkdown's model is the better match: its markdown support is a
*list of transformers the caller provides*, so the set of constructs the editor can produce is a
value we compute from the outlet's slot format. That is 4.2 solved by construction rather than by
configuring a toolbar to hide buttons. Its markdown-shortcut plugin also gives the MarkText feel
directly — type `**x**`, it becomes bold in place, no split pane — which is the thing actually asked
for. Milkdown remains the right answer if we ever need faithful round-trip of constructs beyond the
allowed subset.

## 6. Recommendation — two phases, shippable separately

### Phase 1 — make the preview outlet-true

Independent of any editor decision, and worth more.

- Lift the markdown → wire-syntax conversion so the web can call it, or preview from the payload the
  server already computes. `api.getPayload` exists (`web/src/api.ts:469`) and `Review.tsx:118`
  already fetches it for the payload panel — the merged, converted value for the primary slot is
  in there.
  - Moving `markdownToTelegramHtml` into `shared/` is the cleaner shape (no request per keystroke,
    one renderer, testable in both places) and `server/test/telegram-html.test.ts` moves with it.
  - Previewing from `getPayload` is less code but needs debounce and a save-less preview endpoint,
    since the payload is built from *stored* slots, not the local draft.
- Render the preview as Telegram renders it: bold where Telegram shows bold, `• ` where Telegram
  shows `• `, `cell | cell` where the table went. Deliberately plainer than today's preview. That is
  the point.
- A slot with no `format` keeps the current generic markdown preview — that is correct for a
  destination that accepts markdown as written, and for the tip line, which has no destination.
- Fix the counter to measure the converted visible text for formatted slots, and say which it is.
- One-line guard while in there: `CopyFields` gives every non-primary slot a single-line `<input>`
  (`CopyFields.tsx:51`), so a `slot: markdown` that is not `primary` would silently get a one-liner.
  No configuration does that today; `slotDefSchema` permits it.

**Result:** "preview" starts meaning *what the reader will see*, flattening becomes visible at review
time instead of at send time, and the decision the whole screen exists to support is made against
the truth.

### Phase 2 — the editor

- Introduce Lexical **behind `DocumentEditor`'s existing props**. `value`, `onChange`, `preview`,
  `max`, `disabled`, `monospace` keep their contract, so `CopyFields` and `Tips` do not change.
- Derive the enabled transformer set from the slot's `format`: a `telegram-html` slot gets bold,
  italic, strike, inline code, code fence, link, blockquote, and lists — and headings, tables and
  images are simply not expressible. A slot with no `format` gets the full CommonMark set.
- Keep a source-mode toggle. It is the mobile fallback (4.3), the escape hatch when the rich editor
  disagrees with a model-authored draft, and the thing that makes the whole change reversible.
- Add the round-trip fixture test from 4.1 **before** wiring it into `Review` — a set of real drafts
  (one from the copy desk, one hand-written, one with a code fence, one with a nested list) parsed
  and re-serialized, asserting byte equality.
- With the transformer set constrained, "preview" and "edit" converge: what the editor draws is
  already the allowed subset. The toggle may become unnecessary for formatted slots. Do not remove
  it in the same change.

## 7. What we will not do

- **Store HTML, or a JSON document model, in a slot.** Section 2. This is the line.
- **Adopt an editor whose native model is HTML** (TipTap and friends) and paper over the round-trip.
- **Offer constructs the destination flattens.** Section 4.2.
- **Render a model-authored draft as trusted HTML.** Invariant 4 is unchanged and the new code has
  more surface to honour it across, not less.
- **Ship the editor before the fidelity fix.** A prettier lie is a worse lie.

## 8. Open questions

- **Per-destination preview for a story running in several places.** `TargetStrip` moves between
  siblings and each has its own outlet and format. Phase 1 makes each one true individually; whether
  a side-by-side "how it looks in all four" view is worth building is a separate question.
- **Discord and Nextcloud Talk.** Both accept markdown, so today they need no `format` and the
  generic preview is honest for them. If either grows a converter, Phase 1's structure absorbs it —
  but Discord's markdown is *not* CommonMark either, and the same divergence would reappear.
- **Does the copy desk need to know the subset?** If the editor cannot express a heading, the
  assistant probably should not write one. The writer prompt already receives slot `hint`s; passing
  the allowed constructs is a small extension and a later change.
- **`max` enforcement.** Phase 1 makes the counter true. Whether an over-length draft should be
  *blocked* at approval, rather than merely shown in red, is a product decision this study does not
  make.

## 9. How we would know it worked

- A draft containing a heading, a nested list, a table and an image previews **identically** to what
  the Telegram client renders after a real send to a test channel.
- Opening any existing publication and immediately closing it leaves `dirty` false and creates no
  version.
- The counter's number matches the length Telegram reports for the sent message.
- The review screen still works with JavaScript-heavy editing disabled — source mode reachable, no
  dead screen on a phone.
