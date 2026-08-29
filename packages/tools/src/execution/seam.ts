/**
 * The execution seam's Definition role — how an agent touches the machine
 * (filesystem, shell, …). Deliberately definition-only for now: providers
 * (fs, shell with sandbox policies) land with the workbench, and every
 * policy wraps *exact argv* handed over by the consumer — the seam never
 * interpolates, so what was executed is always reconstructable.
 */

/** One execution request: what to run, never how to wrap it. */
export interface ExecutionRequest {
  /** The exact argv to execute, policy wrapping happens outside this seam. */
  readonly argv: readonly string[]
  /** Working directory for the execution. */
  readonly cwd: string | undefined
  /** Abort signal; the backend must kill the work when aborted. */
  readonly signal: AbortSignal | undefined
}

/** One execution result. */
export interface ExecutionResult {
  /** Process exit code (or equivalent completion status). */
  readonly exitCode: number
  /** Standard output, captured verbatim. */
  readonly stdout: string
  /** Standard error, captured verbatim. */
  readonly stderr: string
}

/**
 * The execution seam: everything a consumer may rely on and a backend must
 * fulfill. Completing the seam requires two providers and an end-to-end swap
 * with zero consumer edits (the M3 gate).
 */
export interface ExecutionAdapter {
  /** Backend identity, e.g. `'fs-local'` or `'shell-local'`. */
  readonly name: string
  /**
   * Execute one request.
   *
   * @param request — the exact work to do.
   * @returns the captured result.
   */
  run(request: ExecutionRequest): Promise<ExecutionResult>
}
