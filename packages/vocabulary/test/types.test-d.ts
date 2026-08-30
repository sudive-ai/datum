/**
 * Compile-time vocabulary assertions.
 *
 * This file is never executed; `pnpm typecheck` compiles it, and every
 * `@ts-expect-error` must be *used* — if an assignment unexpectedly succeeds,
 * the build fails. Nominality and exhaustiveness are enforced here, at
 * compile time, exactly where the fixed language lives.
 */
import type {
  Content,
  ContentBlock,
  ContentMap,
  FinishReason,
  MessageSource,
  SessionEvent,
  SessionEventMap,
  TurnEndReason,
} from '@sudive-ai/datum-vocabulary'
import assert from 'node:assert/strict'
import { assertNever, brand, brandNumber } from '@sudive-ai/datum-vocabulary'

// --- Branded IDs are nominal: mixing them is a compile error ---------------

const sessionId = brand<'SessionId'>('s-1')
const topCallId = brand<'TopCallId'>('call-1')

// @ts-expect-error SessionId is not assignable to TopCallId
const mixed: typeof topCallId = sessionId
mixed

// @ts-expect-error TopCallId is not assignable to SessionId
const mixedBack: typeof sessionId = topCallId
mixedBack

const seq = brandNumber<'EntrySeq'>(0)
// @ts-expect-error EntrySeq (number-branded) is not a string-branded SessionId
const seqAsSession: typeof sessionId = seq
seqAsSession

// Branded values stay primitives at runtime: comparable and serializable.
assert.equal(sessionId, 's-1')
assert.equal(seq, 0)

// --- Derived unions are tagged and exhaustive ------------------------------

// Parameters arrive as the full union — narrowing inside the switch must
// cover every member before assertNever closes the chain.
function explainTurnEnd(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed':
    case 'aborted':
    case 'max-tokens':
      return reason.kind
    case 'error':
      return reason.message
    case 'blocked':
      return reason.reason
    default:
      return assertNever(reason)
  }
}
explainTurnEnd({ kind: 'blocked', reason: 'pre-step refused' })
explainTurnEnd({ kind: 'error', message: 'provider down' })

function explainFinish(finish: FinishReason): string {
  switch (finish.kind) {
    case 'stop':
    case 'length':
    case 'tool_call':
    case 'cancelled':
      return finish.kind
    case 'error':
      return finish.message
    default:
      return assertNever(finish)
  }
}
explainFinish({ kind: 'error', message: 'rate limited' })

function describeSource(source: MessageSource): string {
  switch (source.kind) {
    case 'human':
      return source.surface
    case 'system':
      return source.reason
    case 'tool':
      return source.toolCallId
    default:
      return assertNever(source)
  }
}
describeSource({ kind: 'tool', toolCallId: brand<'ToolCallId'>('tc-1') })

function describeBlock(block: ContentBlock): string {
  switch (block.kind) {
    case 'text':
      return block.text
    case 'thinking':
      return block.text
    case 'image':
      return block.mediaType
    case 'tool_call':
      return block.name
    case 'tool_result':
      return block.toolCallId
    default:
      return assertNever(block)
  }
}
describeBlock({ kind: 'tool_call', toolCallId: brand<'ToolCallId'>('tc-1'), name: 'search', input: { q: 'x' } })

// --- Word maps stay open for declaration merging ---------------------------

declare module '@sudive-ai/datum-vocabulary' {
  interface ContentMap {
    // A downstream plugin adds a word without touching the owner.
    custom_word: { readonly note: string }
  }
}

// The merged word is now part of the union everywhere — the consumer below
// must keep up (its switch covers the new member) or assertNever refuses.
function renderExtended(content: Content): string {
  switch (content.kind) {
    case 'text':
      return content.text
    case 'thinking':
      return content.text
    case 'custom_word':
      return content.note
    default:
      return assertNever(content)
  }
}
renderExtended({ kind: 'custom_word', note: 'merged by a plugin' })
renderExtended({ kind: 'text', text: 'still works' })

const widened: ContentMap['custom_word'] = { note: 'ok' }
widened

// --- Session events are typed end-to-end -----------------------------------

const event: SessionEvent<'user/message'> = {
  seq: 0,
  time: 0,
  type: 'user/message',
  payload: {
    sessionId: brand<'SessionId'>('s-1'),
    messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'text', text: 'hello' }],
    source: { kind: 'human', surface: 'test' },
  },
}
event.payload.content

// @ts-expect-error every payload field is required-on-read
const missingField: SessionEventMap['turn/start'] = { sessionId: brand<'SessionId'>('s-1'), turnId: brand<'TurnId'>('t-1') }
missingField
