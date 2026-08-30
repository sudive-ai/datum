import type { JsonRecord } from '@sudive-ai/datum-vocabulary'

/**
 * The Agent contract — what it takes to run a harness, before any behavior.
 *
 * An agent is a composition (a preset), never runtime code: name, prompt, and
 * call configuration. Behavior enters as plugins on the waterfalls and as
 * registered tools; the runtime itself stays domain-free.
 */
export interface AgentSpec {
  /** Human-readable agent identity; appears in status and logs. */
  readonly name: string
  /** The base system prompt; the pre-step waterfall assembles on top of it. */
  readonly systemPrompt: string
  /** The model identifier handed to the LLM seam. */
  readonly model: string
  /** Default output-token budget. */
  readonly maxTokens: number
  /** Provider-specific call options. */
  readonly options: JsonRecord
  /** Which surface the agent runs on (cli, web, sdk…), for diagnostics. */
  readonly surface: string
  /**
   * Long-conversation compaction policy; omit to disable. When the log
   * exceeds `maxEntries`, the oldest `entries - keepRecent` facts are folded
   * into a logged `context/compacted` summary before the next turn starts.
   */
  readonly compaction?: { readonly maxEntries: number; readonly keepRecent: number } | undefined
}
