/**
 * hello-agent — the smallest possible Datum user plugin.
 *
 * A plugin is a plain cordis plugin: a function receiving the context. It
 * composes domain behavior onto the fixed language — register tools, listen
 * on the agent waterfalls, observe events — and never patches the runtime.
 *
 * Everything registered here is a reversible effect: unloading the plugin
 * removes exactly what it added.
 */
import type { Context } from '@sudive-ai/cordis'

export default function helloPlugin(ctx: Context): void {
  // 1. A domain tool: the model can call it during a turn.
  ctx.tools.register({
    name: 'hello_time',
    description: 'Returns the current time in a friendly sentence.',
    parameters: { type: 'object', properties: {} },
    execute: () => ({ answer: `It is ${new Date().toISOString()} right now.` }),
  })

  // 2. A persona twist on the pre-step waterfall: every step's system prompt
  //    gets one extra line — composition, not configuration of the runtime.
  ctx.on('agent/pre-step', (spec, next) => {
    spec.systemPrompt += '\nAlways answer in the tone of a friendly librarian.'
    return next()
  })

  // 3. Observe the bus: purely notification — order and returns never matter.
  ctx.on('agent/status', (sessionId, status) => {
    console.log(`[hello-agent] ${sessionId} → ${status.state}: ${String(status.detail)}`)
  })
}
