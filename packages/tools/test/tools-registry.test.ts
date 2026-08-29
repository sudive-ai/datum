import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@sudive-ai/cordis'
import { ToolService } from '../src/index.ts'
import type { ToolDefinition } from '../src/index.ts'

function makeTool(name: string, output: string = `${name}-ok`): ToolDefinition {
  return {
    name,
    description: `${name} does its thing.`,
    parameters: { type: 'object', properties: {} },
    execute: () => ({ output }),
  }
}

test('registration is reversible and exactly-once', () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  const dispose = tools.register(makeTool('search'))
  assert.equal(tools.list().length, 1)
  assert.equal(dispose(), true)
  assert.equal(tools.list().length, 0)
  assert.equal(dispose(), false, 'disposer is exactly-once')
})

test('duplicate registration refuses loudly instead of silently overwriting', () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  tools.register(makeTool('search'))
  assert.throws(() => tools.register(makeTool('search')), /already registered/)
})

test('get() refuses unknown tools — the model is never shown an unexecutable tool', () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  assert.throws(() => tools.get('missing'), /no tool named/)
})

test('view() exposes exactly the provider-facing shape', () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  tools.register(makeTool('search'))
  assert.deepEqual(tools.view(), [{
    name: 'search',
    description: 'search does its thing.',
    parameters: { type: 'object', properties: {} },
  }])
})

test('execution fails through, cancellation signal reaches the tool', async () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  const controller = new AbortController()
  const seen: (AbortSignal | undefined)[] = []
  tools.register({
    ...makeTool('slow'),
    execute: async (_input, context) => {
      seen.push(context.signal)
      await new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
      return { output: 'never' }
    },
  })
  const tool = tools.get('slow')
  const pending = Promise.resolve(tool.execute({}, { signal: controller.signal }))
  controller.abort()
  await assert.rejects(pending, /aborted/)
  assert.equal(seen.length, 1)
})
