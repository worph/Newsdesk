import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.js'
import { schema } from '../../db/index.js'
import { logEvent } from '../../events.js'
import { trim } from './trim.js'

/**
 * A submission is free text filed by a source, at whatever depth that source
 * works in. It is explicitly NOT a normalized news item and carries no
 * required identifier — there is nothing to key on, and deduplication is the
 * director's judgement rather than a constraint.
 */
export const submissionInputSchema = z.object({
  source_id: z.string().min(1),
  kind: z.enum(['report', 'timeline', 'snapshot', 'idea']).optional(),
  text: z.string().min(1, 'a submission needs text'),
  refs: z.record(z.string(), z.unknown()).optional(),
  filed_at: z.string().optional(),
})

export const submissionsBodySchema = z.union([
  submissionInputSchema,
  z.array(submissionInputSchema).min(1),
])

export type SubmissionInput = z.infer<typeof submissionInputSchema>

export interface ReceiveResult {
  id: string | null
  sourceId: string
  status: 'RECEIVED' | 'PROCESSED' | 'REJECTED'
  considered: boolean
  note: string
}

/**
 * Store a filed report and work out what part of it is new. Stringers keep no
 * state of their own: re-filing an overlapping window is expected and safe,
 * which is what lets them stay dumb.
 */
export function receiveSubmission(db: Db, input: SubmissionInput): ReceiveResult {
  const source = db.select().from(schema.sources).where(eq(schema.sources.id, input.source_id)).get()

  if (!source) {
    return {
      id: null,
      sourceId: input.source_id,
      status: 'REJECTED',
      considered: false,
      note: `unknown source "${input.source_id}" — add it in Configuration first`,
    }
  }

  const kind = input.kind ?? source.kind
  const id = randomUUID()

  // A disabled source is stored rather than refused: losing a filed report is
  // worse than storing one nobody asked for, and the Inbox shows why it slept.
  if (!source.enabled) {
    db.insert(schema.submissions)
      .values({
        id,
        sourceId: source.id,
        kind,
        text: input.text,
        considered: null,
        refs: input.refs ? JSON.stringify(input.refs) : null,
        filedAt: input.filed_at ?? null,
        status: 'PROCESSED',
        outcome: 'source disabled — stored but not processed',
      })
      .run()
    logEvent(db, {
      level: 'warn',
      code: 'SUBMISSION_SOURCE_DISABLED',
      message: `filed to disabled source "${source.id}"`,
    })
    return {
      id,
      sourceId: source.id,
      status: 'PROCESSED',
      considered: false,
      note: 'source disabled — stored but not processed',
    }
  }

  const result = trim({
    kind,
    text: input.text,
    watermark: source.watermark,
    lastSnapshot: source.lastSnapshot,
  })

  db.transaction((tx) => {
    tx.insert(schema.submissions)
      .values({
        id,
        sourceId: source.id,
        kind,
        text: input.text,
        considered: result.considered || null,
        refs: input.refs ? JSON.stringify(input.refs) : null,
        filedAt: input.filed_at ?? null,
        // Nothing new is a finished submission, not a pending one. Phase 2
        // moves the "something new" case to PROCESSING and enqueues the
        // director.
        status: 'PROCESSED',
        outcome: result.note,
      })
      .run()

    if (result.watermark !== undefined || result.snapshot !== undefined) {
      tx.update(schema.sources)
        .set({
          ...(result.watermark !== undefined ? { watermark: result.watermark } : {}),
          ...(result.snapshot !== undefined ? { lastSnapshot: result.snapshot } : {}),
        })
        .where(eq(schema.sources.id, source.id))
        .run()
    }
  })

  logEvent(db, {
    level: 'info',
    code: 'SUBMISSION_RECEIVED',
    message: `${source.id}: ${result.note}`,
    detail: { submissionId: id, kind, consideredChars: result.considered.length },
  })

  return {
    id,
    sourceId: source.id,
    status: 'PROCESSED',
    considered: result.considered.length > 0,
    note: result.note,
  }
}

export function receiveSubmissions(db: Db, inputs: SubmissionInput[]): ReceiveResult[] {
  return inputs.map((input) => receiveSubmission(db, input))
}
