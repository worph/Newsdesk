import { randomUUID } from 'node:crypto'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { logEvent } from '../events.js'

/**
 * A database-backed queue with a single worker.
 *
 * The app owns its clock — n8n does not orchestrate it — and queue state lives
 * in rows so a restart resumes cleanly rather than losing whatever was in
 * flight. This replaces the old pipeline's staggered cron and its
 * error-reclassification code: a busy upstream is now just a job that waits.
 *
 * See ARCHITECTURE.md invariant 9 and IMPLEMENTATION.md section 5.2.
 */

export type JobKind = 'report' | 'assign' | 'write' | 'publish' | 'handover-followup'

export interface JobRow {
  id: string
  kind: string
  refId: string
  attempts: number
}

export type JobHandler = (db: Db, refId: string, job: JobRow) => Promise<void>

/**
 * A handler may throw this to say "not now, but not broken either" — the job
 * waits without burning an attempt against its retry ceiling.
 */
export class Deferred extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message)
    this.name = 'Deferred'
  }
}

export interface QueueOptions {
  /**
   * Concurrency stays at 1 by default. The single-session constraint that
   * originally forced it is gone — the Beacon now runs queries in parallel —
   * but one worker also gives deterministic ordering and keeps the desk's
   * write path free of contention, which is worth more than throughput at
   * this volume.
   */
  concurrency?: number
  /** Attempts before a job is parked as FAILED for a human to look at. */
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  pollIntervalMs?: number
  /** Injectable so tests do not sleep in real time. */
  now?: () => number
  random?: () => number
}

const DEFAULTS = {
  concurrency: 1,
  maxAttempts: 6,
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
  pollIntervalMs: 2_000,
} as const

/**
 * Exponential backoff with full jitter. Jitter matters even with one worker:
 * several jobs failing against the same dead upstream would otherwise wake in
 * lockstep and hammer it the moment it came back.
 */
export function backoffMs(
  attempts: number,
  options: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number } = {},
): number {
  const base = options.baseDelayMs ?? DEFAULTS.baseDelayMs
  const max = options.maxDelayMs ?? DEFAULTS.maxDelayMs
  const random = options.random ?? Math.random
  const ceiling = Math.min(base * 2 ** Math.max(0, attempts - 1), max)
  return Math.floor(ceiling * (0.5 + random() * 0.5))
}

export function enqueue(db: Db, kind: JobKind, refId: string, runAfter?: Date): string {
  const id = randomUUID()
  db.insert(schema.jobs)
    .values({
      id,
      kind,
      refId,
      status: 'PENDING',
      attempts: 0,
      runAfter: (runAfter ?? new Date()).toISOString(),
    })
    .run()
  return id
}

/**
 * A job left RUNNING can only be one this process was working on when it died
 * — nothing else can claim it, because there is exactly one instance. Return
 * them to the queue on boot so work resumes rather than being stranded.
 */
export function reclaimRunning(db: Db): number {
  const stranded = db.select().from(schema.jobs).where(eq(schema.jobs.status, 'RUNNING')).all()
  if (stranded.length === 0) return 0

  db.update(schema.jobs)
    .set({ status: 'PENDING', runAfter: new Date().toISOString() })
    .where(eq(schema.jobs.status, 'RUNNING'))
    .run()

  logEvent(db, {
    level: 'warn',
    code: 'JOBS_RECLAIMED',
    message: `returned ${stranded.length} interrupted job(s) to the queue`,
    detail: { ids: stranded.map((j) => j.id) },
  })
  return stranded.length
}

/** Claim the next due job, atomically enough for a single-instance app. */
export function claimNext(db: Db, now: Date): JobRow | undefined {
  return db.transaction((tx) => {
    const next = tx
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, 'PENDING'), lte(schema.jobs.runAfter, now.toISOString())))
      .orderBy(asc(schema.jobs.runAfter), asc(schema.jobs.createdAt))
      .limit(1)
      .get()

    if (!next) return undefined

    tx.update(schema.jobs)
      .set({ status: 'RUNNING', attempts: next.attempts + 1 })
      .where(eq(schema.jobs.id, next.id))
      .run()

    return { id: next.id, kind: next.kind, refId: next.refId, attempts: next.attempts + 1 }
  })
}

export interface RunOutcome {
  status: 'DONE' | 'RETRY' | 'FAILED' | 'DEFERRED'
  error?: string
  retryInMs?: number
}

function isRetryable(err: unknown): boolean {
  // McpError carries the classification; anything else is assumed permanent so
  // a genuine bug surfaces instead of looping.
  return err instanceof Error && err.name === 'McpError' && (err as { retryable?: boolean }).retryable === true
}

export class JobQueue {
  private readonly options: Required<Omit<QueueOptions, 'now' | 'random'>> & {
    now: () => number
    random: () => number
  }
  private readonly handlers = new Map<string, JobHandler>()
  private running = false
  private timer: NodeJS.Timeout | undefined
  private active = 0
  /** Resolves when the current in-flight work settles; used by tests and shutdown. */
  private idle: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: Db,
    options: QueueOptions = {},
  ) {
    this.options = {
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    }
  }

  register(kind: JobKind, handler: JobHandler): this {
    this.handlers.set(kind, handler)
    return this
  }

  start(): void {
    if (this.running) return
    this.running = true
    reclaimRunning(this.db)
    this.timer = setInterval(() => {
      void this.tick()
    }, this.options.pollIntervalMs)
    // Unref so the queue's own timer never keeps the process alive.
    this.timer.unref?.()
    void this.tick()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.idle
  }

  /** Drain everything currently due. Returns how many jobs ran. */
  async tick(): Promise<number> {
    let ran = 0
    while (this.active < this.options.concurrency) {
      const job = claimNext(this.db, new Date(this.options.now()))
      if (!job) break

      this.active++
      const work = this.execute(job).finally(() => {
        this.active--
      })
      this.idle = this.idle.then(() => work).catch(() => undefined)
      await work
      ran++
    }
    return ran
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.kind)

    if (!handler) {
      this.fail(job, `no handler registered for job kind "${job.kind}"`)
      return
    }

    try {
      await handler(this.db, job.refId, job)
      this.db.update(schema.jobs).set({ status: 'DONE', lastError: null }).where(eq(schema.jobs.id, job.id)).run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (err instanceof Deferred) {
        // Not a failure: give the attempt back so waiting cannot exhaust the
        // retry ceiling.
        this.db
          .update(schema.jobs)
          .set({
            status: 'PENDING',
            attempts: Math.max(0, job.attempts - 1),
            runAfter: new Date(this.options.now() + err.retryAfterMs).toISOString(),
            lastError: message,
          })
          .where(eq(schema.jobs.id, job.id))
          .run()

        // Debug, not warn: waiting on purpose is the system working. It is
        // logged at all because "not now" and "nothing happened" are otherwise
        // the same silence from outside.
        logEvent(this.db, {
          level: 'debug',
          code: 'JOB_DEFERRED',
          message: `a ${job.kind} job is waiting its turn`,
          detail: {
            jobId: job.id,
            kind: job.kind,
            refId: job.refId,
            retryInSeconds: Math.round(err.retryAfterMs / 1000),
            reason: message,
          },
        })
        return
      }

      const canRetry = isRetryable(err) && job.attempts < this.options.maxAttempts
      if (!canRetry) {
        this.fail(job, message)
        return
      }

      const delay = backoffMs(job.attempts, this.options)
      this.db
        .update(schema.jobs)
        .set({
          status: 'PENDING',
          runAfter: new Date(this.options.now() + delay).toISOString(),
          lastError: message,
        })
        .where(eq(schema.jobs.id, job.id))
        .run()

      logEvent(this.db, {
        level: 'warn',
        code: 'JOB_RETRY',
        message: `a ${job.kind} job did not go through and will try again in ${Math.round(delay / 1000)}s`,
        detail: {
          jobId: job.id,
          kind: job.kind,
          refId: job.refId,
          attempts: job.attempts,
          retryInSeconds: Math.round(delay / 1000),
          error: message,
        },
      })
    }
  }

  private fail(job: JobRow, message: string): void {
    this.db
      .update(schema.jobs)
      .set({ status: 'FAILED', lastError: message })
      .where(eq(schema.jobs.id, job.id))
      .run()

    logEvent(this.db, {
      level: 'error',
      code: 'JOB_FAILED',
      message: `a ${job.kind} job gave up after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}`,
      detail: { jobId: job.id, kind: job.kind, refId: job.refId, attempts: job.attempts, error: message },
    })
  }
}

export interface QueueStats {
  pending: number
  running: number
  done: number
  failed: number
}

export function queueStats(db: Db): QueueStats {
  const rows = db
    .select({ status: schema.jobs.status, count: sql<number>`count(*)` })
    .from(schema.jobs)
    .groupBy(schema.jobs.status)
    .all()

  const stats: QueueStats = { pending: 0, running: 0, done: 0, failed: 0 }
  for (const row of rows) {
    const key = row.status.toLowerCase() as keyof QueueStats
    if (key in stats) stats[key] = Number(row.count)
  }
  return stats
}
