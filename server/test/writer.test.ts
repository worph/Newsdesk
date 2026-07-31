import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { openTestDb, schema, seedDesk } from './helpers.js'
import { buildDraftContext, draftPublication } from '../src/pipeline/writer.js'
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

interface Seeded {
  publicationId: string
  storyId: string
}

function seedPlacedStory(db: Db, over: { angle?: string; verdict?: string; relatedId?: string } = {}): Seeded {
  const storyId = randomUUID()
  const filingId = randomUUID()
  const publicationId = randomUUID()

  db.insert(schema.filings)
    .values({
      id: filingId,
      stringerId: 'korben',
      kind: 'report',
      text: 'Immich 1.142.0 out. Adds Intel QSV transcoding.',
      considered: 'Immich 1.142.0 out. Adds Intel QSV transcoding.',
      status: 'PROCESSED',
    })
    .run()

  db.insert(schema.stories)
    .values({
      id: storyId,
      title: 'Immich v1.142.0',
      summary: 'A point release adding Intel QSV hardware transcoding.',
      url: 'https://example.dev/immich',
      status: 'PLACED',
      dedupVerdict: over.verdict ?? 'NEW',
      relatedStoryId: over.relatedId ?? null,
    })
    .run()

  db.insert(schema.storyFilings).values({ storyId, filingId }).run()

  db.insert(schema.publications)
    .values({
      id: publicationId,
      storyId,
      outletId: 'discord-test',
      status: 'PROPOSED',
      origin: 'managing-editor',
      placementReason: 'self-hosters run it',
      angle: over.angle ?? 'Lead on what changes for someone already running it.',
    })
    .run()

  return { publicationId, storyId }
}

describe('the writer prompt', () => {
  it('carries the voice, the destination, the story and the angle', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    const { prompt } = buildDraftContext(db, publicationId)

    expect(prompt).toContain('concise, technical, anti-hype') // voice voice
    expect(prompt).toContain('self-hosters running a personal cloud') // audience
    expect(prompt).toContain('Test channel for self-hosters') // outlet description
    expect(prompt).toContain('Immich v1.142.0') // story
    expect(prompt).toContain('Lead on what changes') // angle
  })

  it('offers only the authoring slots — never the destination', () => {
    // The writer must not be able to see, let alone set, channelId.
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    const { prompt } = buildDraftContext(db, publicationId)

    expect(prompt).toContain('"title"')
    expect(prompt).toContain('"description"')
    expect(prompt).not.toContain('channelId')
    expect(prompt).not.toContain('1514993197082742814')
  })

  it('delimits the source material and labels it untrusted', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    const { prompt } = buildDraftContext(db, publicationId)

    expect(prompt).toContain('<<<UNTRUSTED_MATERIAL_BEGINS>>>')
    expect(prompt).toContain('untrusted data')
  })

  it('tells the writer to lead with what is new when the story is a follow-up', () => {
    const { db } = openTestDb()
    seedDesk(db)
    db.insert(schema.stories)
      .values({
        id: 'earlier',
        title: 'Immich v1.141.0',
        summary: 'The feature launch.',
        status: 'PLACED',
        dedupVerdict: 'NEW',
      })
      .run()
    const { publicationId } = seedPlacedStory(db, { verdict: 'UPDATE', relatedId: 'earlier' })

    const { prompt } = buildDraftContext(db, publicationId)

    expect(prompt).toContain('follows on from an earlier one')
    expect(prompt).toContain('Immich v1.141.0')
  })

  it('says so plainly when there is no angle, rather than leaving a hole', () => {
    const { db } = openTestDb()
    seedDesk(db)
    const storyId = randomUUID()
    const publicationId = randomUUID()
    db.insert(schema.stories)
      .values({ id: storyId, title: 'T', summary: 'S', status: 'PLACED', dedupVerdict: 'NEW' })
      .run()
    db.insert(schema.publications)
      .values({
        id: publicationId,
        storyId,
        outletId: 'discord-test',
        status: 'PROPOSED',
        origin: 'managing-editor',
        angle: null,
      })
      .run()

    expect(buildDraftContext(db, publicationId).prompt).toContain('no specific angle')
  })
})

describe('drafting', () => {
  it('stores the draft and moves the publication to awaiting approval', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    const result = await draftPublication(
      db,
      scripted(JSON.stringify({ title: 'Immich 1.142.0', description: 'Adds Intel QSV transcoding.' })),
      publicationId,
    )

    expect(result.slots.title).toBe('Immich 1.142.0')

    const publication = db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, publicationId))
      .get()!
    expect(publication.status).toBe('AWAITING_APPROVAL')
    expect(JSON.parse(publication.slots!).description).toContain('Intel QSV')
  })

  it('records the draft as a version, so every edit has something to revert to', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    await draftPublication(
      db,
      scripted(JSON.stringify({ title: 'T', description: 'B' })),
      publicationId,
    )

    const version = db.select().from(schema.draftVersions).get()!
    expect(version.origin).toBe('writer')
    expect(JSON.parse(version.slots).title).toBe('T')
  })

  it('rejects an over-length draft and accepts the correction', async () => {
    // The generated schema is what makes an over-length value impossible
    // rather than merely validated once it is already in the database.
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    const driver = scripted(
      JSON.stringify({ title: 'x'.repeat(300), description: 'B' }),
      JSON.stringify({ title: 'Short enough', description: 'B' }),
    )

    await draftPublication(db, driver, publicationId)

    expect(driver.prompts).toHaveLength(2)
    expect(driver.prompts[1]).toContain('Headline')
    const publication = db.select().from(schema.publications).get()!
    expect(JSON.parse(publication.slots!).title).toBe('Short enough')
  })

  it('refuses a draft that tries to set a key it was not offered', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    const driver = scripted(
      JSON.stringify({ title: 'T', description: 'B', channelId: 'attacker-channel' }),
      JSON.stringify({ title: 'T', description: 'B' }),
    )

    await draftPublication(db, driver, publicationId)

    const stored = JSON.parse(db.select().from(schema.publications).get()!.slots!)
    expect('channelId' in stored).toBe(false)
  })

  it('marks the publication FAILED when the writer cannot produce a usable draft', async () => {
    const { db } = openTestDb()
    seedDesk(db)
    const { publicationId } = seedPlacedStory(db)

    await expect(draftPublication(db, scripted('nonsense', 'more nonsense'), publicationId)).rejects.toThrow()

    const publication = db.select().from(schema.publications).get()!
    expect(publication.status).toBe('FAILED')
    expect(publication.error).toBeTruthy()
  })
})
