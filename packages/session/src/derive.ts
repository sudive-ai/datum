import type { ChatMessage, MessageId, SessionEvent } from '@sudive-ai/datum-vocabulary'
import { brand } from '@sudive-ai/datum-vocabulary'


export type { ChatMessage } from '@sudive-ai/datum-vocabulary'

/**
 * Fold the log into the derived conversation history — a pure projection.
 *
 * `user/message` and `assistant/message` entries become chat messages in log
 * order; `assistant/chunk` entries are deliberately not consulted (the
 * assembled message already references its chunks), and lifecycle/tool events
 * contribute nothing to the message history. When the log carries a
 * `context/compacted` fact, everything before it is replaced by its summary
 * (surfaced as the first user-side message) and derivation resumes from
 * `keptFromSeq`. Deriving never reads state that is not in the log: the
 * projection is recomputable from the entries alone.
 *
 * @param events — the log entries, oldest first.
 * @returns the derived message history.
 */
export function deriveMessages(events: readonly SessionEvent[]): readonly ChatMessage[] {
  const messages: ChatMessage[] = []
  let keptFromSeq = 0
  let summary: string | undefined
  for (const event of events) {
    if (event.type === 'context/compacted') {
      summary = event.payload.summary
      keptFromSeq = event.payload.keptFromSeq
      messages.length = 0
      messages.push({
        messageId: brand<'MessageId'>(`summary-${event.seq}`),
        role: 'user',
        content: [{ kind: 'text', text: `[earlier conversation, summarized] ${summary}` }],
      })
    }
  }
  for (const event of events) {
    if (event.seq < keptFromSeq) continue
    if (event.type === 'context/compacted') continue
    if (event.type === 'user/message') {
      const { source } = event.payload
      messages.push({
        messageId: event.payload.messageId,
        role: 'user',
        content: event.payload.content,
        // Tool feedback keeps its call linkage: the provider encoding turns
        // it into a role:"tool" message tied to the tool_call_id.
        ...(source.kind === 'tool' ? { toolCallId: source.toolCallId } : {}),
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

