import type { SessionEvent } from '@sudive-ai/datum-vocabulary'

/** A file touched during the conversation, viewable in the page. */
export interface ChatFileView {
  readonly path: string
  readonly content: string
}

/**
 * One entry of the chat view.
 *
 * `message` entries render as chat bubbles (role + prose); `activity`
 * entries render collapsed with a summary line (`text`) and expandable
 * detail — thinking, tool calls with their input/output, and file views.
 */
export interface ChatViewEntry {
  readonly kind: 'message' | 'activity'
  /** For message entries. */
  readonly role?: 'user' | 'assistant'
  /** Message prose, or the collapsed summary line of an activity. */
  readonly text: string
  /** Expandable detail (full thinking, tool input/output). */
  readonly detail?: string
  /** Set when the activity touched a file — the page renders it viewable. */
  readonly file?: ChatFileView
  readonly isError?: boolean
}

/** The full chat view state a UI renders. */
export interface ChatViewState {
  readonly entries: readonly ChatViewEntry[]
  /** Only the message entries, in order — convenience for simple renderers. */
  readonly messages: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>
  /** Coarse turn indicator for the UI. */
  readonly busy: boolean
}

/**
 * The pure presenter: folds session events into the chat view.
 *
 * The same fold serves live rendering (fed `session/event` broadcasts one by
 * one) and historical replay (fed reloaded entries) — the M4 gate demands the
 * two produce identical state, so the UI has exactly one rendering path.
 *
 * Folding rules: prose becomes bubbles; thinking, tool calls, and tool
 * results become collapsed activity entries (a `tool/call` opens one, its
 * `tool/result` completes it with output — and for file tools the result
 * carries a viewable file); streamed chunks accumulate into a growing
 * partial bubble until the assembled message replaces them.
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
  const entries: ChatViewEntry[] = []
  /** Per top call: the still-streaming thinking (folded live) and prose. */
  const streaming = new Map<string, { thinking: string; text: string }>()
  /** toolCallId → index of its open activity entry, plus what it invoked. */
  const openTools = new Map<string, { index: number; name: string; input: Record<string, unknown> }>()
  let busy = false

  return {
    apply(event: SessionEvent): void {
      switch (event.type) {
        case 'assistant/chunk': {
          const delta = event.payload.delta
          if (typeof delta['text'] !== 'string') return
          const kind = delta['kind'] === 'thinking' ? 'thinking' as const : 'text' as const
          const buffer = streaming.get(event.payload.topCallId) ?? { thinking: '', text: '' }
          // Thinking folds live into a collapsed activity — it never widens
          // into a prose bubble while it streams.
          buffer[kind] += delta['text']
          streaming.set(event.payload.topCallId, buffer)
          return
        }
        case 'user/message': {
          const { source } = event.payload
          if (source.kind === 'tool') return // tool feedback folds into the tool activity, not a bubble
          entries.push({
            kind: 'message',
            role: 'user',
            text: event.payload.content.map(word => (word.kind === 'text' ? word.text : `[${word.kind}]`)).join(''),
          })
          return
        }
        case 'ask/requested':
          entries.push({
            kind: 'message',
            role: 'assistant',
            text: event.payload.choices.length > 0
              ? `${event.payload.question}\n（选项：${event.payload.choices.join(' / ')}）`
              : event.payload.question,
          })
          return
        case 'assistant/message': {
          streaming.delete(event.payload.topCallId)
          let prose = ''
          const flushProse = (): void => {
            if (prose.length > 0) {
              entries.push({ kind: 'message', role: 'assistant', text: prose })
              prose = ''
            }
          }
          for (const block of event.payload.content) {
            if (block.kind === 'text') {
              prose += block.text
            } else if (block.kind === 'thinking') {
              flushProse()
              entries.push({ kind: 'activity', text: '💭 思考过程', detail: block.text })
            } else if (block.kind === 'tool_call') {
              flushProse()
              entries.push({
                kind: 'activity',
                text: `🔧 调用 ${block.name}`,
                detail: JSON.stringify(block.input, null, 2),
              })
              openTools.set(block.toolCallId, {
                index: entries.length - 1,
                name: block.name,
                input: block.input as Record<string, unknown>,
              })
            }
          }
          flushProse()
          return
        }
        case 'tool/call': {
          // Standalone call fact (without an assembled message): open its activity.
          if (!openTools.has(event.payload.toolCallId)) {
            entries.push({
              kind: 'activity',
              text: `🔧 调用 ${event.payload.name}`,
              detail: JSON.stringify(event.payload.input, null, 2),
            })
            openTools.set(event.payload.toolCallId, {
              index: entries.length - 1,
              name: event.payload.name,
              input: event.payload.input,
            })
          }
          return
        }
        case 'tool/result': {
          const { toolCallId, output, isError } = event.payload
          const open = openTools.get(toolCallId)
          openTools.delete(toolCallId)
          const input = open?.input ?? {}
          const path = typeof input['path'] === 'string' ? input['path'] : undefined
          let summary = `${open?.name ?? 'tool'}${isError ? '（失败）' : ''}`
          let detail = JSON.stringify(output, null, 2)
          let file: ChatFileView | undefined
          if (open?.name === 'read_file' && typeof path === 'string' && !isError) {
            summary = `📄 读取 ${path}`
            const content = (output as { content?: unknown })['content']
            if (typeof content === 'string') file = { path, content }
          } else if (open?.name === 'write_file' && typeof path === 'string' && !isError) {
            summary = `✏️ 写入 ${path}`
            const content = typeof input['content'] === 'string' ? input['content'] : ''
            file = { path, content }
          } else if (open?.name === 'list_files' && !isError) {
            summary = `📂 列目录${typeof path === 'string' && path !== '.' ? ` ${path}` : ''}`
            const listing = (output as { entries?: unknown })['entries']
            if (Array.isArray(listing)) detail = (listing as unknown[]).map(String).join('\n')
          }
          const completed: ChatViewEntry = file !== undefined
            ? { kind: 'activity', text: summary, detail, file, isError }
            : { kind: 'activity', text: summary, detail, isError }
          if (open) {
            entries[open.index] = completed
          } else {
            entries.push(completed)
          }
          return
        }
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
      const all = [...entries]
      for (const buffer of streaming.values()) {
        if (buffer.thinking.length > 0) all.push({ kind: 'activity', text: '💭 思考过程', detail: buffer.thinking })
        if (buffer.text.length > 0) all.push({ kind: 'message', role: 'assistant', text: `${buffer.text}…` })
      }
      return {
        entries: all,
        messages: all
          .filter((entry): entry is ChatViewEntry & { role: 'user' | 'assistant' } => entry.kind === 'message')
          .map(({ role, text }) => ({ role, text })),
        busy,
      }
    },
  }
}
