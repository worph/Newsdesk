import type { ArgsSpec } from '@newsdesk/shared'
import { describe, expect, it } from 'vitest'
import {
  authoringKeys,
  slotsJsonSchema,
  slotsShapeHint,
  slotsZodSchema,
  submitDraftTool,
} from '../src/schema/slots.js'
import {
  checkVerdictLinks,
  managingEditorResultSchema,
  managingEditorShapeHint,
  managingEditorTools,
} from '../src/schema/managing-editor.js'

const discordArgs: ArgsSpec = {
  channelId: '1514993197082742814',
  timestamp: true,
  footer: '{{story.url}}',
  title: { slot: 'text', label: 'Headline', max: 256, optional: false, primary: false },
  description: { slot: 'markdown', label: 'Body', max: 4096, optional: false, primary: true },
  image: { slot: 'image', label: 'Image', optional: true, primary: false },
}

describe('slot spec to writer schema', () => {
  it('offers only the authoring slots — never the destination', () => {
    // This is invariant 3 as a generated artefact: channelId is a literal, so
    // it is not in the schema and the writer cannot reach it.
    const schema = slotsJsonSchema(discordArgs)
    expect(Object.keys(schema.properties as object)).toEqual(['title', 'description', 'image'])
    expect(schema.additionalProperties).toBe(false)
  })

  it('marks optional slots optional and the rest required', () => {
    const schema = slotsJsonSchema(discordArgs)
    expect(schema.required).toEqual(['title', 'description'])
  })

  it('carries the length limit into the schema, so over-length is impossible', () => {
    const props = slotsJsonSchema(discordArgs).properties as Record<string, { maxLength?: number }>
    expect(props.title?.maxLength).toBe(256)
    expect(props.description?.maxLength).toBe(4096)
  })

  it('names the tool submit_draft', () => {
    expect(submitDraftTool(discordArgs).name).toBe('submit_draft')
  })

  it('lists authoring keys and excludes literals and derived values', () => {
    expect(authoringKeys(discordArgs)).toEqual(['title', 'description', 'image'])
  })
})

describe('slot spec as a validator', () => {
  const validator = slotsZodSchema(discordArgs)

  it('accepts a well-formed draft', () => {
    const result = validator.safeParse({ title: 'Immich 1.142', description: 'Body text' })
    expect(result.success).toBe(true)
  })

  it('rejects an over-length value with a message naming the slot', () => {
    const result = validator.safeParse({ title: 'x'.repeat(257), description: 'Body' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toContain('Headline')
  })

  it('rejects a missing required slot', () => {
    expect(validator.safeParse({ title: 'Only a title' }).success).toBe(false)
  })

  it('rejects a key the spec never offered', () => {
    // An extra key is a model authoring an argument configuration did not
    // declare — exactly what the slot design exists to prevent.
    const result = validator.safeParse({
      title: 'T',
      description: 'B',
      channelId: '999',
    })
    expect(result.success).toBe(false)
  })

  it('requires a URL where the slot is a link or image', () => {
    expect(validator.safeParse({ title: 'T', description: 'B', image: 'not-a-url' }).success).toBe(false)
    expect(validator.safeParse({ title: 'T', description: 'B', image: 'https://x.dev/a.png' }).success).toBe(true)
  })

  it('describes the slots for a driver that cannot be handed a schema', () => {
    const hint = slotsShapeHint(discordArgs)
    expect(hint).toContain('"title"')
    expect(hint).toContain('max 256 chars')
    expect(hint).toContain('the main document')
    expect(hint).not.toContain('channelId')
  })
})

describe('managing editor vocabulary', () => {
  const outlets = ['discord-test', 'nextcloud-internal']

  it('accepts a well-formed result', () => {
    const parsed = managingEditorResultSchema(outlets).safeParse({
      stories: [
        {
          title: 'Immich 1.142.0',
          summary: 'Point release.',
          verdict: 'NEW',
          placements: [{ outlet_id: 'discord-test', reason: 'self-hosters run it' }],
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a placement to a destination that does not exist', () => {
    // The enum is generated from live outlets, so an unknown destination is
    // impossible rather than merely validated later.
    const parsed = managingEditorResultSchema(outlets).safeParse({
      stories: [
        {
          title: 'T',
          summary: 'S',
          verdict: 'NEW',
          placements: [{ outlet_id: 'telegram-invented', reason: 'why not' }],
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })

  it('treats zero placements as valid — that is the newsworthiness gate', () => {
    const parsed = managingEditorResultSchema(outlets).safeParse({
      stories: [{ title: 'T', summary: 'S', verdict: 'NEW', placements: [] }],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts an empty result with a reason', () => {
    const parsed = managingEditorResultSchema(outlets).safeParse({
      stories: [],
      no_story_reason: 'a sponsored deal post, excluded by the charter',
    })
    expect(parsed.success).toBe(true)
  })

  it('requires a reason on every placement', () => {
    const parsed = managingEditorResultSchema(outlets).safeParse({
      stories: [{ title: 'T', summary: 'S', verdict: 'NEW', placements: [{ outlet_id: 'discord-test' }] }],
    })
    expect(parsed.success).toBe(false)
  })

  it('generates the tool vocabulary with outlet_id as a live enum', () => {
    const tools = managingEditorTools(
      outlets.map((id) => ({ id, name: id, description: 'd', role: 'publish' })),
    )
    const placement = tools.find((t) => t.name === 'propose_placement')
    const props = placement?.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.outlet_id?.enum).toEqual(outlets)
  })

  it('names the live outlets in the text-driver hint', () => {
    expect(managingEditorShapeHint(outlets)).toContain('"discord-test" | "nextcloud-internal"')
  })
})

describe('verdict links', () => {
  const known = new Set(['story-a', 'story-b'])
  const result = (over: Record<string, unknown>) =>
    managingEditorResultSchema(['discord-test']).parse({
      stories: [{ title: 'T', summary: 'S', verdict: 'NEW', placements: [], ...over }],
    })

  it('passes a NEW story with no link', () => {
    expect(checkVerdictLinks(result({}), known)).toEqual([])
  })

  it('rejects a DUPLICATE that names nothing', () => {
    // A verdict nobody can check is not reviewable, which defeats the point
    // of recording it.
    const problems = checkVerdictLinks(result({ verdict: 'DUPLICATE' }), known)
    expect(problems[0]).toContain('names no related_story_id')
  })

  it('rejects a link to a story it was never shown', () => {
    const problems = checkVerdictLinks(
      result({ verdict: 'UPDATE', related_story_id: 'invented' }),
      known,
    )
    expect(problems[0]).toContain('not one of the stories it was shown')
  })

  it('accepts a well-linked UPDATE', () => {
    expect(checkVerdictLinks(result({ verdict: 'UPDATE', related_story_id: 'story-a' }), known)).toEqual([])
  })
})
