import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.js'
import { schema } from '../../db/index.js'
import { logEvent } from '../../events.js'
import { trim } from './trim.js'

/**
 * A submission is free text filed by a stringer, at whatever depth that stringer
 * works in. It is explicitly NOT a normalized news item and carries no
 * required identifier — there is nothing to key on, and deduplication is the
 * managing editor's judgement rather than a constraint.
 */
/**
 * `source_id` and `kind: idea` are the pre-rename spelling. They stay accepted
 * because the filers are n8n workflows nobody wants to redeploy for a word —
 * the ingest contract is the one place the vocabulary change must not break.
 */
export const submissionInputSchema = z
  .object({
    stringer_id: z.string().min(1).optional(),
    source_id: z.string().min(1).optional(),
    kind: z.enum(['report', 'timeline', 'snapshot', 'tip', 'idea']).optional(),
    text: z.string().min(1, 'a submission needs text'),
    refs: z.record(z.string(), z.unknown()).optional(),
    filed_at: z.string().optional(),
  })
  .refine((v) => v.stringer_id !== undefined || v.source_id !== undefined, {
    message: 'stringer_id is required',
    path: ['stringer_id'],
  })
  .transform(({ source_id, kind, ...rest }) => ({
    ...rest,
    stringer_id: rest.stringer_id ?? source_id!,
    ...(kind ? { kind: kind === 'idea' ? ('tip' as const) : kind } : {}),
  }))

export const submissionsBodySchema = z.union([
  submissionInputSchema,
  z.array(submissionInputSchema).min(1),
])

export type SubmissionInput = z.infer<typeof submissionInputSchema>

export interface ReceiveResult {
  id: string | null
  stringerId: string
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'REJECTED'
  considered: boolean
  note: string
}

export interface ReceiveOptions {
  /**
   * Called for a submission that carries something new, inside the same
   * transaction that stores it — so a queued job can never reference a
   * submission that was rolled back.
   *
   * Absent means no managing editor is wired (tests, or a desk configured without
   * inference); the submission then finishes as PROCESSED, exactly as it did
   * before Phase 2.
   */
  enqueueManagingEditor?: (submissionId: string) => void
}

/**
 * Store a filed report and work out what part of it is new. Stringers keep no
 * state of their own: re-filing an overlapping window is expected and safe,
 * which is what lets them stay dumb.
 */
export function receiveSubmission(
  db: Db,
  input: SubmissionInput,
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
    db.insert(schema.submissions)
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
      code: 'SUBMISSION_STRINGER_DISABLED',
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

  // Nothing new is a finished submission, not a pending one: only material
  // the managing editor has not seen is worth an inference call.
  const hasNewMaterial = result.considered.length > 0
  const willAssign = hasNewMaterial && options.enqueueManagingEditor !== undefined

  db.transaction((tx) => {
    tx.insert(schema.submissions)
      .values({
        id,
        stringerId: stringer.id,
        kind,
        text: input.text,
        considered: result.considered || null,
        refs: input.refs ? JSON.stringify(input.refs) : null,
        filedAt: input.filed_at ?? null,
        status: willAssign ? 'PROCESSING' : 'PROCESSED',
        outcome: willAssign ? `${result.note} — queued for the managing editor` : result.note,
      })
      .run()

    if (willAssign) options.enqueueManagingEditor?.(id)

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
    code: 'SUBMISSION_RECEIVED',
    message: `${stringer.id}: ${result.note}`,
    detail: { submissionId: id, kind, consideredChars: result.considered.length },
  })

  return {
    id,
    stringerId: stringer.id,
    status: willAssign ? 'PROCESSING' : 'PROCESSED',
    considered: result.considered.length > 0,
    note: result.note,
  }
}

export function receiveSubmissions(
  db: Db,
  inputs: SubmissionInput[],
  options: ReceiveOptions = {},
): ReceiveResult[] {
  return inputs.map((input) => receiveSubmission(db, input, options))
}
