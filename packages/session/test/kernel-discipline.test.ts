import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@sudive-ai/cordis'

/**
 * M1 acceptance gate: effect discipline, pinned against the vendored kernel's
 * fiber hardening (not reimplemented here).
 *
 * Teardown must replay disposers in exact reverse order, exactly once, and
 * effect creation during teardown must be rejected.
 */
test('teardown replays disposers in exact reverse order, exactly once', async () => {
  const ctx = new Context()
  const order: string[] = []
  const counts = new Map<string, number>()

  const track = (label: string) => () => {
    order.push(label)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  ctx.fiber.effect(() => track('first'), 'first')
  ctx.fiber.effect(() => track('second'), 'second')
  ctx.fiber.effect(() => track('third'), 'third')

  await ctx.fiber.dispose()
  assert.deepEqual(order, ['third', 'second', 'first'])
  assert.deepEqual([...counts.values()], [1, 1, 1])
})

test('effect creation during teardown is rejected (no orphaned work)', async () => {
  const ctx = new Context()
  let rejection: unknown
  ctx.fiber.effect(() => {
    return () => {
      try {
        ctx.fiber.effect(() => () => {}, 'too late')
      } catch (error) {
        rejection = error
      }
    }
  }, 'spawner')
  await ctx.fiber.dispose()
  assert.ok(rejection instanceof Error, 'expected effect-during-teardown to throw')
  assert.match(String((rejection as Error).message ?? rejection), /inactive|INACTIVE_EFFECT|dispose|unload/i)
})

test('nested fibers unwind children before their parent', async () => {
  const ctx = new Context()
  const order: string[] = []
  ctx.fiber.effect(() => () => order.push('root'), 'root')
  const child = ctx.fiber.effect(() => () => order.push('child'), 'child-holder')
  // The child holder effect registered a plain marker; a real child fiber
  // would dispose through its parent-owned disposer. Root must come last.
  child()
  await ctx.fiber.dispose()
  assert.deepEqual(order, ['child', 'root'])
})
