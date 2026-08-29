import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@sudive-ai/cordis'
import { DISPATCH_MODES, DISPATCH_SEMANTICS } from '../src/index.ts'

// Test-local events, added to the kernel vocabulary by declaration merging —
// the same extension protocol agent events use.
declare module '@sudive-ai/cordis' {
  interface Events {
    ping(): void
    work(): void
    ask(): number | null | string | undefined | Promise<number | null | string | undefined>
    compose(target: { value: number }, next: () => number): number | string
  }
}

test('DISPATCH_MODES is the generated set of the five kernel dispatch modes', () => {
  assert.deepEqual([...DISPATCH_MODES], ['emit', 'parallel', 'serial', 'bail', 'waterfall'])
})

test('every dispatch mode carries exactly one semantic class', () => {
  assert.deepEqual(Object.keys(DISPATCH_SEMANTICS).sort(), [...DISPATCH_MODES].sort())
  assert.equal(DISPATCH_SEMANTICS.emit, 'notification')
  assert.equal(DISPATCH_SEMANTICS.parallel, 'notification')
  assert.equal(DISPATCH_SEMANTICS.serial, 'interrogation')
  assert.equal(DISPATCH_SEMANTICS.bail, 'interrogation')
  assert.equal(DISPATCH_SEMANTICS.waterfall, 'composition')
})

test('emit runs listeners synchronously and ignores return values', () => {
  const ctx = new Context()
  const calls: string[] = []
  ctx.on('ping', () => calls.push('a'))
  ctx.on('ping', () => {
    calls.push('b')
    return 'ignored bail value'
  })
  ctx.emit('ping')
  assert.deepEqual(calls, ['a', 'b'])
})

test('parallel awaits every listener and aggregates rejections', async () => {
  const ctx = new Context()
  const calls: string[] = []
  ctx.on('work', async () => {
    calls.push('slow')
  })
  ctx.on('work', () => Promise.reject(new Error('boom')))
  await assert.rejects(ctx.parallel('work'), AggregateError)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['slow'])
})

test('serial awaits listeners in order until the first bail value', async () => {
  const ctx = new Context()
  const calls: string[] = []
  ctx.on('ask', async () => {
    calls.push('first')
    return null
  })
  ctx.on('ask', async () => {
    calls.push('second')
    return 42
  })
  ctx.on('ask', async () => {
    calls.push('third')
    return 99
  })
  assert.equal(await ctx.serial('ask'), 42)
  assert.deepEqual(calls, ['first', 'second'])
})

test('bail stops on the first synchronous bail value without awaiting', () => {
  const ctx = new Context()
  const calls: string[] = []
  ctx.on('ask', () => {
    calls.push('first')
    return undefined
  })
  ctx.on('ask', () => {
    calls.push('second')
    return 'answer'
  })
  ctx.on('ask', () => {
    calls.push('third')
    return 'never'
  })
  assert.equal(ctx.bail('ask'), 'answer')
  assert.deepEqual(calls, ['first', 'second'])
})

test('waterfall composes listeners outermost-first around the innermost next', () => {
  const ctx = new Context()
  const calls: string[] = []
  // Kernel contract: next() takes no arguments — a waterfall rewrites its
  // input by mutating the draft it received, not by threading values through
  // next().
  const draft = { value: 1 }
  ctx.on('compose', (target: { value: number }, next: () => number) => {
    calls.push('outer')
    target.value += 1
    return next()
  })
  ctx.on('compose', (target: { value: number }, next: () => number) => {
    calls.push('inner')
    target.value *= 10
    return next()
  })
  const result = ctx.waterfall('compose', draft, () => {
    calls.push('default')
    return draft.value
  })
  assert.equal(result, 20)
  assert.deepEqual(calls, ['outer', 'inner', 'default'])
})

test('waterfall veto: a listener that skips next() owns the decision', () => {
  const ctx = new Context()
  ctx.on('compose', (_target: { value: number }, _next: () => number) => {
    return 'vetoed'
  })
  const result = ctx.waterfall('compose', { value: 1 }, () => 42)
  assert.equal(result, 'vetoed')
})
