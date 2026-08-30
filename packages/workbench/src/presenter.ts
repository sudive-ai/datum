import type { SessionEvent } from '@sudive-ai/datum-vocabulary'

/** One row of the chat view: a renderable message. */
export interface ChatViewMessage {
  readonly role: 'user' | 'assistant'
  /** The renderable text (text words joined; blocks rendered as placeholders). */
  readonly text: string
}

/** The full chat view state a UI renders. */
export interface ChatViewState {
  readonly messages: readonly ChatViewMessage[]
  /** Coarse turn indicator for the UI. */
  readonly busy: boolean
}

/**
 * The pure presenter: folds session events into the chat view.
 *
 * The same fold serves live rendering (fed `session/event` broadcasts one by
 * one) and historical replay (fed reloaded entries) — the M4 gate demands the
 * two produce identical state, so the UI has exactly one rendering path.
 */
export interface ChatPresenter {
  /**
   * Apply one event to the view state.
   *
   * @param event — the session event to fold.
   */
  apply(event: SessionEvent): void
  /** The current view state (a fresh snapshot; safe to hand to a renderer). */
  snapshot(): ChatViewState
}

/** Create a fresh presenter with an empty view. */
export function createChatPresenter(): ChatPresenter {
  const messages: ChatViewMessage[] = []
  const streaming = new Map<string, string>()
  let busy = false

  return {
    apply(event: SessionEvent): void {
      switch (event.type) {
        case 'assistant/chunk': {
          const delta = event.payload.delta
          if (typeof delta['text'] === 'string') {
            const current = streaming.get(event.payload.topCallId) ?? ''
            streaming.set(event.payload.topCallId, current + delta['text'])
          }
          return
        }
        case 'user/message': {
          const { source } = event.payload
          if (source.kind === 'tool') return // tool feedback renders inside the conversation flow, not as a human bubble
          messages.push({
            role: 'user',
            text: event.payload.content.map(word => (word.kind === 'text' ? word.text : `[${word.kind}]`)).join(''),
          })
          return
        }
        case 'assistant/message':
          streaming.delete(event.payload.topCallId)
          messages.push({
            role: 'assistant',
            text: event.payload.content
              .map(block => {
                if (block.kind === 'text') return block.text
                if (block.kind === 'tool_call') return `[calls ${block.name}]`
                if (block.kind === 'tool_result') return `[tool ${block.isError ? 'failed' : 'ok'}]`
                return `[${block.kind}]`
              })
              .join(''),
          })
          return
        case 'ask/requested':
          messages.push({
            role: 'assistant',
            text: event.payload.choices.length > 0
              ? `${event.payload.question}\n（选项：${event.payload.choices.join(' / ')}）`
              : event.payload.question,
          })
          return
        case 'turn/start':
          busy = true
          return
        case 'turn/end':
          busy = false
          return
        default:
          return
      }
    },

    snapshot(): ChatViewState {
      const partials = [...streaming.values()]
        .filter(text => text.length > 0)
        .map(text => ({ role: 'assistant' as const, text: `${text}…` }))
      return { messages: [...messages, ...partials], busy }
    },
  }
}
