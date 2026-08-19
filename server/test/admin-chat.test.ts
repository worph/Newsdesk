import { describe, expect, it } from 'vitest'
import { CHAT_CALLER, type AdminToolContext } from '../src/admin/registry.js'
import { dispatch, MAX_CALLS, runConfirmed, runTurn } from '../src/chat/loop.js'
import { appendMessage, currentThread, listMessages, startThread, threadForTurn } from '../src/chat/thread.js'
import { getConfigVersion, readConfig, writeConfig } from '../src/config/store.js'
import type { Db } from '../src/db/index.js'
import { listEvents } from '../src/events.js'
import type { InferenceDriver, InferenceRequest } from '../src/ports/inference/types.js'
import { openTestDb, schema, seedDesk } from './helpers.js'

/**
 * The loop that lets the administrator chat use the desk's own tools.
 *
 * What matters is not that it works when the model behaves. It is that the
 * allowlist holds when the model names something that does not exist, that a
 * refusal comes back in a form the model can act on, that the bounds actually
 * stop it, and that every one of those still ends with a message in the thread
 * rather than an exception.
 */

/** Answers in order; captures the prompt each one was given. */
function scripted(...answers: unknown[]): InferenceDriver & { prompts: string[] } {
  const prompts: string[] = []
  return {
    name: 'scripted',
    capabilities: { toolCalling: false },
    prompts,
    async run(request: InferenceRequest) {
      prompts.push(request.prompt)
      const next = answers.shift()
      if (next === undefined) throw new Error('the driver ran out of scripted answers')
      return { text: typeof next === 'string' ? next : JSON.stringify(next) }
    },
  }
}

const done = (say: string) => ({ say, call: null })
const calls = (tool: string, input: Record<string, unknown> = {}) => ({ say: '', call: { tool, input } })

function boot() {
  const { db, sqlite } = openTestDb()
  seedDesk(db)
  const threadId = startThread(db)
  return { db, sqlite, threadId }
}

function toolRows(db: Db, threadId: string) {
  return listMessages(db, threadId).filter((message) => message.role === 'tool')
}

function ctxFor(db: Db): AdminToolContext {
  return { db, version: 'test', caller: CHAT_CALLER }
}

describe('the allowlist', () => {
  /**
   * The mechanism, not the courtesy. A model naming something the desk never
   * built a handler for must reach nothing at all — and must be told, in a way
   * it can act on, so the next round is a correction rather than a repeat.
   */
  it('refuses a tool that does not exist and feeds the refusal back', async () => {
    const { db, threadId } = boot()
    const driver = scripted(calls('publish_now', { outlet: 'discord-test' }), done('I cannot publish.'))

    await runTurn(db, driver, threadId, 'publish the latest story')

    const rows = toolRows(db, threadId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ok).toBe(false)
    expect(rows[0]!.toolName).toBe('publish_now')

    // Nothing ran, and nothing was published — there is no such handler.
    expect(db.select().from(schema.publications).all()).toHaveLength(0)

    const { events } = listEvents(db, { category: 'config' })
    expect(events.some((event) => event.code === 'CHAT_TOOL_FAILED')).toBe(true)

    // The load-bearing one: the second prompt carries both the name it invented
    // and the refusal, so the model can correct rather than guess again.
    expect(driver.prompts).toHaveLength(2)
    expect(driver.prompts[1]).toContain('publish_now')
    expect(driver.prompts[1]).toContain('There is no tool called')
  })

  /**
   * This test used to assert the catalogue offered no way to publish. It now
   * asserts the opposite half: the editorial tools ARE offered — the desk's
   * owner asked for them — and every one of them arrives at the model already
   * labelled as something it can only propose.
   *
   * That label is not decoration. It is the difference between a model that
   * says "I have spiked them" and one that says "shall I?", and the catalogue
   * is where the model learns which kind of tool it is holding.
   */
  it('offers the editorial tools already marked as the operator to confirm', async () => {
    const { db, threadId } = boot()
    const driver = scripted(done('nothing to do'))

    await runTurn(db, driver, threadId, 'hello')

    const catalogue = driver.prompts[0]!
    expect(catalogue).toContain('### upsert_outlet')

    for (const editorial of ['spike_publications', 'drop_stories', 'approve_publications']) {
      expect(catalogue).toContain(`### ${editorial}`)
      // The confirmation note sits between this heading and the next one.
      const section = catalogue.slice(catalogue.indexOf(`### ${editorial}`))
      const body = section.slice(0, section.indexOf('### ', 4) === -1 ? undefined : section.indexOf('### ', 4))
      expect(body, editorial).toContain('The operator confirms this one')
    }
  })
})

describe('refusals round-trip', () => {
  it('returns a path per problem, and accepts the corrected call', async () => {
    const { db, threadId } = boot()
    const base = {
      id: 'discord-second',
      name: 'Second channel',
      description: 'Another room for the same kind of thing.',
      role: 'publish',
      driver: 'mcp',
      enabled: true,
      voice: 'alicia',
      endpoint: 'beacon',
      tool: 'discord-mcp__send_message',
    }

    const driver = scripted(
      // No destination pinned: invariant 3 with teeth, and the save is refused.
      calls('upsert_outlet', {
        outlet: { ...base, args: { content: { slot: 'markdown', label: 'Body', max: 2000, primary: true } } },
      }),
      calls('upsert_outlet', {
        outlet: {
          ...base,
          args: {
            channelId: '123456789',
            content: { slot: 'markdown', label: 'Body', max: 2000, primary: true },
          },
        },
      }),
      done('Added it.'),
    )

    await runTurn(db, driver, threadId, 'add a second discord channel')

    const rows = toolRows(db, threadId)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.ok).toBe(false)
    expect(rows[1]!.ok).toBe(true)

    expect(readConfig(db).outlets.map((outlet) => outlet.id)).toContain('discord-second')

    // The successful write hung an undo off the row, and it resolves.
    expect(rows[1]!.versionId).toBeTypeOf('number')
    expect(getConfigVersion(db, rows[1]!.versionId!)).toBeTruthy()
  })

  it('links to nothing when the write changed nothing', async () => {
    const { db, threadId } = boot()
    // Record the current state first, so the write below is a true no-op.
    writeConfig(db, readConfig(db), 'ui')

    const charter = readConfig(db).charter
    const driver = scripted(calls('set_charter', { charter }), done('Already said that.'))

    await runTurn(db, driver, threadId, 'set the charter to what it already is')

    const rows = toolRows(db, threadId)
    expect(rows[0]!.ok).toBe(true)
    expect(rows[0]!.versionId).toBeNull()
  })
})

describe('the bounds', () => {
  it('stops at the call ceiling and says so', async () => {
    const { db, threadId } = boot()
    const driver = scripted(...Array.from({ length: MAX_CALLS + 1 }, () => calls('get_config')))

    await runTurn(db, driver, threadId, 'read the config forever')

    expect(toolRows(db, threadId)).toHaveLength(MAX_CALLS)

    const { events } = listEvents(db, { category: 'config' })
    const failed = events.find((event) => event.code === 'CHAT_TURN_FAILED')
    expect(failed).toBeTruthy()
    expect((failed!.detail as { reason: string }).reason).toBe('bound')

    const last = listMessages(db, threadId).at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('could not finish')

    // The ninth model call is the chance to speak, not a ninth tool call.
    expect(driver.prompts).toHaveLength(MAX_CALLS + 1)
  })

  it('stops when the turn runs out of time, before asking again', async () => {
    const { db, threadId } = boot()
    const driver = scripted(calls('get_config'), done('never reached'))

    // Jumps past the deadline on the second check.
    let clock = 0
    await runTurn(db, driver, threadId, 'read it', {
      now: () => (clock += 90_000),
      turnMs: 120_000,
    })

    const { events } = listEvents(db, { category: 'config' })
    const failed = events.find((event) => event.code === 'CHAT_TURN_FAILED')
    expect((failed!.detail as { reason: string }).reason).toBe('timeout')
    // It gave up rather than spending another call it did not have time for.
    expect(driver.prompts.length).toBeLessThanOrEqual(2)
  })

  it('turns an unusable answer into a message rather than an exception', async () => {
    const { db, threadId } = boot()
    const driver = scripted('not json at all', 'still not json')

    await expect(runTurn(db, driver, threadId, 'hello')).resolves.toBeUndefined()

    const last = listMessages(db, threadId).at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('could not finish')
  })

  it('lets a transport failure end the turn without retrying it', async () => {
    const { db, threadId } = boot()
    const driver: InferenceDriver = {
      name: 'broken',
      capabilities: { toolCalling: false },
      async run() {
        throw Object.assign(new Error('beacon down'), { name: 'McpError' })
      },
    }

    await runTurn(db, driver, threadId, 'hello')

    const { events } = listEvents(db, { category: 'config' })
    const failed = events.find((event) => event.code === 'CHAT_TURN_FAILED')
    expect((failed!.detail as { reason: string }).reason).toBe('inference')
  })
})

describe('what the model is shown', () => {
  it('rebuilds the digest every round, so it never works from a stale copy', async () => {
    const { db, threadId } = boot()
    const driver = scripted(
      calls('upsert_voice', {
        voice: { id: 'second', name: 'Second voice', tone: 'dry', audience: 'the team' },
      }),
      done('added'),
    )

    await runTurn(db, driver, threadId, 'add a voice')

    // One voice when the turn started, two by the time it was asked again.
    expect(driver.prompts[0]).toContain('1 voice')
    expect(driver.prompts[1]).toContain('2 voices')
  })

  it('tells a brand new desk that it has no charter', async () => {
    const { db } = openTestDb()
    const threadId = startThread(db)
    const driver = scripted(done('Let us write one.'))

    await runTurn(db, driver, threadId, 'what should I do first?')

    expect(driver.prompts[0]).toContain('never been configured')
  })

  it('carries its remaining budget, so it can pace itself', async () => {
    const { db, threadId } = boot()
    const driver = scripted(done('hello'))

    await runTurn(db, driver, threadId, 'hello')

    expect(driver.prompts[0]).toContain(`Call 1 of ${MAX_CALLS}`)
    expect(driver.prompts[0]).toContain('second(s) left')
  })
})

describe('the destructive gate', () => {
  /**
   * §6 and §12 together: destructive calls confirm, but the loop does not
   * suspend to wait. The turn ends having written an offer, and the operator
   * answers it out of band.
   */
  it('offers a removal rather than running it', async () => {
    const { db, threadId } = boot()
    const driver = scripted(
      calls('remove_config_entry', { collection: 'voices', id: 'alicia' }),
      done('Say the word and I will.'),
    )

    await runTurn(db, driver, threadId, 'delete the alicia voice')

    const row = toolRows(db, threadId)[0]!
    expect(row.ok).toBe(false)
    expect(row.confirmWith).toBe('alicia')
    // Still there. Nothing was deleted.
    expect(readConfig(db).voices.map((voice) => voice.id)).toContain('alicia')
  })

  /**
   * The assertion this whole surface rests on.
   *
   * The chat can now approve and send, which is a deliberate change to what the
   * product guarantees — but only through a person typing a word. A model that
   * could reach `approve_publications` inside its own loop would be a desk that
   * publishes to a live Discord channel because a turn went sideways, and no
   * amount of prompt wording would be worth anything against it.
   */
  it('will not let the model publish inside its own turn', async () => {
    const { db, threadId } = boot()
    const sent: string[] = []
    const driver = scripted(
      calls('approve_publications', {}),
      done('Offered — it is yours to confirm.'),
    )

    await runTurn(db, driver, threadId, 'approve everything waiting', {
      // Wired, so the only thing standing between the model and the wire is
      // the gate itself rather than a missing dependency.
      enqueuePublish: (id: string) => void sent.push(id),
    })

    const row = toolRows(db, threadId)[0]!
    expect(row.ok).toBe(false)
    expect(row.confirmWith).toBe('publish all')
    // Nothing was queued, and the sentence offered to the operator says what
    // they would be agreeing to rather than naming a config change.
    expect(sent).toEqual([])
    expect(row.content).toContain('approve drafts and send them')
  })

  it('still refuses on confirmation when the desk itself would not allow it', async () => {
    const { db, threadId } = boot()
    db.insert(schema.filings)
      .values({ id: 'f1', stringerId: 'korben', kind: 'timeline', text: 'a report', status: 'RECEIVED' })
      .run()

    const offered = await dispatch(
      { tool: 'remove_config_entry', input: { collection: 'stringers', id: 'korben' } },
      ctxFor(db),
    )
    expect(offered.confirmWith).toBe('korben')

    // Confirming is the operator's decision, not permission to bypass the
    // store: a stringer that has filed must be disabled, never deleted.
    const row = appendMessage(db, {
      threadId,
      role: 'tool',
      content: offered.text,
      toolName: 'remove_config_entry',
      toolInput: { collection: 'stringers', id: 'korben' },
      ok: false,
      confirmWith: 'korben',
    })

    const confirmed = await runConfirmed(db, row, ctxFor(db))
    expect(confirmed.ok).toBe(false)
    expect(confirmed.text).toContain('enabled: false')
    expect(readConfig(db).stringers.map((stringer) => stringer.id)).toContain('korben')
  })

  it('runs a confirmed removal that the desk does allow', async () => {
    const { db, threadId } = boot()

    const row = appendMessage(db, {
      threadId,
      role: 'tool',
      content: 'offered',
      toolName: 'remove_config_entry',
      toolInput: { collection: 'voices', id: 'alicia' },
      ok: false,
      confirmWith: 'alicia',
    })

    // The outlet references the voice, so drop it first — otherwise this would
    // pass for the wrong reason, refused by referential integrity.
    writeConfig(db, { ...readConfig(db), outlets: [] }, 'ui')

    const confirmed = await runConfirmed(db, row, ctxFor(db))
    expect(confirmed.ok, confirmed.text).toBe(true)
    expect(readConfig(db).voices).toHaveLength(0)
    expect(confirmed.versionId).toBeTypeOf('number')
  })
})

describe('the conversation', () => {
  it('keeps talking in a thread that is still warm', () => {
    const { db } = openTestDb()
    const first = startThread(db)
    appendMessage(db, { threadId: first, role: 'user', content: 'hello' })

    // Seven hours later: the same conversation.
    const sevenHours = Date.now() + 7 * 60 * 60 * 1000
    expect(currentThread(db, () => sevenHours)).toBe(first)
    expect(threadForTurn(db, () => sevenHours)).toBe(first)
  })

  it('starts a new one once the last has gone cold', () => {
    const { db } = openTestDb()
    const first = startThread(db)
    appendMessage(db, { threadId: first, role: 'user', content: 'hello' })

    const nineHours = Date.now() + 9 * 60 * 60 * 1000
    expect(currentThread(db, () => nineHours)).toBeUndefined()

    const second = threadForTurn(db, () => nineHours)
    expect(second).not.toBe(first)
    // The old conversation is kept, not deleted — it records why a change was
    // made, which a configuration version cannot.
    expect(listMessages(db, first)).toHaveLength(1)
    expect(listMessages(db, second)).toHaveLength(0)
  })

  it('records the tool turns as rows, so the thread is the audit trail', async () => {
    const { db, threadId } = boot()
    const driver = scripted(calls('get_charter'), done('That is the charter.'))

    await runTurn(db, driver, threadId, 'what is the charter?')

    expect(listMessages(db, threadId).map((message) => message.role)).toEqual([
      'user',
      'tool',
      'assistant',
    ])
  })

  it('writes the change as the chat, so the history screen can say who', async () => {
    const { db, threadId } = boot()
    const driver = scripted(calls('set_charter', { charter: 'A charter written in the chat.' }), done('Done.'))

    await runTurn(db, driver, threadId, 'rewrite the charter')

    const { events } = listEvents(db, { category: 'config' })
    const changed = events.find((event) => event.code === 'CONFIG_CHANGED')
    expect((changed!.detail as { author: string }).author).toBe('chat')
    expect(changed!.message).toContain('the administrator chat')
  })
})
