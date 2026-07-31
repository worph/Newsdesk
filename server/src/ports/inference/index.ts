import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.js'
import { schema as tables } from '../../db/index.js'
import { getSetting } from '../../settings.js'
import type { McpEndpointRef } from '../mcp/client.js'
import { attachAuth } from '../mcp/oauth.js'
import { createClaudeCodeDriver } from './claude-code.js'
import { InferenceUnavailable, type InferenceDriver } from './types.js'

export const INFERENCE_SETTING = {
  driver: 'inference_driver',
  endpoint: 'inference_endpoint',
} as const

/**
 * Build the configured inference driver.
 *
 * The endpoint is a row rather than an environment variable so a deployment
 * can be repointed from the UI, and so /healthz reports on the same object the
 * managing editor actually calls.
 */
export function createInferenceDriver(db: Db): InferenceDriver {
  const driverName = getSetting(db, INFERENCE_SETTING.driver) ?? 'mcp-claude-code'
  const endpoint = resolveEndpoint(db)

  switch (driverName) {
    case 'mcp-claude-code':
      return createClaudeCodeDriver(endpoint)
    default:
      throw new InferenceUnavailable(
        `unknown inference driver "${driverName}" — expected one of: mcp-claude-code`,
      )
  }
}

function resolveEndpoint(db: Db): McpEndpointRef {
  const configured = getSetting(db, INFERENCE_SETTING.endpoint)

  if (configured) {
    const row = db.select().from(tables.mcpEndpoints).where(eq(tables.mcpEndpoints.id, configured)).get()
    if (!row) {
      throw new InferenceUnavailable(
        `inference endpoint "${configured}" is configured but no longer exists — set another in Settings`,
      )
    }
    return attachAuth(db, row)
  }

  // Unset: the single configured endpoint is unambiguous. More than one is a
  // choice we must not make silently, because guessing wrong sends the desk's
  // thinking to the wrong place.
  const all = db.select().from(tables.mcpEndpoints).all()
  if (all.length === 1 && all[0]) return attachAuth(db, all[0])
  if (all.length === 0) {
    throw new InferenceUnavailable('no MCP endpoint configured — add one in Configuration')
  }
  throw new InferenceUnavailable(
    `several MCP endpoints exist (${all.map((e) => e.id).join(', ')}) — choose one in Settings`,
  )
}

export { InferenceUnavailable }
export * from './types.js'
export { extractJson, InferenceFailed, runStructured } from './structured.js'
export type { StructuredRequest } from './structured.js'
