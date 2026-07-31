import { randomUUID } from 'node:crypto'
import type { Reporting } from '@newsdesk/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'
import { runStructured } from '../ports/inference/structured.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { extractUrls, type FetchedPage, type ReportingTools, type SearchHit } from '../ports/reporting/tools.js'
import { fillPrompt, loadPrompt } from '../prompts/load.js'

/**
 * Reporting: the desk going and looking, for a filing that arrived without a
 * stringer behind it.
 *
 * A tip is the one input authored by someone with no credentials and no access
 * — which is exactly why it needs this. The phase produces a dossier (a story
 * file: sourced claims, chronology, open questions) and never an article,
 * because at this point no destination has been chosen and the writer fills
 * slots per publication one step later.
 *
 * Two properties carry the whole design:
 *
 *   The model never names a url. It answers with indices into a catalogue the
 *   desk built, so a fetched page cannot steer the next fetch.
 *
 *   A citation exists because the desk retrieved the page. Sourced claims are
 *   checked against dossier_sources before the dossier is stored; anything
 *   uncited is demoted to unverified recall and logged, exactly as the managing
 *   editor downgrades a dedup verdict it cannot substantiate.
 *
 * And one rule above both: losing a tip is the worst outcome available, so
 * every failure below still ends with the filing reaching the managing editor.
 *
 * See docs/pitch-and-reporting.md.
 */

/** How much of one page is carried into a prompt. Enough to judge, not enough to drown. */
const PAGE_EXCERPT_CHARS = 4_000
/** Search hits kept per query. Beyond this the catalogue becomes noise. */
const HITS_PER_QUERY = 6

const steerSchema = z.object({
  queries: z.array(z.string().min(1)).max(8).default([]),
  /** Catalogue numbers, not urls — the model cannot name an address. */
  open: z.array(z.number().int().positive()).max(20).default([]),
  done: z.boolean().default(false),
})

const dossierSchema = z.object({
  headline: z.string().min(1),
  brief: z.string().min(1),
  angle: z.string().nullable().default(null),
  sourced: z
    .array(z.object({ claim: z.string().min(1), url: z.string().min(1), as_of: z.string().nullable().default(null) }))
    .default([]),
  chronology: z
    .array(z.object({ when: z.string().min(1), what: z.string().min(1), url: z.string().nullable().default(null) }))
    .default([]),
  unknowns: z.array(z.string().min(1)).default([]),
  recall: z.array(z.object({ claim: z.string().min(1) })).default([]),
  body: z.string().nullable().default(null),
})

/**
 * The output types, not the input ones. Every field below has a default, so
 * zod's input and output shapes differ and runStructured would otherwise infer
 * the optional side — the call sites are annotated for the same reason
 * managing-editor.ts annotates its result.
 */
export type Dossier = z.output<typeof dossierSchema>
type Steer = z.output<typeof steerSchema>

const STEER_SHAPE = [
  '{',
  '  "queries": string[],   // searches to run now, [] if none',
  '  "open": number[],      // catalogue numbers to read, [] if none',
  '  "done": boolean',
  '}',
].join('\n')

const DOSSIER_SHAPE = [
  '{',
  '  "headline": string,',
  '  "brief": string,',
  '  "angle": string | null,',
  '  "sourced": [{ "claim": string, "url": string, "as_of": string | null }],',
  '  "chronology": [{ "when": string, "what": string, "url": string | null }],',
  '  "unknowns": string[],',
  '  "recall": [{ "claim": string }],',
  '  "body": string | null',
  '}',
].join('\n')

interface Retrieved extends FetchedPage {
  via: 'tip' | 'search'
  query?: string
  title?: string
}

function renderCorpus(pages: Retrieved[]): string {
  const usable = pages.filter((page) => page.ok && page.text.trim())
  if (usable.length === 0) return '(nothing has been retrieved — no link was carried and no page could be opened)'
  return usable
    .map((page, i) =>
      [`### [${i + 1}] ${page.title ?? page.url}`, page.url, '', page.text.slice(0, PAGE_EXCERPT_CHARS)].join('\n'),
    )
    .join('\n\n---\n\n')
}

function renderCatalogue(catalogue: SearchHit[], opened: Set<string>): string {
  if (catalogue.length === 0) return '(no searches have run yet)'
  return catalogue
    .map((hit, i) => {
      const mark = opened.has(hit.url) ? ' — already read' : ''
      return `${i + 1}. ${hit.title}${mark}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`
    })
    .join('\n')
}

/**
 * A search of last resort, for a first round where the model proposed nothing.
 *
 * The floor is deliberate: a reporter who files without looking anything up is
 * not reporting, so at least one search always runs even when the tip reads as
 * self-sufficient.
 */
export function fallbackQuery(text: string): string {
  return text.trim().split(/\s+/).slice(0, 12).join(' ')
}

export interface ReportOptions {
  /** Injectable so tests do not wait in real time. */
  now?: () => number
}

export interface ReportResult {
  dossier: Dossier
  sources: number
  demoted: number
  note: string
}

/**
 * Run the loop and return the dossier. Throws only if the filing is missing —
 * every other failure is the caller's to degrade around.
 */
export async function runReporter(
  db: Db,
  driver: InferenceDriver,
  tools: ReportingTools,
  filingId: string,
  reporting: Reporting,
  options: ReportOptions = {},
): Promise<ReportResult> {
  const now = options.now ?? Date.now
  const deadline = now() + reporting.wall_clock_seconds * 1000

  const filing = db.select().from(schema.filings).where(eq(schema.filings.id, filingId)).get()
  if (!filing) throw new Error(`filing "${filingId}" not found`)

  const tip = filing.considered ?? filing.text
  const pages: Retrieved[] = []
  const catalogue: SearchHit[] = []
  const seenUrls = new Set<string>()
  const opened = new Set<string>()
  const notes: string[] = []
  let fetches = 0

  const budgetLeft = () => reporting.max_fetches - fetches
  const outOfTime = () => now() >= deadline

  async function retrieve(url: string, via: 'tip' | 'search', query?: string): Promise<void> {
    if (opened.has(url) || budgetLeft() <= 0 || !tools.canFetch) return
    opened.add(url)
    fetches++
    const page = await tools.fetch(url)
    pages.push({ ...page, via, ...(query ? { query } : {}) })
  }

  // 1. Harvest. Every link the tip carried, before any model call — a tip that
  //    arrived with a link is already half-reported.
  for (const url of extractUrls(tip)) {
    if (outOfTime()) break
    await retrieve(url, 'tip')
  }
  if (!tools.canFetch) notes.push('no fetch tool configured')

  // 2. Steer and search, one model call per round.
  let searched = false
  for (let round = 1; round <= reporting.max_rounds; round++) {
    if (outOfTime()) {
      notes.push(`out of time after ${round - 1} round(s)`)
      break
    }
    if (!tools.canSearch && searched) break

    const steer: Steer = await runStructured(db, driver, {
      purpose: 'reporter',
      refId: filingId,
      prompt: fillPrompt(loadPrompt('reporter-steer'), {
        TIP: tip,
        CORPUS: renderCorpus(pages),
        CATALOGUE: renderCatalogue(catalogue, opened),
        ROUND: String(round),
        MAX_ROUNDS: String(reporting.max_rounds),
        FETCHES_LEFT: String(budgetLeft()),
      }),
      schema: steerSchema,
      shapeHint: STEER_SHAPE,
    })

    // Indices into the catalogue the desk built. Anything out of range is
    // silently dropped rather than resolved — that is the whole point of
    // numbering: an index cannot become an arbitrary address.
    for (const index of steer.open) {
      if (outOfTime()) break
      const hit = catalogue[index - 1]
      if (hit) await retrieve(hit.url, 'search')
    }

    // The floor: round one always searches, even if the model asked for nothing.
    const queries = steer.queries.length > 0 ? steer.queries : round === 1 ? [fallbackQuery(tip)] : []

    if (tools.canSearch) {
      for (const query of queries) {
        if (outOfTime()) break
        try {
          const hits = await tools.search(query)
          searched = true
          for (const hit of hits.slice(0, HITS_PER_QUERY)) {
            if (seenUrls.has(hit.url)) continue
            seenUrls.add(hit.url)
            catalogue.push(hit)
          }
        } catch (err) {
          notes.push(`search failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } else if (round === 1) {
      notes.push('no search tool answered')
    }

    if (steer.done || budgetLeft() <= 0) break
  }

  // A last pass over anything found in the final round but never opened, so the
  // dossier is not written blind to the search that produced it.
  for (const hit of catalogue) {
    if (outOfTime() || budgetLeft() <= 0) break
    if (!opened.has(hit.url)) await retrieve(hit.url, 'search')
  }

  // 3. Record what was retrieved BEFORE filing, so citations can be checked
  //    against rows rather than against a promise.
  const rows = pages.map((page) => ({
    id: randomUUID(),
    filingId,
    url: page.url,
    title: page.title ?? null,
    via: page.via,
    query: page.query ?? null,
    ok: page.ok,
    chars: page.text.length,
  }))
  if (rows.length > 0) db.insert(schema.dossierSources).values(rows).run()

  // 4. File.
  const filed: Dossier = await runStructured(db, driver, {
    purpose: 'reporter',
    refId: filingId,
    prompt: fillPrompt(loadPrompt('reporter-file'), {
      TIP: tip,
      CORPUS: renderCorpus(pages),
      TODAY: new Date(now()).toISOString().slice(0, 10),
    }),
    schema: dossierSchema,
    shapeHint: DOSSIER_SHAPE,
  })

  const dossier = demoteUncited(db, filingId, filed, pages)
  const demoted = dossier.recall.length - filed.recall.length

  const note = [
    `${pages.filter((p) => p.ok).length} source(s) read`,
    `${dossier.sourced.length} sourced claim(s)`,
    ...(demoted > 0 ? [`${demoted} uncited claim(s) demoted`] : []),
    ...notes,
  ].join(', ')

  return { dossier, sources: rows.length, demoted, note }
}

/**
 * A claim citing a page the desk never retrieved is not reportable, so it is
 * moved to `recall` rather than stored as a sourced fact.
 *
 * This is the invariant the phase exists to hold: `sourced` is what a human
 * downstream will read as reported, so it must never contain a url we cannot
 * show a row for. Mirrors checkVerdictLinks in managing-editor.ts.
 */
export function demoteUncited(
  db: Db,
  filingId: string,
  dossier: Dossier,
  pages: Array<{ url: string; ok: boolean }>,
): Dossier {
  const retrieved = new Set(pages.filter((page) => page.ok).map((page) => page.url))
  const kept = dossier.sourced.filter((claim) => retrieved.has(claim.url))
  const uncited = dossier.sourced.filter((claim) => !retrieved.has(claim.url))

  if (uncited.length === 0) return dossier

  logEvent(db, {
    level: 'warn',
    code: 'DOSSIER_CITATION_UNVERIFIED',
    message: `demoted ${uncited.length} claim(s) citing a page the desk never retrieved`,
    detail: { filingId, urls: uncited.map((claim) => claim.url) },
  })

  return {
    ...dossier,
    sourced: kept,
    recall: [
      ...dossier.recall,
      ...uncited.map((claim) => ({ claim: `${claim.claim} [cited ${claim.url}, which was never retrieved]` })),
    ],
    // Chronology entries lean on the same urls, so an uncitable one loses its link
    // rather than carrying an unverifiable reference into the story file.
    chronology: dossier.chronology.map((entry) =>
      entry.url && !retrieved.has(entry.url) ? { ...entry, url: null } : entry,
    ),
  }
}

/**
 * Render the dossier for the managing editor.
 *
 * `sourced` and `recall` are kept visibly apart: the managing editor is told
 * plainly which claims are reported and which are the desk's unverified
 * memory, because it is about to decide whether this is a story.
 */
export function renderDossier(dossier: Dossier): string {
  const lines = [`# ${dossier.headline}`, '', dossier.brief]

  if (dossier.angle) lines.push('', `Angle: ${dossier.angle}`)

  lines.push('', '## Sourced — each claim was read on the page cited')
  lines.push(
    dossier.sourced.length > 0
      ? dossier.sourced
          .map((claim) => `- ${claim.claim}${claim.as_of ? ` (as of ${claim.as_of})` : ''}\n  ${claim.url}`)
          .join('\n')
      : '(nothing could be sourced — this is a lead, not a filing)',
  )

  if (dossier.chronology.length > 0) {
    lines.push('', '## Chronology')
    lines.push(
      dossier.chronology.map((e) => `- ${e.when}: ${e.what}${e.url ? `\n  ${e.url}` : ''}`).join('\n'),
    )
  }

  if (dossier.recall.length > 0) {
    lines.push('', '## Unverified recall — NOT reported, NOT checked, no date')
    lines.push(dossier.recall.map((r) => `- ${r.claim}`).join('\n'))
  }

  if (dossier.unknowns.length > 0) {
    lines.push('', '## Open questions')
    lines.push(dossier.unknowns.map((u) => `- ${u}`).join('\n'))
  }

  if (dossier.body) {
    lines.push('', '## As written by the tipster, verbatim')
    lines.push(dossier.body)
  }

  return lines.join('\n')
}

export interface ReporterOptions extends ReportOptions {
  /** Called once reporting has settled, however it settled. */
  enqueueManagingEditor?: (filingId: string) => void
}

/**
 * Registered against the queue's `report` kind.
 *
 * Fail-open is absolute and deliberate: an unreported tip is a bad day, a
 * swallowed one is a broken promise. Every path below ends with the filing
 * queued for the managing editor and the degradation named in `outcome`, where
 * a human can see it and re-run by hand.
 */
export function reporterHandler(
  driver: () => InferenceDriver,
  tools: () => ReportingTools | undefined,
  reporting: () => Reporting | undefined,
  options: ReporterOptions = {},
) {
  return async (db: Db, filingId: string): Promise<void> => {
    const config = reporting()
    const kit = tools()

    const handOn = (outcome: string) => {
      db.update(schema.filings)
        .set({ status: 'PROCESSING', outcome })
        .where(eq(schema.filings.id, filingId))
        .run()
      options.enqueueManagingEditor?.(filingId)
    }

    if (!config || !config.enabled || !kit) {
      handOn('reporting is not configured — queued for the managing editor unreported')
      return
    }

    try {
      const result = await runReporter(db, driver(), kit, filingId, config, options)

      db.update(schema.filings)
        .set({
          dossier: JSON.stringify(result.dossier),
          reportedAt: new Date((options.now ?? Date.now)()).toISOString(),
          status: 'PROCESSING',
          outcome: `reported — ${result.note}`,
        })
        .where(eq(schema.filings.id, filingId))
        .run()

      logEvent(db, {
        level: 'info',
        code: 'FILING_REPORTED',
        message: `"${result.dossier.headline}" — ${result.note}`,
        detail: { filingId, sources: result.sources, sourced: result.dossier.sourced.length },
      })

      options.enqueueManagingEditor?.(filingId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logEvent(db, {
        level: 'error',
        code: 'REPORTING_FAILED',
        message: `reporting failed, filing handed on unreported: ${message}`,
        detail: { filingId, error: message },
      })
      handOn(`reporting failed (${message}) — queued for the managing editor unreported`)
    }
  }
}
