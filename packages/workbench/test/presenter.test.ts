import test from 'node:test'
import assert from 'node:assert/strict'

import type { SessionEvent, SessionEventType } from '@sudive-ai/datum-vocabulary'
import { brand, type AskId } from '@sudive-ai/datum-vocabulary'
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
      case 'approval/requested': return { sessionId: SESSION, approvalId: brand<'ApprovalId'>(`ap-${seq}`), toolCallId: undefined, action: { tool: 'echo', input: {} } }
      case 'approval/decided': return { sessionId: SESSION, approvalId: brand<'ApprovalId'>(`ap-${seq}`), decision: 'granted', approver: 'ui' }
      case 'context/compacted': return { sessionId: SESSION, upToSeq: 0 as never, keptFromSeq: seq as never, summary: `s-${seq}` }
      case 'ask/requested': return { sessionId: SESSION, askId: brand<'AskId'>(`ask-${seq}`), question: `q-${seq}`, choices: [] }
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

test('streaming chunks render as a growing partial bubble until the message lands', () => {
  const presenter = createChatPresenter()
  const topCallId = brand<'TopCallId'>('c-1')
  presenter.apply({ seq: 0 as never, time: 0, type: 'assistant/chunk', payload: {
    sessionId: SESSION, topCallId, chunkSeq: 0, delta: { kind: 'text', text: ' hel' },
  } })
  presenter.apply({ seq: 1 as never, time: 0, type: 'assistant/chunk', payload: {
    sessionId: SESSION, topCallId, chunkSeq: 1, delta: { kind: 'text', text: 'lo' },
  } })
  const partial = presenter.snapshot()
  assert.deepEqual(partial.messages, [{ role: 'assistant', text: ' hello…' }])

  presenter.apply({ seq: 2 as never, time: 0, type: 'assistant/message', payload: {
    sessionId: SESSION, topCallId,
    messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'text', text: 'hello' }],
    chunkSeqs: [0, 1],
    finishReason: { kind: 'stop' },
  } })
  const final = presenter.snapshot()
  assert.deepEqual(final.messages, [{ role: 'assistant', text: 'hello' }])
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

test('thinking and tool calls fold into collapsed activities, not bubbles', () => {
  const presenter = createChatPresenter()
  presenter.apply({ seq: 0 as never, time: 0, type: 'assistant/message', payload: {
    sessionId: SESSION,
    topCallId: brand<'TopCallId'>('c-1'),
    messageId: brand<'MessageId'>('m-1'),
    content: [
      { kind: 'thinking', text: '让我先看看文件' },
      { kind: 'tool_call', toolCallId: brand<'ToolCallId'>('tc-1'), name: 'read_file', input: { path: 'notes.md' } },
      { kind: 'text', text: '这是正文。' },
    ],
    chunkSeqs: [0],
    finishReason: { kind: 'stop' },
  } })
  const entries = presenter.snapshot().entries
  assert.deepEqual(entries.map(entry => [entry.kind, entry.text]), [
    ['activity', '💭 思考过程'],
    ['activity', '🔧 调用 read_file'],
    ['message', '这是正文。'],
  ])
  assert.match(entries[0]!.detail ?? '', /让我先看看文件/)
  assert.match(entries[1]!.detail ?? '', /notes\.md/)
})

test('tool results complete their activity: read_file yields a viewable file', () => {
  const presenter = createChatPresenter()
  presenter.apply({ seq: 0 as never, time: 0, type: 'assistant/message', payload: {
    sessionId: SESSION, topCallId: brand<'TopCallId'>('c-1'), messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'tool_call', toolCallId: brand<'ToolCallId'>('tc-1'), name: 'read_file', input: { path: 'notes.md' } }],
    chunkSeqs: [0], finishReason: { kind: 'tool_call' },
  } })
  presenter.apply({ seq: 1 as never, time: 0, type: 'tool/result', payload: {
    sessionId: SESSION, toolCallId: brand<'ToolCallId'>('tc-1'),
    output: { content: '# 笔记内容' }, isError: false,
  } })
  const entry = presenter.snapshot().entries[0]!
  assert.equal(entry.text, '📄 读取 notes.md')
  assert.deepEqual(entry.file, { path: 'notes.md', content: '# 笔记内容' })
})

test('write_file results carry the written content as a viewable file; failures mark the entry', () => {
  const presenter = createChatPresenter()
  presenter.apply({ seq: 0 as never, time: 0, type: 'assistant/message', payload: {
    sessionId: SESSION, topCallId: brand<'TopCallId'>('c-1'), messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'tool_call', toolCallId: brand<'ToolCallId'>('tc-2'), name: 'write_file', input: { path: 'out.md', content: '新内容' } }],
    chunkSeqs: [0], finishReason: { kind: 'tool_call' },
  } })
  presenter.apply({ seq: 1 as never, time: 0, type: 'tool/result', payload: {
    sessionId: SESSION, toolCallId: brand<'ToolCallId'>('tc-2'), output: { written: 'out.md' }, isError: false,
  } })
  const ok = presenter.snapshot().entries[0]!
  assert.equal(ok.text, '✏️ 写入 out.md')
  assert.deepEqual(ok.file, { path: 'out.md', content: '新内容' })

  presenter.apply({ seq: 2 as never, time: 0, type: 'assistant/message', payload: {
    sessionId: SESSION, topCallId: brand<'TopCallId'>('c-2'), messageId: brand<'MessageId'>('m-2'),
    content: [{ kind: 'tool_call', toolCallId: brand<'ToolCallId'>('tc-3'), name: 'write_file', input: { path: 'bad.md', content: 'x' } }],
    chunkSeqs: [0], finishReason: { kind: 'tool_call' },
  } })
  presenter.apply({ seq: 3 as never, time: 0, type: 'tool/result', payload: {
    sessionId: SESSION, toolCallId: brand<'ToolCallId'>('tc-3'), output: { message: 'disk full' }, isError: true,
  } })
  const failed = presenter.snapshot().entries[1]!
  assert.equal(failed.isError, true)
  assert.match(failed.text, /write_file（失败）/)
  assert.equal(failed.file, undefined)
})

test('streaming thinking folds live into a collapsed activity, separate from the prose bubble', () => {
  const presenter = createChatPresenter()
  const topCallId = brand<'TopCallId'>('c-1')
  // Thinking arrives first, streaming…
  presenter.apply({ seq: 0 as never, time: 0, type: 'assistant/chunk', payload: {
    sessionId: SESSION, topCallId, chunkSeq: 0, delta: { kind: 'thinking', text: '先想一下' },
  } })
  const mid = presenter.snapshot()
  assert.deepEqual(mid.entries, [
    { kind: 'activity', text: '💭 思考过程', detail: '先想一下' },
  ])
  presenter.apply({ seq: 1 as never, time: 0, type: 'assistant/chunk', payload: {
    sessionId: SESSION, topCallId, chunkSeq: 1, delta: { kind: 'thinking', text: '，再回答' },
  } })
  assert.match(presenter.snapshot().entries[0]!.detail ?? '', /先想一下，再回答/)
  // …then prose streams beside it as a partial bubble.
  presenter.apply({ seq: 2 as never, time: 0, type: 'assistant/chunk', payload: {
    sessionId: SESSION, topCallId, chunkSeq: 2, delta: { kind: 'text', text: '答' },
  } })
  assert.deepEqual(presenter.snapshot().entries.map(entry => [entry.kind, entry.text]), [
    ['activity', '💭 思考过程'],
    ['message', '答…'],
  ])
  // The assembled message retires both partials.
  presenter.apply({ seq: 3 as never, time: 0, type: 'assistant/message', payload: {
    sessionId: SESSION, topCallId, messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'thinking', text: '先想一下，再回答' }, { kind: 'text', text: '答' }],
    chunkSeqs: [0, 1, 2],
    finishReason: { kind: 'stop' },
  } })
  assert.deepEqual(presenter.snapshot().entries.map(entry => [entry.kind, entry.text]), [
    ['activity', '💭 思考过程'],
    ['message', '答'],
  ])
})
