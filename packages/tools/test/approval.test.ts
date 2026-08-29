import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@sudive-ai/cordis'
import { ToolService } from '../src/index.ts'
import type { ToolDefinition } from '../src/index.ts'

function guardedTool(name = 'danger'): ToolDefinition {
  return {
    name,
    description: 'Does something guarded.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: () => ({ ran: name }),
  }
}

function freeTool(name = 'safe'): ToolDefinition {
  return {
    name,
    description: 'Does something unguarded.',
    parameters: { type: 'object', properties: {} },
    execute: () => ({ ran: name }),
  }
}

test('approval fail-closed: without an approver, guarded actions refuse with unavailable', async () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  tools.register(guardedTool())
  await assert.rejects(
    tools.execute('danger', {}, { signal: undefined }),
    /approval unavailable/,
  )
})

test('unguarded tools run without an approver', async () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  tools.register(freeTool())
  assert.deepEqual(await tools.execute('safe', {}, { signal: undefined }), { ran: 'safe' })
})

test('a mounted approver gates execution: grant runs, deny refuses', async () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  tools.register(guardedTool())

  const decisions: string[] = []
  tools.setGuard(tool => {
    decisions.push(tool.name)
  })
  assert.deepEqual(await tools.execute('danger', {}, { signal: undefined }), { ran: 'danger' })
  assert.deepEqual(decisions, ['danger'])

  tools.setGuard(tool => {
    throw new Error(`denied: ${tool.name}`)
  })
  await assert.rejects(tools.execute('danger', {}, { signal: undefined }), /denied/)
})

test('unmounting the approver closes the chokepoint again', async () => {
  const ctx = new Context()
  const tools = new ToolService(ctx, 'tools')
  tools.register(guardedTool())
  tools.setGuard(() => {})
  tools.setGuard(undefined)
  await assert.rejects(tools.execute('danger', {}, { signal: undefined }), /approval unavailable/)
})
