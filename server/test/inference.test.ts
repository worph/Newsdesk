import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openTestDb } from './helpers.js'
import { extractJson, InferenceFailed, runStructured } from '../src/ports/inference/structured.js'
import type { InferenceDriver, InferenceRequest } from '../src/ports/inference/types.js'

describe('extractJson', () => {
  it('reads a bare object, which is what claude-code actually returns', () => {
    expect(extractJson('{"ok":true}')).toBe('{"ok":true}')
  })

  it('unwraps a markdown fence', () => {
    expect(extractJson('```json\n{"ok":true}\n```')).toBe('{"ok":true}')
    expect(extractJson('```\n{"ok":true}\n```')).toBe('{"ok":true}')
  })

  it('survives a preamble and a trailing remark', () => {
    expect(extractJson('Here you go:\n{"ok":true}\nHope that helps!')).toBe('{"ok":true}')
  })

  it('does not let a brace inside a string change the depth', () => {
    // The whole point of scanning rather than counting: a summary quoting a
    // brace would otherwise truncate the object at the wrong place.
    const text = 'note\n{"summary":"uses {{story.url}} as a template","ok":true}\ndone'
    expect(JSON.parse(extractJson(text) ?? '{}')).toEqual({
      summary: 'uses {{story.url}} as a template',
      ok: true,
    })
  })

  it('handles an escaped quote inside a string', () => {
    const text = '{"title":"he said \\"hi\\"","ok":true}'
    expect(JSON.parse(extractJson(text) ?? '{}')).toEqual({ title: 'he said "hi"', ok: true })
  })

  it('extracts an array as readily as an object', () => {
    expect(extractJson('result: [1,2,3]')).toBe('[1,2,3]')
  })

  it('skips an unbalanced opener and finds the real value after it', () => {
    expect(extractJson('this { is not json, but this is: {"ok":true}')).toBe('{"ok":true}')
  })

  it('returns null when there is no JSON at all, rather than guessing', () => {
    expect(extractJson('I cannot help with that.')).toBeNull()
    expect(extractJson('')).toBeNull()
  })
})

/** A driver that replays scripted answers, so the pipeline is testable without Beacon. */
function scriptedDriver(answers: string[]): InferenceDriver & { prompts: string[] } {
  const prompts: string[] = []
  return {
    name: 'scripted',
    capabilities: { toolCalling: false },
    prompts,
    async run(request: InferenceRequest) {
      prompts.push(request.prompt)
      return { text: answers.shift() ?? '' }
    },
  }
}

const shape = z.object({ verdict: z.enum(['NEW', 'DUPLICATE']), reason: z.string() })

describe('runStructured', () => {
  it('validates and returns the parsed object', async () => {
    const { db } = openTestDb()
    const driver = scriptedDriver(['{"verdict":"NEW","reason":"first sighting"}'])

    const result = await runStructured(db, driver, {
      purpose: 'managing-editor',
      prompt: 'decide',
      schema: shape,
      shapeHint: '{ verdict, reason }',
    })

    expect(result).toEqual({ verdict: 'NEW', reason: 'first sighting' })
  })

  it('tells a non-tool-calling driver to answer in JSON', async () => {
    const { db } = openTestDb()
    const driver = scriptedDriver(['{"verdict":"NEW","reason":"x"}'])

    await runStructured(db, driver, {
      purpose: 'managing-editor',
      prompt: 'decide',
      schema: shape,
      shapeHint: '{ verdict, reason }',
    })

    expect(driver.prompts[0]).toContain('single JSON object')
    expect(driver.prompts[0]).toContain('{ verdict, reason }')
  })

  it('retries once with the validation error included, and succeeds', async () => {
    const { db } = openTestDb()
    const driver = scriptedDriver([
      '{"verdict":"MAYBE","reason":"unsure"}', // not in the enum
      '{"verdict":"DUPLICATE","reason":"same release as story 4"}',
    ])

    const result = await runStructured(db, driver, {
      purpose: 'managing-editor',
      prompt: 'decide',
      schema: shape,
      shapeHint: '{ verdict, reason }',
    })

    expect(result.verdict).toBe('DUPLICATE')
    expect(driver.prompts).toHaveLength(2)
    expect(driver.prompts[1]).toContain('could not be used')
    expect(driver.prompts[1]).toContain('verdict')
  })

  it('gives up after the second failure rather than looping', async () => {
    const { db } = openTestDb()
    const driver = scriptedDriver(['not json at all', 'still not json'])

    await expect(
      runStructured(db, driver, {
        purpose: 'managing-editor',
        prompt: 'decide',
        schema: shape,
        shapeHint: '{ verdict, reason }',
      }),
    ).rejects.toThrow(InferenceFailed)

    expect(driver.prompts).toHaveLength(2)
  })

  it('records every attempt in inference_calls, failures included', async () => {
    const { db, sqlite } = openTestDb()
    const driver = scriptedDriver(['garbage', '{"verdict":"NEW","reason":"ok"}'])

    await runStructured(db, driver, {
      purpose: 'managing-editor',
      refId: 'sub-1',
      prompt: 'decide',
      schema: shape,
      shapeHint: '{ verdict, reason }',
    })

    const rows = sqlite.prepare('select purpose, ref_id, ok from inference_calls order by id').all() as Array<{
      purpose: string
      ref_id: string
      ok: number
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ purpose: 'managing-editor', ref_id: 'sub-1', ok: 0 })
    expect(rows[1]).toMatchObject({ purpose: 'managing-editor', ref_id: 'sub-1', ok: 1 })
  })

  it('lets a transport failure out immediately, for the queue to back off on', async () => {
    const { db } = openTestDb()
    const transport = Object.assign(new Error('HTTP 503'), { name: 'McpError' })
    const driver: InferenceDriver = {
      name: 'broken',
      capabilities: { toolCalling: false },
      run: async () => {
        throw transport
      },
    }

    // Rewording the prompt cannot fix a dead upstream — waiting can.
    await expect(
      runStructured(db, driver, {
        purpose: 'managing-editor',
        prompt: 'decide',
        schema: shape,
        shapeHint: '{ verdict, reason }',
      }),
    ).rejects.toThrow('HTTP 503')
  })
})
