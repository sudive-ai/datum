import test from 'node:test'
import assert from 'node:assert/strict'

import { brand, type SessionEvent } from '@sudive-ai/datum-vocabulary'
import { MockAdapter, type ChatRequest, type ChatResponse } from '@sudive-ai/datum-tools'
import { createChatPresenter } from '../src/index.ts'
import { resolveWorkbenchConfig, startWorkbench, type WorkbenchHandle } from '../src/index.ts'

const SESSION = brand<'SessionId'>('sess-ask')

test('presenter folds ask/requested into a question bubble listing the choices', () => {
  const presenter = createChatPresenter()
  presenter.apply({ seq: 0 as never, time: 0, type: 'ask/requested', payload: {
    sessionId: SESSION,
    askId: brand<'AskId'>('ask-1'),
    question: '用哪个方案？',
    choices: ['方案A', '方案B'],
  } })
  assert.deepEqual(presenter.snapshot().messages, [
    { role: 'assistant', text: '用哪个方案？\n（选项：方案A / 方案B）' },
  ])
})

test('interactive ask: ask_user pauses the turn; the answer lands as user/message and reaches the model', async () => {
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'ask-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    ask: { enabled: true },
    memory: { enabled: false },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  try {
    // The model asks, then answers using what the user said.
    let seenMessages: Array<{ role: string; text: string }> = []
    handle.ctx.llm.use(new MockAdapter({
      handler: async (request: ChatRequest) => {
        seenMessages = request.messages.map(m => ({
          role: m.role,
          text: m.content.map(w => (w.kind === 'text' ? w.text : '')).join(''),
        }))
        const lastText = seenMessages.at(-1)?.text ?? ''
        if (lastText.includes('部署到')) {
          return { finishReason: { kind: 'stop' }, content: [{ kind: 'text', text: `好的，按你说的办` }], usage: null }
        }
        return {
          finishReason: { kind: 'tool_call' },
          content: [{
            kind: 'tool_call',
            toolCallId: brand<'ToolCallId'>('tc-ask'),
            name: 'ask_user',
            input: { question: '部署到哪个环境？', choices: ['staging', 'production'] },
          }],
          usage: null,
        } satisfies ChatResponse
      },
    }))
    const base = `http://127.0.0.1:${handle.port}`
    await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '准备部署' }) })

    // The pending case appears with the offered choices.
    const deadline = Date.now() + 5000
    let pending: Array<{ id: string; question: string; choices: string[] }> = []
    while (Date.now() < deadline) {
      pending = (await (await fetch(`${base}/api/asks`)).json()) as typeof pending
      if (pending.length > 0) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.question, '部署到哪个环境？')
    assert.deepEqual(pending[0]!.choices, ['staging', 'production'])

    // Answering resolves the turn.
    const answered = await fetch(`${base}/api/asks/${pending[0]!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '部署到 production' }),
    })
    assert.equal(answered.status, 204)

    const settle = Date.now() + 5000
    while (Date.now() < settle) {
      const state = (await (await fetch(`${base}/api/history`)).json()) as { busy: boolean }
      if (!state.busy) break
      await new Promise(r => setTimeout(r, 50))
    }

    // The ask and the answer are durable facts.
    const ask = handle.session.entries.find((entry): entry is Extract<SessionEvent, { type: 'ask/requested' }> => entry.type === 'ask/requested')
    assert.ok(ask)
    assert.equal(ask.payload.question, '部署到哪个环境？')
    const answer = handle.session.entries.find((entry): entry is Extract<SessionEvent, { type: 'user/message' }> =>
      entry.type === 'user/message' && entry.payload.source.kind === 'human' && entry.payload.source.surface === 'ask')
    assert.ok(answer)
    assert.equal((answer.payload.content[0]! as { text: string }).text, '部署到 production')

    // And the answer reached the model in the derived history.
    assert.ok(seenMessages.some(m => m.text === '部署到 production'))
  } finally {
    await handle.close()
  }
})

test('ask disabled: the tool is not offered', async () => {
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'x', systemPrompt: '', model: 'm', maxTokens: 16 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    ask: { enabled: false },
    memory: { enabled: false },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  try {
    assert.throws(() => handle.ctx.tools.get('ask_user'), /no tool named/)
  } finally {
    await handle.close()
  }
})

test('live broadcast frames are unnamed so the page refetches history on events', async () => {
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'frame-agent', systemPrompt: '', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/events`)
    const reader = response.body!.getReader()
    await fetch(`http://127.0.0.1:${handle.port}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'frame check' }),
    })
    const deadline = Date.now() + 5000
    let received = ''
    let sawUnnamed = false
    while (Date.now() < deadline && !sawUnnamed) {
      const { value, done } = await reader.read()
      if (done) break
      received += new TextDecoder().decode(value)
      // An unnamed data frame (no preceding event: line) drives onmessage.
      sawUnnamed = /(^|\n)data: \{"seq"/.test(received)
    }
    assert.ok(sawUnnamed, 'broadcast frames must be unnamed data frames')
    await reader.cancel().catch(() => undefined)
  } finally {
    await handle.close()
  }
})

test('pending asks and approvals survive a page reload (initial fetch restores the cards)', async () => {
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'restore-agent', systemPrompt: '', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    ask: { enabled: true },
    approval: { mode: 'interactive' },
    memory: { enabled: false },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  try {
    // Seed a pending ask through the real tool path.
    const askPromise = handle.ctx.tools.execute('ask_user', { question: '选哪个？', choices: ['a', 'b'] }, { signal: undefined })
    const deadline = Date.now() + 5000
    let pending: Array<{ id: string }> = []
    while (Date.now() < deadline) {
      pending = (await (await fetch(`http://127.0.0.1:${handle.port}/api/asks`)).json()) as typeof pending
      if (pending.length > 0) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.equal(pending.length, 1)
    // Simulating a reload: a fresh GET returns the same pending case.
    const again = (await (await fetch(`http://127.0.0.1:${handle.port}/api/asks`)).json()) as Array<{ id: string }>
    assert.deepEqual(again.map(item => item.id), pending.map(item => item.id))
    // Answering via the API retires it everywhere.
    await fetch(`http://127.0.0.1:${handle.port}/api/asks/${pending[0]!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'a' }),
    })
    void askPromise
    assert.equal(((await (await fetch(`http://127.0.0.1:${handle.port}/api/asks`)).json()) as unknown[]).length, 0)
  } finally {
    await handle.close()
  }
})
