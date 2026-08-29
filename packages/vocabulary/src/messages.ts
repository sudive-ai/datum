import type { Content, ContentBlock } from './vocabulary.ts'
import type { MessageId } from './ids.ts'

/**
 * One message of the model-visible conversation history.
 *
 * This is the shape the LLM seam consumes and `deriveMessages()` produces;
 * whatever reaches a model request is built from these and must therefore be
 * reconstructable from the log (model-visible ⟺ logged).
 */
export interface ChatMessage {
  /** Identity of the message in the log (`user/message` / `assistant/message`). */
  readonly messageId: MessageId
  /** `'user'` for user-side input, `'assistant'` for model output. */
  readonly role: 'user' | 'assistant'
  /** The typed content words/blocks of the message. */
  readonly content: readonly (Content | ContentBlock)[]
}
