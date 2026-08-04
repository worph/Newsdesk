import { commitSelector, filledKeys, hasCommit, hasHandover, parseRecipe, readKeys } from '@newsdesk/shared'
import { describe, expect, it } from 'vitest'

/**
 * The cookbook grammar.
 *
 * Two properties are load-bearing and the rest is convenience: prose must never
 * be reinterpreted as an instruction, and a `fill` must name a payload key
 * rather than carry text. Both are tested here rather than implied.
 */

const LINKEDIN = `## Stage
The composer opens as a modal over the page.
wait:  button.share-box-feed-entry__trigger
click: button.share-box-feed-entry__trigger
fill:  div.ql-editor[contenteditable="true"] <- body

## Hand over
Read it, then click "Post" at the bottom right.

## Verify
read: a.app-aware-link[href*='/feed/update/'] -> url
`

describe('parsing a recipe', () => {
  it('reads steps and keeps prose', () => {
    const { recipe, issues } = parseRecipe(LINKEDIN)

    expect(issues).toEqual([])
    expect(recipe.stage.map((step) => step.verb)).toEqual(['wait', 'click', 'fill'])
    expect(recipe.stage[2]).toMatchObject({
      verb: 'fill',
      selector: 'div.ql-editor[contenteditable="true"]',
      key: 'body',
    })
    expect(recipe.prose.stage).toBe('The composer opens as a modal over the page.')
    expect(recipe.handover).toBe('Read it, then click "Post" at the bottom right.')
    expect(recipe.verify[0]).toMatchObject({ verb: 'read', key: 'url' })
  })

  it('names a payload key, never the text to publish', () => {
    const { recipe } = parseRecipe(LINKEDIN)
    expect(filledKeys(recipe)).toEqual(['body'])
    expect(readKeys(recipe)).toEqual(['url'])
    // Nothing in a parsed step can carry copy: a step has a selector and a key.
    for (const step of recipe.stage) {
      expect(Object.keys(step).sort()).toEqual(expect.arrayContaining(['line', 'selector', 'verb']))
    }
  })

  it('leaves prose that merely looks like an instruction alone', () => {
    const { recipe, issues } = parseRecipe(`## Stage
Note: the composer is slow to appear on a cold profile.
Remember to check the preview card renders.
click: button.go
## Hand over
Press Post.`)

    expect(issues).toEqual([])
    expect(recipe.stage).toHaveLength(1)
    expect(recipe.prose.stage).toContain('Note: the composer is slow')
  })

  it('distinguishes an absent hand over from an empty one', () => {
    expect(hasHandover(parseRecipe('## Stage\nclick: a').recipe)).toBe(false)
    expect(hasHandover(parseRecipe('## Stage\nclick: a\n## Hand over').recipe)).toBe(true)
    // The heading is what makes an outlet human-click, so spelling variants of
    // it must not silently turn one into an outlet the desk would finish itself.
    expect(hasHandover(parseRecipe('## Stage\nclick: a\n## Handover\nPress it.').recipe)).toBe(true)
    expect(hasHandover(parseRecipe('## Stage\nclick: a\n## hand-over\nPress it.').recipe)).toBe(true)
  })

  it('refuses a fill with no key and a read with no destination', () => {
    const { issues } = parseRecipe(`## Stage
fill: div.editor
## Verify
read: a.link`)

    expect(issues).toHaveLength(2)
    expect(issues[0]!.message).toContain('<selector> <- <key>')
    expect(issues[1]!.message).toContain('<selector> -> <key>')
    expect(issues[0]!.line).toBe(2)
  })

  it('keeps verbs to the section where they mean something', () => {
    const { issues } = parseRecipe(`## Stage
read: a.link -> url
## Hand over
click: button.post`)

    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('not allowed under stage'),
      expect.stringContaining('hand over section is prose'),
    ])
  })

  it('wants a stage section and refuses steps adrift of one', () => {
    expect(parseRecipe('click: button.go').issues.map((i) => i.message)).toEqual([
      expect.stringContaining('before any section'),
      expect.stringContaining('needs a `## Stage` section'),
    ])
  })

  it('notices a section written twice', () => {
    const { issues } = parseRecipe('## Stage\nclick: a\n## Stage\nclick: b')
    expect(issues[0]!.message).toContain('appears twice')
  })
})

/**
 * The section that sends.
 *
 * It is separate from `## Stage` because of *when* it runs: the byte-compare
 * happens at the end of staging, so a sending click among the stage steps would
 * fire before the copy had been proved. Everything below is that ordering
 * expressed as grammar.
 */
describe('the commit section', () => {
  const TELEGRAM = `## Stage
wait: div.composer
fill: div.composer <- body

## Commit
wait:  button.send:not([disabled])
click: button.send

## Verify
read: a.message-link -> url`

  it('collects its steps apart from the stage ones', () => {
    const { recipe, issues } = parseRecipe(TELEGRAM)

    expect(issues).toEqual([])
    expect(recipe.stage.map((s) => s.verb)).toEqual(['wait', 'fill'])
    expect(recipe.commit.map((s) => s.verb)).toEqual(['wait', 'click'])
    expect(hasCommit(recipe)).toBe(true)
  })

  it('refuses to let copy in after the compare', () => {
    // The one rule that makes the section worth having: everything the desk
    // types is proved before these steps run, so nothing may type here.
    const { issues } = parseRecipe(`## Stage
fill: div.composer <- body
## Commit
fill: div.composer <- body`)

    expect(issues).toHaveLength(1)
    expect(issues[0]!.line).toBe(4)
    expect(issues[0]!.message).toContain('not allowed under commit')
  })

  it('takes the last click as the button that sends', () => {
    // Reaching a send button routinely means opening a menu on the way, and
    // those earlier clicks are how you get to the thing, not the thing.
    const { recipe } = parseRecipe(`## Stage
fill: div.composer <- body
## Commit
click: button.more
click: button.send-now`)

    expect(commitSelector(recipe)).toBe('button.send-now')
  })

  it('has no opinion when a destination has no button', () => {
    // Docmost saves as the desk types; there is nothing to press, and that is a
    // shape of recipe rather than a defect in one.
    const { recipe } = parseRecipe(LINKEDIN)
    expect(hasCommit(recipe)).toBe(false)
    expect(commitSelector(recipe)).toBeNull()
  })
})
