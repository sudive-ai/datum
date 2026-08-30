import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkbenchConfig, startWorkbench, type WorkbenchHandle } from '../src/index.ts'

/** A workbench whose workspace is a temp dir and whose plugin file lives there. */
async function withSelfBench(run: (handle: WorkbenchHandle, base: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'datum-self-'))
  const pluginPath = join(dir, 'self-plugin.ts')
  writeFileSync(pluginPath, `export default (ctx) => { ctx.tools.register({ name: 'plugin_tool_v1', description: 'v1', parameters: { type: 'object', properties: {} }, execute: () => ({ v: 1 }) }) }\n`)
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'self-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    plugins: [pluginPath],
    workspace: { fileTools: true, root: dir },
    memory: { enabled: false },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  try {
    await run(handle, `http://127.0.0.1:${handle.port}`, dir)
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('self-modification: read/list work in the sandbox; escaping paths refuse', async () => {
  await withSelfBench(async (handle) => {
    const read = await handle.ctx.tools.execute('read_file', { path: 'self-plugin.ts' }, { signal: undefined }) as { content: string }
    assert.match(read.content, /plugin_tool_v1/)

    await assert.rejects(
      handle.ctx.tools.execute('read_file', { path: '../../../etc/hostname' }, { signal: undefined }),
      /escapes the workspace root/,
    )
  })
})

test('self-modification: write_file is approval-gated — refused closed without an approver', async () => {
  await withSelfBench(async (handle) => {
    await assert.rejects(
      handle.ctx.tools.execute('write_file', { path: 'new.txt', content: 'x' }, { signal: undefined }),
      /approval unavailable/,
    )
  })
})

test('self-modification: the agent replaces its own plugin and reload makes it live', async () => {
  await withSelfBench(async (handle, base, dir) => {
    // v1 is live.
    assert.ok(handle.ctx.tools.list().some(tool => tool.name === 'plugin_tool_v1'))

    // The agent "modifies itself": rewrite its own plugin file (this is the
    // approved write), then call reload_plugins.
    writeFileSync(join(dir, 'self-plugin.ts'), `export default (ctx) => { ctx.tools.register({ name: 'plugin_tool_v2', description: 'v2', parameters: { type: 'object', properties: {} }, execute: () => ({ v: 2 }) }) }\n`)
    const result = await handle.ctx.tools.execute('reload_plugins', {}, { signal: undefined }) as { tools: string[] }

    assert.ok(result.tools.includes('plugin_tool_v2'), `v2 registered, got: ${result.tools.join(',')}`)
    assert.ok(!result.tools.includes('plugin_tool_v1'), 'v1 unregistered by the reversible teardown')

    const v2 = handle.ctx.tools.get('plugin_tool_v2')
    assert.deepEqual(await v2.execute({}, { signal: undefined }), { v: 2 })
    void base
  })
})

test('self-modification: workbench.page.html in the workspace overrides the UI page', async () => {
  await withSelfBench(async (handle, base, dir) => {
    const before = await (await fetch(`${base}/`)).text()
    assert.match(before, /Datum Workbench/)

    writeFileSync(join(dir, 'workbench.page.html'), '<!doctype html><html><body><h1>MY OWN WORKBENCH</h1></body></html>')
    const after = await (await fetch(`${base}/`)).text()
    assert.match(after, /MY OWN WORKBENCH/)
    assert.doesNotMatch(after, /Datum Workbench/)

    rmSync(join(dir, 'workbench.page.html'))
    const restored = await (await fetch(`${base}/`)).text()
    assert.match(restored, /Datum Workbench/)
  })
})
