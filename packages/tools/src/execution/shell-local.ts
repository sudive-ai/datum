import { spawn } from 'node:child_process'
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from './seam.ts'

/** Policy for {@link createShellLocalAdapter}: the sandbox wrapped around exact argv. */
export interface ShellLocalPolicy {
  /** When set, `argv[0]` must be on this allowlist — anything else refuses. */
  readonly allow?: readonly string[] | undefined
}

/**
 * The shell-local execution provider: process execution over **exact argv**.
 *
 * The contract is the whole point: `spawn(argv[0], argv.slice(1))` with no
 * shell in between — no interpolation, no concatenation, nothing to inject.
 * The optional allowlist policy wraps the outside; abort kills the child.
 *
 * @param policy — see {@link ShellLocalPolicy}.
 * @returns the adapter.
 */
export function createShellLocalAdapter(policy: ShellLocalPolicy = {}): ExecutionAdapter {
  return {
    name: 'shell-local',

    run(request: ExecutionRequest): Promise<ExecutionResult> {
      const [file = '', ...args] = request.argv
      if (!file) return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'shell-local adapter: argv must name a program' })
      if (policy.allow && !policy.allow.includes(file)) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: `shell-local adapter: ${JSON.stringify(file)} is not on the policy allowlist` })
      }

      return new Promise(resolveRun => {
        const child = spawn(file, args, {
          cwd: request.cwd ?? undefined,
          signal: request.signal,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        const finish = (exitCode: number, note?: string): void => {
          resolveRun({ exitCode, stdout, stderr: note === undefined ? stderr : `${stderr}${stderr ? '\n' : ''}${note}` })
        }
        child.on('error', (error: NodeJS.ErrnoException) => {
          finish(error.code === 'ABORT_ERR' ? 130 : 127, String(error))
        })
        child.on('close', code => {
          finish(code ?? 1)
        })
      })
    },
  }
}
