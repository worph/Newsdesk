import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { EXPIRE_AFTER_MS, handoverFollowupHandler } from '../src/ports/delivery/browser/handover.js'
import { BrowserBusy, resetLeases } from '../src/ports/delivery/browser/lease.js'
import {
  abandon,
  attest,
  confirmSignedIn,
  setSignInSettleMs,
  setTraceDir,
  stage,
} from '../src/ports/delivery/browser/session.js'
import { deliverPublication } from '../src/ports/delivery/index.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * Publishing through a browser, against a stub of the container.
 *
 * The stub is a real HTTP server rather than a mocked `fetch`, because what is
 * under test is a contract with something outside the process: the shape of
 * `/api/action`, that a filled field can be read back at all, and — the one
 * that matters — what the desk does when the page disagrees with the payload
 * it froze.
 */

const RECIPE = `## Stage
The composer opens as a modal.
wait:  button.compose
click: button.compose
fill:  div.editor <- body

## Hand over
Read it, then press Post.

## Verify
read: a.permalink -> url
`

/** A page that remembers what was typed into it, and can be told to lie. */
interface StubPage {
  navigatedTo: string | null
  /** Tabs the desk opened, and how many it has asked for. */
  opened: number
  openPages: Set<string>
  fields: Map<string, string>
  attributes: Map<string, string>
  /** Corrupt what a read-back returns, to stand in for a composer that mangles input. */
  mangle: ((value: string) => string) | null
  /**
   * Answer as a block editor rather than a form field — the desk compares the
   * two differently, so which one the stub claims to be is part of the fixture.
   */
  rich: boolean
  fail: string | null
}

/** The two JSON string literals the desk embeds in an evaluate script. */
function literals(script: string): string[] {
  return [...script.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string)
}

async function startStub(page: StubPage): Promise<{ apiBase: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, string>) : {}
      const reply = (value: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }

      if (page.fail && req.url?.includes(page.fail)) return reply({ error: 'stub failure' }, 500)

      // The desk now opens a tab of its own and names it on every call. The
      // stub keeps one page and simply hands out ids, which is enough to prove
      // the desk asks for a tab and gives it back.
      if (req.url === '/api/pages' && req.method === 'POST') {
        const pageId = `stub-page-${++page.opened}`
        page.openPages.add(pageId)
        return reply({ pageId, url: body.url ?? 'about:blank', title: 'stub' }, 201)
      }
      if (req.url === '/api/pages' && req.method === 'GET') {
        return reply({ pages: [...page.openPages].map((pageId) => ({ pageId, owner: 'newsdesk' })) })
      }
      if (req.url?.startsWith('/api/pages/') && req.method === 'DELETE') {
        page.openPages.delete(decodeURIComponent(req.url.slice('/api/pages/'.length)))
        return reply({ closed: true })
      }

      if (req.url === '/api/navigate') {
        page.navigatedTo = body.url ?? null
        return reply({ ok: true })
      }

      if (req.url === '/api/action') {
        switch (body.action) {
          case 'waitFor':
          case 'click':
            return reply({ ok: true })
          case 'type':
            page.fields.set(body.selector!, body.text ?? '')
            return reply({ ok: true })
          case 'getText':
            return reply({ text: page.fields.get(body.selector!) ?? '' })
          default:
            return reply({ error: `unknown action ${body.action}` }, 400)
        }
      }

      if (req.url === '/api/evaluate') {
        /**
         * The container hands the script to Playwright's `page.evaluate`, which
         * evaluates a *string* as an expression. A bare `() => {…}` therefore
         * evaluates to a function object and comes back as nothing — which is
         * indistinguishable from an empty field unless the stub is as strict
         * about it as the real thing.
         */
        if (!/^\s*\(.*\)\s*\(\s*\)\s*$/s.test(body.script ?? '')) {
          return reply({ result: undefined })
        }
        const [selector, attribute] = literals(body.script ?? '')
        // `exists` asks whether anything matches at all, and answers a boolean
        // rather than a value — an empty field is present, not absent.
        if (/!==\s*null/.test(body.script ?? '')) {
          return reply({ result: page.fields.has(selector!) })
        }
        if (attribute !== undefined) {
          return reply({ result: page.attributes.get(`${selector}|${attribute}`) ?? null })
        }
        const stored = page.fields.get(selector!)
        if (stored === undefined) return reply({ result: null })
        return reply({
          result: { value: page.mangle ? page.mangle(stored) : stored, rich: page.rich },
        })
      }

      if (req.url?.startsWith('/api/screenshot')) {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
      }

      if (req.url === '/api/vnc-password') return reply({ password: 'hunter2' })
      if (req.url === '/api/status') return reply({ url: page.navigatedTo })

      return reply({ error: 'not found' }, 404)
    })
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    apiBase: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

const PAGE_URL = 'https://example.test/company/admin/posts'
const BODY = 'The release lands today.\n\nIt is smaller than it looks.'

function seedBrowserPublication(
  db: Db,
  apiBase: string,
  options: { status?: string; recipe?: string; scheduledFor?: string | null } = {},
): string {
  db.insert(schema.browserEngines)
    .values({ id: 'sidecar', name: 'Newsdesk browser', apiBase, viewer: 'novnc' })
    .run()

  db.insert(schema.outlets)
    .values({
      id: 'linkedin',
      name: 'LinkedIn',
      description: 'the company page',
      role: 'publish',
      driver: 'browser',
      enabled: true,
      voiceId: 'alicia',
      engineId: 'sidecar',
      recipe: options.recipe ?? RECIPE,
      argsSpec: JSON.stringify({
        url: PAGE_URL,
        body: { slot: 'markdown', label: 'Post', optional: false, primary: true },
      }),
    })
    .run()

  const storyId = randomUUID()
  db.insert(schema.stories)
    .values({
      id: storyId,
      title: 'A release lands',
      summary: 'It shipped.',
      status: 'PLACED',
      dedupVerdict: 'NEW',
    })
    .run()

  const id = randomUUID()
  db.insert(schema.publications)
    .values({
      id,
      storyId,
      outletId: 'linkedin',
      status: options.status ?? 'AWAITING_SEND',
      origin: 'managing-editor',
      slots: JSON.stringify({ body: BODY }),
      payload: JSON.stringify({ url: PAGE_URL, body: BODY }),
      approvedAt: new Date().toISOString(),
      scheduledFor: options.scheduledFor ?? null,
    })
    .run()

  return id
}

describe('browser publishing', () => {
  let page: StubPage
  let stub: { apiBase: string; close: () => Promise<void> }
  let traceDir: string

  beforeEach(async () => {
    resetLeases()
    page = {
      navigatedTo: null,
      opened: 0,
      openPages: new Set(),
      fields: new Map(),
      attributes: new Map(),
      mangle: null,
      rich: false,
      fail: null,
    }
    stub = await startStub(page)
    traceDir = mkdtempSync(join(tmpdir(), 'newsdesk-traces-'))
    setTraceDir(traceDir)
    // The real window lets a single-page app finish redirecting to its login
    // screen; the stub answers at once, so waiting for it is pure test latency.
    setSignInSettleMs(50)
  })

  afterEach(async () => {
    await stub.close()
    rmSync(traceDir, { recursive: true, force: true })
  })

  describe('the slot coming due', () => {
    it('hands over instead of sending, and touches no browser', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'SCHEDULED' })

      await deliverPublication(db, id)

      const row = db.select().from(schema.publications).where(eqId(id)).get()
      expect(row?.status).toBe('AWAITING_SEND')
      expect(row?.publishedAt).toBeNull()
      // The whole point of stage-on-open: waiting for a person must not occupy
      // the single browser for hours.
      expect(page.navigatedTo).toBeNull()
      expect(row?.stagedAt).toBeNull()

      const jobs = db.select().from(schema.jobs).all()
      expect(jobs.filter((job) => job.kind === 'handover-followup')).toHaveLength(1)
    })

    it('is not offered twice when a second send job lands on it', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'SCHEDULED' })

      await deliverPublication(db, id)
      await deliverPublication(db, id)

      expect(
        db.select().from(schema.jobs).all().filter((job) => job.kind === 'handover-followup'),
      ).toHaveLength(1)
    })
  })

  describe('when the browser is signed out', () => {
    const GATED = `## Signed out
when: input#email
${RECIPE}`

    it('asks for a sign-in instead of asking for a publish', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'SCHEDULED', recipe: GATED })
      page.fields.set('input#email', '')

      await deliverPublication(db, id)

      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('NEEDS_AUTH')
      const codes = db.select().from(schema.events).all().map((e) => e.code)
      expect(codes).toContain('NEEDS_AUTH')
      expect(codes).not.toContain('HANDOVER_DUE')
    })

    it('will not compose a page it cannot get into', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'SCHEDULED', recipe: GATED })
      page.fields.set('input#email', '')

      await deliverPublication(db, id)
      await expect(stage(db, id)).rejects.toThrow(/signed out/)
    })

    it('checks the page rather than believing the operator', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'SCHEDULED', recipe: GATED })
      page.fields.set('input#email', '')

      await deliverPublication(db, id)
      // Says so while the login form is still there: publishing into a login
      // page is precisely what this state exists to prevent.
      expect(await confirmSignedIn(db, id)).toBe(false)
      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('NEEDS_AUTH')

      // Now they really have signed in.
      page.fields.delete('input#email')
      expect(await confirmSignedIn(db, id)).toBe(true)
      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('AWAITING_SEND')
      await expect(stage(db, id)).resolves.toMatchObject({ outletName: 'LinkedIn' })
    })

    it('does not check a destination that declares no markers', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'SCHEDULED' })

      await deliverPublication(db, id)

      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('AWAITING_SEND')
      expect(db.select().from(schema.publishTraces).all().filter((t) => t.phase === 'signin')).toHaveLength(0)
    })
  })

  describe('composing the page', () => {
    it('navigates to the pinned literal and types the frozen payload', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)

      const staged = await stage(db, id)

      expect(page.navigatedTo).toBe(PAGE_URL)
      expect(page.fields.get('div.editor')).toBe(BODY)
      expect(staged.handover).toBe('Read it, then press Post.')
      expect(db.select().from(schema.publications).where(eqId(id)).get()?.stagedAt).toBeTruthy()
    })

    it('records the byte comparison as evidence, not as a claim', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)

      await stage(db, id)

      const compare = db
        .select()
        .from(schema.publishTraces)
        .all()
        .find((row) => row.action === 'compare')
      expect(compare?.ok).toBe(true)
      const detail = JSON.parse(compare!.detail!) as Record<string, unknown>
      expect(detail.approved).toBe(detail.onPage)
      // Hashes, not the copy: it already lives on the publication row and two
      // copies of it are two things that can drift.
      expect(JSON.stringify(detail)).not.toContain('release lands today')
    })

    it('refuses to hand over a page that does not hold what was approved', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      page.mangle = (value) => value.replace('smaller', 'bigger')

      await expect(stage(db, id)).rejects.toThrow(/not what was approved/)

      const row = db.select().from(schema.publications).where(eqId(id)).get()
      expect(row?.status).toBe('FAILED')
      expect(row?.stagedAt).toBeNull()
      expect(
        db.select().from(schema.publishTraces).all().find((t) => t.action === 'compare')?.ok,
      ).toBe(false)
    })

    it('tolerates the whitespace a real composer adds', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      // A contenteditable normalises line endings and leaves a trailing newline.
      page.mangle = (value) => `${value.replace(/\n/g, '\r\n')}\n`

      await expect(stage(db, id)).resolves.toMatchObject({ outletName: 'LinkedIn' })
    })

    it('tolerates the paragraph spacing a block editor invents', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      // Docmost's ProseMirror makes every line a node and reads them back with
      // its own spacing — a blank line where the payload had none, and several
      // where it had one. Nothing in the copy changed.
      page.rich = true
      page.mangle = (value) => value.replace(/\n/g, '\n\n\n')

      await expect(stage(db, id)).resolves.toMatchObject({ outletName: 'LinkedIn' })
    })

    it('still catches altered copy in a block editor, where spacing is forgiven', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      // The looser comparison forgives the editor's spacing and nothing else:
      // a word that changed is still a word that changed.
      page.rich = true
      page.mangle = (value) => value.replace(/\n/g, '\n\n').replace('smaller', 'bigger')

      await expect(stage(db, id)).rejects.toThrow(/not what was approved/)
      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('FAILED')
    })

    it('lets one publish hold the browser at a time', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const first = seedBrowserPublication(db, stub.apiBase)

      // A second story, because one story runs at most once per outlet.
      const otherStory = randomUUID()
      db.insert(schema.stories)
        .values({
          id: otherStory,
          title: 'Another release lands',
          summary: 'It also shipped.',
          status: 'PLACED',
          dedupVerdict: 'NEW',
        })
        .run()

      const second = randomUUID()
      db.insert(schema.publications)
        .values({
          id: second,
          storyId: otherStory,
          outletId: 'linkedin',
          status: 'AWAITING_SEND',
          origin: 'managing-editor',
          slots: JSON.stringify({ body: BODY }),
          payload: JSON.stringify({ url: PAGE_URL, body: BODY }),
          approvedAt: new Date().toISOString(),
        })
        .run()

      await stage(db, first)
      await expect(stage(db, second)).rejects.toBeInstanceOf(BrowserBusy)
      // And the refusal says who has it, so the next person is not left guessing.
      await expect(stage(db, second)).rejects.toThrow(/LinkedIn/)
    })

    it('reuses its tab when the same publication takes the browser again', async () => {
      // An operator reloading the live page must not leak a tab per reload.
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)

      await stage(db, id)
      await stage(db, id)

      expect(page.opened).toBe(1)
      expect(page.openPages.size).toBe(1)
    })

    it('opens a fresh tab when the remembered one has gone', async () => {
      // The browser is reaped when idle and recreated with the container,
      // taking every tab with it. A lease outliving one would otherwise wedge
      // the publication on a page that no longer exists.
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)

      await stage(db, id)
      page.openPages.clear() // the browser restarted under us

      await expect(stage(db, id)).resolves.toMatchObject({ outletName: 'LinkedIn' })
      expect(page.opened).toBe(2)
    })

    it('will not stage something that is not waiting to be sent', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'PUBLISHED' })

      await expect(stage(db, id)).rejects.toThrow(/only a publication waiting to be sent/)
    })
  })

  describe('recording that it went out', () => {
    it('is verified when the desk finds the post', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      page.attributes.set('a.permalink|href', 'https://example.test/feed/update/123')

      await stage(db, id)
      const result = await attest(db, id)

      expect(result).toMatchObject({
        evidence: 'verified',
        externalUrl: 'https://example.test/feed/update/123',
      })
      const row = db.select().from(schema.publications).where(eqId(id)).get()
      expect(row?.status).toBe('PUBLISHED')
      expect(row?.evidence).toBe('verified')
      expect(row?.publishedAt).toBeTruthy()
    })

    it('stores a permalink the ledger can be followed from', async () => {
      // Pages write their own links relative; a bare `/post/1` in external_url
      // is not a link anyone can click from the desk.
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      page.attributes.set('a.permalink|href', '/post/7')

      await stage(db, id)

      expect(await attest(db, id)).toMatchObject({
        evidence: 'verified',
        externalUrl: 'https://example.test/post/7',
      })
    })

    it('is attested when the recipe has no way to look', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, {
        recipe: '## Stage\nfill: div.editor <- body\n## Hand over\nPress Post.',
      })

      await stage(db, id)
      expect(await attest(db, id)).toMatchObject({ evidence: 'attested', externalUrl: null })
    })

    it('is attested, not failed, when the check runs and finds nothing', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      // The operator says it went out. A check that cannot confirm downgrades
      // the evidence; it does not overrule them.
      await stage(db, id)

      expect(await attest(db, id)).toMatchObject({ evidence: 'attested' })
      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('PUBLISHED')
    })

    it('keeps the record of being composed when the live view closes after a send', async () => {
      // The live view frees the browser on its way out, including on the way
      // out after a successful send.
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)

      await stage(db, id)
      await attest(db, id)
      abandon(db, id)

      const row = db.select().from(schema.publications).where(eqId(id)).get()
      expect(row?.status).toBe('PUBLISHED')
      expect(row?.stagedAt).toBeTruthy()
    })

    it('does not publish twice', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase)
      page.attributes.set('a.permalink|href', 'https://example.test/feed/update/9')

      await stage(db, id)
      const first = await attest(db, id)
      const second = await attest(db, id)

      expect(second).toEqual(first)
    })
  })

  describe('when nobody publishes it', () => {
    it('reminds, then gives the slot up', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const scheduledFor = new Date(Date.now() - 60_000).toISOString()
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'SCHEDULED', scheduledFor })

      await deliverPublication(db, id)

      // An hour in: still owed, so it nags and books the next look.
      await handoverFollowupHandler({ now: () => Date.parse(scheduledFor) + 60 * 60_000 })(db, id)
      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('AWAITING_SEND')

      // Past the deadline: the news has moved on, so it wants a fresh decision
      // rather than firing stale copy tomorrow morning.
      await handoverFollowupHandler({ now: () => Date.parse(scheduledFor) + EXPIRE_AFTER_MS + 1 })(db, id)

      const row = db.select().from(schema.publications).where(eqId(id)).get()
      expect(row?.status).toBe('AWAITING_APPROVAL')
      // Withdrawn, not spiked: the copy survives and only the slot is given up.
      expect(row?.payload).toBeNull()
      expect(row?.scheduledFor).toBeNull()

      const codes = db.select().from(schema.events).all().map((e) => e.code)
      expect(codes).toContain('SEND_EXPIRED')
    })

    it('does nothing at all once the row has moved on', async () => {
      const { db } = openTestDb()
      seedDesk(db)
      const id = seedBrowserPublication(db, stub.apiBase, { status: 'PUBLISHED' })

      await handoverFollowupHandler({ now: () => Date.now() + EXPIRE_AFTER_MS * 2 })(db, id)

      expect(db.select().from(schema.publications).where(eqId(id)).get()?.status).toBe('PUBLISHED')
    })
  })
})

/** Local shorthand; drizzle's `eq` needs the column and reads badly inline here. */
function eqId(id: string) {
  return eq(schema.publications.id, id)
}
