import type { z } from 'zod'
import type { Db } from '../../db/index.js'
import { schema as tables } from '../../db/index.js'
import type { InferenceDriver } from './types.js'

/**
 * Getting a validated object out of a driver that cannot be handed a schema.
 *
 * The observed behaviour of `claude-code` is clean, unfenced JSON — but a
 * parser that assumes that is one model update away from breaking the desk,
 * so the extraction below is deliberately forgiving and the retry exists.
 */

/** Strip a ```json fence if the whole answer is wrapped in one. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json|JSON)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return fenced?.[1] ?? text
}

/**
 * Find the first balanced JSON value in free text, so a preamble or a trailing
 * remark does not cost us the answer. String-aware: a brace inside a string
 * literal must not change the depth.
 */
export function extractJson(text: string): string | null {
  const source = stripFence(text.trim())

  const trimmed = source.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // Fast path — the common case, and it keeps the whole value including any
    // trailing newline handling JSON.parse already does.
    try {
      JSON.parse(trimmed)
      return trimmed
    } catch {
      // Fall through to scanning: the value may be followed by prose.
    }
  }

  for (let start = 0; start < source.length; start++) {
    const opener = source[start]
    if (opener !== '{' && opener !== '[') continue
    const closer = opener === '{' ? '}' : ']'

    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < source.length; i++) {
      const char = source[i]

      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }

      if (char === '"') inString = true
      else if (char === opener) depth++
      else if (char === closer) {
        depth--
        if (depth === 0) {
          const candidate = source.slice(start, i + 1)
          try {
            JSON.parse(candidate)
            return candidate
          } catch {
            break // Not valid from this start; try the next opener.
          }
        }
      }
    }
  }

  return null
}

export class InferenceFailed extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastText?: string,
  ) {
    super(message)
    this.name = 'InferenceFailed'
  }
}

function logCall(
  db: Db,
  purpose: string,
  refId: string | undefined,
  durationMs: number,
  ok: boolean,
  error?: string,
): void {
  db.insert(tables.inferenceCalls)
    .values({
      purpose,
      refId: refId ?? null,
      durationMs,
      ok,
      error: error ?? null,
    })
    .run()
}

export interface StructuredRequest<T> {
  purpose: 'director' | 'writer' | 'assistant'
  refId?: string
  prompt: string
  /** Validates and types the result. Its failure message is fed back on retry. */
  schema: z.ZodType<T>
  /** Shown to the model so it knows the shape expected of it. */
  shapeHint: string
  timeoutMs?: number
}

const JSON_INSTRUCTION = [
  'Respond with a single JSON object and nothing else.',
  'No prose before or after it, no markdown code fence.',
].join(' ')

/**
 * Run a driver and return a validated object.
 *
 * On a parse or validation failure the request is retried exactly once, with
 * the error included so the model can correct itself. Once: a second failure
 * is a prompt or schema problem, and spending another call on it only delays
 * the error reaching the log where someone can fix it.
 */
export async function runStructured<T>(
  db: Db,
  driver: InferenceDriver,
  request: StructuredRequest<T>,
): Promise<T> {
  const base = driver.capabilities.toolCalling
    ? request.prompt
    : `${request.prompt}\n\n${JSON_INSTRUCTION}\n\nExpected shape:\n${request.shapeHint}`

  let prompt = base
  let lastText: string | undefined
  let lastError = 'no attempt ran'

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now()
    try {
      const result = await driver.run({
        prompt,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      })
      lastText = result.text

      const json = extractJson(result.text)
      if (json === null) {
        throw new Error('no JSON object found in the response')
      }

      const parsed = request.schema.safeParse(JSON.parse(json))
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }

      logCall(db, request.purpose, request.refId, Date.now() - started, true)
      return parsed.data
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      logCall(db, request.purpose, request.refId, Date.now() - started, false, lastError)

      // A transport failure is the queue's problem, not something a reworded
      // prompt can fix — let it out so the job can back off and try again.
      if (isTransport(err)) throw err

      prompt = [
        base,
        '',
        'Your previous response could not be used:',
        lastError,
        '',
        'Return only the corrected JSON object.',
      ].join('\n')
    }
  }

  throw new InferenceFailed(
    `inference did not produce a usable result after 2 attempts: ${lastError}`,
    2,
    lastText,
  )
}

function isTransport(err: unknown): boolean {
  return err instanceof Error && err.name === 'McpError'
}
