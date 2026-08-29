import test from 'node:test'
import assert from 'node:assert/strict'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
