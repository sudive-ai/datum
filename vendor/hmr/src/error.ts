import { Context } from '@sudive-ai/cordis'
import { codeFrameColumns } from '@babel/code-frame'
import { readFileSync } from 'node:fs'

// Structural stand-in for esbuild's `BuildFailure` (vendored copy does not
// depend on esbuild for a type-only import; see vendor/README.md mod 8).
interface BuildFailure {
  errors: { text: string; location?: { file: string; line: number; column: number } }[]
  warnings: unknown[]
}

function isBuildFailure(e: any): e is BuildFailure {
  return Array.isArray(e?.errors) && e.errors.every((error: any) => error.text)
}

/** Log HMR build failures with code frames when source locations are available. */
export function handleError(ctx: Context, e: any) {
  if (!isBuildFailure(e)) {
    ctx.logger.warn(e)
    return
  }

  for (const error of e.errors) {
    if (!error.location) {
      ctx.logger.warn(error.text)
      continue
    }
    try {
      const { file, line, column } = error.location
      const source = readFileSync(file, 'utf8')
      const formatted = codeFrameColumns(source, {
        start: { line, column },
      }, {
        highlightCode: true,
        message: error.text,
      })
      ctx.logger.warn(`File: ${file}:${line}:${column}\n` + formatted)
    } catch (e) {
      ctx.logger.warn(e)
    }
  }
}
