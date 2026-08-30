import { readFile, readdir, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from './seam.ts'

/** Policy for {@link createFsLocalAdapter}: the sandbox wrapped around exact argv. */
export interface FsLocalPolicy {
  /** Every touched path must stay under this root; required — no policy, no provider. */
  readonly root: string
  /** Refuse write-like operations (write/mkdir/rm) when false; defaults to allow. */
  readonly readonly?: boolean | undefined
}

/**
 * The fs-local execution provider: filesystem access expressed as exact argv.
 *
 * Argv contract — `argv[0]` is the op, the rest are its arguments:
 * `read <path>` / `list <path>` / `stat <path>` / `write <path> <content>` /
 * `mkdir <path>` / `rm <path>`.
 *
 * Sandbox policy wraps the *outside* of the seam: paths are resolved against
 * the policy root and must stay inside it; `readonly` refuses write-like ops.
 * The consumer still hands over exact argv — what ran is always on record.
 *
 * @param policy — see {@link FsLocalPolicy}; the root is mandatory.
 * @returns the adapter.
 */
export function createFsLocalAdapter(policy: FsLocalPolicy): ExecutionAdapter {
  if (!policy.root) throw new TypeError('fs-local adapter: policy root is required (no policy, no provider)')

  const inSandbox = (path: string): string => {
    const root = resolve(policy.root)
    const target = resolve(root, path)
    if (target !== root && !target.startsWith(root + '/')) {
      throw new Error(`fs-local adapter: ${JSON.stringify(path)} escapes the sandbox root ${JSON.stringify(root)}`)
    }
    return target
  }

  return {
    name: 'fs-local',

    async run(request: ExecutionRequest): Promise<ExecutionResult> {
      const [op = '', ...args] = request.argv
      try {
        switch (op) {
          case 'read': {
            const content = await readFile(inSandbox(args[0] ?? ''), 'utf8')
            return { exitCode: 0, stdout: content, stderr: '' }
          }
          case 'list': {
            const entries = await readdir(inSandbox(args[0] ?? '.'))
            return { exitCode: 0, stdout: entries.join('\n'), stderr: '' }
          }
          case 'stat': {
            const info = await stat(inSandbox(args[0] ?? ''))
            return { exitCode: 0, stdout: JSON.stringify({ size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() }), stderr: '' }
          }
          case 'write': {
            if (policy.readonly === true) return { exitCode: 1, stdout: '', stderr: 'fs-local adapter: the policy is readonly' }
            await writeFile(inSandbox(args[0] ?? ''), args[1] ?? '', 'utf8')
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          case 'mkdir': {
            if (policy.readonly === true) return { exitCode: 1, stdout: '', stderr: 'fs-local adapter: the policy is readonly' }
            await mkdir(inSandbox(args[0] ?? ''), { recursive: true })
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          case 'rm': {
            if (policy.readonly === true) return { exitCode: 1, stdout: '', stderr: 'fs-local adapter: the policy is readonly' }
            await rm(inSandbox(args[0] ?? ''), { recursive: true })
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          default:
            return { exitCode: 1, stdout: '', stderr: `fs-local adapter: unknown op ${JSON.stringify(op)}` }
        }
      } catch (error) {
        return { exitCode: 1, stdout: '', stderr: String(error) }
      }
    },
  }
}
