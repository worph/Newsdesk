import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checksSignIn,
  commitSelector,
  parseRecipe,
  type PublishMode,
  type Recipe,
  type RecipeStep,
} from '@newsdesk/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/index.js'
import { schema } from '../../../db/index.js'
import { logEvent } from '../../../events.js'
import { enqueue } from '../../../pipeline/queue.js'
import { McpError } from '../../mcp/client.js'
import { browser, loadEngine, type BrowserEngineRef } from './engine.js'
import { acquire, attachPage, BrowserBusy, holder, release, renew, type Lease } from './lease.js'
import { resolveMode } from './mode.js'

/**
 * Publishing through a browser, one publication at a time.
 *
 * Three moments, and they are deliberately not one call:
 *
 *   stage    compose the page, prove the bytes, hand it to a person
 *   attest   the person pressed the destination's own button; record it
 *   abandon  they did not; give the browser back and keep the slot
 *
 * Nothing here presses a publish button. That is the whole design: the desk
 * gets the post ready and a human commits it, which is what makes this safe
 * to run against destinations whose terms require a person, and what keeps
 * the LLM out of the send path entirely.
 *
 * See docs/browser-publishing.md sections 2, 4 and 5.
 */

export interface StagedPage {
  publicationId: string
  outletName: string
  /** What the operator is told to do, straight from the recipe. */
  handover: string
  mode: PublishMode
  /**
   * The button the operator is being asked to press, when the recipe names one.
   *
   * The desk does not click it under a hand-over mode — this is so the viewer
   * can put it on screen. Reading prose on a phone and then hunting for the
   * control it describes is the part of a hand-over that a screencast makes
   * worse, and the recipe already knows the answer.
   */
  commitSelector: string | null
  lease: Lease
  screenshotPath: string | null
  stagedAt: string
}

/**
 * A detached publication that already has a draft at its destination.
 *
 * Its own class rather than a plain refusal because the caller has something
 * useful to do with it: this is not an error the operator caused, it is the desk
 * declining to make a second copy and handing back the first one's address.
 */
/**
 * The browser is signed out, found while staging rather than at the slot.
 *
 * Distinct from every other staging error because it must not park the row
 * `FAILED`: `NEEDS_AUTH` has a notification, a deep link and a re-probe behind
 * it, and this is the state that machinery exists for.
 */
export class SignedOut extends Error {
  constructor(readonly outletName: string) {
    super(`the browser is signed out of ${outletName}`)
    this.name = 'SignedOut'
  }
}

export class AlreadyFiled extends Error {
  constructor(
    readonly draftUrl: string,
    readonly outletName: string,
  ) {
    super(`this is already filed on ${outletName} — opening it again would file a second copy`)
    this.name = 'AlreadyFiled'
  }
}

export interface Attestation {
  status: 'PUBLISHED'
  /**
   * `edited` is not a weaker `verified` — it says the desk found the post *and*
   * that what is at the destination is no longer the payload that was approved,
   * because a person worked on it before sending. See §2.
   */
  evidence: 'verified' | 'attested' | 'edited'
  externalUrl: string | null
  externalId: string | null
}

/** Where screenshots live. Set once at boot so this module stays free of env. */
let traceDir = '/data/traces'
export function setTraceDir(dir: string): void {
  traceDir = dir
}

interface Loaded {
  publication: typeof schema.publications.$inferSelect
  outlet: typeof schema.outlets.$inferSelect
  story: typeof schema.stories.$inferSelect
  engine: BrowserEngineRef
  recipe: Recipe
  payload: Record<string, unknown>
}

/**
 * Is the browser signed in to this destination?
 *
 * Navigates to the pinned page and looks for anything the recipe says only
 * exists when signed out. A recipe that declares no markers is not checked at
 * all and answers `true` — the desk does not invent a login requirement for a
 * page that needs none.
 *
 * Costs one navigation, which is why it runs at the moment a slot comes due
 * rather than continuously: the answer is only worth having just before
 * somebody is asked to act on it.
 */
export async function probeSignedIn(db: Db, publicationId: string): Promise<boolean> {
  const loaded = load(db, publicationId)
  if (!checksSignIn(loaded.recipe)) return true

  /**
   * The probe navigates, so it needs the browser as much as a publish does —
   * without the lease it would wipe a page somebody else has staged and is
   * reading. If the browser is busy the check is simply skipped: a false alarm
   * here would send an operator to sign in to something that is already fine,
   * and staging checks again anyway.
   *
   * ⚠️ Only call this from *outside* a lease. `release` is not refcounted while
   * `acquire` is re-entrant, so calling it from within one gives the browser
   * away mid-publish — which is why the actual looking lives in
   * `signedOutMarkerFound`, and why staging calls that instead of this.
   */
  try {
    acquire(loaded.engine.id, publicationId, loaded.outlet.name, { ttlMs: 60_000 })
  } catch (err) {
    if (err instanceof BrowserBusy) return true
    throw err
  }

  try {
    const url = destinationUrl(loaded)
    await browser.navigate(loaded.engine, url)
    return !(await signedOutMarkerFound(db, loaded, undefined, url))
  } finally {
    release(loaded.engine.id, publicationId)
  }
}

/**
 * Does this page carry a marker that only exists when signed out?
 *
 * Takes no lease and navigates nowhere: it looks at the tab it is given, which
 * is what lets staging reuse it *inside* its own lease and on *its own* tab.
 * Both matter — a check that took the lease would release it out from under the
 * publish, and a check against page 0 would prove nothing about the page the
 * desk is a moment away from typing into.
 */
async function signedOutMarkerFound(
  db: Db,
  loaded: Loaded,
  pageId: string | undefined,
  url: string,
): Promise<boolean> {
  for (const marker of loaded.recipe.signedOut) {
    const present = await appearsWithin(loaded.engine, marker.selector, signInSettleMs, pageId)
    trace(db, loaded.publication.id, {
      phase: 'signin',
      action: 'check',
      selector: marker.selector,
      url,
      ok: !present,
      detail: { signedOut: present, pageId },
    })
    if (present) return true
  }
  return false
}

function load(db: Db, publicationId: string): Loaded {
  const publication = db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, publicationId))
    .get()
  if (!publication) throw new McpError(`publication "${publicationId}" not found`, false)

  const outlet = db.select().from(schema.outlets).where(eq(schema.outlets.id, publication.outletId)).get()
  if (!outlet) throw new McpError(`outlet "${publication.outletId}" no longer exists`, false)
  if (outlet.driver !== 'browser') {
    throw new McpError(`outlet "${outlet.id}" is not a browser outlet`, false)
  }

  const story = db.select().from(schema.stories).where(eq(schema.stories.id, publication.storyId)).get()
  if (!story) throw new McpError(`story "${publication.storyId}" no longer exists`, false)

  if (!publication.payload) {
    throw new McpError('this has no frozen payload — it was never approved', false)
  }

  const { recipe, issues } = parseRecipe(outlet.recipe ?? '')
  if (issues.length > 0) {
    // Validation refuses to save a recipe like this, so reaching here means the
    // outlet was written round the config screen. Say so rather than half-running it.
    throw new McpError(
      `the recipe for "${outlet.id}" does not parse: ${issues.map((i) => `line ${i.line}: ${i.message}`).join('; ')}`,
      false,
    )
  }

  return {
    publication,
    outlet,
    story,
    engine: loadEngine(db, outlet.engineId),
    recipe,
    payload: JSON.parse(publication.payload) as Record<string, unknown>,
  }
}

function trace(
  db: Db,
  publicationId: string,
  row: {
    phase: 'signin' | 'stage' | 'commit' | 'handover' | 'verify'
    action: string
    selector?: string | null
    url?: string | null
    ok: boolean
    detail?: unknown
    screenshotPath?: string | null
  },
): void {
  db.insert(schema.publishTraces)
    .values({
      id: randomUUID(),
      publicationId,
      phase: row.phase,
      action: row.action,
      selector: row.selector ?? null,
      url: row.url ?? null,
      ok: row.ok,
      detail: row.detail === undefined ? null : JSON.stringify(row.detail),
      screenshotPath: row.screenshotPath ?? null,
    })
    .run()
}

/** The page this outlet publishes to — a literal, pinned in configuration. */
function destinationUrl(loaded: Loaded): string {
  const key = loaded.outlet.destinationKey ?? 'url'
  const value = loaded.payload[key]
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) {
    throw new McpError(
      `outlet "${loaded.outlet.id}" has no pinned page to publish to — "${key}" is not an absolute url`,
      false,
    )
  }
  return value
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * How long to let a page settle before believing it is signed in.
 *
 * A single-page app answers the navigation immediately and *then* decides it
 * needs a login, so a check made the moment navigation resolves sees the
 * signed-in page it was about to stop being. Docmost does exactly this: the
 * redirect to `/login` and the form both render client-side, about a second
 * later.
 *
 * The cost falls only on the healthy path — a marker that appears returns at
 * once — and only once per hand-over, which is a cheap price for not sending
 * someone to sign in to something that is already fine, or worse, publishing
 * into a login page.
 */
let signInSettleMs = 6_000

/** Injectable so the suite does not spend the settle window on every case. */
export function setSignInSettleMs(ms: number): void {
  signInSettleMs = ms
}

/** Is this selector on the page now, or does it turn up while the page settles? */
async function appearsWithin(
  engine: BrowserEngineRef,
  selector: string,
  windowMs: number,
  pageId?: string,
): Promise<boolean> {
  const deadline = Date.now() + windowMs
  for (;;) {
    /**
     * A read that throws is "not yet", not a failure.
     *
     * This poll starts the instant a navigation resolves, which on a
     * single-page app is precisely when it is about to navigate again — and a
     * read issued into a context the redirect then destroys comes back as an
     * error rather than an answer. Letting that propagate would turn "the
     * browser is signed out" into "the publish crashed", which is the one
     * outcome this check exists to prevent.
     *
     * The window is the authority: if the marker never appears within it, the
     * answer is a clean `false`, however many reads were swallowed getting
     * there.
     */
    try {
      if (await browser.exists(engine, selector, pageId)) return true
    } catch {
      // fall through to the deadline check and poll again
    }
    if (Date.now() >= deadline) return false
    await new Promise((done) => setTimeout(done, 300))
  }
}

/** Make a link the ledger can be followed from. Anything unparseable is left alone. */
function absolute(value: string, base: string): string {
  try {
    return new URL(value, base).toString()
  } catch {
    return value
  }
}

/**
 * What a browser does to text on the way in and out.
 *
 * A contenteditable reports `\r\n` as `\n`, collapses a trailing newline, and
 * some composers normalise non-breaking spaces. Comparing raw would fail on
 * every real page for reasons that have nothing to do with the copy, so the
 * comparison is made on a normalised form — and the *typed* bytes are still
 * exactly the frozen ones, which is the property that matters.
 */
/**
 * The same comparison, for an editor that keeps a document rather than a string.
 *
 * A block editor has no concept of a blank line: every line it is given becomes
 * a node, and reading it back renders those nodes with its own spacing. Docmost
 * returns a paragraph break where the payload had a single newline, and several
 * where the payload had a blank one — so a strict comparison fails on every rich
 * field, over a difference that is not in the copy at all.
 *
 * Blank lines are therefore dropped from both sides, which leaves the check
 * where it belongs: **every line of the approved text is on the page, in order,
 * unaltered.** What it stops proving is paragraph spacing inside a rich editor,
 * which that editor was never storing to begin with. Plain fields keep the
 * strict comparison below, where the bytes really are the bytes.
 */
function comparableRich(value: string): string {
  return comparable(value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
}

function comparable(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/ /g, ' ').replace(/[ \t]+$/gm, '').trim()
}

async function runStep(
  db: Db,
  loaded: Loaded,
  step: RecipeStep,
  phase: 'stage' | 'commit' | 'verify',
  pageId?: string,
): Promise<string | undefined> {
  const { engine } = loaded
  const id = loaded.publication.id

  try {
    switch (step.verb) {
      case 'wait':
        await browser.waitFor(engine, step.selector, undefined, pageId)
        trace(db, id, { phase, action: 'wait', selector: step.selector, ok: true })
        return undefined

      case 'hover':
        await browser.hover(engine, step.selector, pageId)
        trace(db, id, { phase, action: 'hover', selector: step.selector, ok: true })
        return undefined

      case 'click':
        await browser.click(engine, step.selector, pageId)
        trace(db, id, { phase, action: 'click', selector: step.selector, ok: true })
        return undefined

      case 'fill': {
        const value = loaded.payload[step.key!]
        if (typeof value !== 'string') {
          throw new McpError(
            `the frozen payload has no text for "${step.key}" — the recipe and the outlet's args disagree`,
            false,
          )
        }
        await browser.fill(engine, step.selector, value, pageId)
        trace(db, id, {
          phase,
          action: 'fill',
          selector: step.selector,
          ok: true,
          detail: { key: step.key, chars: value.length },
        })
        return undefined
      }

      case 'read': {
        // A permalink is nearly always an href rather than text.
        const attribute = await browser.readAttribute(engine, step.selector, 'href', pageId)
        const raw = attribute ?? (await browser.getText(engine, step.selector, pageId))
        // Pages write their own links relative — `/post/1` — and a bare path
        // stored as an external url is not a link anyone can follow back from
        // the ledger. Resolved against the page we pinned, never against
        // whatever the browser happens to be showing.
        const value = raw ? absolute(raw, destinationUrl(loaded)) : raw
        trace(db, id, {
          phase,
          action: 'read',
          selector: step.selector,
          ok: Boolean(value),
          detail: { key: step.key, value },
        })
        return value || undefined
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    trace(db, id, { phase, action: step.verb, selector: step.selector, ok: false, detail: { error: message } })
    throw err
  }
}

async function screenshot(
  db: Db,
  loaded: Loaded,
  phase: 'stage' | 'verify',
  pageId?: string,
): Promise<string | null> {
  try {
    const image = await browser.screenshot(loaded.engine, pageId)
    mkdirSync(traceDir, { recursive: true })
    const name = `${loaded.publication.id}-${phase}-${Date.now()}.png`
    writeFileSync(join(traceDir, name), image)
    trace(db, loaded.publication.id, { phase, action: 'screenshot', ok: true, screenshotPath: name })
    return name
  } catch (err) {
    // A missing screenshot must never be the reason a publish fails — it is
    // evidence about the run, not part of it.
    trace(db, loaded.publication.id, {
      phase,
      action: 'screenshot',
      ok: false,
      detail: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}

/**
 * Compose the page and hand it to a person.
 *
 * The order is load, lease, navigate, run the steps, then **read every filled
 * field back and compare it to the frozen payload**. A mismatch aborts here,
 * before anyone is shown anything and before any button exists to press — the
 * operator must never be asked to approve bytes the desk cannot prove are the
 * ones they already approved.
 */
export async function stage(db: Db, publicationId: string): Promise<StagedPage> {
  const loaded = load(db, publicationId)
  const mode = resolveMode(loaded.outlet)

  /**
   * Already filed, and filing again would file a second one.
   *
   * First of everything in this function and deliberately **before the lease**:
   * a busy browser must not be able to mask this. A detached stage created
   * something durable at the destination, so a reopened row asking to stage is
   * not a retry — it is a request for a duplicate, and the only safe answer is
   * the link it already has. See docs/browser-publishing.md §4.2.
   */
  if (mode === 'detached' && loaded.publication.draftUrl) {
    throw new AlreadyFiled(loaded.publication.draftUrl, loaded.outlet.name)
  }

  /**
   * Who may ask for a stage depends on who finishes.
   *
   * A hand-over row is staged when its operator opens it, so it is already
   * waiting. An `auto` row is staged by delivery the moment its slot fires, so
   * it is still `APPROVED` or `SCHEDULED` — and a `FAILED` one is a human
   * pressing retry on either.
   */
  const STAGEABLE = ['AWAITING_SEND', 'APPROVED', 'SCHEDULED', 'FAILED']
  if (!STAGEABLE.includes(loaded.publication.status)) {
    throw new McpError(
      loaded.publication.status === 'NEEDS_AUTH'
        ? 'the browser is signed out of this destination — sign it back in first'
        : `this is ${loaded.publication.status.toLowerCase()} — only an approved publication can be staged`,
      false,
    )
  }

  const lease = acquire(loaded.engine.id, publicationId, loaded.outlet.name)

  try {
    const pageId = await ownTab(loaded, publicationId)
    const url = destinationUrl(loaded)
    await browser.navigate(loaded.engine, url, pageId)
    trace(db, publicationId, { phase: 'stage', action: 'navigate', url, ok: true, detail: { pageId } })

    /**
     * Still signed in, checked on *this* tab and not on trust.
     *
     * The slot-time probe can be hours old by the moment anyone acts on it, and
     * a session that lapsed in between would otherwise be discovered as a
     * `wait:` that timed out — a baffling error on a destination with a button,
     * and a half-written page on one that saves as you type. This is the
     * cheapest check in the file and it guards the most expensive mistake.
     */
    if (checksSignIn(loaded.recipe) && (await signedOutMarkerFound(db, loaded, pageId, url))) {
      throw new SignedOut(loaded.outlet.name)
    }

    for (const step of loaded.recipe.stage) {
      await runStep(db, loaded, step, 'stage', pageId)
      renew(loaded.engine.id, publicationId)
    }

    for (const step of loaded.recipe.stage.filter((s) => s.verb === 'fill')) {
      const expected = String(loaded.payload[step.key!] ?? '')
      const field = await browser.readValue(loaded.engine, step.selector, pageId)
      // How the field stores text decides how strictly it can be compared —
      // the reader knows which kind it read, so the choice is made from that
      // rather than from anything the recipe claims.
      const normalise = field.rich ? comparableRich : comparable
      const matches = normalise(expected) === normalise(field.value)

      trace(db, publicationId, {
        phase: 'stage',
        action: 'compare',
        selector: step.selector,
        ok: matches,
        // The evidence that invariant 2 held: what was approved, and what the
        // page actually holds. Hashes rather than the copy itself — the copy is
        // already on the publication row, and duplicating it here would put the
        // same text in two places that could drift. `rich` is recorded because
        // it says which comparison the row is evidence of.
        detail: {
          key: step.key,
          rich: field.rich,
          approved: hash(normalise(expected)),
          onPage: hash(normalise(field.value)),
          approvedChars: expected.length,
          onPageChars: field.value.length,
        },
      })

      if (!matches) {
        throw new McpError(
          `what reached the page is not what was approved for "${step.key}" — nothing was sent`,
          false,
        )
      }
    }

    const shot = await screenshot(db, loaded, 'stage', pageId)
    const stagedAt = new Date().toISOString()

    db.update(schema.publications)
      .set({ stagedAt, error: null })
      .where(eq(schema.publications.id, publicationId))
      .run()

    logEvent(db, {
      level: 'info',
      code: 'STAGED',
      storyId: loaded.publication.storyId,
      publicationId,
      message: `composed on ${loaded.outlet.name} and handed over`,
      detail: { url, engine: loaded.engine.id, filled: loaded.recipe.stage.filter((s) => s.verb === 'fill').length },
    })

    return {
      publicationId,
      outletName: loaded.outlet.name,
      handover: loaded.recipe.handover ?? '',
      mode,
      commitSelector: commitSelector(loaded.recipe),
      lease,
      screenshotPath: shot,
      stagedAt,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await screenshot(db, loaded, 'stage', holder(loaded.engine.id)?.pageId)
    await releaseTab(loaded, publicationId)

    /**
     * Signed out is not a failure, it is a state with its own machinery.
     *
     * Marking the row `FAILED` here would bypass `NEEDS_AUTH` entirely — no
     * notification asking for a sign-in, no deep link to the login page, and an
     * ops error for a browser that simply needs somebody to log in. The one
     * thing this branch must do is get out of the way.
     */
    if (err instanceof SignedOut) {
      db.update(schema.publications)
        .set({ status: 'NEEDS_AUTH', error: null })
        .where(eq(schema.publications.id, publicationId))
        .run()

      logEvent(db, {
        level: 'warn',
        code: 'NEEDS_AUTH',
        storyId: loaded.publication.storyId,
        publicationId,
        message: `the browser is signed out of ${loaded.outlet.name} — someone has to sign it back in`,
        detail: { outletId: loaded.outlet.id, foundWhile: 'staging' },
      })
      throw err
    }

    db.update(schema.publications)
      .set({ status: 'FAILED', error: message })
      .where(eq(schema.publications.id, publicationId))
      .run()

    logEvent(db, {
      level: 'error',
      code: 'STAGE_FAILED',
      storyId: loaded.publication.storyId,
      publicationId,
      message: `could not compose this on ${loaded.outlet.name}`,
      detail: { outletId: loaded.outlet.id, engine: loaded.engine.id, error: message },
    })
    throw err
  }
}

/**
 * The operator says they pressed it.
 *
 * If the recipe knows how to find the published post, the desk goes and looks —
 * and only then is the row `verified`. Otherwise it records exactly what it has:
 * a person's word, marked as such. Both are legitimate outcomes; the two being
 * indistinguishable in the ledger would not be.
 */
export async function attest(db: Db, publicationId: string): Promise<Attestation> {
  const loaded = load(db, publicationId)

  if (loaded.publication.status === 'PUBLISHED') {
    return {
      status: 'PUBLISHED',
      evidence: (loaded.publication.evidence as Attestation['evidence']) ?? 'attested',
      externalUrl: loaded.publication.externalUrl,
      externalId: loaded.publication.externalId,
    }
  }
  if (loaded.publication.status !== 'AWAITING_SEND') {
    throw new McpError(
      `this is ${loaded.publication.status.toLowerCase()} — only a publication waiting to be sent can be marked sent`,
      false,
    )
  }

  const found = await runVerify(db, loaded, holder(loaded.engine.id)?.pageId)
  const shipped = await rereadShipped(db, loaded, holder(loaded.engine.id)?.pageId)

  /**
   * `edited` outranks the other two, and that ordering is the point of it.
   *
   * A row where the desk both found the post *and* can see the operator worked
   * on it afterwards is not simply `verified` — what is at the destination is no
   * longer the payload that was approved. Saying `verified` there would be true
   * about the wrong question. See docs/browser-publishing.md §2.
   */
  const evidence: Attestation['evidence'] = shipped?.differs ? 'edited' : found.evidence

  db.update(schema.publications)
    .set({
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      evidence,
      externalUrl: found.externalUrl,
      externalId: found.externalId,
      shipped: shipped ? JSON.stringify(shipped.fields) : null,
      error: null,
    })
    .where(eq(schema.publications.id, publicationId))
    .run()

  const { externalUrl, externalId } = found

  await releaseTab(loaded, publicationId)

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'PUBLISHED',
    storyId: loaded.publication.storyId,
    publicationId,
    message:
      evidence === 'edited'
        ? `published on ${loaded.outlet.name}, edited on the page before it went`
        : evidence === 'verified'
          ? `published on ${loaded.outlet.name} and confirmed on the page`
          : `published on ${loaded.outlet.name}, on the operator's word`,
    detail: { driver: 'browser', evidence, externalUrl, externalId },
  })

  return { status: 'PUBLISHED', evidence, externalUrl, externalId }
}

/**
 * Look for what was published, and record what was found.
 *
 * Shared by the operator's confirmation and by an `auto` publish, because they
 * are asking the same question of the same page — the difference between them is
 * who was standing there, not what counts as having landed.
 *
 * A verify section that ran and matched nothing means the desk looked and did
 * not see the post, which is *not* the same as having no way to look. Only a
 * step that actually found something is evidence.
 */
async function runVerify(
  db: Db,
  loaded: Loaded,
  pageId: string | undefined,
): Promise<{ externalUrl: string | null; externalId: string | null; evidence: 'verified' | 'attested' }> {
  let externalUrl: string | null = null
  let externalId: string | null = null

  if (loaded.recipe.verify.length === 0) return { externalUrl, externalId, evidence: 'attested' }

  try {
    for (const step of loaded.recipe.verify) {
      const value = await runStep(db, loaded, step, 'verify', pageId)
      if (step.verb !== 'read' || !value) continue
      if (step.key === 'url') externalUrl = value
      if (step.key === 'id') externalId = value
    }
  } catch (err) {
    // A failed check never overrules what happened. It downgrades the evidence
    // and is recorded, which is all it should ever do — the alternative is a
    // desk that calls a successful publish a failure because it could not find
    // the permalink afterwards.
    logEvent(db, {
      level: 'warn',
      code: 'VERIFY_FAILED',
      storyId: loaded.publication.storyId,
      publicationId: loaded.publication.id,
      message: `could not confirm the post on ${loaded.outlet.name} — recording it as attested`,
      detail: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  await screenshot(db, loaded, 'verify', pageId)
  return { externalUrl, externalId, evidence: externalUrl || externalId ? 'verified' : 'attested' }
}

/**
 * What the fields hold now that the operator has finished with them.
 *
 * The compare at staging proved the desk typed the approved bytes. This asks a
 * different question — what did the destination actually receive — and the two
 * answers diverge whenever somebody applies formatting, fixes a line, or adds a
 * paragraph before pressing send. All of which is legitimate; recording the
 * approved payload as though it were the published one is not.
 *
 * Returns null when the desk cannot honestly answer: no tab left, or a read that
 * failed. A missing answer is recorded as missing rather than assumed to be
 * "unchanged" — see docs/browser-publishing.md §5.
 */
async function rereadShipped(
  db: Db,
  loaded: Loaded,
  pageId: string | undefined,
): Promise<{ fields: Record<string, string>; differs: boolean } | null> {
  const fills = loaded.recipe.stage.filter((step) => step.verb === 'fill')
  if (fills.length === 0) return null

  const fields: Record<string, string> = {}
  let differs = false

  try {
    for (const step of fills) {
      const approved = String(loaded.payload[step.key!] ?? '')
      const field = await browser.readValue(loaded.engine, step.selector, pageId)
      const normalise = field.rich ? comparableRich : comparable
      const changed = normalise(approved) !== normalise(field.value)
      if (changed) differs = true
      fields[step.key!] = field.value

      trace(db, loaded.publication.id, {
        phase: 'handover',
        action: 'compare',
        selector: step.selector,
        ok: true,
        detail: {
          key: step.key,
          reread: true,
          changed,
          approved: hash(normalise(approved)),
          shipped: hash(normalise(field.value)),
        },
      })
    }
  } catch (err) {
    // Recorded as *not read*, which is the honest shape. Claiming a comparison
    // that did not happen is the exact failure this whole mechanism exists to
    // correct, so a re-read the desk could not do says so in the trace.
    trace(db, loaded.publication.id, {
      phase: 'handover',
      action: 'compare',
      ok: false,
      detail: { reread: false, error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }

  return { fields, differs }
}

/**
 * Press the destination's own button, then go and look.
 *
 * Called only after `stage` has composed the page **and proved the bytes**, and
 * only for an outlet in `auto`. That ordering is the entire reason `## Commit`
 * is a section of its own rather than the tail of `## Stage`: put the sending
 * click among the stage steps and it fires before the comparison it is supposed
 * to be gated on. See docs/browser-publishing.md §3.
 *
 * The lease and the tab are the caller's; this finishes the job inside them.
 */
export async function commitAndVerify(db: Db, publicationId: string): Promise<Attestation> {
  const loaded = load(db, publicationId)
  const pageId = holder(loaded.engine.id)?.pageId

  for (const [index, step] of loaded.recipe.commit.entries()) {
    // The last click is the one that made it public, and an incident asks about
    // that step and no other. A trace that could not tell it from the click
    // that opened a menu could not answer the only question worth asking.
    const commits = step.verb === 'click' && index === lastClickIndex(loaded.recipe.commit)
    await runStep(db, loaded, step, 'commit', pageId)
    if (commits) {
      trace(db, publicationId, {
        phase: 'commit',
        action: 'commit',
        selector: step.selector,
        ok: true,
        detail: { sentAt: new Date().toISOString() },
      })
    }
    renew(loaded.engine.id, publicationId)
  }

  const found = await runVerify(db, loaded, pageId)

  /**
   * Verify found nothing, and the click has already happened.
   *
   * `FAILED` would be the intuitive status and it is the dangerous one: it reads
   * as "this did not go out" and invites a retry that posts the story twice. The
   * truthful record is that it was sent and the desk could not find it, which is
   * `PUBLISHED (attested)` plus a warning loud enough to go and look by hand.
   */
  if (found.evidence === 'attested' && loaded.recipe.verify.length > 0) {
    logEvent(db, {
      level: 'warn',
      code: 'VERIFY_FAILED',
      storyId: loaded.publication.storyId,
      publicationId,
      message: `sent to ${loaded.outlet.name} but the desk could not find it afterwards — check the destination before re-sending, it is probably there`,
      detail: { outletId: loaded.outlet.id, mode: 'auto' },
    })
  }

  db.update(schema.publications)
    .set({
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      evidence: found.evidence,
      externalUrl: found.externalUrl,
      externalId: found.externalId,
      error: null,
    })
    .where(eq(schema.publications.id, publicationId))
    .run()

  await releaseTab(loaded, publicationId)

  logEvent(db, {
    level: 'info',
    code: 'PUBLISHED',
    storyId: loaded.publication.storyId,
    publicationId,
    message: `published on ${loaded.outlet.name} by the desk`,
    detail: {
      driver: 'browser',
      mode: 'auto',
      evidence: found.evidence,
      externalUrl: found.externalUrl,
      externalId: found.externalId,
    },
  })

  return { status: 'PUBLISHED', ...found }
}

function lastClickIndex(steps: RecipeStep[]): number {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.verb === 'click') return i
  return -1
}

/**
 * File a draft, record where it went, and let go of everything.
 *
 * The detached half of staging. Verify runs *now* rather than at confirmation,
 * because the link it reads is the hand-over — without it there is nothing to
 * send the operator to and, worse, nothing for the never-file-this-twice guard
 * to key on.
 */
export async function recordDraft(db: Db, publicationId: string): Promise<string | null> {
  const loaded = load(db, publicationId)
  const found = await runVerify(db, loaded, holder(loaded.engine.id)?.pageId)
  const draftUrl = found.externalUrl

  db.update(schema.publications)
    .set({ draftUrl })
    .where(eq(schema.publications.id, publicationId))
    .run()

  await releaseTab(loaded, publicationId)
  return draftUrl
}

/**
 * They opened it and did not send.
 *
 * The slot survives: the payload is still frozen, the row is still
 * AWAITING_SEND, and the reminders keep their schedule. Only the browser is
 * given back, so someone else can use it.
 */
export async function abandon(db: Db, publicationId: string): Promise<void> {
  const loaded = load(db, publicationId)
  await releaseTab(loaded, publicationId)

  /**
   * Only a row still waiting is reopened. The live view releases the browser on
   * its way out, which includes the way out after a successful send — and
   * clearing `staged_at` on something already published would quietly delete
   * the record that it was ever composed.
   */
  if (loaded.publication.status !== 'AWAITING_SEND') return

  /**
   * A detached row was never "staged and waiting" in the sense this clears. Its
   * draft is at the destination, and `staged_at` is the record that it was put
   * there. Wiping that on the way out of a screen would leave a real page under
   * News with nothing in the desk pointing at it.
   */
  if (loaded.publication.draftUrl) return

  db.update(schema.publications)
    .set({ stagedAt: null })
    .where(eq(schema.publications.id, publicationId))
    .run()
  trace(db, publicationId, { phase: 'handover', action: 'abandon', ok: true })
}

/**
 * Open the destination so a person can sign in to it.
 *
 * Opening the viewer is not enough on its own: the browser starts lazily and is
 * reaped when idle, so an operator arriving from a notification would otherwise
 * be shown a blank window, or whatever page the last publish happened to leave
 * behind. Navigating here is also what makes the login page *this* outlet's,
 * rather than wherever the browser drifted to.
 *
 * The lease matters more here than anywhere else in the flow: a publish that
 * took the browser mid-login would navigate away while someone was typing a
 * password into it.
 */
/**
 * The tab this publication owns, opening one if the lease has none yet.
 *
 * Owning a tab rather than driving whatever is first is what makes the live
 * view point at *our* page, and what tells the container's collector that this
 * one is in use.
 */
async function ownTab(loaded: Loaded, publicationId: string): Promise<string> {
  const existing = holder(loaded.engine.id)
  /**
   * A remembered tab is only worth reusing if it is still open. The browser
   * restarts — reaped when idle, recreated with the container — and takes
   * every tab with it, so a lease outliving one would wedge the publication
   * on a page that no longer exists until the lease itself expired.
   */
  if (existing?.publicationId === publicationId && existing.pageId) {
    if (await browser.hasPage(loaded.engine, existing.pageId)) return existing.pageId
  }

  const pageId = await browser.openPage(loaded.engine, `newsdesk:${loaded.outlet.id}`)
  attachPage(loaded.engine.id, publicationId, pageId)
  return pageId
}

/** Give the tab back with the browser; a tab per abandoned publish would leak. */
async function releaseTab(loaded: Loaded, publicationId: string): Promise<void> {
  const lease = holder(loaded.engine.id)
  const pageId = lease?.publicationId === publicationId ? lease.pageId : undefined
  release(loaded.engine.id, publicationId)
  if (pageId) await browser.closePage(loaded.engine, pageId).catch(() => undefined)
}

export async function beginSignIn(db: Db, publicationId: string): Promise<{ url: string; lease: Lease }> {
  const loaded = load(db, publicationId)
  if (loaded.publication.status !== 'NEEDS_AUTH') {
    throw new McpError(
      `this is ${loaded.publication.status.toLowerCase()} — it is not waiting on a sign-in`,
      false,
    )
  }

  const lease = acquire(loaded.engine.id, publicationId, `signing in to ${loaded.outlet.name}`)
  const url = destinationUrl(loaded)

  try {
    const pageId = await ownTab(loaded, publicationId)
    await browser.navigate(loaded.engine, url, pageId)
    trace(db, publicationId, { phase: 'signin', action: 'navigate', url, ok: true, detail: { pageId } })
    return { url, lease }
  } catch (err) {
    await releaseTab(loaded, publicationId)
    trace(db, publicationId, {
      phase: 'signin',
      action: 'navigate',
      url,
      ok: false,
      detail: { error: err instanceof Error ? err.message : String(err) },
    })
    throw err
  }
}

/**
 * The operator says they have signed the browser back in.
 *
 * Their word is not enough here, and that is the difference between this and
 * `attest`: a sign-in is a fact about the browser that the desk can go and
 * check for itself in one navigation, so it does. Publishing into a login page
 * because someone clicked the button too early is exactly the failure this
 * whole state exists to prevent.
 */
export async function confirmSignedIn(db: Db, publicationId: string): Promise<boolean> {
  const loaded = load(db, publicationId)
  if (loaded.publication.status !== 'NEEDS_AUTH') {
    throw new McpError(
      `this is ${loaded.publication.status.toLowerCase()} — it is not waiting on a sign-in`,
      false,
    )
  }

  if (!(await probeSignedIn(db, publicationId))) return false

  /**
   * Where the row goes back to depends on who was going to finish it.
   *
   * A hand-over row returns to `AWAITING_SEND`: its operator is standing on the
   * live view and will carry on. An `auto` row has nobody standing anywhere —
   * leaving it `AWAITING_SEND` would park it forever, offering "press their
   * button" on a destination whose button the desk was always going to press.
   * It goes back to being approved, and the send is queued again.
   */
  const mode = resolveMode(loaded.outlet)

  if (mode === 'auto') {
    db.update(schema.publications)
      .set({ status: loaded.publication.scheduledFor ? 'SCHEDULED' : 'APPROVED', error: null })
      .where(eq(schema.publications.id, publicationId))
      .run()
    enqueue(db, 'publish', publicationId)
  } else {
    db.update(schema.publications)
      .set({ status: 'AWAITING_SEND', error: null })
      .where(eq(schema.publications.id, publicationId))
      .run()
  }

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'SIGNED_IN',
    storyId: loaded.publication.storyId,
    publicationId,
    message: `the browser is signed back in to ${loaded.outlet.name}`,
  })

  return true
}

/** Keep a lease alive while the live view is open. */
export function keepAlive(db: Db, publicationId: string): boolean {
  const loaded = load(db, publicationId)
  return renew(loaded.engine.id, publicationId) !== undefined
}

export { loadEngine }
