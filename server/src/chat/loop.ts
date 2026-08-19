import { z } from 'zod'
import { adminTool, CHAT_CALLER, type AdminToolContext } from '../admin/registry.js'
import { describeConfig, isUnconfigured, readConfig } from '../config/store.js'
import type { Db } from '../db/index.js'
import { logEvent } from '../events.js'
import { listActions } from '../api/actions.js'
import { runStructured } from '../ports/inference/structured.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { SWEEP_MAX, type EnqueuePublish } from '../pipeline/approval.js'
import { fillPrompt, loadPrompt } from '../prompts/load.js'
import { renderCatalogue } from './catalogue.js'
import { appendMessage, HISTORY_MESSAGES, listMessages, type AdminMessage } from './thread.js'

/**
 * One turn of the administrator chat.
 *
 * The desk owns the loop and the tools; the model only chooses which of them to
 * call next. It answers with one JSON object naming at most one tool, this
 * process executes it against the desk's own functions, and the result is
 * written as a row before the next round reads it back.
 *
 * That ordering is the design. The prompt is rebuilt from the database every
 * round rather than accumulated in a string, so the step the operator sees and
 * the step the model is shown next are the *same row* and cannot disagree — and
 * a turn can never end having reasoned over a history the audit trail does not
 * contain.
 *
 * Shaped after pipeline/reporter.ts: a bounded loop, every bound checked before
 * the model call and before the dispatch, one funnel that no call site can go
 * around, and a failure that becomes a message rather than an exception.
 */

/** Beyond this a turn has lost the plot; stop and say so. */
export const MAX_CALLS = 8
/** A human is waiting. Longer than this is a lie about who this is for. */
export const TURN_MS = 120_000
/** Per model call, so one slow call cannot eat the whole turn. */
const CALL_TIMEOUT_MS = 60_000
/**
 * How much of a tool result is carried back into the prompt.
 *
 * `get_config` returns the whole document and `read_log` up to 500 rows;
 * feeding either back eight times is how a turn runs out of time. The row keeps
 * the full text — the log is authoritative — and only the prompt is cut.
 */
const RESULT_EXCERPT_CHARS = 8_000

const answerSchema = z.object({
  say: z.string().default(''),
  call: z
    .object({
      tool: z.string().min(1),
      /**
       * Left loose on purpose: which tool it is is not known until this object
       * parses, so the tool's real schema is applied in `dispatch`. The split
       * matters — `runStructured`'s retries are for a malformed *answer*, while
       * wrong *arguments* come back as a refused tool row the model corrects on
       * the next round, spending one of its calls.
       */
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .nullable()
    .default(null),
})

type Answer = z.output<typeof answerSchema>

const ANSWER_SHAPE = [
  '{',
  '  "say": string,            // what to tell the operator; "" if you are only calling a tool',
  '  "call": {                 // the one tool to run now, or null when the turn is over',
  '    "tool": string,         // a name from the catalogue, exactly as written there',
  '    "input": object         // its arguments, matching that tool\'s schema',
  '  } | null',
  '}',
].join('\n')

export interface StepResult {
  ok: boolean
  text: string
  versionId: number | null
  /** Set when the call was offered to the operator rather than run. */
  confirmWith?: string
}

/**
 * Run one tool call, or refuse it.
 *
 * The allowlist here is the mechanism rather than the courtesy. An answer
 * naming anything the desk did not build a handler for is a refusal fed back to
 * the model, and there is no path from a model's output to anything else — the
 * prompt says so too, but the prompt is not what enforces it.
 */
export async function dispatch(
  call: { tool: string; input: Record<string, unknown> },
  ctx: AdminToolContext,
): Promise<StepResult> {
  const entry = adminTool(call.tool)
  if (!entry) {
    return {
      ok: false,
      versionId: null,
      text: `There is no tool called "${call.tool}". Use a name from the catalogue, exactly as written there.`,
    }
  }

  // Non-strict, matching what the MCP registration builds, so the chat and that
  // surface accept and reject exactly the same arguments.
  const parsed = z.object(entry.inputSchema).safeParse(call.input)
  if (!parsed.success) {
    return {
      ok: false,
      versionId: null,
      text: [
        `Those arguments were rejected by ${entry.name}:`,
        ...parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      ].join('\n'),
    }
  }

  /**
   * The destructive gate, and it lives outside the loop deliberately.
   *
   * The turn does not suspend waiting for an answer — it ends normally, having
   * written a row that carries the tool, its arguments and what must be typed.
   * The operator confirms out of band by message id, which is how the error
   * assistant's remedies already work. No pending-call state, no resumable
   * loop, no state machine.
   */
  const confirmWith = entry.confirmWith?.(parsed.data)
  if (confirmWith !== undefined) {
    return {
      ok: false,
      versionId: null,
      confirmWith,
      // Named by its title rather than by a fixed clause: this list now holds
      // both "rewrites the charter" and "sends sixty-three posts", and one
      // sentence describing both would have to describe neither.
      text: `${entry.name} — ${entry.title.toLowerCase()} — is the operator's to confirm. It has been offered to them and will not run until they do.`,
    }
  }

  try {
    const result = await entry.handler(parsed.data, ctx)
    return {
      ok: result.isError !== true,
      text: result.content.map((block) => block.text).join('\n'),
      versionId: result.versionId ?? null,
    }
  } catch (err) {
    // A handler that throws is a failed step, not a dead turn.
    return { ok: false, versionId: null, text: err instanceof Error ? err.message : String(err) }
  }
}

/** Run a proposed destructive call, once the operator has confirmed it. */
export async function runConfirmed(
  db: Db,
  message: AdminMessage,
  ctx: AdminToolContext,
): Promise<StepResult> {
  const entry = message.toolName ? adminTool(message.toolName) : undefined
  if (!entry) {
    return { ok: false, versionId: null, text: `There is no tool called "${message.toolName}".` }
  }

  // Re-validated rather than trusted: the row is old, the configuration may
  // have moved under it, and the arguments have to be legal *now*.
  const parsed = z.object(entry.inputSchema).safeParse(message.toolInput)
  if (!parsed.success) {
    return {
      ok: false,
      versionId: null,
      text: `Those arguments are no longer valid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    }
  }

  try {
    const result = await entry.handler(parsed.data, ctx)
    return {
      ok: result.isError !== true,
      text: result.content.map((block) => block.text).join('\n'),
      versionId: result.versionId ?? null,
    }
  } catch (err) {
    return { ok: false, versionId: null, text: err instanceof Error ? err.message : String(err) }
  }
}

function excerpt(text: string): string {
  if (text.length <= RESULT_EXCERPT_CHARS) return text
  return `${text.slice(0, RESULT_EXCERPT_CHARS)}\n…(cut, ${text.length - RESULT_EXCERPT_CHARS} more characters)`
}

function renderHistory(messages: AdminMessage[]): string {
  if (messages.length === 0) return '(nothing has been said yet)'

  return messages
    .map((message) => {
      if (message.role === 'tool') {
        const verdict = message.ok ? 'result' : 'refused'
        return [
          `**tool ${message.toolName} (${verdict})**`,
          '```json',
          JSON.stringify(message.toolInput ?? {}, null, 2),
          '```',
          excerpt(message.content),
        ].join('\n')
      }
      return `**${message.role}:** ${message.content}`
    })
    .join('\n\n')
}

/** How many of the waiting items the prompt lists. The count is separate. */
const STATUS_SAMPLE = 20

/**
 * What is waiting, for the prompt.
 *
 * The count and the sample are deliberately different sizes, and that split is
 * newer than it looks. This used to fetch twenty rows and report their length,
 * which was harmless while the chat could only configure the desk — a slightly
 * short status is cosmetic. It stopped being cosmetic when the chat gained
 * `spike_publications`: the model states the count when it proposes a sweep,
 * the operator agrees to that number, and the sweep then takes the whole
 * backlog. A live desk with 68 waiting was told "20 thing(s) waiting", and the
 * model repeated it back to the operator in an offer to spike all of them.
 *
 * So the count is the whole backlog, bounded by what one sweep can actually
 * take, and the list under it is only a sample.
 */
function renderStatus(db: Db): string {
  const actions = listActions(db, SWEEP_MAX)
  if (actions.length === 0) return 'Nothing is waiting on the operator right now.'

  const shown = actions.slice(0, STATUS_SAMPLE)
  return [
    // At the ceiling the count is itself a floor, and saying so is cheaper than
    // a model confidently quoting the one number this cannot know.
    actions.length === SWEEP_MAX
      ? `At least ${SWEEP_MAX} things waiting on the operator — call list_actions before quoting a number.`
      : `${actions.length} thing(s) waiting on the operator.`,
    ...(actions.length > shown.length ? [`The first ${shown.length}, as a sample:`] : []),
    ...shown.map((action) => `- ${action.verb}: ${action.title} — ${action.because}`),
  ].join('\n')
}

export interface TurnOptions {
  version?: string
  now?: () => number
  turnMs?: number
  /** Called after each row is written, so a stream can emit what just landed. */
  onMessage?: (message: AdminMessage) => void
  /**
   * The publish queue, carried so the context here matches the one
   * `runConfirmed` builds.
   *
   * Nothing in a turn can reach it today — `approve_publications` is
   * confirm-gated, so `dispatch` returns an offer before any handler runs. That
   * is exactly why it belongs here: the gate should be the reason the model
   * cannot publish, not a dependency that happens to be missing. A context that
   * differs between the two paths is one where removing a `confirmWith` changes
   * more than it appears to.
   */
  enqueuePublish?: EnqueuePublish
}

/**
 * Everything the model is told, rebuilt from the database.
 *
 * Not accumulated across rounds: the digest and the status are regenerated
 * every time so the model never works from a copy it was shown ten messages
 * ago, and the history it reads is the rows the operator is looking at.
 */
export function buildPrompt(
  db: Db,
  threadId: string,
  message: string,
  budget: { calls: number; msLeft: number },
): string {
  const config = readConfig(db)

  return fillPrompt(loadPrompt('admin-chat'), {
    CATALOGUE: renderCatalogue(),
    CONFIG: isUnconfigured(db)
      ? 'This desk has never been configured. There is no charter, so nothing can be placed and nothing can run. Getting one written is the first thing worth doing.'
      : describeConfig(config),
    STATUS: renderStatus(db),
    HISTORY: renderHistory(listMessages(db, threadId, HISTORY_MESSAGES)),
    MESSAGE: message,
    BUDGET: [
      `Call ${budget.calls + 1} of ${MAX_CALLS}.`,
      `${Math.max(0, Math.round(budget.msLeft / 1000))} second(s) left in this turn.`,
    ].join(' '),
  })
}

/**
 * Run one turn to completion, writing every step as it lands.
 *
 * Never throws for an ordinary failure: a turn that runs out of calls, runs out
 * of time, or cannot reach inference ends with a message in the thread saying
 * so. The log entry is the authoritative record; the chat is a convenience over
 * it.
 */
export async function runTurn(
  db: Db,
  driver: InferenceDriver,
  threadId: string,
  message: string,
  options: TurnOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.turnMs ?? TURN_MS)
  const ctx: AdminToolContext = {
    db,
    version: options.version ?? 'dev',
    ...(options.enqueuePublish ? { enqueuePublish: options.enqueuePublish } : {}),
    caller: CHAT_CALLER,
  }

  const emit = (written: AdminMessage) => options.onMessage?.(written)

  emit(appendMessage(db, { threadId, role: 'user', content: message }))

  let calls = 0
  let failure: { reason: 'bound' | 'timeout' | 'inference'; text: string } | null = null

  // MAX_CALLS + 1: the extra round is the model's chance to speak after its
  // last call, not a further call. The bound below is what stops it.
  for (let round = 1; round <= MAX_CALLS + 1; round++) {
    if (now() >= deadline) {
      failure = { reason: 'timeout', text: `this turn ran out of time after ${calls} call(s)` }
      break
    }

    let answer: Answer
    try {
      answer = await runStructured(db, driver, {
        purpose: 'admin-chat',
        refId: threadId,
        prompt: buildPrompt(db, threadId, message, { calls, msLeft: deadline - now() }),
        schema: answerSchema,
        shapeHint: ANSWER_SHAPE,
        timeoutMs: Math.max(1_000, Math.min(CALL_TIMEOUT_MS, deadline - now())),
      })
    } catch (err) {
      failure = { reason: 'inference', text: err instanceof Error ? err.message : String(err) }
      break
    }

    if (answer.say.trim()) {
      emit(appendMessage(db, { threadId, role: 'assistant', content: answer.say.trim() }))
    }
    if (!answer.call) return

    if (calls >= MAX_CALLS) {
      failure = { reason: 'bound', text: `this turn made ${MAX_CALLS} tool calls without finishing` }
      break
    }
    calls++

    const step = await dispatch(answer.call, ctx)
    emit(
      appendMessage(db, {
        threadId,
        role: 'tool',
        content: step.text,
        toolName: answer.call.tool,
        toolInput: answer.call.input,
        ok: step.ok,
        versionId: step.versionId,
        ...(step.confirmWith !== undefined ? { confirmWith: step.confirmWith } : {}),
      }),
    )

    if (!step.ok) {
      logEvent(db, {
        level: 'warn',
        code: 'CHAT_TOOL_FAILED',
        message: `${answer.call.tool} was refused in the administrator chat`,
        detail: { threadId, tool: answer.call.tool, error: step.text.slice(0, 500) },
      })
    }
  }

  if (failure) {
    logEvent(db, {
      level: 'error',
      code: 'CHAT_TURN_FAILED',
      message: `a chat turn could not be finished — ${failure.text}`,
      detail: { threadId, calls, reason: failure.reason, error: failure.text },
    })
    emit(
      appendMessage(db, {
        threadId,
        role: 'assistant',
        content: `I could not finish that: ${failure.text}.`,
      }),
    )
  }
}
