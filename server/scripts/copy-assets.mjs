import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Prompts are prose, so they live as .md files rather than as string literals
 * in TypeScript — a prompt full of JSON examples and backticks is exactly the
 * thing you do not want to be escaping. tsc does not copy non-TS assets, and
 * the runtime image only takes `server/dist`, so they are copied in here.
 */
const root = fileURLToPath(new URL('..', import.meta.url))

for (const dir of ['prompts']) {
  const from = `${root}src/${dir}`
  if (!existsSync(from)) continue
  // Only the prose. The .ts alongside it is compiled by tsc, and copying the
  // source into dist would ship two versions of the same module.
  cpSync(from, `${root}dist/${dir}`, {
    recursive: true,
    filter: (src) => !src.endsWith('.ts'),
  })
}
