import test from 'node:test'
import assert from 'node:assert/strict'

import { brand } from '@sudive-ai/datum-vocabulary'
import { createOpenAICompatibleAdapter, LlmService, MockAdapter } from '../src/index.ts'
import type { ChatRequest } from '../src/index.ts'
import { Context } from '@sudive-ai/cordis'

const CONFIG = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'gpt-test' }

function makeRequest(): ChatRequest {
  return {
    model: 'gpt-test',
    maxTokens: 128,
    options: {},
    systemPrompt: 'sys',
    messages: [{ messageId: brand<'MessageId'>('m-1'), role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    tools: [],
    signal: undefined,
  }
}

function sseResponse(lines: string[]): typeof fetch {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
      controller.close()
    },
  })
  return (async () => new Response(body, { status: 200 })) as typeof fetch
}

test('openai stream: text deltas assemble into the response and reach onDelta in order', async () => {
  const adapter = createOpenAICompatibleAdapter(CONFIG, sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ]))
  const deltas: string[] = []
  const response = await adapter.stream!(makeRequest(), delta => deltas.push(`${delta.kind}:${delta.delta}`))

  assert.deepEqual(deltas, ['thinking:thinking hard', 'text:Hel', 'text:lo'])
  assert.deepEqual(response.content, [
    { kind: 'thinking', text: 'thinking hard' },
    { kind: 'text', text: 'Hello' },
  ])
  assert.deepEqual(response.finishReason, { kind: 'stop' })
})

test('openai stream: tool-call fragments concatenate into one complete call', async () => {
  const adapter = createOpenAICompatibleAdapter(CONFIG, sseResponse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"datum\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ]))
  const response = await adapter.stream!(makeRequest(), () => undefined)
  assert.deepEqual(response.content, [{
    kind: 'tool_call',
    toolCallId: brand<'ToolCallId'>('call_1'),
    name: 'search',
    input: { q: 'datum' },
  }])
  assert.deepEqual(response.finishReason, { kind: 'tool_call' })
})

test('service.stream falls back to chat (no deltas) when the adapter cannot stream', async () => {
  const ctx = new Context()
  const llm = new LlmService(ctx, 'llm')
  llm.use({
    name: 'plain',
    chat: async () => ({ finishReason: { kind: 'stop' }, content: [{ kind: 'text', text: 'whole' }], usage: null }),
  })
  const deltas: string[] = []
  const response = await llm.stream(makeRequest(), delta => deltas.push(delta.delta))
  assert.deepEqual(deltas, [])
  assert.deepEqual(response.content, [{ kind: 'text', text: 'whole' }])
})

test('mock adapter streams its scripted text as deltas', async () => {
  const adapter = new MockAdapter({
    script: [{ finishReason: { kind: 'stop' }, content: [{ kind: 'text', text: 'piece one' }, { kind: 'text', text: 'piece two' }], usage: null }],
  })
  const deltas: string[] = []
  const response = await adapter.stream(makeRequest(), delta => deltas.push(delta.delta))
  assert.deepEqual(deltas, ['piece one', 'piece two'])
  assert.equal((response.content[0] as { text: string }).text, 'piece one')
})
