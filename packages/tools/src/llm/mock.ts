import { deepFreeze } from '../freeze.ts'
import type { ChatDelta, ChatRequest, ChatResponse, LlmAdapter } from './seam.ts'

/**
 * Canonical JSON key of a request — the snapshot identity for the mock.
 *
 * The model-visible request surface (model, messages, system prompt, tools,
 * options) decides replay identity; the abort signal is deliberately excluded.
 *
 * @param request — the normalized request.
 * @returns a stable textual key.
 */
export function mockRequestKey(request: ChatRequest): string {
  const surface = {
    model: request.model,
    maxTokens: request.maxTokens,
    options: request.options,
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    tools: request.tools,
  }
  return JSON.stringify(surface)
}

/**
 * The mock adapter — the primary test infrastructure of the LLM seam.
 *
 * Two modes, composable:
 * - **script**: a `handler` (or an ordered response list) produces answers;
 *   used to drive behaviors in tests.
 * - **snapshot**: recorded request → response pairs replay *keylessly* (no
 *   provider, no API key). A request without a snapshot refuses loudly —
 *   model-visible behavior changes must update the snapshot, never fall
 *   through.
 */
export class MockAdapter implements LlmAdapter {
  readonly name = 'mock'

  private readonly _handler: ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>) | undefined
  private readonly _snapshots = new Map<string, ChatResponse>()
  private readonly _script: ChatResponse[] | undefined
  private _scriptIndex = 0

  /**
   * @param options — `handler` takes precedence; else `script` is consumed in
   *   order (repeating the last entry when exhausted); else snapshot-only.
   */
  constructor(options: {
    handler?: (request: ChatRequest) => ChatResponse | Promise<ChatResponse>
    script?: readonly ChatResponse[]
  } = {}) {
    this._handler = options.handler
    this._script = options.script ? [...options.script] : undefined
  }

  /** Record one request → response pair for keyless snapshot replay. */
  record(request: ChatRequest, response: ChatResponse): void {
    this._snapshots.set(mockRequestKey(request), deepFreeze(structuredClone(response)))
  }

  /** How many snapshots are held. */
  get snapshotCount(): number {
    return this._snapshots.size
  }

  async stream(request: ChatRequest, onDelta: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const response = await this.chat(request)
    for (const block of response.content) {
      if (block.kind === 'text') onDelta({ kind: 'text', delta: block.text })
    }
    return response
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this._handler) return deepFreeze(await this._handler(request))
    if (this._script && this._script.length > 0) {
      const index = Math.min(this._scriptIndex, this._script.length - 1)
      this._scriptIndex++
      return deepFreeze(structuredClone(this._script[index]!))
    }
    const snapshot = this._snapshots.get(mockRequestKey(request))
    if (!snapshot) {
      throw new Error('mock adapter: no snapshot recorded for this request; a model-visible change must update the snapshot')
    }
    return structuredClone(snapshot)
  }
}
