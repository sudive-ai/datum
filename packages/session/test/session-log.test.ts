import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@sudive-ai/cordis'
import type { SessionEvent } from '@sudive-ai/datum-vocabulary'
import { brand } from '@sudive-ai/datum-vocabulary'
import { SessionLog } from '../src/index.ts'

const SESSION = brand<'SessionId'>('sess-test')

test('append assigns gap-free monotonic seqs and stamps time', () => {
  let now = 1000
  const log = new SessionLog({ sessionId: SESSION, clock: () => now })
  const first = log.append('turn/start', {
    sessionId: SESSION,
    turnId: brand<'TurnId'>('t-1'),
    trigger: brand<'MessageId'>('m-1'),
  })
  now = 2000
  const second = log.append('step/start', {
    sessionId: SESSION,
    turnId: brand<'TurnId'>('t-1'),
    stepId: brand<'StepId'>('s-1'),
  })
  assert.equal(first.seq, 0)
  assert.equal(first.time, 1000)
  assert.equal(second.seq, 1)
  assert.equal(second.time, 2000)
  assert.equal(log.nextSeq, 2)
})

test('appended entries are deep-frozen facts', () => {
  const log = new SessionLog({ sessionId: SESSION, clock: () => 0 })
  const entry = log.append('tool/call', {
    sessionId: SESSION,
    topCallId: brand<'TopCallId'>('c-1'),
    toolCallId: brand<'ToolCallId'>('tc-1'),
    name: 'search',
    input: { q: 'x' },
  })
  assert.ok(Object.isFrozen(entry))
  assert.ok(Object.isFrozen(entry.payload))
})

test('append fails loud on a payload that cannot survive JSON', () => {
  const log = new SessionLog({ sessionId: SESSION, clock: () => 0 })
  assert.throws(
    // @ts-expect-error deliberately violating the JSON payload contract
    () => log.append('user/message', { sessionId: SESSION, messageId: brand<'MessageId'>('m-1'), content: [{ kind: 'text', text: () => 'fn' }], source: { kind: 'human', surface: 'test' } }),
    /content\[0\]\.text has unsupported runtime type/,
  )
})

test('append broadcasts session/event on the mounted context', () => {
  const ctx = new Context()
  const received: SessionEvent[] = []
  ctx.on('session/event', event => received.push(event))
  const log = new SessionLog({ sessionId: SESSION, context: ctx, clock: () => 0 })
  log.append('session/end-seed', { sessionId: SESSION, reason: { kind: 'completed' } })
  assert.equal(received.length, 1)
  const broadcast = received[0]!
  assert.equal(broadcast.type, 'session/end-seed')
  assert.equal(broadcast.seq, 0)
})

test('without a context the log stays a pure data structure', () => {
  const log = new SessionLog({ sessionId: SESSION, clock: () => 0 })
  log.append('turn/end', { sessionId: SESSION, turnId: brand<'TurnId'>('t-1'), reason: { kind: 'aborted' } })
  assert.equal(log.entries.length, 1)
})
