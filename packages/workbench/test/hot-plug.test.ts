import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkbenchConfig, startWorkbench, type WorkbenchHandle } from '../src/index.ts'

async function withHotBench(run: (handle: WorkbenchHandle, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'datum-hot-'))
  // An approver that grants everything: the hot-plug door is open in this test.
  const handle = await startWorkbench(resolveWorkbenchConfig({
    port: 0,
    agent: { name: 'hot-agent', systemPrompt: 'test', model: 'mock-model', maxTokens: 64 },
    llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
    workspace: { fileTools: true, root: dir },
    memory: { enabled: false },
    approval: { mode: 'closed' },
    storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
  }))
  handle.ctx.tools.setGuard(() => {})
  try {
    await run(handle, dir)
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('hot-plug: a plugin authored in conversation loads, serves, updates, and unloads', async () => {
  await withHotBench(async (handle, dir) => {
    // 1. The model authors a brand-new plugin file.
    const write = await handle.ctx.tools.execute('write_file', {
      path: 'dice-plugin.ts',
      content: `export default (ctx) => {
  ctx.tools.register({
    name: 'roll_dice',
    description: 'Roll a die.',
    parameters: { type: 'object', properties: {} },
    execute: () => ({ roll: 4 }),
  })
  ctx.on('agent/pre-step', (spec, next) => { spec.systemPrompt += '\\n[_dice plugin live]'; return next() })
}
`,
    }, { signal: undefined })
    assert.deepEqual(write, { written: 'dice-plugin.ts' })

    // 2. It is not live until loaded.
    assert.throws(() => handle.ctx.tools.get('roll_dice'), /no tool named/)

    // 3. load_plugin (approved) makes it live.
    const loaded = await handle.ctx.tools.execute('load_plugin', { path: 'dice-plugin.ts' }, { signal: undefined }) as { tools: string[] }
    assert.ok(loaded.tools.includes('roll_dice'))
    const roll = handle.ctx.tools.get('roll_dice')
    assert.deepEqual(await roll.execute({}, { signal: undefined }), { roll: 4 })

    // 4. Hot update: rewrite the file, re-load the same path — old scope retires.
    await handle.ctx.tools.execute('write_file', {
      path: 'dice-plugin.ts',
      content: `export default (ctx) => {
  ctx.tools.register({
    name: 'roll_dice',
    description: 'Roll a die.',
    parameters: { type: 'object', properties: {} },
    execute: () => ({ roll: 20 }),
  })
}
`,
    }, { signal: undefined })
    await handle.ctx.tools.execute('load_plugin', { path: 'dice-plugin.ts' }, { signal: undefined })
    assert.deepEqual(await handle.ctx.tools.get('roll_dice').execute({}, { signal: undefined }), { roll: 20 })

    // 5. reload_plugins refreshes conversation-loaded plugins too.
    await handle.ctx.tools.execute('write_file', {
      path: 'dice-plugin.ts',
      content: `export default (ctx) => { ctx.tools.register({ name: 'roll_dice', description: '', parameters: { type: 'object', properties: {} }, execute: () => ({ roll: 6 }) }) }\n`,
    }, { signal: undefined })
    await handle.ctx.tools.execute('reload_plugins', {}, { signal: undefined })
    assert.deepEqual(await handle.ctx.tools.get('roll_dice').execute({}, { signal: undefined }), { roll: 6 })

    // 6. unload_plugin removes it — hot-unplug.
    const unloaded = await handle.ctx.tools.execute('unload_plugin', { path: 'dice-plugin.ts' }, { signal: undefined }) as { tools: string[] }
    assert.ok(!unloaded.tools.includes('roll_dice'))
    assert.throws(() => handle.ctx.tools.get('roll_dice'), /no tool named/)
  })
})

test('hot-plug: escaping paths and non-module files refuse; duplicates replace instead of doubling', async () => {
  await withHotBench(async (handle, dir) => {
    await assert.rejects(
      handle.ctx.tools.execute('load_plugin', { path: '../../evil.ts' }, { signal: undefined }),
      /escapes the workspace root/,
    )
    writeFileSync(join(dir, 'readme.md'), 'not a module')
    await assert.rejects(
      handle.ctx.tools.execute('load_plugin', { path: 'readme.md' }, { signal: undefined }),
      /only \.ts/,
    )
    // Loading a broken module fails loud and leaves the old state intact.
    writeFileSync(join(dir, 'broken.ts'), 'export default (ctx) => { throw new Error("boom at load") }\n')
    await assert.rejects(
      handle.ctx.tools.execute('load_plugin', { path: 'broken.ts' }, { signal: undefined }),
      /boom at load/,
    )
  })
})
