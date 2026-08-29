import { brand, type Content, type ContentBlock, type FinishReason, type JsonRecord } from '@sudive-ai/datum-vocabulary'
import type { ChatRequest, ChatResponse, LlmAdapter, ToolView } from './seam.ts'

/** Configuration for {@link createOpenAICompatibleAdapter}; all fields required (fail loud). */
export interface OpenAICompatibleConfig {
  /** Base URL, e.g. `https://api.openai.com/v1` — `/chat/completions` is appended. */
  baseUrl: string
  /** Bearer token; mount it from the environment, never from the log. */
  apiKey: string
  /** Default model used when a request does not carry a more specific one. */
  model: string
}

/**
 * The OpenAI-compatible REST adapter — the real Provider of the LLM seam.
 *
 * Speaks `POST {baseUrl}/chat/completions` with a bearer token through
 * `fetch`; no vendor SDK. The response is normalized into the fixed language;
 * an unmappable finish reason becomes a `FinishReason` error word rather than
 * a silent fallback.
 *
 * @param config — required connection config; missing fields fail at creation.
 * @param fetchImpl — injectable fetch (tests stub it); defaults to globalThis.fetch.
 * @returns the adapter.
 */
export function createOpenAICompatibleAdapter(
  config: OpenAICompatibleConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): LlmAdapter {
  if (!config.baseUrl) throw new TypeError('openai-compatible adapter: baseUrl is required')
  if (!config.apiKey) throw new TypeError('openai-compatible adapter: apiKey is required (mount from the environment)')
  if (!config.model) throw new TypeError('openai-compatible adapter: model is required')
  const endpoint = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`

  return {
    name: 'openai-compatible',

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const body = encodeRequest(request)
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal ?? null,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`openai-compatible adapter: provider answered ${response.status}: ${detail.slice(0, 500)}`)
      }
      return decodeResponse((await response.json()) as unknown)
    },
  }
}

/** Encode a normalized request into the OpenAI chat-completions wire shape. */
function encodeRequest(request: ChatRequest): JsonRecord {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    messages: [
      { role: 'system', content: request.systemPrompt },
      ...request.messages.map(message => ({
        role: message.role,
        content: message.content.map(encodeContentWord),
      })),
    ],
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool: ToolView) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
    ...request.options,
  } satisfies JsonRecord
}

/** Encode one content word or block into an OpenAI message content part. */
function encodeContentWord(word: Content | ContentBlock): JsonRecord {
  const kind = word.kind
  if (kind === 'text') return { type: 'text', text: word.text }
  if (kind === 'thinking') return { type: 'text', text: `<thinking>${word.text}</thinking>` }
  if (kind === 'tool_call') {
    return { type: 'text', text: `[the assistant called tool ${word.name} with ${JSON.stringify(word.input)}]` }
  }
  if (kind === 'tool_result') {
    return { type: 'text', text: `[tool result: ${JSON.stringify(word.output)}]` }
  }
  return { type: 'text', text: `[image ${word.mediaType}]` }
}

/** Decode the provider JSON into the normalized response; unknown shapes fail loud. */
function decodeResponse(raw: unknown): ChatResponse {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('openai-compatible adapter: response is not a JSON object')
  }
  const body = raw as Record<string, unknown>
  const choices = body['choices']
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TypeError('openai-compatible adapter: response carries no choices')
  }
  const choice = choices[0] as Record<string, unknown>
  const message = (choice['message'] ?? {}) as Record<string, unknown>
  const content: ContentBlock[] = []
  const text = message['content']
  if (typeof text === 'string' && text.length > 0) {
    content.push({ kind: 'text', text })
  }
  const toolCalls = message['tool_calls']
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      content.push(decodeToolCall(call))
    }
  }
  return {
    finishReason: decodeFinishReason(choice['finish_reason']),
    content,
    usage: (body['usage'] ?? null) as JsonRecord | null,
    providerFinish: typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : undefined,
  }
}

/** Decode one OpenAI tool call into a `tool_call` content block. */
function decodeToolCall(raw: unknown): ContentBlock {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('openai-compatible adapter: tool call is not an object')
  }
  const call = raw as Record<string, unknown>
  const fn = (call['function'] ?? {}) as Record<string, unknown>
  if (typeof call['id'] !== 'string' || typeof fn['name'] !== 'string') {
    throw new TypeError('openai-compatible adapter: tool call lacks id/name')
  }
  let input: JsonRecord
  try {
    input = JSON.parse(typeof fn['arguments'] === 'string' ? fn['arguments'] : '{}') as JsonRecord
  } catch (cause) {
    throw new TypeError('openai-compatible adapter: tool call arguments are not valid JSON', { cause })
  }
  return { kind: 'tool_call', toolCallId: brand<'ToolCallId'>(call['id']), name: fn['name'], input }
}

/** Map the provider finish text onto the fixed `FinishReason` vocabulary. */
function decodeFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'stop':
      return { kind: 'stop' }
    case 'length':
      return { kind: 'length' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool_call' }
    case 'content_filter':
      return { kind: 'error', message: 'provider content filter stopped the call' }
    default:
      return { kind: 'error', message: `unmapped provider finish reason: ${String(raw)}` }
  }
}
