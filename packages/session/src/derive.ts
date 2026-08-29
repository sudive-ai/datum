import type { ChatMessage, MessageId, SessionEvent } from '@sudive-ai/datum-vocabulary'
import { brand } from '@sudive-ai/datum-vocabulary'

export type { ChatMessage } from '@sudive-ai/datum-vocabulary'

/**
 * Fold the log into the derived conversation history — a pure projection.
 *
 * `user/message` and `assistant/message` entries become chat messages in log
 * order; `assistant/chunk` entries are deliberately not consulted (the
 * assembled message already references its chunks), and lifecycle/tool events
 * contribute nothing to the message history. Deriving never reads state that
 * is not in the log: the projection is recomputable from the entries alone.
 *
 * @param events — the log entries, oldest first.
 * @returns the derived message history.
 */
export function deriveMessages(events: readonly SessionEvent[]): readonly ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      messages.push({
        messageId: event.payload.messageId,
        role: 'user',
        content: event.payload.content,
      })
    } else if (event.type === 'assistant/message') {
      messages.push({
        messageId: event.payload.messageId,
        role: 'assistant',
        content: event.payload.content,
      })
    }
  }
  return messages
}

/**
 * Mint a fresh message id.
 *
 * Message identity is assigned by the writer at append time; the format is
 * opaque and only uniqueness within a session matters.
 *
 * @returns a new `MessageId`.
 */
export function newMessageId(): MessageId {
  return brand<'MessageId'>(`msg-${Math.random().toString(36).slice(2, 10)}`)
}
