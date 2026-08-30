import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFsLocalAdapter, createShellLocalAdapter } from '../src/index.ts'
import type { ExecutionAdapter, ExecutionRequest } from '../src/index.ts'

/** The consumer: written against the seam only — it never names a provider. */
async function consumer(adapter: ExecutionAdapter, request: ExecutionRequest): Promise<string> {
  const result = await adapter.run(request)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout
}

test('swap gate (execution seam): the same consumer drives fs-local and shell-local unedited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-exec-'))
  try {
    writeFileSync(join(dir, 'fact.txt'), 'the answer')

    // fs-local answers from the filesystem…
    const fsResult = await consumer(createFsLocalAdapter({ root: dir }), {
      argv: ['read', 'fact.txt'],
      cwd: undefined,
      signal: undefined,
    })
    // …shell-local answers from a process, through the identical call.
    const shellResult = await consumer(createShellLocalAdapter({ allow: ['cat'] }), {
      argv: ['cat', join(dir, 'fact.txt')],
      cwd: undefined,
      signal: undefined,
    })

    assert.equal(fsResult, 'the answer')
    assert.equal(shellResult, 'the answer')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fs-local sandbox: paths escaping the policy root refuse; readonly refuses writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-fs-'))
  try {
    const adapter = createFsLocalAdapter({ root: dir, readonly: true })
    const escape = await adapter.run({ argv: ['read', '../../etc/hostname'], cwd: undefined, signal: undefined })
    assert.equal(escape.exitCode, 1)
    assert.match(escape.stderr, /escapes the sandbox root/)

    const write = await adapter.run({ argv: ['write', 'x.txt', 'nope'], cwd: undefined, signal: undefined })
    assert.equal(write.exitCode, 1)
    assert.match(write.stderr, /readonly/)

    // Inside the sandbox, writes work when the policy allows them.
    const writable = createFsLocalAdapter({ root: dir })
    const made = await writable.run({ argv: ['mkdir', 'notes'], cwd: undefined, signal: undefined })
    assert.equal(made.exitCode, 0)
    const stored = await writable.run({ argv: ['write', 'notes/hello.txt', 'kept'], cwd: undefined, signal: undefined })
    assert.equal(stored.exitCode, 0, stored.stderr)
    assert.equal(readFileSync(join(dir, 'notes/hello.txt'), 'utf8'), 'kept')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shell-local policy: the allowlist refuses unlisted programs; abort kills the child', async () => {
  const adapter = createShellLocalAdapter({ allow: ['echo'] })
  const denied = await adapter.run({ argv: ['rm', '-rf', '/'], cwd: undefined, signal: undefined })
  assert.equal(denied.exitCode, 1)
  assert.match(denied.stderr, /not on the policy allowlist/)

  const controller = new AbortController()
  const pending = adapter.run({ argv: ['sleep', '5'], cwd: undefined, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  const started = Date.now()
  const result = await pending
  assert.ok(Date.now() - started < 2000, 'abort must kill the child promptly')
  assert.notEqual(result.exitCode, 0)
})
