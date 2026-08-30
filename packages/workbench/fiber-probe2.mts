import { Context } from '@sudive-ai/cordis'
import { ToolService } from '@sudive-ai/datum-tools'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = join(process.cwd(), '.fiber-probe2-' + Date.now())
mkdirSync(dir, { recursive: true })
const pluginPath = join(dir, 'p.ts')
writeFileSync(pluginPath, `
export default (ctx) => {
  ctx.on('probe-event', () => {})
  ctx.tools.register({ name: 't1', description: '', parameters: { type: 'object', properties: {} }, execute: () => ({}) })
}
`)

const ctx = new Context()
const tools = new ToolService(ctx, 'tools')
let probeCount = 0
ctx.on('probe-event', () => probeCount++)
ctx.emit('probe-event')
const mod = await import(pathToFileURL(pluginPath).href)
const fiber = ctx.plugin(mod.default)
await fiber
console.log('after plugin: tools =', tools.list().map(t => t.name))
await fiber.dispose()
ctx.emit('probe-event')
console.log('after dispose: tools =', tools.list().map(t => t.name), '| probe listeners fired on dispose-emit:', probeCount)
