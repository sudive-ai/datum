import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@sudive-ai/cordis'
import { brand } from '@sudive-ai/datum-vocabulary'
import { createOpenAICompatibleAdapter, LlmService, MockAdapter } from '../src/index.ts'
import type { ChatRequest, ChatResponse } from '../src/index.ts'

function makeRequest(model = 'mock-model'): ChatRequest {
  return {
    model,
    maxTokens: 256,
    options: { temperature: 0.5 },
    systemPrompt: 'You are Datum.',
    messages: [{ messageId: brand<'MessageId'>('m-1'), role: 'user', content: [{ kind: 'text', text: 'ping' }] }],
    tools: [],
    signal: undefined,
  }
}

function makeResponse(text: string): ChatResponse {
  return { finishReason: { kind: 'stop' }, content: [{ kind: 'text', text }], usage: null }
}

test('chat fails loud when no adapter is mounted', async () => {
  const ctx = new Context()
  const llm = new LlmService(ctx, 'llm')
  assert.throws(() => llm.chat(makeRequest()), /no adapter mounted/)
})

test('swap gate: consumers follow the mounted adapter with zero edits', async () => {
  const ctx = new Context()
  const llm = new LlmService(ctx, 'llm')

  // The consumer — written against the seam only, never against a provider.
  const consumer = async (): Promise<string> => {
    const response = await ctx.llm.chat(makeRequest())
    const word = response.content[0]
    return word !== undefined && word.kind === 'text' ? word.text : ''
  }

  const first = new MockAdapter({ script: [makeResponse('from-first')] })
  const disposeFirst = llm.use(first)
  assert.equal(await consumer(), 'from-first')

  // Swap providers without touching the consumer.
  disposeFirst()
  const second = new MockAdapter({ script: [makeResponse('from-second')] })
  llm.use(second)
  assert.equal(await consumer(), 'from-second')
})

test('llm.use is a reversible registration', () => {
  const ctx = new Context()
  const llm = new LlmService(ctx, 'llm')
  const adapter = new MockAdapter()
  const dispose = llm.use(adapter)
  assert.equal(llm.adapter, adapter)
  assert.equal(dispose(), true)
  assert.throws(() => llm.adapter, /no adapter mounted/)
  assert.equal(dispose(), false, 'disposer is exactly-once')
})

test('mock snapshot replay: recorded requests replay keylessly and identically', async () => {
  const recorded = new MockAdapter()
  const request = makeRequest()
  recorded.record(request, makeResponse('snapshot-answer'))

  const response = await recorded.chat(request)
  assert.equal(recorded.snapshotCount, 1, 'replay involved no provider, no key, no recording of new snapshots')
  assert.deepEqual(response, makeResponse('snapshot-answer'))
})

test('mock snapshot replay refuses a request it has never seen (fail closed)', async () => {
  const replayer = new MockAdapter()
  await assert.rejects(
    replayer.chat(makeRequest('different-model')),
    /no snapshot recorded/,
  )
})

test('mock adapter is deterministic across identical requests', async () => {
  const adapter = new MockAdapter({ script: [makeResponse('same')] })
  const request = makeRequest()
  const first = await adapter.chat(request)
  const second = await adapter.chat(request)
  assert.deepEqual(first, second)
})

test('script repeats its last entry when exhausted (test infrastructure never surprises)', async () => {
  const adapter = new MockAdapter({ script: [makeResponse('a'), makeResponse('b')] })
  await adapter.chat(makeRequest())
  await adapter.chat(makeRequest())
  const third = await adapter.chat(makeRequest())
  const word = third.content[0]
  assert.ok(word !== undefined && word.kind === 'text')
  assert.equal(word.text, 'b')
})
