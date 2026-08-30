import test from 'node:test'
import assert from 'node:assert/strict'

import type { ApprovalId, SessionEvent, SessionEventType } from '@sudive-ai/datum-vocabulary'
import { brand, brandNumber } from '@sudive-ai/datum-vocabulary'
import { deriveMessages } from '../src/index.ts'
import { parseSessionLog, serializeSessionLog } from '../src/index.ts'
import { SessionLog } from '../src/index.ts'

/**
 * Deterministic PRNG (mulberry32) — the fuzz must be reproducible: a failing
 * seed is a failing test everyone can replay.
 */
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

const SESSION = brand<'SessionId'>('sess-fuzz')

const ALL_TYPES: SessionEventType[] = [
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'user/message', 'assistant/chunk', 'assistant/message',
  'tool/call', 'tool/result', 'request/header', 'request/context', 'session/end-seed',
]

/** Build a valid payload for one event type under a deterministic RNG. */
function buildPayload(random: () => number, seq: number, type: SessionEventType): Record<string, unknown> {
  const turnId = brand<'TurnId'>(`t-${1 + Math.floor(random() * 3)}`)
  const stepId = brand<'StepId'>(`s-${1 + Math.floor(random() * 5)}`)
  const messageId = brand<'MessageId'>(`m-${seq}`)
  const topCallId = brand<'TopCallId'>(`c-${1 + Math.floor(random() * 4)}`)
  const toolCallId = brand<'ToolCallId'>(`tc-${seq}`)
  const text = `text-${Math.floor(random() * 1000)}`
  const reasonPool = ['completed', 'aborted', 'error', 'max-tokens', 'blocked'] as const
  const reason = reasonPool[Math.floor(random() * reasonPool.length)]!
  switch (type) {
    case 'turn/start':
      return { sessionId: SESSION, turnId, trigger: messageId }
    case 'turn/end':
      return { sessionId: SESSION, turnId, reason: reason === 'blocked' ? { kind: 'blocked', reason: 'test' } : reason === 'error' ? { kind: 'error', message: text } : { kind: reason } }
    case 'step/start':
      return { sessionId: SESSION, turnId, stepId }
    case 'step/end':
      return { sessionId: SESSION, turnId, stepId, finishReason: { kind: reason === 'blocked' ? 'stop' : reason === 'aborted' ? 'cancelled' : reason === 'max-tokens' ? 'length' : reason === 'error' ? { kind: 'error', message: text } : 'stop' } }
    case 'user/message':
      return { sessionId: SESSION, messageId, content: [{ kind: 'text', text }], source: { kind: 'human', surface: 'fuzz' } }
    case 'assistant/chunk':
      return { sessionId: SESSION, topCallId, chunkSeq: seq, delta: { text } }
    case 'assistant/message':
      return { sessionId: SESSION, topCallId, messageId, content: [{ kind: 'text', text }], chunkSeqs: [0, 1], finishReason: { kind: 'stop' } }
    case 'tool/call':
      return { sessionId: SESSION, topCallId, toolCallId, name: 'search', input: { q: text } }
    case 'tool/result':
      return { sessionId: SESSION, toolCallId, output: { text }, isError: random() < 0.2 }
    case 'request/header':
      return { sessionId: SESSION, turnId, topCallId, reason: random() < 0.5 ? 'initial' : 'series', model: 'mock-model' }
    case 'request/context':
      return { sessionId: SESSION, topCallId, context: { messages: [{ role: 'user', content: text }] } }
    case 'session/end-seed':
      return { sessionId: SESSION, reason: { kind: 'completed' } }
    case 'approval/requested':
      return { sessionId: SESSION, approvalId: brand<'ApprovalId'>(`ap-${seq}`), toolCallId: toolCallId, action: { tool: 'search', input: { q: text } } }
    case 'approval/decided':
      return { sessionId: SESSION, approvalId: brand<'ApprovalId'>(`ap-${seq}`), decision: random() < 0.5 ? 'granted' : 'denied', approver: 'ui' }
    case 'context/compacted':
      return { sessionId: SESSION, upToSeq: brandNumber<'EntrySeq'>(Math.max(0, seq - 1)), keptFromSeq: brandNumber<'EntrySeq'>(seq), summary: `summary-${seq}` }
  }
}

test('replay fuzz: append → serialize → reload reproduces the process byte-identically', () => {
  const random = mulberry32(42)
  let now = 0
  const log = new SessionLog({ sessionId: SESSION, clock: () => (now += 7) })
  for (let index = 0; index < 600; index++) {
    const type = ALL_TYPES[Math.floor(random() * ALL_TYPES.length)]!
    log.append(type, buildPayload(random, index, type) as never)
  }

  const serialized = serializeSessionLog(log.entries)
  const reloaded = parseSessionLog(serialized)

  // Byte identity: the serialized form of the reload equals the original
  // serialization exactly — no normalization, no loss.
  assert.equal(serializeSessionLog([...reloaded]), serialized)

  // Structural identity: entries deep-equal, seqs gap-free, count preserved.
  assert.deepEqual(reloaded, [...log.entries])
  assert.equal(reloaded.length, 600)
  reloaded.forEach((entry: SessionEvent, index: number) => assert.equal(entry.seq, index))

  // Projection identity: the derived history of the reload equals the
  // derived history of the original process.
  assert.deepEqual(deriveMessages(reloaded), deriveMessages([...log.entries]))
})

test('replay fuzz is deterministic for a given seed', () => {
  const run = (): string => {
    const random = mulberry32(1234)
    const log = new SessionLog({ sessionId: SESSION, clock: () => 0 })
    for (let index = 0; index < 100; index++) {
      const type = ALL_TYPES[Math.floor(random() * ALL_TYPES.length)]!
      log.append(type, buildPayload(random, index, type) as never)
    }
    return serializeSessionLog(log.entries)
  }
  assert.equal(run(), run())
})
