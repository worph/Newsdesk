import { callTool, type McpEndpointRef } from '../mcp/client.js'
import type { InferenceDriver, InferenceRequest, InferenceResult } from './types.js'

/**
 * Inference through `claude-code__query_claude` behind a Beacon.
 *
 * `toolCalling: false` — this driver cannot be handed a schema, so the same
 * request is made in prose and the app validates the answer. That is the
 * weaker of the two capability levels, which is exactly why it ships first:
 * everything built on top is written against the weaker guarantee, and the
 * tool-calling driver then becomes a strict improvement rather than a rewrite.
 *
 * It is the day-one driver for our deployment because it bills against an
 * existing account rather than metered tokens.
 */
export const CLAUDE_CODE_TOOL = 'claude-code__query_claude'

/** Publish-class calls get a generous ceiling; the queue is what absorbs the wait. */
const DEFAULT_TIMEOUT_MS = 280_000

export function createClaudeCodeDriver(endpoint: McpEndpointRef): InferenceDriver {
  return {
    name: 'mcp-claude-code',
    capabilities: { toolCalling: false },

    async run(request: InferenceRequest): Promise<InferenceResult> {
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const result = await callTool(
        endpoint,
        CLAUDE_CODE_TOOL,
        {
          prompt: request.prompt,
          // The tool takes its own timeout in seconds and enforces it upstream.
          // Kept just under ours so the upstream gives up first and we get its
          // message rather than an opaque transport abort.
          timeout: Math.max(30, Math.floor(timeoutMs / 1000) - 20),
        },
        { timeoutMs },
      )
      return { text: result.text }
    },
  }
}
