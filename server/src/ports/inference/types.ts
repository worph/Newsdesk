/**
 * One operation — "given this context, produce this structured result" — at
 * two capability levels. A driver that can call tools gets a generated schema
 * that makes an invalid result impossible; a driver that cannot is asked for
 * JSON and the app validates it. Everything above this interface is written
 * once, against the weaker guarantee.
 *
 * See ARCHITECTURE.md section 4.2 and IMPLEMENTATION.md section 5.3.
 */

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>
}

export interface InferenceRequest {
  prompt: string
  /** Offered only to a driver that can call tools. */
  tools?: ToolSchema[]
  timeoutMs?: number
}

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface InferenceResult {
  /** Raw text as returned. Empty when the driver answered with tool calls. */
  text: string
  toolCalls?: ToolCall[]
}

export interface InferenceCapabilities {
  /**
   * True when the driver constrains output with a real tool schema. False
   * means the same request is made in prose and validated after the fact.
   */
  toolCalling: boolean
}

export interface InferenceDriver {
  readonly name: string
  readonly capabilities: InferenceCapabilities
  run(request: InferenceRequest): Promise<InferenceResult>
}

/** Raised when a driver cannot be built — misconfiguration, not a call failure. */
export class InferenceUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InferenceUnavailable'
  }
}
