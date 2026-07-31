import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.js'
import { schema } from '../../db/index.js'
import { logEvent } from '../../events.js'
import { trim } from './trim.js'

/**
 * A filing is free text filed by a stringer, at whatever depth that stringer
 * works in. It is explicitly NOT a normalized news item and carries no
 * required identifier — there is nothing to key on, and deduplication is the
 * managing editor's judgement rather than a constraint.
 */
export const filingInputSchema = z.object({
  stringer_id: z.string().min(1),
  kind: z.enum(['report', 'timeline', 'snapshot', 'tip']).optional(),
  text: z.string().min(1, 'a filing needs text'),
  refs: z.record(z.string(), z.unknown()).optional(),
  filed_at: z.string().optional(),
})

export const filingsBodySchema = z.union([
  filingInputSchema,
  z.array(filingInputSchema).min(1),
])

export type FilingInput = z.infer<typeof filingInputSchema>

export interface ReceiveResult {
  id: string | null
  stringerId: string
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'REJECTED'
  considered: boolean
  note: string
}

export interface ReceiveOptions {
  /**
   * Called for a filing that carries something new, inside the same
   * transaction that stores it — so a queued job can never reference a
   * filing that was rolled back.
   *
   * Absent means no managing editor is wired (tests, or a desk configured without
   * inference); the filing then finishes as PROCESSED, exactly as it did
   * before Phase 2.
   */
  enqueueManagingEditor?: (filingId: string) => void
  /**
   * Called instead of the managing editor for a kind the reporting phase
   * covers. The reporter hands the filing on itself once it has gone and
   * looked, so this replaces the managing-editor call rather than adding to it.
   *
   * Absent means the phase is not configured and everything goes straight to
   * the managing editor, exactly as before.
   */
  enqueueReporter?: (filingId: string) => void
  /** Which kinds get reported. Empty or absent means none do. */
  reportedKinds?: readonly string[]
}

/**
 * Store a filed report and work out what part of it is new. Stringers keep no
 * state of their own: re-filing an overlapping window is expected and safe,
 * which is what lets them stay dumb.
 */
export function receiveFiling(
  db: Db,
  input: FilingInput,
  options: ReceiveOptions = {},
): ReceiveResult {
  const stringer = db.select().from(schema.stringers).where(eq(schema.stringers.id, input.stringer_id)).get()

  if (!stringer) {
    return {
      id: null,
      stringerId: input.stringer_id,
      status: 'REJECTED',
      considered: false,
      note: `unknown stringer "${input.stringer_id}" — add it in Configuration first`,
    }
  }

  const kind = input.kind ?? stringer.kind
  const id = randomUUID()

  // A disabled stringer is stored rather than refused: losing a filed report is
  // worse than storing one nobody asked for, and the Wire shows why it slept.
  if (!stringer.enabled) {
    db.insert(schema.filings)
      .values({
        id,
        stringerId: stringer.id,
        kind,
        text: input.text,
        considered: null,
        refs: input.refs ? JSON.stringify(input.refs) : null,
        filedAt: input.filed_at ?? null,
        status: 'PROCESSED',
        outcome: 'stringer disabled — stored but not processed',
      })
      .run()
    logEvent(db, {
      level: 'warn',
      code: 'FILING_STRINGER_DISABLED',
      message: `filed to disabled stringer "${stringer.id}"`,
    })
    return {
      id,
      stringerId: stringer.id,
      status: 'PROCESSED',
      considered: false,
      note: 'stringer disabled — stored but not processed',
    }
  }

  const result = trim({
    kind,
    text: input.text,
    watermark: stringer.watermark,
    lastSnapshot: stringer.lastSnapshot,
  })

  // Nothing new is a finished filing, not a pending one: only material
  // the managing editor has not seen is worth an inference call.
  const hasNewMaterial = result.considered.length > 0
  const willReport =
    hasNewMaterial &&
    options.enqueueReporter !== undefined &&
    (options.reportedKinds ?? []).includes(kind)
  const willAssign = hasNewMaterial && !willReport && options.enqueueManagingEditor !== undefined

  const queued = willReport ? 'PROCESSING' : willAssign ? 'PROCESSING' : 'PROCESSED'
  const note = willReport
    ? `${result.note} — queued for the reporter`
    : willAssign
      ? `${result.note} — queued for the managing editor`
      : result.note

  db.transaction((tx) => {
    tx.insert(schema.filings)
      .values({
        id,
        stringerId: stringer.id,
        kind,
        text: input.text,
        considered: result.considered || null,
        refs: input.refs ? JSON.stringify(input.refs) : null,
        filedAt: input.filed_at ?? null,
        status: queued,
        outcome: note,
      })
      .run()

    if (willReport) options.enqueueReporter?.(id)
    else if (willAssign) options.enqueueManagingEditor?.(id)

    if (result.watermark !== undefined || result.snapshot !== undefined) {
      tx.update(schema.stringers)
        .set({
          ...(result.watermark !== undefined ? { watermark: result.watermark } : {}),
          ...(result.snapshot !== undefined ? { lastSnapshot: result.snapshot } : {}),
        })
        .where(eq(schema.stringers.id, stringer.id))
        .run()
    }
  })

  logEvent(db, {
    level: 'info',
    code: 'FILING_RECEIVED',
    message: `${stringer.id}: ${result.note}`,
    detail: { filingId: id, kind, consideredChars: result.considered.length },
  })

  return {
    id,
    stringerId: stringer.id,
    status: queued,
    considered: result.considered.length > 0,
    note: result.note,
  }
}

export function receiveFilings(
  db: Db,
  inputs: FilingInput[],
  options: ReceiveOptions = {},
): ReceiveResult[] {
  return inputs.map((input) => receiveFiling(db, input, options))
}
