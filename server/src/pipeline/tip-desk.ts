import { z } from 'zod'
import type { Db } from '../db/index.js'
import { runStructured } from '../ports/inference/structured.js'
import type { InferenceDriver } from '../ports/inference/types.js'
import { fillPrompt, loadPrompt } from '../prompts/load.js'

/**
 * The tip line's assistant. Deliberately not the copy desk.
 *
 * The copy desk is keyed to a publication: every turn writes a draft version
 * and a chat message, and its safety model is that the history is the undo. A
 * tip has none of that — it is not a row yet, and it may never become one — so
 * this turn is stateless. The conversation lives in the browser until the tip
 * is filed, which also means an abandoned note leaves nothing behind.
 *
 * What it shares with the copy desk is the mechanism, runStructured, and that
 * is the right amount of sharing.
 */

export interface TipTurn {
  role: 'user' | 'assistant'
  content: string
}

const replySchema = z.object({
  reply: z.string().min(1),
  text: z.string().min(1),
})

export type TipDeskReply = z.output<typeof replySchema>

const SHAPE = [
  '{',
  '  "reply": string,   // a sentence or two for the editor',
  '  "text": string     // the complete updated note',
  '}',
].join('\n')

/** Cap the history carried into the prompt: a long tip session is still a note, not a document. */
const MAX_TURNS = 20

function renderHistory(turns: TipTurn[]): string {
  if (turns.length === 0) return '(this is the first turn)'
  return turns
    .slice(-MAX_TURNS)
    .map((turn) => `${turn.role === 'user' ? 'Editor' : 'You'}: ${turn.content}`)
    .join('\n\n')
}

export function buildTipDeskPrompt(input: { text: string; history: TipTurn[]; message: string }): string {
  return fillPrompt(loadPrompt('tip-desk'), {
    TEXT: input.text.trim() || '(empty so far)',
    HISTORY: renderHistory(input.history),
    MESSAGE: input.message,
  })
}

export async function runTipDesk(
  db: Db,
  driver: InferenceDriver,
  input: { text: string; history: TipTurn[]; message: string },
): Promise<TipDeskReply> {
  return runStructured(db, driver, {
    purpose: 'tip-desk',
    prompt: buildTipDeskPrompt(input),
    schema: replySchema,
    shapeHint: SHAPE,
  })
}
