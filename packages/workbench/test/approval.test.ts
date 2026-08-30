import test from 'node:test'
import assert from 'node:assert/strict'

import { brand, type ToolCallId } from '@sudive-ai/datum-vocabulary'
import { MockAdapter, type ChatResponse } from '@sudive-ai/datum-tools'
import { resolveWorkbenchConfig, startWorkbench, type WorkbenchConfig, type WorkbenchHandle } from '../src/index.ts'

const SCRIPT: ChatResponse[] = [
  {
    finishReason: { kind: 'tool_call' },
    content: [{ kind: 'tool_call', toolCallId: brand<'ToolCallId'>('tc-1'), name: 'delete_everything', input: { target: 'world' } }],
    usage: null,
  },
  { finishReason: { kind: 'stop' }, content: [{ kind: 'text', text: 'done' }], usage: null },
]

/** Mount a workbench with one guarded tool and the interactive approval surface. */
async function withApprovalBench(run: (handle: WorkbenchHandle, base: string) => Promise<void>): Promise<void> {
  const config: WorkbenchConfig = resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'approval-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
    llm: {
      provider: 'mock',
      apiKeyEnv: 'UNUSED_KEY',
    },
    approval: { mode: 'interactive' },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  })
  const handle = await startWorkbench(config)
  handle.ctx.tools.register({
    name: 'delete_everything',
    description: 'Extremely guarded demo tool.',
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
    requiresApproval: true,
    execute: input => ({ deleted: String(input['target']) }),
  })
  // The scripted model always asks for the guarded tool.
  handle.ctx.llm.use(new MockAdapter({ script: SCRIPT }))
  try {
    await run(handle, `http://127.0.0.1:${handle.port}`)
  } finally {
    await handle.close()
  }
}

async function post(handle: WorkbenchHandle, text: string): Promise<void> {
  await fetch(`http://127.0.0.1:${handle.port}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

async function waitIdle(handle: WorkbenchHandle): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = (await (await fetch(`http://127.0.0.1:${handle.port}/api/history`)).json()) as { busy: boolean }
    if (!state.busy) return
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
  }
  assert.fail('turn did not finish in time')
}

test('interactive approval: a guarded tool opens a case; granting lets it run and logs the decision', async () => {
  await withApprovalBench(async (handle, base) => {
    await post(handle, 'delete it please')
    // The case appears while the turn waits on it.
    const deadline = Date.now() + 5000
    let pending: Array<{ id: string; tool: string; input: unknown }> = []
    while (Date.now() < deadline) {
      pending = (await (await fetch(`${base}/api/approvals`)).json()) as typeof pending
      if (pending.length > 0) break
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    }
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.tool, 'delete_everything')
    assert.deepEqual(pending[0]!.input, { target: 'world' })

    const decision = await fetch(`${base}/api/approvals/${pending[0]!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'granted' }),
    })
    assert.equal(decision.status, 204)

    await waitIdle(handle)
    const types = handle.session.entries.filter(entry => entry.type.startsWith('approval/')).map(entry => entry.type)
    assert.deepEqual(types, ['approval/requested', 'approval/decided'])
    const decided = handle.session.entries.find(entry => entry.type === 'approval/decided')!
    assert.deepEqual(decided.payload.decision, 'granted')
    assert.equal(decided.payload.approver, 'ui')
    const result = handle.session.entries.find(entry => entry.type === 'tool/result')!
    assert.equal(result.payload.isError, false)
  })
})

test('interactive approval: denying refuses the tool and logs the denial', async () => {
  await withApprovalBench(async (handle, base) => {
    await post(handle, 'delete it — but I will say no')
    const deadline = Date.now() + 5000
    let pending: Array<{ id: string }> = []
    while (Date.now() < deadline) {
      pending = (await (await fetch(`${base}/api/approvals`)).json()) as typeof pending
      if (pending.length > 0) break
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    }
    const decision = await fetch(`${base}/api/approvals/${pending[0]!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'denied' }),
    })
    assert.equal(decision.status, 204)

    await waitIdle(handle)
    const decided = handle.session.entries.find(entry => entry.type === 'approval/decided')!
    assert.deepEqual(decided.payload.decision, 'denied')
    assert.equal(decided.payload.approver, 'ui')
    const result = handle.session.entries.find(entry => entry.type === 'tool/result')!
    assert.equal(result.payload.isError, true)
    assert.match(String(result.payload.output.message), /approval denied/)
  })
})

test('closed mode (default): no approver — the tool refuses and the decision logs unavailable', async () => {
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'closed-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  handle.ctx.tools.register({
    name: 'guarded',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: () => ({ ran: true }),
  })
  handle.ctx.llm.use(new MockAdapter({
    script: [
      { finishReason: { kind: 'tool_call' }, content: [{ kind: 'tool_call', toolCallId: brand<'ToolCallId'>('tc-9'), name: 'guarded', input: {} }], usage: null },
      { finishReason: { kind: 'stop' }, content: [{ kind: 'text', text: 'ok' }], usage: null },
    ],
  }))
  try {
    await post(handle, 'try it')
    await waitIdle(handle)
    const decided = handle.session.entries.find(entry => entry.type === 'approval/decided')
    assert.ok(decided)
    assert.deepEqual(decided.payload.decision, 'unavailable')
    assert.equal(decided.payload.approver, 'none')
  } finally {
    await handle.close()
  }
})
