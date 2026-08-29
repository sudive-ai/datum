import test from 'node:test'
import assert from 'node:assert/strict'

import type { SessionEvent, SessionEventType } from '@sudive-ai/datum-vocabulary'
import { brand } from '@sudive-ai/datum-vocabulary'
import { parseSessionLog, serializeSessionLog, SessionLog } from '@sudive-ai/datum-session'
import { createChatPresenter } from '../src/index.ts'

const SESSION = brand<'SessionId'>('sess-live')

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES: SessionEventType[] = [
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'user/message', 'assistant/chunk', 'assistant/message',
  'tool/call', 'tool/result', 'request/header', 'request/context', 'session/end-seed',
]

function buildEvent(random: () => number, seq: number): SessionEvent {
  const type = TYPES[Math.floor(random() * TYPES.length)]!
  const turnId = brand<'TurnId'>('t-1')
  const messageId = brand<'MessageId'>(`m-${seq}`)
  const topCallId = brand<'TopCallId'>('c-1')
  const toolCallId = brand<'ToolCallId'>(`tc-${seq}`)
  const payload: Record<string, unknown> = (() => {
    switch (type) {
      case 'turn/start': return { sessionId: SESSION, turnId, trigger: messageId }
      case 'turn/end': return { sessionId: SESSION, turnId, reason: random() < 0.5 ? { kind: 'completed' } : { kind: 'blocked', reason: 'x' } }
      case 'step/start': return { sessionId: SESSION, turnId, stepId: brand<'StepId'>('s-1') }
      case 'step/end': return { sessionId: SESSION, turnId, stepId: brand<'StepId'>('s-1'), finishReason: { kind: 'stop' } }
      case 'user/message': return {
        sessionId: SESSION, messageId,
        content: [{ kind: 'text', text: `u-${seq}` }],
        source: random() < 0.5 ? { kind: 'human', surface: 'web' } : { kind: 'tool', toolCallId },
      }
      case 'assistant/chunk': return { sessionId: SESSION, topCallId, chunkSeq: 0, delta: { text: 'x' } }
      case 'assistant/message': return {
        sessionId: SESSION, topCallId, messageId,
        content: [{ kind: 'text', text: `a-${seq}` }],
        chunkSeqs: [0], finishReason: { kind: 'stop' },
      }
      case 'tool/call': return { sessionId: SESSION, topCallId, toolCallId, name: 'echo', input: {} }
      case 'tool/result': return { sessionId: SESSION, toolCallId, output: { ok: 1 }, isError: false }
      case 'request/header': return { sessionId: SESSION, turnId, topCallId, reason: 'initial', model: 'm' }
      case 'request/context': return { sessionId: SESSION, topCallId, context: { messages: [] } }
      case 'session/end-seed': return { sessionId: SESSION, reason: { kind: 'completed' } }
    }
  })()
  return { seq: seq, time: 0, type, payload } as unknown as SessionEvent
}

test('live = replay: incremental folding and full-replay folding produce identical views', () => {
  const random = mulberry32(7)
  const live = createChatPresenter()
  const replay = createChatPresenter()

  const log = new SessionLog({ sessionId: SESSION, clock: () => 0 })
  const generated: SessionEvent[] = []
  for (let index = 0; index < 400; index++) {
    const event = buildEvent(random, index)
    generated.push(event)
    live.apply(event) // the live path: events as they are broadcast
    log.append(event.type, event.payload)
  }

  // The replay path: serialize → reload → fold from nothing.
  const reloaded = parseSessionLog(serializeSessionLog(log.entries))
  for (const event of reloaded) replay.apply(event)
  // The generated feed and the log must agree event-for-event.
  assert.deepEqual(reloaded.map(event => [event.seq, event.type]), generated.map(event => [event.seq, event.type]))

  assert.deepEqual(replay.snapshot(), live.snapshot())
})

test('tool feedback and chunks do not render as chat bubbles', () => {
  const presenter = createChatPresenter()
  presenter.apply({ seq: 0 as never, time: 0, type: 'user/message', payload: {
    sessionId: SESSION,
    messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'text', text: 'hello' }],
    source: { kind: 'human', surface: 'web' },
  } })
  presenter.apply({ seq: 1 as never, time: 0, type: 'user/message', payload: {
    sessionId: SESSION,
    messageId: brand<'MessageId'>('m-2'),
    content: [{ kind: 'text', text: '{"tool":"echo"}' }],
    source: { kind: 'tool', toolCallId: brand<'ToolCallId'>('tc-1') },
  } })
  presenter.apply({ seq: 2 as never, time: 0, type: 'assistant/message', payload: {
    sessionId: SESSION,
    topCallId: brand<'TopCallId'>('c-1'),
    messageId: brand<'MessageId'>('m-3'),
    content: [{ kind: 'text', text: 'hi' }],
    chunkSeqs: [0],
    finishReason: { kind: 'stop' },
  } })
  const view = presenter.snapshot()
  assert.equal(view.messages.length, 2)
  assert.deepEqual(view.messages.map(message => message.role), ['user', 'assistant'])
})
