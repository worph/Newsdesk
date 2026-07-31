import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '@newsdesk/shared'
import { describe, expect, it } from 'vitest'
import { yamlToConfig } from '../src/config/store.js'

const examplePath = fileURLToPath(new URL('../../deploy/config.example.yaml', import.meta.url))

describe('the shipped example configuration', () => {
  // It is the first thing anyone edits, and it is imported verbatim on first
  // boot — it must never drift from the schema.
  it('parses and validates with no issues', () => {
    const { config, issues } = parseConfig(yamlToConfig(readFileSync(examplePath, 'utf8')))
    expect(issues).toEqual([])
    expect(config.charter.length).toBeGreaterThan(0)
    expect(config.targets.length).toBeGreaterThan(0)
    expect(config.voices.length).toBeGreaterThan(0)
    expect(config.stringers.length).toBeGreaterThan(0)
  })

  it('pins a literal destination on every publish target', () => {
    const { config } = parseConfig(yamlToConfig(readFileSync(examplePath, 'utf8')))
    for (const target of config.targets.filter((t) => t.role === 'publish')) {
      const key = target.destination_key ?? 'channelId'
      expect(typeof target.args[key]).toBe('string')
    }
  })

  it('demonstrates all three argument forms, so the example teaches the model', () => {
    const { config } = parseConfig(yamlToConfig(readFileSync(examplePath, 'utf8')))
    const args = config.targets[0]!.args
    const kinds = Object.values(args).map((v) =>
      typeof v === 'object' && v !== null && 'slot' in v
        ? 'slot'
        : typeof v === 'string' && v.includes('{{')
          ? 'derived'
          : 'literal',
    )
    expect(new Set(kinds)).toEqual(new Set(['literal', 'derived', 'slot']))
  })
})
