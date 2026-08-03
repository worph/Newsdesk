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

export type RecipeSection = 'stage' | 'handover' | 'verify' | 'signedout'

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
   * The prose the operator is shown when the page is handed to them, or null
   * when the section is absent — which is what distinguishes an outlet a human
   * finishes from one the desk would finish itself.
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

/** Which verbs make sense where. A `read` while staging would find nothing yet. */
const ALLOWED: Record<RecipeSection, readonly RecipeVerb[]> = {
  signedout: ['when'],
  stage: ['wait', 'hover', 'click', 'fill'],
  handover: [],
  verify: ['wait', 'read'],
}

const HEADINGS: Array<{ section: RecipeSection; re: RegExp }> = [
  { section: 'signedout', re: /^#{1,6}\s*signed[\s-]?out\s*$/i },
  { section: 'stage', re: /^#{1,6}\s*stage\s*$/i },
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
  const verify: RecipeStep[] = []
  const prose: Record<RecipeSection, string[]> = { signedout: [], stage: [], handover: [], verify: [] }
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
      handover: seen.has('handover') ? tidy('handover') : null,
      verify,
      prose: {
        signedout: tidy('signedout'),
        stage: tidy('stage'),
        handover: tidy('handover'),
        verify: tidy('verify'),
      },
    },
    issues,
  }
}

/**
 * Whether a human finishes this publish.
 *
 * The presence of the section is the whole signal — an outlet whose recipe says
 * what the operator clicks is one the desk stops short of sending. See
 * docs/browser-publishing.md section 3.
 */
export function hasHandover(recipe: Recipe): boolean {
  return recipe.handover !== null
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
