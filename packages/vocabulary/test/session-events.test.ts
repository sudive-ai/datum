import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  SessionFormatUnsupportedError,
  assertKnownSessionEventType,
} from '../src/index.ts'

test('the vocabulary holds the 12 core events plus governance and compaction', () => {
  assert.equal(KNOWN_SESSION_EVENT_TYPES.length, 15)
  assert.equal(new Set(KNOWN_SESSION_EVENT_TYPES).size, 15)
  assert.deepEqual([...KNOWN_SESSION_EVENT_TYPES].sort(), [
    'approval/decided',
    'approval/requested',
    'assistant/chunk',
    'assistant/message',
    'context/compacted',
    'request/context',
    'request/header',
    'session/end-seed',
    'step/end',
    'step/start',
    'tool/call',
    'tool/result',
    'turn/end',
    'turn/start',
    'user/message',
  ])
})

test('SESSION_FORMAT_VERSION starts at 0', () => {
  assert.equal(SESSION_FORMAT_VERSION, 0)
})

test('a core event type passes the fail-closed check', () => {
  assert.doesNotThrow(() => assertKnownSessionEventType('turn/start'))
  assert.doesNotThrow(() => assertKnownSessionEventType('session/end-seed'))
})

test('an unknown event type refuses to load with SessionFormatUnsupportedError', () => {
  try {
    assertKnownSessionEventType('plugin/exotic')
    assert.fail('expected SessionFormatUnsupportedError')
  } catch (error) {
    assert.ok(error instanceof SessionFormatUnsupportedError)
    assert.equal(error.name, 'SessionFormatUnsupportedError')
    assert.equal(error.eventType, 'plugin/exotic')
    assert.equal(error.formatVersion, SESSION_FORMAT_VERSION)
    assert.match(error.message, /plugin\/exotic/)
    assert.match(error.message, /SESSION_FORMAT_VERSION=0/)
  }
})

test('an envelope survives a JSON round-trip byte-identically', () => {
  const envelope = {
    seq: 7,
    time: 1_756_416_000_000,
    type: 'user/message',
    payload: {
      sessionId: 'sess-1',
      messageId: 'msg-1',
      content: [{ kind: 'text', text: 'hello' }],
      source: { kind: 'human', surface: 'web' },
    },
  }
  const restored = JSON.parse(JSON.stringify(envelope))
  assert.deepEqual(restored, envelope)
  assert.equal(JSON.stringify(restored), JSON.stringify(envelope))
})
