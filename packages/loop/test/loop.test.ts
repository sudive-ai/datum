import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@sudive-ai/cordis'
import { brand, type ContentBlock, type JsonRecord, type SessionEvent } from '@sudive-ai/datum-vocabulary'
import { deriveMessages, SessionLog } from '@sudive-ai/datum-session'
import { LlmService, MockAdapter, ToolService } from '@sudive-ai/datum-tools'
import type { ChatRequest, ChatResponse } from '@sudive-ai/datum-tools'
import { AgentLoop, createAgentLoop, requestSurface, setLoopFactory } from '../src/index.ts'

const SESSION = brand<'SessionId'>('sess-loop')

interface Rig {
  ctx: Context
  loop: AgentLoop
  log: SessionLog
}

function textResponse(text: string): ChatResponse {
  return { finishReason: { kind: 'stop' }, content: [{ kind: 'text', text }], usage: null }
}

function toolCallResponse(call: { id: string; name: string; input: JsonRecord }): ChatResponse {
  const block: ContentBlock = {
    kind: 'tool_call',
    toolCallId: brand<'ToolCallId'>(call.id),
    name: call.name,
    input: call.input,
  }
  return { finishReason: { kind: 'tool_call' }, content: [block], usage: null }
}

/** Narrow a log entry to its typed shape after asserting its type. */
function findTyped<T extends SessionEvent['type']>(log: SessionLog, type: T): Extract<SessionEvent, { type: T }> | undefined {
  return log.entries.find((entry): entry is Extract<SessionEvent, { type: T }> => entry.type === type)
}

function lastTyped<T extends SessionEvent['type']>(log: SessionLog, type: T): Extract<SessionEvent, { type: T }> {
  const entry = log.entries.at(-1)
  assert.ok(entry && entry.type === type, `expected the last entry to be ${type}, got ${entry?.type}`)
  return entry as Extract<SessionEvent, { type: T }>
}

/** Mount a full rig: context, session, llm (mock), tools, loop. */
function rig(options: {
  handler?: (request: ChatRequest) => Promise<ChatResponse>
  script?: ChatResponse[]
} = {}): Rig {
  const ctx = new Context()
  const log = new SessionLog({ sessionId: SESSION, context: ctx, clock: () => 0 })
  const llm = new LlmService(ctx, 'llm')
  const adapter = options.handler
    ? new MockAdapter({ handler: options.handler })
    : new MockAdapter({ script: options.script ?? [textResponse('done')] })
  llm.use(adapter)
  const tools = new ToolService(ctx, 'tools')
  tools.register({
    name: 'echo',
    description: 'Echo the input.',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: input => ({ echoed: String(input['text']) }),
  })
  const loop = new AgentLoop({
    context: ctx,
    session: log,
    llm,
    tools,
    spec: {
      name: 'rig-agent',
      systemPrompt: 'You are rig.',
      model: 'mock-model',
      maxTokens: 128,
      options: { temperature: 0 },
      surface: 'test',
    },
  })
  return { ctx, loop, log }
}

test('happy path: one turn, one step, terminal completed fact', async () => {
  const { loop, log } = rig({ script: [textResponse('hello!')] })
  const message = loop.submit('hi')
  const reason = await loop.runTurn(message)
  assert.deepEqual(reason, { kind: 'completed' })

  const types = log.entries.map(entry => entry.type)
  assert.deepEqual(types, [
    'user/message', 'turn/start', 'step/start',
    'request/header', 'request/context', 'assistant/chunk', 'assistant/message', 'step/end',
    'turn/end',
  ])
  assert.deepEqual(lastTyped(log, 'turn/end').payload.reason, { kind: 'completed' })
  assert.deepEqual(deriveMessages(log.entries).map(m => [m.role, (m.content[0]! as { text: string }).text]), [
    ['user', 'hi'],
    ['assistant', 'hello!'],
  ])
})

test('tool round: tool_call → execution → logged feedback → next step completes', async () => {
  const { loop, log } = rig({
    script: [
      toolCallResponse({ id: 'call_1', name: 'echo', input: { text: 'datum' } }),
      textResponse('echoed!'),
    ],
  })
  const message = loop.submit('use the tool')
  const reason = await loop.runTurn(message)
  assert.deepEqual(reason, { kind: 'completed' })

  const types = log.entries.map(entry => entry.type)
  assert.deepEqual(types, [
    'user/message', 'turn/start',
    'step/start', 'request/header', 'request/context', 'assistant/chunk', 'assistant/message', 'step/end',
    'tool/call', 'tool/result', 'user/message',
    'step/start', 'request/header', 'request/context', 'assistant/chunk', 'assistant/message', 'step/end',
    'turn/end',
  ])
  const call = findTyped(log, 'tool/call')
  assert.equal(call?.payload.name, 'echo')
  assert.deepEqual(call?.payload.input, { text: 'datum' })
  const result = findTyped(log, 'tool/result')
  assert.deepEqual(result?.payload.output, { echoed: 'datum' })
  assert.equal(result?.payload.isError, false)
})

test('vocabulary gate: request/context equals exactly what the provider received', async () => {
  let captured: ChatRequest | undefined
  const { loop, log } = rig({
    handler: async request => {
      captured = request
      return textResponse('ok')
    },
  })
  const message = loop.submit('check the invariant')
  await loop.runTurn(message)

  assert.ok(captured)
  const contextEntry = findTyped(log, 'request/context')
  assert.ok(contextEntry)
  assert.deepEqual(contextEntry.payload.context, requestSurface(captured))
  // And the model-visible history is the log's own projection, as of the
  // moment of the request (before the reply that followed it).
  const requestIndex = log.entries.indexOf(contextEntry)
  const visible = log.entries.filter(entry => entry.type === 'assistant/chunk' && log.entries.indexOf(entry) > requestIndex)
  const horizon = visible.length > 0 ? log.entries.indexOf(visible[0]!) : log.entries.length
  assert.deepEqual(contextEntry.payload.context['messages'], deriveMessages(log.entries.slice(0, horizon)))
})

test('cancel-leak gate: cancel while the model hangs; the signal reaches the await; the turn still ends', async () => {
  let observedSignal: AbortSignal | undefined
  const { loop, log } = rig({
    handler: async request => {
      observedSignal = request.signal
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted by test')))
      })
      return textResponse('never')
    },
  })
  const message = loop.submit('slow one')
  const pending = loop.runTurn(message)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(loop.running)
  loop.cancel()
  const reason = await pending
  assert.deepEqual(reason, { kind: 'aborted' })
  assert.equal(observedSignal?.aborted, true)
  assert.equal(loop.running, false)
  const end = lastTyped(log, 'turn/end')
  assert.deepEqual(end.payload.reason, { kind: 'aborted' })
})

test('rejection leaves a trace: a vetoed pre-step closes the turn as blocked, logged', async () => {
  const { ctx, loop, log } = rig()
  ctx.on('agent/pre-step', (_spec, next) => {
    void next
    return { blocked: 'policy says no' }
  })
  const message = loop.submit('refused request')
  const reason = await loop.runTurn(message)
  assert.deepEqual(reason, { kind: 'blocked', reason: 'policy says no' })

  // No model call happened; the refusal is a logged fact.
  assert.equal(findTyped(log, 'request/header'), undefined)
  const end = lastTyped(log, 'turn/end')
  assert.deepEqual(end.payload.reason, { kind: 'blocked', reason: 'policy says no' })
})

test('request waterfall may adjust configuration; message content stays unreachable', async () => {
  const { ctx, loop, log } = rig()
  ctx.on('agent/request', spec => {
    spec.model = 'rewired-model'
    spec.maxTokens = 99
    return spec
  })
  const message = loop.submit('config check')
  await loop.runTurn(message)
  assert.equal(findTyped(log, 'request/header')?.payload.model, 'rewired-model')
  const context = findTyped(log, 'request/context')
  assert.equal(context?.payload.context['maxTokens'], 99)
})

test('turn-stopping listeners are awaited before the terminal fact', async () => {
  const { ctx, loop, log } = rig()
  const order: string[] = []
  ctx.on('agent/turn-stopping', async () => {
    await new Promise(resolve => setImmediate(resolve))
    order.push('stopping-listener')
  })
  const message = loop.submit('order check')
  await loop.runTurn(message)
  order.push('after-run')
  assert.deepEqual(order, ['stopping-listener', 'after-run'])
  assert.equal(log.entries.at(-1)?.type, 'turn/end')
})

test('runTurn refuses concurrent turns (one driver per loop)', async () => {
  const { loop } = rig({
    handler: async request => {
      await new Promise(resolve => setTimeout(resolve, 20))
      void request
      return textResponse('slow')
    },
  })
  const message = loop.submit('first')
  const pending = loop.runTurn(message)
  await assert.rejects(loop.runTurn(brand<'MessageId'>('m-x')), /already running/)
  await pending
})

test('factory seam: setLoopFactory swaps the whole harness, reversibly', () => {
  const { ctx, log } = rig()
  class CustomLoop extends AgentLoop {
    readonly custom = true
  }
  const deps = () => ({
    context: ctx,
    session: log,
    llm: ctx.llm,
    tools: ctx.tools,
    spec: { name: 'x', systemPrompt: '', model: 'm', maxTokens: 1, options: {}, surface: 'test' },
  })
  const restore = setLoopFactory(deps => new CustomLoop(deps))
  assert.ok(createAgentLoop(deps()) instanceof CustomLoop)
  restore()
  assert.equal(createAgentLoop(deps()) instanceof CustomLoop, false)
  assert.ok(createAgentLoop(deps()) instanceof AgentLoop)
})
