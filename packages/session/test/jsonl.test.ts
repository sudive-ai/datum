import test from 'node:test'
import assert from 'node:assert/strict'

import { brand, SESSION_FORMAT_VERSION, SessionFormatUnsupportedError } from '@sudive-ai/datum-vocabulary'
import { parseSessionLog, serializeSessionLog, SessionFormatError, SessionLog } from '../src/index.ts'

const SESSION = brand<'SessionId'>('sess-test')

function sampleLog(): SessionLog {
  const log = new SessionLog({ sessionId: SESSION, clock: () => 42 })
  log.append('user/message', {
    sessionId: SESSION,
    messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'text', text: 'hello' }],
    source: { kind: 'human', surface: 'test' },
  })
  log.append('assistant/message', {
    sessionId: SESSION,
    topCallId: brand<'TopCallId'>('c-1'),
    messageId: brand<'MessageId'>('m-2'),
    content: [{ kind: 'text', text: 'hi' }],
    chunkSeqs: [],
    finishReason: { kind: 'stop' },
  })
  return log
}

test('serialize → parse round-trips byte-identically', () => {
  const log = sampleLog()
  const text = serializeSessionLog(log.entries)
  const restored = parseSessionLog(text)
  assert.deepEqual(restored, [...log.entries])
  assert.equal(JSON.stringify(restored), JSON.stringify([...log.entries]))
  assert.ok(text.endsWith('\n'))
})

test('an empty log serializes to an empty string and back', () => {
  assert.equal(serializeSessionLog([]), '')
  assert.deepEqual(parseSessionLog(''), [])
})

test('a log entry with an unknown type refuses to load (fail closed)', () => {
  const rawLine = JSON.stringify({ seq: 0, time: 0, type: 'plugin/future-event', payload: { x: 1 } })
  assert.throws(() => parseSessionLog(rawLine + '\n'), (error: unknown) => {
    assert.ok(error instanceof SessionFormatUnsupportedError)
    assert.equal(error.eventType, 'plugin/future-event')
    assert.equal(error.formatVersion, SESSION_FORMAT_VERSION)
    return true
  })
})

test('a structurally broken line refuses with SessionFormatError', () => {
  assert.throws(() => parseSessionLog('not json\n'), (error: unknown) => {
    assert.ok(error instanceof SessionFormatError)
    assert.equal(error.line, 1)
    assert.match(error.message, /not valid JSON/)
    return true
  })
  assert.throws(
    () => parseSessionLog(JSON.stringify({ seq: 0, time: 0, type: 'turn/start', payload: null }) + '\n'),
    SessionFormatError,
  )
  assert.throws(
    () => parseSessionLog(JSON.stringify({ seq: 3, time: 0, type: 'turn/start', payload: {} }) + '\n'),
    (error: unknown) => {
      assert.ok(error instanceof SessionFormatError)
      assert.match(error.message, /gap-free/)
      return true
    },
  )
})

test('a log without a trailing newline refuses rather than guessing', () => {
  assert.throws(() => parseSessionLog('{"seq":0}'), SessionFormatError)
})

test('seq must count gap-free from zero across the whole log', () => {
  const log = sampleLog()
  log.append('turn/start', { sessionId: SESSION, turnId: brand<'TurnId'>('t-9'), trigger: brand<'MessageId'>('m-1') })
  const text = serializeSessionLog(log.entries)
  const lines = text.split('\n')
  lines.splice(1, 1) // drop the middle entry: seqs now jump 0 → 2
  assert.throws(() => parseSessionLog(lines.join('\n')), (error: unknown) => {
    assert.ok(error instanceof SessionFormatError)
    assert.equal(error.line, 2)
    return true
  })
})
