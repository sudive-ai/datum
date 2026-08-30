import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = join(process.cwd(), '.cache-probe-' + Date.now())
mkdirSync(dir, { recursive: true })
const p = join(dir, 'v.ts')
writeFileSync(p, 'export const v = 1\n')
const a = await import(pathToFileURL(p).href)
writeFileSync(p, 'export const v = 2\n')
const b = await import(pathToFileURL(p).href + '?t=' + Date.now())
console.log('a.v =', a.v, '| b.v (query bust) =', b.v)
writeFileSync(p, 'export const v = 3\n')
const c = await import(pathToFileURL(p).href + '?t=' + (Date.now() + 1))
console.log('c.v (query bust 2) =', c.v)
