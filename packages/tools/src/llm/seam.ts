import type { ChatMessage, ContentBlock, FinishReason, JsonRecord } from '@sudive-ai/datum-vocabulary'

/** The provider-facing view of one registered tool. */
export interface ToolView {
  readonly name: string
  readonly description: string
  /** JSON Schema describing the tool's input object. */
  readonly parameters: JsonRecord
}

/**
 * One model request, exactly as the caller intends it to be visible.
 *
 * Everything here is a fact that the loop logs (`request/header`,
 * `request/context`); the seam cannot smuggle in un-logged model-visible
 * content, because there is no channel for it (model-visible ⟺ logged).
 */
export interface ChatRequest {
  /** The model identifier as the provider understands it. */
  readonly model: string
  /** Hard output-token budget for the call. */
  readonly maxTokens: number
  /** Provider-specific call options (temperature, top_p, …). */
  readonly options: JsonRecord
  /** The system prompt for this call. */
  readonly systemPrompt: string
  /** The conversation history visible to the model. */
  readonly messages: readonly ChatMessage[]
  /** The tools the model may call. */
  readonly tools: readonly ToolView[]
  /** Cancellation signal; aborting must settle the promise immediately. */
  readonly signal: AbortSignal | undefined
}

/** One model response, normalized into the fixed language. */
export interface ChatResponse {
  /** Why the call finished. */
  readonly finishReason: FinishReason
  /** The produced content blocks (text and/or tool calls). */
  readonly content: readonly ContentBlock[]
  /** Provider-reported token usage, when the provider reports it. */
  readonly usage: JsonRecord | null
  /** Raw provider finish text, for adapters that carry one (e.g. OpenAI). */
  readonly providerFinish?: string | undefined
}

/** One incremental piece of a streaming response. */
export interface ChatDelta {
  readonly kind: 'text' | 'thinking'
  /** The piece of text that arrived. */
  readonly delta: string
}

/**
 * The LLM seam's Definition role: everything a consumer may rely on and a
 * provider must fulfill. Two adapters complete the seam — an OpenAI-compatible
 * REST adapter (real) and a mock adapter (the primary test infrastructure).
 */
export interface LlmAdapter {
  /** Provider identity, e.g. `'openai-compatible'` or `'mock'`. */
  readonly name: string
  /**
   * Place one chat request.
   *
   * @param request — the normalized request.
   * @returns the normalized response.
   * @throws when the provider fails; the loop turns failures into logged
   *   facts, adapters must not swallow them.
   */
  chat(request: ChatRequest): Promise<ChatResponse>
  /**
   * Place one chat request as a stream, reporting deltas as they arrive.
   * Optional: consumers fall back to {@link chat} when absent. The returned
   * response is always the complete assembled one — deltas are a live view,
   * the response is the fact.
   *
   * @param request — the normalized request.
   * @param onDelta — called with each incremental piece, in arrival order.
   * @returns the complete normalized response.
   */
  stream?(request: ChatRequest, onDelta: (delta: ChatDelta) => void): Promise<ChatResponse>
}
