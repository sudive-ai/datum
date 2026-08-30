import test from 'node:test'
import assert from 'node:assert/strict'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@sudive-ai/cordis'
import { resolveWorkbenchConfig, startWorkbench, type WorkbenchConfig, type WorkbenchHandle } from '../src/index.ts'

test('config resolution applies defaults and fails loud on garbage', () => {
  const resolved = resolveWorkbenchConfig({})
  assert.equal(resolved.port, 8642)
  assert.equal(resolved.llm.provider, 'mock')
  assert.equal(resolved.agent.name, 'datum-agent')
  assert.deepEqual(resolved.plugins, [])
  // Storage defaults to the local sqlite engine.
  assert.deepEqual(resolved.storage, { engine: 'sqlite', path: 'datum.db', connectionStringEnv: 'DATUM_PG_URL' })

  assert.throws(() => resolveWorkbenchConfig({ port: -1 }), /port/)
  assert.throws(() => resolveWorkbenchConfig({ llm: { provider: 'carrier-pigeon' } }))
})

/** Shared config with ephemeral storage; the restart test brings its own. */
function baseConfig(): WorkbenchConfig {
  return resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'test-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  })
}

async function withWorkbench(run: (handle: WorkbenchHandle, base: string) => Promise<void>): Promise<void> {
  const handle = await startWorkbench(baseConfig())
  try {
    await run(handle, `http://127.0.0.1:${handle.port}`)
  } finally {
    await handle.close()
  }
}

test('e2e: a posted message drives a turn; history reflects the log', async () => {
  await withWorkbench(async (handle, base) => {
    const health = await fetch(`${base}/api/health`)
    assert.deepEqual(await health.json(), { ok: true, agent: 'test-agent' })

    const post = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello workbench' }),
    })
    assert.equal(post.status, 202)

    // Poll until the turn's terminal fact lands.
    const deadline = Date.now() + 5000
    let history: { messages: Array<{ role: string; text: string }>; busy: boolean } | undefined
    while (Date.now() < deadline) {
      history = (await (await fetch(`${base}/api/history`)).json()) as typeof history
      if (!history?.busy) break
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    }
    assert.ok(history)
    assert.equal(history.busy, false)
    assert.deepEqual(
      history.messages.map(message => [message.role, message.text]),
      [['user', 'hello workbench'], ['assistant', '[mock] You said: hello workbench']],
    )
    // The log behind the UI holds the full fact set.
    const types = handle.session.entries.map(entry => entry.type)
    assert.ok(types.includes('turn/end'))
    assert.ok(types.includes('request/context'))
  })
})

test('e2e: SSE stream delivers session events to subscribers', async () => {
  await withWorkbench(async (_handle, base) => {
    const stream = await fetch(`${base}/events`)
    assert.equal(stream.headers.get('content-type'), 'text/event-stream')
    const reader = stream.body!.getReader()
    void reader // keep the stream open

    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'sse check' }),
    })

    const deadline = Date.now() + 5000
    let received = ''
    while (Date.now() < deadline && !received.includes('assistant/message')) {
      const { value, done } = await reader.read()
      if (done) break
      received += new TextDecoder().decode(value)
    }
    assert.ok(received.includes('user/message'))
    assert.ok(received.includes('assistant/message'))
    await reader.cancel()
  })
})

test('postgres engine fails loud at startup when the connection-string env is unset', async () => {
  await assert.rejects(
    startWorkbench(resolveWorkbenchConfig({
      port: 0,
      storage: { engine: 'postgres', path: 'unused.db', connectionStringEnv: 'DATUM_PG_URL_TEST_UNSET' },
    })),
    /DATUM_PG_URL_TEST_UNSET is not set/,
  )
})

test('restart recovery: facts survive a full workbench restart through sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-workbench-'))
  const dbPath = join(dir, 'datum.db')
  const config = (): WorkbenchConfig => resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'recover-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    storage: { engine: 'sqlite', path: dbPath, connectionStringEnv: 'UNUSED_PG' },
  })
  try {
    { // first lifetime
      const handle = await startWorkbench(config())
      await fetch(`http://127.0.0.1:${handle.port}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'survive me' }),
      })
      const deadline = Date.now() + 5000
      const busy = async (): Promise<boolean> => {
        const state = (await (await fetch(`http://127.0.0.1:${handle.port}/api/history`)).json()) as { busy: boolean }
        return state.busy
      }
      while (Date.now() < deadline && await busy()) {
        await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
      }
      await handle.close()
    }
    { // second lifetime: same database file, history is back
      const handle = await startWorkbench(config())
      try {
        const history = (await (await fetch(`http://127.0.0.1:${handle.port}/api/history`)).json()) as {
          messages: Array<{ role: string; text: string }>
        }
        assert.deepEqual(
          history.messages.map(message => [message.role, message.text]),
          [['user', 'survive me'], ['assistant', '[mock] You said: survive me']],
        )
      } finally {
        await handle.close()
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('user plugins load from config and compose onto the context', async () => {
  // The demo plugin registers a tool and a pre-step persona tweak; plugin
  // paths resolve against the process cwd, so the test passes an absolute one.
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    plugins: [new URL('../../../examples/hello-agent/hello-plugin.ts', import.meta.url).pathname],
    agent: { name: 'plugin-agent', systemPrompt: 'base', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  try {
    const tools = handle.ctx.tools.list().map(tool => tool.name)
    assert.ok(tools.includes('hello_time'), `plugin tool registered, got: ${tools.join(',')}`)
  } finally {
    await handle.close()
  }
})

test('multi-session: create, switch, and see separate histories; delete removes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-multi-'))
  let handle: WorkbenchHandle | undefined
  try {
    handle = await startWorkbench(resolveWorkbenchConfig({
      port: 0,
      agent: { name: 'multi-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
      llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
      storage: { engine: 'sqlite', path: join(dir, 'datum.db'), connectionStringEnv: 'UNUSED_PG' },
    }))
    const base = `http://127.0.0.1:${handle.port}`
    const post = async (text: string): Promise<void> => {
      await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    }
    const waitIdle = async (): Promise<void> => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const state = (await (await fetch(`${base}/api/history`)).json()) as { busy: boolean }
        if (!state.busy) return
        await new Promise(r => setTimeout(r, 50))
      }
      assert.fail('turn did not finish')
    }

    await post('first session talk')
    await waitIdle()
    const firstId = handle.session.sessionId

    const created = await fetch(`${base}/api/sessions`, { method: 'POST' })
    assert.equal(created.status, 201)
    const secondId = handle.session.sessionId
    assert.notEqual(secondId, firstId)

    // The fresh session has an empty view; switch back and the history returns.
    assert.deepEqual(((await (await fetch(`${base}/api/history`)).json()) as { messages: unknown[] }).messages, [])
    const switchBack = await fetch(`${base}/api/sessions/${firstId}/activate`, { method: 'POST' })
    assert.equal(switchBack.status, 200)
    assert.equal(handle.session.sessionId, firstId)
    const restored = (await (await fetch(`${base}/api/history`)).json()) as { messages: Array<{ text: string }> }
    assert.match(restored.messages.map(m => m.text).join('|'), /first session talk/)

    // The listing shows both, with the active one marked.
    const listing = (await (await fetch(`${base}/api/sessions`)).json()) as { active: string; sessions: Array<{ sessionId: string }> }
    assert.equal(listing.active, firstId)
    assert.deepEqual(listing.sessions.map(s => s.sessionId).sort(), [firstId, secondId].sort())

    // Deleting the active session activates another one.
    const deleted = await fetch(`${base}/api/sessions/${firstId}`, { method: 'DELETE' })
    assert.equal(deleted.status, 204)
    assert.notEqual(handle.session.sessionId, firstId)
    assert.deepEqual(((await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ sessionId: string }> }).sessions.map(s => s.sessionId), [secondId])
  } finally {
    await handle?.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory: remember feeds recall and the digest reaches the pre-step system prompt', async () => {
  const handle = await startWorkbench(baseConfig())
  try {
    const base = `http://127.0.0.1:${handle.port}`
    let seenSystemPrompt = ''
    const { MockAdapter } = await import('@sudive-ai/datum-tools')
    handle.ctx.llm.use(new MockAdapter({
      handler: async request => {
        seenSystemPrompt = request.systemPrompt
        return { finishReason: { kind: 'stop' }, content: [{ kind: 'text', text: 'noted' }], usage: null }
      },
    }))

    // The model saves a memory through the tool; recall reads it back.
    await handle.ctx.tools.execute('remember', { key: 'user-language', content: '中文' }, { signal: undefined })
    const recalled = await handle.ctx.tools.execute('recall', { query: 'language' }, { signal: undefined }) as { memories: Array<{ key: string; content: string }> }
    assert.deepEqual(recalled.memories, [{ key: 'user-language', content: '中文' }])

    // The next turn's pre-step carries the digest into the system prompt.
    await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const state = (await (await fetch(`${base}/api/history`)).json()) as { busy: boolean }
      if (!state.busy) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.match(seenSystemPrompt, /## Long-term memory/)
    assert.match(seenSystemPrompt, /user-language: 中文/)
  } finally {
    await handle.close()
  }
})

test('a dangling turn in the database does not crash startup (repair broadcast before bind)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-boot-'))
  try {
    // Craft the crashed state: a turn that never ended.
    const { createSqliteStorage, mountSessionPersistence, openPersistentSessionLog } = await import('@sudive-ai/datum-storage')
    const storage = createSqliteStorage({ path: join(dir, 'datum.db') })
    const pre = await openPersistentSessionLog({ context: new Context(), storage })
    pre.session.append('user/message', {
      sessionId: pre.session.sessionId,
      messageId: (await import('@sudive-ai/datum-session')).newMessageId(),
      content: [{ kind: 'text', text: 'interrupted' }],
      source: { kind: 'human', surface: 'test' },
    })
    pre.session.append('turn/start', {
      sessionId: pre.session.sessionId,
      turnId: (await import('@sudive-ai/datum-vocabulary')).brand<'TurnId'>('t-crash'),
      trigger: (await import('@sudive-ai/datum-vocabulary')).brand<'MessageId'>('m-crash'),
    })
    await new Promise(r => setTimeout(r, 50))
    await pre.disposePersistence()
    await storage.close()

    // Boot the workbench on that database: the repair broadcast fires while
    // no session is bound yet — it must not crash, and the view must not
    // stay busy.
    const handle = await startWorkbench(resolveWorkbenchConfig({
      port: 0,
      agent: { name: 'boot-agent', systemPrompt: '', model: 'mock-model', maxTokens: 64 },
      llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
      storage: { engine: 'sqlite', path: join(dir, 'datum.db'), connectionStringEnv: 'UNUSED_PG' },
    }))
    try {
      const history = (await (await fetch(`http://127.0.0.1:${handle.port}/api/history`)).json()) as { busy: boolean }
      assert.equal(history.busy, false)
    } finally {
      await handle.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


