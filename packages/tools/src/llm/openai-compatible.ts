import { brand, type Content, type ContentBlock, type FinishReason, type JsonRecord, type JsonValue } from '@sudive-ai/datum-vocabulary'
import type { ChatDelta, ChatRequest, ChatResponse, LlmAdapter, ToolView } from './seam.ts'

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

    async stream(request: ChatRequest, onDelta: (delta: ChatDelta) => void): Promise<ChatResponse> {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ ...encodeRequest(request), stream: true }),
        signal: request.signal ?? null,
      })
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        throw new Error(`openai-compatible adapter: provider answered ${response.status}: ${detail.slice(0, 500)}`)
      }

      let text = ''
      let thinking = ''
      // OpenAI streams tool calls as index-keyed fragments that concatenate.
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
      let finish: unknown
      const decoder = new TextDecoder()
      let buffer = ''

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Buffer, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          applyStreamChunk(JSON.parse(payload), {
            onText: piece => {
              text += piece
              onDelta({ kind: 'text', delta: piece })
            },
            onThinking: piece => {
              thinking += piece
              onDelta({ kind: 'thinking', delta: piece })
            },
            onToolCall: (index, id, name, argumentsPiece) => {
              const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' }
              if (id) current.id = id
              if (name) current.name = name
              current.arguments += argumentsPiece
              toolCalls.set(index, current)
            },
            onFinish: reason => {
              finish = reason
            },
          })
        }
      }

      const content: ContentBlock[] = []
      if (thinking.length > 0) content.push({ kind: 'thinking', text: thinking })
      if (text.length > 0) content.push({ kind: 'text', text })
      for (const key of [...toolCalls.keys()].sort((a, b) => a - b)) {
        const call = toolCalls.get(key)!
        let input: JsonRecord
        try {
          input = JSON.parse(call.arguments || '{}') as JsonRecord
        } catch (cause) {
          throw new TypeError('openai-compatible adapter: streamed tool call arguments are not valid JSON', { cause })
        }
        content.push({ kind: 'tool_call', toolCallId: brand<'ToolCallId'>(call.id), name: call.name, input })
      }
      return { finishReason: decodeFinishReason(finish), content, usage: null, providerFinish: typeof finish === 'string' ? finish : undefined }
    },

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

/**
 * Encode a normalized request into the OpenAI chat-completions wire shape.
 *
 * History follows the provider protocol exactly: an assistant message that
 * requested tools carries a native `tool_calls` array, each tool feedback
 * becomes a `role: "tool"` message tied to its `tool_call_id`, and thinking
 * blocks are dropped (reasoning content must not be sent back — the model
 * re-derives it). Encoding tool calls as bracketed prose instead teaches the
 * model to *print* fake calls rather than make real ones.
 */
function encodeRequest(request: ChatRequest): JsonRecord {
  const wire: Array<JsonRecord> = []
  for (const message of request.messages) {
    if (message.role === 'user' && message.toolCallId !== undefined) {
      const feedback: JsonRecord = {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content.map(encodeText).join(''),
      }
      wire.push(feedback)
      continue
    }
    if (message.role === 'assistant') {
      const text = message.content.filter(block => block.kind === 'text').map(block => (block as { text: string }).text).join('')
      const toolCalls = message.content.filter((block): block is Extract<ContentBlock, { kind: 'tool_call' }> => block.kind === 'tool_call')
      const encoded: JsonRecord = toolCalls.length > 0
        ? {
            role: 'assistant',
            content: text.length > 0 ? text : null,
            tool_calls: toolCalls.map(call => ({
              id: call.toolCallId,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          }
        : { role: 'assistant', content: text.length > 0 ? text : null }
      wire.push(encoded)
      continue
    }
    wire.push({ role: 'user', content: message.content.map(encodeContentPart) } satisfies JsonRecord)
  }
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    messages: [
      { role: 'system', content: request.systemPrompt },
      ...wire,
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

/** Encode one content word or block of a user message into a content part. */
function encodeContentPart(word: Content | ContentBlock): JsonRecord {
  if (word.kind === 'text') return { type: 'text', text: word.text }
  if (word.kind === 'tool_result') return { type: 'text', text: JSON.stringify(word.output) }
  return { type: 'text', text: `[${word.kind}]` }
}

/** Flatten message content to plain text (tool feedback bodies). */
function encodeText(word: Content | ContentBlock): string {
  if (word.kind === 'text') return word.text
  if (word.kind === 'tool_result') return JSON.stringify(word.output)
  return ''
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

/** Handlers applied to one `data:` chunk of an OpenAI stream. */
function applyStreamChunk(raw: unknown, handlers: {
  onText: (piece: string) => void
  onThinking: (piece: string) => void
  onToolCall: (index: number, id: string, name: string, argumentsPiece: string) => void
  onFinish: (reason: unknown) => void
}): void {
  if (raw === null || typeof raw !== 'object') return
  const body = raw as Record<string, unknown>
  const choice = (body['choices'] as Array<Record<string, unknown>> | undefined)?.[0]
  if (!choice) return
  const delta = (choice['delta'] ?? {}) as Record<string, unknown>
  if (typeof delta['content'] === 'string') handlers.onText(delta['content'])
  const reasoning = delta['reasoning_content'] ?? delta['reasoning']
  if (typeof reasoning === 'string') handlers.onThinking(reasoning)
  if (Array.isArray(delta['tool_calls'])) {
    for (const fragment of delta['tool_calls'] as Array<Record<string, unknown>>) {
      const index = typeof fragment['index'] === 'number' ? fragment['index'] : 0
      const fn = (fragment['function'] ?? {}) as Record<string, unknown>
      handlers.onToolCall(
        index,
        typeof fragment['id'] === 'string' ? fragment['id'] : '',
        typeof fn['name'] === 'string' ? fn['name'] : '',
        typeof fn['arguments'] === 'string' ? fn['arguments'] : '',
      )
    }
  }
  if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) {
    handlers.onFinish(choice['finish_reason'])
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
