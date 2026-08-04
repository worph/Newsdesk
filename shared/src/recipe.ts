/**
 * A cookbook: how to publish to a destination that has no API.
 *
 * The recipe is prose an operator edits, with step lines mixed in. Prose is for
 * the human reading the live browser; step lines are what the desk executes.
 * Keeping both in one document is the point — a cookbook that drifted from what
 * the desk actually does would be worse than no cookbook.
 *
 *     ## Stage
 *     Click the composer, then paste into the editor div.
 *     wait:  button.share-box-feed-entry__trigger
 *     click: button.share-box-feed-entry__trigger
 *     fill:  div.ql-editor[contenteditable="true"] <- body
 *
 *     ## Hand over
 *     The operator reads it and clicks "Post" in the modal.
 *
 *     ## Verify
 *     read: a.app-aware-link[href*='/feed/update/'] -> url
 *
 * Note what a step never carries: the text to publish. `fill` names a *payload
 * key*, and the desk supplies the bytes from the frozen payload — so a recipe
 * cannot become a second place where published copy lives. Nor does it carry
 * the destination, which stays a pinned literal in `args` (invariant 3).
 *
 * See docs/browser-publishing.md sections 2 and 3.
 */

/**
 * `hover` earns its place because a control that only exists under the pointer
 * is not an edge case: a page tree reveals its "new child" button on hover, and
 * so do most row-level actions on most apps. Playwright refuses to click what
 * is `visibility: hidden`, so without this verb such a destination is not
 * merely awkward to write — it cannot be reached at all.
 */
export const RECIPE_VERBS = ['wait', 'hover', 'click', 'fill', 'read', 'when'] as const
export type RecipeVerb = (typeof RECIPE_VERBS)[number]

export interface RecipeStep {
  verb: RecipeVerb
  selector: string
  /** `fill` reads this payload key; `read` writes this result key. */
  key?: string
  /** 1-based, so an issue can name the line the operator is looking at. */
  line: number
}

export type RecipeSection = 'stage' | 'commit' | 'handover' | 'verify' | 'signedout'

export interface Recipe {
  /**
   * Selectors that exist **only when signed out** — a login form's email field,
   * a "Sign in" button. Any one of them on the page means the desk cannot
   * publish until a person signs the browser in.
   *
   * A marker rather than the opposite test on purpose: "signed in" has no
   * reliable shape, but every login page has something a signed-in page does
   * not. Declaring nothing here means the desk does not check, which is right
   * for a destination that needs no account.
   */
  signedOut: RecipeStep[]
  stage: RecipeStep[]
  /**
   * The click that actually sends, and anything needed to reach it.
   *
   * Separate from `stage` because of *when* it runs, which is the whole reason
   * the section exists: the byte-compare happens at the end of staging, so a
   * sending click among the stage steps would fire before the copy had been
   * proved. Here it runs only after the comparison passed.
   *
   * Executed by the desk only under `publish: auto`. Under a hand-over mode it
   * is inert — the viewer uses its selector to point the operator at the button
   * and nothing else. That is what lets one recipe serve both, with the outlet's
   * `publish` field as the only difference.
   *
   * See docs/browser-publishing.md §3.
   */
  commit: RecipeStep[]
  /**
   * The prose the operator is shown when the page is handed to them, or null
   * when the section is absent.
   *
   * It used to be the mode switch — present meant a human finished the publish.
   * It no longer is: the outlet says how a publish finishes, and this says what
   * to tell the person once it has been decided that there is one.
   */
  handover: string | null
  verify: RecipeStep[]
  /** Section prose, for the live view. */
  prose: Record<RecipeSection, string>
}

export interface RecipeIssue {
  line: number
  message: string
}

export interface ParsedRecipe {
  recipe: Recipe
  issues: RecipeIssue[]
}

/**
 * Which verbs make sense where. A `read` while staging would find nothing yet.
 *
 * `commit` takes no `fill:`, and that refusal is load-bearing rather than tidy:
 * the byte-compare has already run by the time these steps execute, so copy
 * entering here would be copy nobody proved.
 */
const ALLOWED: Record<RecipeSection, readonly RecipeVerb[]> = {
  signedout: ['when'],
  stage: ['wait', 'hover', 'click', 'fill'],
  commit: ['wait', 'click'],
  handover: [],
  verify: ['wait', 'read'],
}

const HEADINGS: Array<{ section: RecipeSection; re: RegExp }> = [
  { section: 'signedout', re: /^#{1,6}\s*signed[\s-]?out\s*$/i },
  { section: 'stage', re: /^#{1,6}\s*stage\s*$/i },
  { section: 'commit', re: /^#{1,6}\s*commit\s*$/i },
  { section: 'handover', re: /^#{1,6}\s*hand[\s-]?over\s*$/i },
  { section: 'verify', re: /^#{1,6}\s*verif(?:y|ication)\s*$/i },
]

function headingFor(line: string): RecipeSection | undefined {
  const trimmed = line.trim()
  return HEADINGS.find(({ re }) => re.test(trimmed))?.section
}

/** `fill: <selector> <- key` and `read: <selector> -> key`. */
const BINDINGS: Partial<Record<RecipeVerb, { arrow: string; what: string }>> = {
  fill: { arrow: '<-', what: 'the payload key to type into it' },
  read: { arrow: '->', what: 'the result key to store it as' },
}

function parseStep(
  verb: RecipeVerb,
  rest: string,
  line: number,
  issues: RecipeIssue[],
): RecipeStep | undefined {
  const binding = BINDINGS[verb]

  if (!binding) {
    if (!rest) {
      issues.push({ line, message: `\`${verb}:\` needs a CSS selector` })
      return undefined
    }
    return { verb, selector: rest, line }
  }

  const at = rest.indexOf(binding.arrow)
  if (at === -1) {
    issues.push({
      line,
      message: `\`${verb}:\` needs \`<selector> ${binding.arrow} <key>\` — ${binding.what}`,
    })
    return undefined
  }

  const selector = rest.slice(0, at).trim()
  const key = rest.slice(at + binding.arrow.length).trim()
  if (!selector) {
    issues.push({ line, message: `\`${verb}:\` needs a CSS selector before \`${binding.arrow}\`` })
    return undefined
  }
  if (!key) {
    issues.push({ line, message: `\`${verb}:\` needs a key after \`${binding.arrow}\`` })
    return undefined
  }
  return { verb, selector, key, line }
}

const STEP_RE = new RegExp(`^(${RECIPE_VERBS.join('|')})\\s*:\\s*(.*)$`, 'i')

/**
 * Parse a cookbook.
 *
 * A line whose first token is a known verb is a step; everything else is prose
 * and is kept verbatim. That rule is deliberately dumb: prose is the common
 * case and an operator writing "Note: the composer is slow" must not have it
 * silently reinterpreted as an instruction.
 */
export function parseRecipe(text: string): ParsedRecipe {
  const issues: RecipeIssue[] = []
  const signedOut: RecipeStep[] = []
  const stage: RecipeStep[] = []
  const commit: RecipeStep[] = []
  const verify: RecipeStep[] = []
  const prose: Record<RecipeSection, string[]> = {
    signedout: [],
    stage: [],
    commit: [],
    handover: [],
    verify: [],
  }
  const seen = new Set<RecipeSection>()

  let section: RecipeSection | undefined

  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const line = index + 1
    const heading = headingFor(raw)

    if (heading) {
      if (seen.has(heading)) {
        issues.push({ line, message: `the ${heading} section appears twice` })
      }
      seen.add(heading)
      section = heading
      continue
    }

    const trimmed = raw.trim()
    const match = STEP_RE.exec(trimmed)

    if (!match) {
      if (section) prose[section].push(raw)
      else if (trimmed) {
        issues.push({
          line,
          message: 'this is before any section — start the recipe with a `## Stage` heading',
        })
      }
      continue
    }

    const verb = match[1]!.toLowerCase() as RecipeVerb
    const rest = match[2]!.trim()

    if (!section) {
      issues.push({ line, message: `\`${verb}:\` is before any section — put it under \`## Stage\`` })
      continue
    }
    if (!ALLOWED[section].includes(verb)) {
      issues.push({
        line,
        message:
          ALLOWED[section].length === 0
            ? `the hand over section is prose for the operator — \`${verb}:\` belongs under \`## Stage\``
            : `\`${verb}:\` is not allowed under ${section} — it takes ${ALLOWED[section]
                .map((v) => `\`${v}\``)
                .join(', ')}`,
      })
      continue
    }

    const step = parseStep(verb, rest, line, issues)
    if (!step) continue
    if (section === 'signedout') signedOut.push(step)
    else if (section === 'stage') stage.push(step)
    else if (section === 'commit') commit.push(step)
    else verify.push(step)
  }

  if (!seen.has('stage')) {
    issues.push({ line: 1, message: 'a recipe needs a `## Stage` section' })
  }

  const tidy = (part: RecipeSection): string => prose[part].join('\n').trim()

  return {
    recipe: {
      signedOut,
      stage,
      commit,
      handover: seen.has('handover') ? tidy('handover') : null,
      verify,
      prose: {
        signedout: tidy('signedout'),
        stage: tidy('stage'),
        commit: tidy('commit'),
        handover: tidy('handover'),
        verify: tidy('verify'),
      },
    },
    issues,
  }
}

/**
 * Whether the recipe says anything to the person who finishes this publish.
 *
 * It used to be the mode switch. It is now what the validator checks a declared
 * mode *against*: a hand-over mode with nothing to tell the operator is an
 * outlet that will hand them a page and no instructions, and an `auto` outlet
 * carrying operator instructions is a contradiction rather than a leftover.
 * See docs/browser-publishing.md section 3.
 */
export function hasHandover(recipe: Recipe): boolean {
  return recipe.handover !== null
}

/** Whether the desk has been given a click that sends. */
export function hasCommit(recipe: Recipe): boolean {
  return recipe.commit.length > 0
}

/**
 * The button that sends, for a viewer that wants to point at it.
 *
 * The *last* click rather than the first: reaching a send button routinely means
 * opening a menu or a modal on the way, and those earlier clicks are how you get
 * to the thing, not the thing. Returns null when the recipe names no commit
 * step, which is every destination that saves as you type.
 */
export function commitSelector(recipe: Recipe): string | null {
  const clicks = recipe.commit.filter((step) => step.verb === 'click')
  return clicks.length > 0 ? clicks[clicks.length - 1]!.selector : null
}

/** Payload keys the recipe types in, in order. */
export function filledKeys(recipe: Recipe): string[] {
  return recipe.stage.filter((step) => step.verb === 'fill').map((step) => step.key!)
}

/** Result keys the verify phase produces. `url` becomes the publication's external url. */
export function readKeys(recipe: Recipe): string[] {
  return recipe.verify.filter((step) => step.verb === 'read').map((step) => step.key!)
}

/** Result keys a verify step may store. Anything else has nowhere to go. */
export const RECIPE_READ_KEYS = ['url', 'id'] as const

/**
 * Whether this recipe can tell a signed-out page from a signed-in one.
 *
 * A destination that needs no account declares nothing and is never checked —
 * the desk does not invent a login requirement for a public page.
 */
export function checksSignIn(recipe: Recipe): boolean {
  return recipe.signedOut.length > 0
}
