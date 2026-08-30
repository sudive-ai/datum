import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkbenchConfig, startWorkbench } from '../src/index.ts'

test('the emitted page script is valid JavaScript (escaping regression gate)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-page-'))
  try {
    const handle = await startWorkbench(resolveWorkbenchConfig({
      port: 0,
      agent: { name: 'page-agent', systemPrompt: '', model: 'm', maxTokens: 16 },
      llm: { provider: 'mock', apiKeyEnv: 'UNUSED_KEY' },
      storage: { engine: 'memory', path: 'unused.db', connectionStringEnv: 'UNUSED_PG' },
    }))
    try {
      const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text()
      // The session UI ships in the page.
      assert.match(html, /id="sessions"/)
      assert.match(html, /id="new-session"/)
      const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!
      const file = join(dir, 'page-script.mjs')
      writeFileSync(file, script)
      // A syntax error here is exactly how the session list vanished before.
      execFileSync(process.execPath, ['--check', file])
    } finally {
      await handle.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
