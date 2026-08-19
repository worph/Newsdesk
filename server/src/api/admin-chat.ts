import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CHAT_CALLER, type AdminToolContext } from '../admin/registry.js'
import { requireSession } from '../auth.js'
import { runConfirmed, runTurn } from '../chat/loop.js'
import { deskStatus, inferenceState, renderStatusReport } from '../chat/status.js'
import {
  appendMessage,
  currentThread,
  getMessage,
  listMessages,
  startThread,
  threadForTurn,
  type AdminMessage,
} from '../chat/thread.js'
import type { Db } from '../db/index.js'
import type { EnqueuePublish } from '../pipeline/approval.js'
import type { InferenceDriver } from '../ports/inference/types.js'

/**
 * The administrator chat.
 *
 * See docs/admin-chat.md. The loop and the tools live elsewhere; this file is
 * the surface a browser at the desk talks to.
 */

export interface AdminChatOptions {
  /** A factory, called per use — the endpoint is a row that can be repointed. */
  driver?: () => InferenceDriver
  /** Overridden in tests so the suite does not wait on real network timeouts. */
  probeTimeoutMs?: number
  /**
   * The queue `approve_publications` hands frozen payloads to. Absent means no
   * publisher is wired and that tool refuses — see `admin/registry.ts`.
   */
  enqueuePublish?: EnqueuePublish
}

/**
 * The turns in flight, by thread.
 *
 * In memory, and that is sound for the same reason the assistant's
 * double-submit guard is: one desk, one process (invariant 9). It exists to
 * refuse a second turn on a conversation that is already thinking, not to
 * survive a restart — a turn interrupted by one genuinely is not running, and
 * the rows it wrote before dying are still the audit trail.
 */
const inFlight = new Set<string>()

/** Server-sent events, written straight to the socket after `reply.hijack()`. */
function sse(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const messageBody = z.object({ message: z.string().min(1).max(8_000) })
const confirmBody = z.object({ messageId: z.string().min(1), confirm: z.string() })
const commandBody = z.object({ command: z.string().min(1).max(64) })

/** What a roll answers when the conversation it would put away is mid-turn. */
const STILL_THINKING = 'this conversation is still thinking — wait for it to finish'

export function registerAdminChatRoutes(
  app: FastifyInstance,
  db: Db,
  version: string,
  options: AdminChatOptions = {},
): void {
  const contextFor = (): AdminToolContext => ({
    db,
    version,
    ...(options.enqueuePublish ? { enqueuePublish: options.enqueuePublish } : {}),
    caller: CHAT_CALLER,
  })
  const statusOptions = () => ({
    ...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
    ...(options.driver ? { driver: options.driver } : {}),
  })

  /**
   * The Start routine, as JSON.
   *
   * A route of its own so a screen can render before any conversation exists
   * and while inference is down — which is precisely when it is worth reading.
   */
  app.post('/api/v1/admin-chat/status', { preHandler: requireSession }, async () =>
    deskStatus(db, version, statusOptions()),
  )

  /**
   * The conversation, as it stands.
   *
   * The reconnect path, and the reason the stream below can be as simple as it
   * is: a dropped connection, a reload, a phone that slept — all recover here,
   * because every step was a row before it was ever an event.
   */
  app.get('/api/v1/admin-chat', { preHandler: requireSession }, async () => {
    const threadId = currentThread(db)
    return {
      threadId: threadId ?? null,
      messages: threadId ? listMessages(db, threadId) : [],
      running: threadId ? inFlight.has(threadId) : false,
      inference: inferenceState(options.driver),
    }
  })

  /**
   * Put the visible conversation away and start a fresh one.
   *
   * The old thread is kept, not deleted: it records *why* a change was made,
   * which the configuration version it points at cannot.
   *
   * Shared by `/new` and the DELETE below, because "start a fresh one" has to
   * mean the same thing however it was asked for — including the refusal while
   * a turn is still writing rows into the thread being put away. `undefined` is
   * that refusal; the caller owns the status code, and `STILL_THINKING` is the
   * wording both doors give for it.
   */
  function roll(): { threadId: string; messages: AdminMessage[] } | undefined {
    const threadId = currentThread(db)
    if (threadId && inFlight.has(threadId)) return undefined
    return { threadId: startThread(db), messages: [] }
  }

  /**
   * A command the desk answers itself, without asking anyone.
   *
   * `/status` is the one that matters: it runs no inference, so it still works
   * when the administrator cannot — which is the moment someone most wants to
   * know what is wrong. It becomes a pair of ordinary rows, so the answer sits
   * in the conversation and in the audit trail like everything else.
   */
  app.post('/api/v1/admin-chat/command', { preHandler: requireSession }, async (request, reply) => {
    const parsed = commandBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'a command is required' })

    const command = parsed.data.command.trim().toLowerCase()

    /**
     * `/new` is the one command that answers by replacing the conversation
     * rather than by adding to it — the roll of §8.1, asked for by hand
     * instead of waiting eight hours for it.
     *
     * It comes back shaped like the DELETE it shares, so a client can tell
     * "the desk said something" from "the desk started over" by the `threadId`
     * that only the second one carries.
     */
    if (command === '/new') {
      const rolled = roll()
      if (!rolled) {
        return reply.code(409).send({ error: STILL_THINKING })
      }
      return rolled
    }

    if (command !== '/status') {
      return reply.code(400).send({ error: `there is no ${command} command — try /status or /new` })
    }

    const threadId = threadForTurn(db)
    const asked = appendMessage(db, { threadId, role: 'user', content: command })
    const answered = appendMessage(db, {
      threadId,
      role: 'assistant',
      content: renderStatusReport(await deskStatus(db, version, statusOptions())),
    })

    return { messages: [asked, answered] }
  })

  /**
   * Say something, and watch the turn happen.
   *
   * The turn runs detached rather than tied to this request, so closing the tab
   * does not abandon a half-finished sequence of configuration writes. The
   * stream is a view of rows that are written either way — every event here
   * corresponds to a row that is already committed, which is what stops the
   * screen showing a step the log does not have.
   */
  app.post('/api/v1/admin-chat/messages', { preHandler: requireSession }, async (request, reply) => {
    const parsed = messageBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'a message is required' })

    const state = inferenceState(options.driver)
    if (!state.available) return reply.code(503).send({ error: state.reason })

    let driver: InferenceDriver
    try {
      driver = options.driver!()
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) })
    }

    const threadId = threadForTurn(db)
    if (inFlight.has(threadId)) {
      return reply.code(409).send({ error: 'this conversation is already thinking — wait for it to finish' })
    }
    inFlight.add(threadId)

    // Fastify must be told the response is no longer its to send, before
    // anything is written to the raw socket.
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would hold every step until the turn ended, which
      // is precisely the thing this endpoint exists to avoid.
      'x-accel-buffering': 'no',
    })
    sse(reply.raw, 'open', { threadId })

    // A step can be a minute apart and idle timeouts sit between the desk and
    // the browser, so the connection has to say something in between.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
    let open = true
    reply.raw.on('close', () => {
      // The listener goes; the turn does not. It is still writing rows, and the
      // GET above is how a returning browser catches up.
      open = false
      clearInterval(heartbeat)
    })

    try {
      await runTurn(db, driver, threadId, parsed.data.message, {
        version,
        ...(options.enqueuePublish ? { enqueuePublish: options.enqueuePublish } : {}),
        onMessage: (message) => {
          if (open) sse(reply.raw, 'message', message)
        },
      })
      if (open) sse(reply.raw, 'done', { threadId })
    } catch (err) {
      // runTurn writes its own failures as messages; reaching here means
      // something outside the loop broke, and the socket is the only place
      // left to say so.
      if (open) sse(reply.raw, 'error', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      inFlight.delete(threadId)
      clearInterval(heartbeat)
      if (open) reply.raw.end()
    }
    return reply
  })

  /**
   * Run a call the chat proposed but would not make.
   *
   * The id of the message, never its contents: the row carries the tool and the
   * arguments, and `runConfirmed` re-validates them against the registry before
   * anything happens. What the browser sends is agreement, not a payload.
   */
  app.post('/api/v1/admin-chat/confirm', { preHandler: requireSession }, async (request, reply) => {
    const parsed = confirmBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'a message id and a confirmation are required' })

    const proposal = getMessage(db, parsed.data.messageId)
    if (!proposal || proposal.role !== 'tool' || !proposal.confirmWith) {
      return reply.code(404).send({ error: 'there is no proposal with that id' })
    }
    if (parsed.data.confirm !== proposal.confirmWith) {
      return reply.code(422).send({ error: `type "${proposal.confirmWith}" to confirm this` })
    }

    const result = await runConfirmed(db, proposal, contextFor())
    const written: AdminMessage = appendMessage(db, {
      threadId: proposal.threadId,
      role: 'tool',
      content: result.text,
      toolName: proposal.toolName ?? 'unknown',
      toolInput: proposal.toolInput,
      ok: result.ok,
      versionId: result.versionId,
    })

    return { ok: result.ok, message: written }
  })

  /** The `/new` command by another door, for the button that predates it. */
  app.delete('/api/v1/admin-chat', { preHandler: requireSession }, async (_request, reply) => {
    const rolled = roll()
    if (!rolled) {
      return reply.code(409).send({ error: STILL_THINKING })
    }
    return rolled
  })
}
