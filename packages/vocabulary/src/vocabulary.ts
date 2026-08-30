import type { JsonRecord } from './json.ts'
import type { ToolCallId } from './ids.ts'

/**
 * The five word maps — the open vocabularies of the fixed language.
 *
 * Each map is an interface whose keys name a word and whose values describe
 * that word's payload. They are extended by declaration merging: a plugin
 * adds a member to a map without touching the owner, and every derived union
 * (see {@link WordOf}) widens automatically. Consumers must stay exhaustive
 * over derived unions and close them with {@link assertNever}, so adding a
 * word surfaces as a compile error at every consumer — the fixed language
 * refuses to grow silently.
 */
export type WordOf<M> = {
  [K in keyof M & string]: { readonly kind: K } & M[K]
}[keyof M & string]

/** Kinds of message content, as derived/derived-merged by {@link Content}. */
export interface ContentMap {
  /** Plain renderable text. */
  text: { readonly text: string }
  /** Model reasoning surfaced alongside the answer; never model-visible input. */
  thinking: { readonly text: string }
}

/** A message-content word: `{ kind }` tagged union over {@link ContentMap}. */
export type Content = WordOf<ContentMap>

/** Kinds of provider-level content blocks, as merged into {@link ContentBlock}. */
export interface ContentBlockMap {
  /** A text block as returned by a provider. */
  text: { readonly text: string }
  /** Model reasoning surfaced beside the answer (e.g. DeepSeek's reasoning_content). */
  thinking: { readonly text: string }
  /** An image block: base64 `data` with its IANA `mediaType`. */
  image: { readonly mediaType: string; readonly data: string }
  /** A tool invocation requested by the model. */
  tool_call: { readonly toolCallId: ToolCallId; readonly name: string; readonly input: JsonRecord }
  /** A tool result handed back to the model. */
  tool_result: { readonly toolCallId: ToolCallId; readonly output: JsonRecord; readonly isError: boolean }
}

/** A content-block word: `{ kind }` tagged union over {@link ContentBlockMap}. */
export type ContentBlock = WordOf<ContentBlockMap>

/** Origins of a user-side message, as merged into {@link MessageSource}. */
export interface MessageSourceMap {
  /** Typed or spoken by a human on some surface (cli, web, sdk…). */
  human: { readonly surface: string }
  /** Injected by the runtime itself, never by the model. */
  system: { readonly reason: string }
  /** Fed back from a tool execution. */
  tool: { readonly toolCallId: ToolCallId }
}

/** A message-source word: `{ kind }` tagged union over {@link MessageSourceMap}. */
export type MessageSource = WordOf<MessageSourceMap>

/** Reasons a model call finished, as merged into {@link FinishReason}. */
export interface FinishReasonMap {
  /** The model ended its output normally. */
  stop: Record<never, never>
  /** Output was cut off by a token limit. */
  length: Record<never, never>
  /** The model asked for tool executions. */
  tool_call: Record<never, never>
  /** The call failed; `message` carries the provider-reported reason. */
  error: { readonly message: string }
  /** The call was cancelled through its AbortSignal. */
  cancelled: Record<never, never>
}

/** A finish-reason word: `{ kind }` tagged union over {@link FinishReasonMap}. */
export type FinishReason = WordOf<FinishReasonMap>

/** Reasons a turn ended, as merged into {@link TurnEndReason}. */
export interface TurnEndReasonMap {
  /** The turn drove its intent to completion. */
  completed: Record<never, never>
  /** The turn was cancelled by its owner. */
  aborted: Record<never, never>
  /** The turn died on an error; `message` names it. */
  error: { readonly message: string }
  /** The turn exhausted its token budget. */
  'max-tokens': Record<never, never>
  /** A pre-step (or governance chokepoint) refused the turn; `reason` says why. */
  blocked: { readonly reason: string }
}

/** A turn-end-reason word: `{ kind }` tagged union over {@link TurnEndReasonMap}. */
export type TurnEndReason = WordOf<TurnEndReasonMap>

/**
 * Close an exhaustive union: the compiler narrows `value` to `never` at every
 * handled member, so reaching this function means the vocabulary grew without
 * the consumer keeping up — fail loud at compile time.
 *
 * @param value — the supposedly-exhausted union value.
 * @returns never; always throws.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled vocabulary member: ${JSON.stringify(String(value))}`)
}
