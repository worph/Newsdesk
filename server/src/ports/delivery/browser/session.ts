import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checksSignIn,
  hasHandover,
  parseRecipe,
  type Recipe,
  type RecipeStep,
} from '@newsdesk/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/index.js'
import { schema } from '../../../db/index.js'
import { logEvent } from '../../../events.js'
import { McpError } from '../../mcp/client.js'
import { browser, loadEngine, type BrowserEngineRef } from './engine.js'
import { acquire, attachPage, BrowserBusy, holder, release, renew, type Lease } from './lease.js'

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
  lease: Lease
  screenshotPath: string | null
  stagedAt: string
}

export interface Attestation {
  status: 'PUBLISHED'
  evidence: 'verified' | 'attested'
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

/** Does this outlet's recipe stop and ask for a person? */
export function handsOver(recipe: string | null | undefined): boolean {
  if (!recipe) return false
  return hasHandover(parseRecipe(recipe).recipe)
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
   * and `stage` re-checks anyway.
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

    for (const marker of loaded.recipe.signedOut) {
      const present = await appearsWithin(loaded.engine, marker.selector, signInSettleMs)
      trace(db, publicationId, {
        phase: 'signin',
        action: 'check',
        selector: marker.selector,
        url,
        ok: !present,
        detail: { signedOut: present },
      })
      if (present) return false
    }
    return true
  } finally {
    release(loaded.engine.id, publicationId)
  }
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
    phase: 'signin' | 'stage' | 'handover' | 'verify'
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
): Promise<boolean> {
  const deadline = Date.now() + windowMs
  for (;;) {
    if (await browser.exists(engine, selector)) return true
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
function comparable(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/ /g, ' ').replace(/[ \t]+$/gm, '').trim()
}

async function runStep(
  db: Db,
  loaded: Loaded,
  step: RecipeStep,
  phase: 'stage' | 'verify',
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

  if (loaded.publication.status !== 'AWAITING_SEND') {
    throw new McpError(
      loaded.publication.status === 'NEEDS_AUTH'
        ? 'the browser is signed out of this destination — sign it back in first'
        : `this is ${loaded.publication.status.toLowerCase()} — only a publication waiting to be sent can be staged`,
      false,
    )
  }
  if (!hasHandover(loaded.recipe)) {
    throw new McpError(`the recipe for "${loaded.outlet.id}" has no hand over section`, false)
  }

  const lease = acquire(loaded.engine.id, publicationId, loaded.outlet.name)

  try {
    const pageId = await ownTab(loaded, publicationId)
    const url = destinationUrl(loaded)
    await browser.navigate(loaded.engine, url, pageId)
    trace(db, publicationId, { phase: 'stage', action: 'navigate', url, ok: true, detail: { pageId } })

    for (const step of loaded.recipe.stage) {
      await runStep(db, loaded, step, 'stage', pageId)
      renew(loaded.engine.id, publicationId)
    }

    for (const step of loaded.recipe.stage.filter((s) => s.verb === 'fill')) {
      const expected = String(loaded.payload[step.key!] ?? '')
      const actual = await browser.readValue(loaded.engine, step.selector, pageId)
      const matches = comparable(expected) === comparable(actual)

      trace(db, publicationId, {
        phase: 'stage',
        action: 'compare',
        selector: step.selector,
        ok: matches,
        // The evidence that invariant 2 held: what was approved, and what the
        // page actually holds. Hashes rather than the copy itself — the copy is
        // already on the publication row, and duplicating it here would put the
        // same text in two places that could drift.
        detail: {
          key: step.key,
          approved: hash(comparable(expected)),
          onPage: hash(comparable(actual)),
          approvedChars: expected.length,
          onPageChars: actual.length,
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
      lease,
      screenshotPath: shot,
      stagedAt,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await screenshot(db, loaded, 'stage', holder(loaded.engine.id)?.pageId)
    await releaseTab(loaded, publicationId)

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

  let externalUrl: string | null = null
  let externalId: string | null = null
  let evidence: Attestation['evidence'] = 'attested'

  if (loaded.recipe.verify.length > 0) {
    try {
      const pageId = holder(loaded.engine.id)?.pageId
      for (const step of loaded.recipe.verify) {
        const value = await runStep(db, loaded, step, 'verify', pageId)
        if (step.verb !== 'read' || !value) continue
        if (step.key === 'url') externalUrl = value
        if (step.key === 'id') externalId = value
      }
      // Only a step that actually found something is evidence. A verify section
      // that ran and matched nothing means the desk looked and did not see the
      // post, which is not the same as having no way to look.
      evidence = externalUrl || externalId ? 'verified' : 'attested'
    } catch (err) {
      // The human says it went out; a failed check does not overrule them. It
      // downgrades the evidence and is recorded, which is all it should do.
      logEvent(db, {
        level: 'warn',
        code: 'VERIFY_FAILED',
        storyId: loaded.publication.storyId,
        publicationId,
        message: `could not confirm the post on ${loaded.outlet.name} — recording it as attested`,
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    await screenshot(db, loaded, 'verify', holder(loaded.engine.id)?.pageId)
  }

  db.update(schema.publications)
    .set({
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      evidence,
      externalUrl,
      externalId,
      error: null,
    })
    .where(eq(schema.publications.id, publicationId))
    .run()

  await releaseTab(loaded, publicationId)

  logEvent(db, {
    level: 'info',
    actor: 'human',
    code: 'PUBLISHED',
    storyId: loaded.publication.storyId,
    publicationId,
    message:
      evidence === 'verified'
        ? `published on ${loaded.outlet.name} and confirmed on the page`
        : `published on ${loaded.outlet.name}, on the operator's word`,
    detail: { driver: 'browser', evidence, externalUrl, externalId },
  })

  return { status: 'PUBLISHED', evidence, externalUrl, externalId }
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

  db.update(schema.publications)
    .set({ status: 'AWAITING_SEND', error: null })
    .where(eq(schema.publications.id, publicationId))
    .run()

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
