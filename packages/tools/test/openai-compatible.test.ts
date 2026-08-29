import test from 'node:test'
import assert from 'node:assert/strict'

import { brand } from '@sudive-ai/datum-vocabulary'
import { createOpenAICompatibleAdapter } from '../src/index.ts'
import type { ChatRequest } from '../src/index.ts'

const CONFIG = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'gpt-test' }

function makeRequest(): ChatRequest {
  return {
    model: 'gpt-test',
    maxTokens: 128,
    options: { temperature: 0.2 },
    systemPrompt: 'You are Datum.',
    messages: [{ messageId: brand<'MessageId'>('m-1'), role: 'user', content: [{ kind: 'text', text: 'ping' }] }],
    tools: [{
      name: 'search',
      description: 'Search the web.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }],
    signal: undefined,
  }
}

function stubFetch(payload: unknown, capture: { url?: string; init?: RequestInit | undefined } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url)
    capture.init = init
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

test('creation fails loud on missing config', () => {
  assert.throws(() => createOpenAICompatibleAdapter({ baseUrl: '', apiKey: 'k', model: 'm' }), /baseUrl/)
  assert.throws(() => createOpenAICompatibleAdapter({ baseUrl: 'https://x', apiKey: '', model: 'm' }), /apiKey/)
  assert.throws(() => createOpenAICompatibleAdapter({ baseUrl: 'https://x', apiKey: 'k', model: '' }), /model/)
})

test('request maps onto the chat-completions wire shape', async () => {
  const capture: { url?: string; init?: RequestInit | undefined } = {}
  const adapter = createOpenAICompatibleAdapter(CONFIG, stubFetch({
    choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  }, capture))

  const response = await adapter.chat(makeRequest())

  assert.equal(capture.url, 'https://llm.example/v1/chat/completions')
  const init = capture.init!
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>)['authorization'], 'Bearer test-key')
  const body = JSON.parse(String(init.body))
  assert.equal(body.model, 'gpt-test')
  assert.equal(body.max_tokens, 128)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'You are Datum.')
  assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'ping' }])
  assert.equal(body.tools[0].function.name, 'search')

  assert.deepEqual(response.finishReason, { kind: 'stop' })
  assert.deepEqual(response.content, [{ kind: 'text', text: 'pong' }])
  assert.deepEqual(response.usage, { prompt_tokens: 3, completion_tokens: 1 })
})

test('tool calls decode into tool_call blocks with parsed input', async () => {
  const adapter = createOpenAICompatibleAdapter(CONFIG, stubFetch({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"datum"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }))

  const response = await adapter.chat(makeRequest())
  assert.deepEqual(response.finishReason, { kind: 'tool_call' })
  assert.deepEqual(response.content, [{
    kind: 'tool_call',
    toolCallId: brand<'ToolCallId'>('call_1'),
    name: 'search',
    input: { q: 'datum' },
  }])
})

test('an unmapped finish reason becomes an error word, not a silent fallback', async () => {
  const adapter = createOpenAICompatibleAdapter(CONFIG, stubFetch({
    choices: [{ message: { content: '' }, finish_reason: 'something_new' }],
  }))
  const response = await adapter.chat(makeRequest())
  assert.deepEqual(response.finishReason, { kind: 'error', message: 'unmapped provider finish reason: something_new' })
})

test('a non-2xx provider answer fails loud with the status and detail', async () => {
  const adapter = createOpenAICompatibleAdapter(CONFIG, (async () => {
    return new Response('{"error":"rate limited"}', { status: 429 })
  }) as typeof fetch)
  await assert.rejects(() => adapter.chat(makeRequest()), /429/)
})
