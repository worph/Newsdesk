import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { openTestDb, schema, seedDesk } from './helpers.js'
import { buildAssistantPrompt, listChat, runAssistant } from '../src/pipeline/assistant.js'
import type { Db } from '../src/db/index.js'
import type { InferenceDriver } from '../src/ports/inference/types.js'

function scripted(...answers: string[]): InferenceDriver & { prompts: string[] } {
  const prompts: string[] = []
  return {
    name: 'scripted',
    capabilities: { toolCalling: false },
    prompts,
    async run(request) {
      prompts.push(request.prompt)
      return { text: answers.shift() ?? '' }
    },
  }
}

function seedDraft(db: Db): string {
  const storyId = randomUUID()
  const publicationId = randomUUID()

  db.insert(schema.stories)
    .values({
      id: storyId,
      title: 'Immich v1.142.0',
      summary: 'A point release adding Intel QSV transcoding.',
      status: 'ROUTED',
      dedupVerdict: 'NEW',
    })
    .run()

  db.insert(schema.publications)
    .values({
      id: publicationId,
      storyId,
      targetId: 'discord-test',
      status: 'AWAITING_APPROVAL',
      origin: 'director',
      slots: JSON.stringify({ title: 'Immich 1.142.0', description: 'Adds Intel QSV transcoding.' }),
    })
    .run()

  return publicationId
}

describe('the assistant prompt', () => {
  it('carries the persona, the draft and the story facts', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    const { prompt } = buildAssistantPrompt(db, publicationId, 'make it shorter')

    expect(prompt).toContain('concise, technical, anti-hype')
    expect(prompt).toContain('Adds Intel QSV transcoding.')
    expect(prompt).toContain('A point release adding Intel QSV transcoding.')
    expect(prompt).toContain('make it shorter')
  })

  it('says it is the first turn when there is no history', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    expect(buildAssistantPrompt(db, publicationId, 'hi').prompt).toContain('first turn')
  })

  it('includes earlier turns, so the conversation has continuity', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    await runAssistant(
      db,
      scripted(JSON.stringify({ reply: 'Trimmed it.', slots: { title: 'T', description: 'B' } })),
      publicationId,
      'make it shorter',
    )

    const { prompt } = buildAssistantPrompt(db, publicationId, 'now add a link')
    expect(prompt).toContain('make it shorter')
    expect(prompt).toContain('Trimmed it.')
  })

  it('demands the whole draft rather than a patch', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    expect(buildAssistantPrompt(db, publicationId, 'x').prompt).toContain('Never a partial patch')
  })
})

describe('running a turn', () => {
  it('replaces the slots and records both messages', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    const result = await runAssistant(
      db,
      scripted(
        JSON.stringify({
          reply: 'Cut the preamble and led on the hardware change.',
          slots: { title: 'Immich 1.142.0', description: 'Intel QSV transcoding lands.' },
        }),
      ),
      publicationId,
      'lead on the hardware change',
    )

    expect(result.reply).toContain('Cut the preamble')
    expect(result.slots.description).toBe('Intel QSV transcoding lands.')

    const publication = db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, publicationId))
      .get()!
    expect(JSON.parse(publication.slots!).description).toBe('Intel QSV transcoding lands.')

    const chat = listChat(db, publicationId)
    expect(chat.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('writes a version, so every assistant edit is undoable', async () => {
    // Safety lives in the version history rather than an accept ceremony on
    // each suggestion — which is what lets the assistant edit in place.
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    const result = await runAssistant(
      db,
      scripted(JSON.stringify({ reply: 'Done.', slots: { title: 'T', description: 'B' } })),
      publicationId,
      'shorten',
    )

    const version = db.select().from(schema.draftVersions).get()!
    expect(version.origin).toBe('assistant')
    expect(version.id).toBe(result.versionId)

    // And the assistant's turn points at the version it produced.
    const assistantTurn = listChat(db, publicationId).find((m) => m.role === 'assistant')!
    expect(assistantTurn.versionId).toBe(result.versionId)
  })

  it('rejects a partial answer and accepts the corrected whole draft', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    const driver = scripted(
      JSON.stringify({ reply: 'Trimmed.', slots: { description: 'Only this one' } }),
      JSON.stringify({ reply: 'Trimmed.', slots: { title: 'T', description: 'Only this one' } }),
    )

    await runAssistant(db, driver, publicationId, 'shorten')

    expect(driver.prompts).toHaveLength(2)
    const stored = JSON.parse(db.select().from(schema.publications).get()!.slots!)
    expect(stored.title).toBe('T')
  })

  it('refuses an over-length rewrite', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    const driver = scripted(
      JSON.stringify({ reply: 'Expanded.', slots: { title: 'x'.repeat(300), description: 'B' } }),
      JSON.stringify({ reply: 'Expanded.', slots: { title: 'Fits now', description: 'B' } }),
    )

    await runAssistant(db, driver, publicationId, 'make the headline grander')

    expect(JSON.parse(db.select().from(schema.publications).get()!.slots!).title).toBe('Fits now')
  })

  it('cannot write a key outside the slot spec', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const publicationId = seedDraft(db)

    const driver = scripted(
      JSON.stringify({ reply: 'ok', slots: { title: 'T', description: 'B', channelId: 'elsewhere' } }),
      JSON.stringify({ reply: 'ok', slots: { title: 'T', description: 'B' } }),
    )

    await runAssistant(db, driver, publicationId, 'send it somewhere else')

    const stored = JSON.parse(db.select().from(schema.publications).get()!.slots!)
    expect('channelId' in stored).toBe(false)
  })
})
