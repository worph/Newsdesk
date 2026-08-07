import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'

/**
 * One visible conversation, rolled when it goes cold.
 *
 * The operator never holds a thread id and never manages a list: opening the
 * page shows the conversation they were in, or an empty one. The boundary
 * exists all the same, because the prompt carries a bounded history window and
 * in a single unbounded thread that window is a lie — the outlet set up three
 * weeks ago is still visibly on screen while the model can no longer see it.
 *
 * Rolling costs almost nothing precisely because the prompt regenerates the
 * configuration digest and the desk status every turn. A new thread loses the
 * *conversation*, never the desk's state.
 */

/**
 * How long a conversation may sit before the next turn starts a new one.
 *
 * A working session is a day and overnight is a real boundary, so the seam
 * lands roughly where a person would have put it anyway.
 */
export const IDLE_ROLL_MS = 8 * 60 * 60 * 1000

/** How many turns the prompt carries. Tool turns count. */
export const HISTORY_MESSAGES = 20

export interface AdminMessage {
  id: string
  /** Carried so a proposal confirmed later lands back in its own conversation. */
  threadId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName: string | null
  toolInput: unknown
  ok: boolean | null
  confirmWith: string | null
  versionId: number | null
  createdAt: string
}

export interface AppendMessage {
  threadId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolInput?: unknown
  ok?: boolean
  confirmWith?: string
  versionId?: number | null
}

function rowToMessage(row: typeof schema.adminMessages.$inferSelect): AdminMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role as AdminMessage['role'],
    content: row.content,
    toolName: row.toolName,
    toolInput: row.toolInput ?? null,
    ok: row.ok,
    confirmWith: row.confirmWith,
    versionId: row.versionId,
    createdAt: row.createdAt,
  }
}

/** The newest thread, if it is still warm enough to keep talking in. */
export function currentThread(db: Db, now: () => number = Date.now): string | undefined {
  const newest = db
    .select()
    .from(schema.adminThreads)
    .orderBy(desc(schema.adminThreads.createdAt), desc(schema.adminThreads.id))
    .limit(1)
    .get()
  if (!newest) return undefined

  const idleFor = now() - Date.parse(newest.updatedAt)
  // An unparseable timestamp reads as NaN, and NaN > IDLE_ROLL_MS is false —
  // which keeps the thread rather than silently starting a new one on every
  // turn. Losing a boundary is recoverable; losing the conversation is not.
  return idleFor > IDLE_ROLL_MS ? undefined : newest.id
}

export function startThread(db: Db): string {
  const id = randomUUID()
  db.insert(schema.adminThreads).values({ id }).run()
  return id
}

/**
 * The thread this turn belongs to, starting one when the last has gone cold.
 */
export function threadForTurn(db: Db, now: () => number = Date.now): string {
  return currentThread(db, now) ?? startThread(db)
}

export function appendMessage(db: Db, message: AppendMessage): AdminMessage {
  const id = randomUUID()
  db.insert(schema.adminMessages)
    .values({
      id,
      threadId: message.threadId,
      role: message.role,
      content: message.content,
      toolName: message.toolName ?? null,
      toolInput: message.toolInput ?? null,
      ok: message.ok ?? null,
      confirmWith: message.confirmWith ?? null,
      versionId: message.versionId ?? null,
    })
    .run()

  // The roll reads `updatedAt`, so every write has to move it or a busy
  // conversation would age out mid-sentence.
  db.update(schema.adminThreads)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.adminThreads.id, message.threadId))
    .run()

  return rowToMessage(db.select().from(schema.adminMessages).where(eq(schema.adminMessages.id, id)).get()!)
}

/** Oldest first, which is both reading order and prompt order. */
export function listMessages(db: Db, threadId: string, limit?: number): AdminMessage[] {
  const rows = db
    .select()
    .from(schema.adminMessages)
    .where(eq(schema.adminMessages.threadId, threadId))
    .orderBy(schema.adminMessages.createdAt, schema.adminMessages.id)
    .all()

  return (limit === undefined ? rows : rows.slice(-limit)).map(rowToMessage)
}

export function getMessage(db: Db, id: string): AdminMessage | undefined {
  const row = db.select().from(schema.adminMessages).where(eq(schema.adminMessages.id, id)).get()
  return row ? rowToMessage(row) : undefined
}
