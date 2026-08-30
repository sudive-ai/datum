import { Service, type Context } from '@sudive-ai/cordis'
import type { ChatDelta, ChatRequest, ChatResponse, LlmAdapter } from './seam.ts'

/**
 * The LLM seam's Consumer role, mounted as `ctx.llm`.
 *
 * Adapters mount through {@link LlmService.use} — a reversible registration
 * (the disposer unmounts exactly what was mounted). Consumers call
 * {@link LlmService.chat} and never import a concrete adapter, so swapping
 * providers touches zero consumer code.
 */
export class LlmService extends Service {
  private _adapter: LlmAdapter | undefined

  /**
   * Mount one adapter; the returned disposer unmounts it (reversibly, in
   * fiber teardown order).
   *
   * @param adapter — the provider implementation to mount.
   * @returns a disposer unmounting this adapter if still mounted.
   */
  use(adapter: LlmAdapter): () => boolean {
    this.ctx.fiber.assertActive()
    this._adapter = adapter
    return () => {
      if (this._adapter === adapter) {
        this._adapter = undefined
        return true
      }
      return false
    }
  }

  /** The mounted adapter; fail loud when none — silence is never a success path. */
  get adapter(): LlmAdapter {
    if (!this._adapter) {
      throw new Error('llm service: no adapter mounted; mount one with ctx.llm.use(adapter)')
    }
    return this._adapter
  }

  /**
   * Place one chat request through the mounted adapter.
   *
   * @param request — the normalized request.
   * @returns the normalized response.
   */
  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.adapter.chat(request)
  }

  /**
   * Place one chat request as a stream; falls back to the non-streaming
   * `chat` (no deltas) when the mounted adapter cannot stream.
   *
   * @param request — the normalized request.
   * @param onDelta — receives each incremental piece, in arrival order.
   * @returns the complete normalized response.
   */
  stream(request: ChatRequest, onDelta: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const adapter = this.adapter
    return adapter.stream ? adapter.stream(request, onDelta) : adapter.chat(request)
  }
}

declare module '@sudive-ai/cordis' {
  interface Context {
    /** The LLM seam; adapters mount via `ctx.llm.use(...)`. */
    llm: LlmService
  }
}
