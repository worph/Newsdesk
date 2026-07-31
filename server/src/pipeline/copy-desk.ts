import { randomUUID } from 'node:crypto'
import type { ArgsSpec } from '@newsdesk/shared'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { runStructured } from '../ports/inference/structured.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { fillPrompt, loadPrompt } from '../prompts/load.js'
import { slotsShapeHint, slotsZodSchema } from '../schema/slots.js'

/**
 * The copy desk edits the document in place, beside it, in the editor's own
 * words. It returns a reply and the FULL updated slots — never a partial patch
 * and never a tool call against the world.
 *
 * Every turn writes a version, so "undo" is the history rather than an accept
 * ceremony on each suggestion. Safety lives in the version list, which is why
 * the copy desk can be allowed to rewrite the document directly.
 *
 * See ARCHITECTURE.md section 8.
 */

/**
 * Insertion order, not timestamp order.
 *
 * A turn writes the user message and the copy desk's reply in one transaction,
 * so their `created_at` values tie to the millisecond — and the id tiebreaker
 * is a random UUID, which would render the conversation in a random order.
 * SQLite's rowid is monotonic for inserts and nothing here is ever deleted.
 */
const CHAT_ORDER = sql`rowid asc`

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

function renderHistory(turns: ChatTurn[]): string {
  if (turns.length === 0) return '(this is the first turn)'
  return turns.map((turn) => `${turn.role === 'user' ? 'Editor' : 'You'}: ${turn.content}`).join('\n\n')
}

function renderSlots(args: ArgsSpec, slots: Record<string, string>): string {
  const entries = Object.entries(args).filter(([, spec]) => typeof spec === 'object' && spec !== null && 'slot' in spec)
  return entries
    .map(([key]) => `### ${key}\n${slots[key] ?? '(empty)'}`)
    .join('\n\n')
}

export function buildCopyDeskPrompt(
  db: Db,
  publicationId: string,
  message: string,
): { prompt: string; args: ArgsSpec } {
  const publication = db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, publicationId))
    .get()
  if (!publication) throw new Error(`publication "${publicationId}" not found`)

  const story = db.select().from(schema.stories).where(eq(schema.stories.id, publication.storyId)).get()
  const outlet = db.select().from(schema.outlets).where(eq(schema.outlets.id, publication.outletId)).get()
  if (!story || !outlet) throw new Error('story or outlet missing for this publication')

  const args = JSON.parse(outlet.argsSpec) as ArgsSpec
  const slots = publication.slots ? (JSON.parse(publication.slots) as Record<string, string>) : {}

  const voice = outlet.voiceId
    ? db.select().from(schema.voices).where(eq(schema.voices.id, outlet.voiceId)).get()
    : undefined

  const history = db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.publicationId, publicationId))
    .orderBy(CHAT_ORDER)
    .all()

  const prompt = fillPrompt(loadPrompt('copy-desk'), {
    VOICE: voice
      ? [`tone: ${voice.tone}`, `audience: ${voice.audience}`, ...(voice.rules ? [voice.rules] : [])].join('\n')
      : '(no voice configured — keep the draft as it reads)',
    OUTLET: [`name: ${outlet.name}`, '', outlet.description.trim()].join('\n'),
    STORY: [`title: ${story.title}`, ...(story.url ? [`url: ${story.url}`] : []), '', story.summary].join('\n'),
    SLOTS: renderSlots(args, slots),
    HISTORY: renderHistory(history.map((h) => ({ role: h.role as ChatTurn['role'], content: h.content }))),
    MESSAGE: message,
    SLOT_SPEC: slotsShapeHint(args),
  })

  return { prompt, args }
}

export interface CopyDeskReply {
  reply: string
  slots: Record<string, string>
  versionId: string
}

export async function runCopyDesk(
  db: Db,
  driver: InferenceDriver,
  publicationId: string,
  message: string,
): Promise<CopyDeskReply> {
  const { prompt, args } = buildCopyDeskPrompt(db, publicationId, message)

  // The full draft, not a patch: anything omitted would silently be lost.
  const resultSchema = z.object({
    reply: z.string().min(1),
    slots: slotsZodSchema(args),
  })

  const shapeHint = `{\n  "reply": string,   // a sentence or two for the editor\n  "slots": ${slotsShapeHint(args)
    .split('\n')
    .join('\n  ')}\n}`

  const result = await runStructured(db, driver, {
    purpose: 'copy-desk',
    refId: publicationId,
    prompt,
    schema: resultSchema,
    shapeHint,
  })

  const versionId = randomUUID()
  const replyMessageId = randomUUID()

  db.transaction((tx) => {
    tx.insert(schema.chatMessages)
      .values({ id: randomUUID(), publicationId, role: 'user', content: message, versionId: null })
      .run()

    tx.insert(schema.draftVersions)
      .values({
        id: versionId,
        publicationId,
        slots: JSON.stringify(result.slots),
        origin: 'copy-desk',
      })
      .run()

    tx.insert(schema.chatMessages)
      .values({
        id: replyMessageId,
        publicationId,
        role: 'assistant',
        content: result.reply,
        // Linking the turn to the version it produced is what makes the
        // conversation navigable as history rather than just a log.
        versionId,
      })
      .run()

    tx.update(schema.publications)
      .set({ slots: JSON.stringify(result.slots) })
      .where(eq(schema.publications.id, publicationId))
      .run()
  })

  return { reply: result.reply, slots: result.slots, versionId }
}

export function listChat(db: Db, publicationId: string) {
  return db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.publicationId, publicationId))
    .orderBy(CHAT_ORDER)
    .all()
}
