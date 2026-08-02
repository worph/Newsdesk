import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Prompts are prose in .md files, copied into dist at build time. Loaded once
 * and cached: they change with a deploy, not between calls.
 */
const cache = new Map<string, string>()

export type PromptName =
  | 'managing-editor'
  | 'writer'
  | 'copy-desk'
  /** What to look up next, once per round of the reporting loop. */
  | 'reporter-steer'
  /** The dossier, written once from everything the desk retrieved. */
  | 'reporter-file'
  /** Helping an editor shape a tip before it is filed. */
  | 'tip-desk'
  /** Diagnosing one logged failure and proposing remedies for it. */
  | 'assist'

export function loadPrompt(name: PromptName): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  const path = fileURLToPath(new URL(`./${name}.md`, import.meta.url))
  const text = readFileSync(path, 'utf8')
  cache.set(name, text)
  return text
}

/**
 * Replace `{{TOKEN}}` placeholders. Only the tokens supplied are touched, so
 * anything brace-shaped that survives into the prompt is left exactly as
 * written rather than silently blanked.
 */
export function fillPrompt(template: string, values: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value)
  }
  return out
}
