import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ADMIN_TOOLS,
  adminTool,
  CHAT_CALLER,
  MCP_CALLER,
  type AdminToolContext,
} from '../src/admin/registry.js'
import { SETTING, setSetting } from '../src/settings.js'
import { openTestDb, seedDesk } from './helpers.js'

/**
 * The catalogue is generated, so it gets asserted.
 *
 * Two surfaces read this list — the MCP server and the administrator chat —
 * and neither can check the other at runtime. What holds them together is that
 * every entry is well formed in the ways both depend on: a description a model
 * can choose from, a schema that constructs, and a confirmation on exactly the
 * entries that can destroy something.
 */

describe('the administration tool registry', () => {
  it('gives every entry the parts both callers need', () => {
    for (const entry of ADMIN_TOOLS) {
      expect(entry.name, 'name').toMatch(/^[a-z][a-z0-9_]*$/)
      expect(entry.title, entry.name).toBeTruthy()
      // The description is what a model chooses from. An entry without one is
      // reachable only by accident.
      expect(entry.description.length, entry.name).toBeGreaterThan(40)
      expect(entry.handler, entry.name).toBeTypeOf('function')
    }
  })

  it('names each entry once', () => {
    const names = ADMIN_TOOLS.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('carries schemas that construct, so the chat can validate against them', () => {
    for (const entry of ADMIN_TOOLS) {
      // The chat wraps the raw shape to check a model's arguments before
      // dispatching. If that throws, the tool is unreachable from the chat
      // while looking perfectly healthy over MCP.
      const schema = z.object(entry.inputSchema)
      expect(schema, entry.name).toBeInstanceOf(z.ZodObject)
      expect(() => schema.safeParse({}), entry.name).not.toThrow()
    }
  })

  /**
   * The gate the chat leans on. `dispatch` refuses to run anything carrying a
   * `confirmWith` and offers it to the operator instead, so an entry that can
   * delete configuration without one would be run unattended.
   */
  it('asks for a confirmation on exactly the entries that can destroy something', () => {
    const destructive = ADMIN_TOOLS.filter((entry) => entry.annotations?.destructiveHint === true)
    expect(destructive.map((entry) => entry.name)).toEqual([
      'remove_config_entry',
      'write_config',
      'restore_config_version',
    ])

    for (const entry of ADMIN_TOOLS) {
      const shouldConfirm = entry.annotations?.destructiveHint === true
      expect(typeof entry.confirmWith === 'function', entry.name).toBe(shouldConfirm)
    }
  })

  it('confirms with something already on the proposal', () => {
    // Never a fresh token to copy from somewhere else: confirming has to mean
    // having read the thing that is about to change.
    expect(adminTool('remove_config_entry')!.confirmWith!({ collection: 'voices', id: 'alicia' })).toBe('alicia')
    expect(adminTool('restore_config_version')!.confirmWith!({ id: 12 })).toBe('12')
    expect(adminTool('write_config')!.confirmWith!({ yaml: 'x', reason: 'y' })).toBe('replace')
  })

  it('offers nothing that could publish', () => {
    // The human between every draft and every channel is the product. This is
    // the same assertion the MCP suite makes, kept here too because the list is
    // what it is really about — the transport is incidental.
    for (const forbidden of ['approve', 'publish', 'spike', 'send']) {
      expect(ADMIN_TOOLS.some((entry) => entry.name.includes(forbidden))).toBe(false)
    }
  })

  it('finds an entry by name, and nothing by a name it does not have', () => {
    expect(adminTool('get_config')?.name).toBe('get_config')
    expect(adminTool('publish_now')).toBeUndefined()
  })

  it('shows secrets to a sidecar and redacts them for a browser', () => {
    expect(MCP_CALLER.redactSecrets).toBe(false)
    expect(CHAT_CALLER.redactSecrets).toBe(true)
    // The author lands on every restore point, and the history screen reads it.
    expect(MCP_CALLER.author).toBe('mcp')
    expect(CHAT_CALLER.author).toBe('chat')
  })
})

/**
 * The one place the two callers are meant to differ.
 *
 * Over MCP the caller is a sidecar that already holds a token; in the chat the
 * value would land in a message row and a browser scrollback, and it is the
 * credential pasted into every stringer workflow.
 */
describe('reading the settings as each caller', () => {
  function contextFor(caller: typeof MCP_CALLER) {
    const { db } = openTestDb()
    seedDesk(db)
    setSetting(db, SETTING.ingestToken, 'nsk_averylongingesttoken3f2a')
    return { db, ctx: { db, version: 'test', caller } satisfies AdminToolContext }
  }

  async function settings(caller: typeof MCP_CALLER) {
    const { ctx } = contextFor(caller)
    const result = await adminTool('get_settings')!.handler({}, ctx)
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>
  }

  it('hands an MCP caller the whole token', async () => {
    expect(await settings(MCP_CALLER)).toMatchObject({
      ingestToken: 'nsk_averylongingesttoken3f2a',
    })
  })

  it('hands the chat enough to recognise it and no more', async () => {
    const payload = await settings(CHAT_CALLER)

    expect(payload.ingestToken).toBe('…3f2a')
    expect(payload.ingestTokenRedacted).toBe(true)
    expect(String(payload.note)).toContain('Settings')
    // Enough to answer "is it set" and "is this the one the stringers hold",
    // which is all the chat ever needs — it files with file_tip.
    expect(JSON.stringify(payload)).not.toContain('averylongingesttoken')
  })

  it('keeps the key the same either way, so a model reads one shape', async () => {
    const [overMcp, inChat] = [await settings(MCP_CALLER), await settings(CHAT_CALLER)]
    expect(Object.keys(overMcp)).toEqual(['timezone', 'ingestToken', 'pushDevices'])
    expect(Object.keys(inChat).slice(0, 2)).toEqual(['timezone', 'ingestToken'])
  })
})
