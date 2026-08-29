/**
 * Datum tools — the registry of model-facing capabilities and the guarded
 * execution pipeline.
 *
 * A tool is a model-facing schema plus a canonical, lossless-JSON output
 * declaration and an `execute` function. Only model-facing fields ever reach
 * a model request; execution metadata is registry-owned and never leaks.
 *
 * Execution is guarded at chokepoints, in order: pre-policy (approval and
 * permission checks — default deny, fail closed) → monotonic guards → around
 * dispatch → post-policy → final-result observation. Governance lives on
 * these edges, never inside a tool body: swapping a provider must never
 * change a policy, and tightening a policy must never fork a provider.
 *
 * Red lines (see /AGENTS.md):
 * - The cancellation signal is forwarded to every tool; the registry never
 *   abandons a running call and never hard-kills same-process work.
 * - Every tool call and result becomes durable facts; a call whose result
 *   reached the model without a log entry breaks the runtime invariant.
 */

/** Model-facing description of one tool: name, description, parameter schema. */
export interface ToolSchema {
  /** Stable, model-visible call name. */
  readonly name: string;
  /** Human- and model-facing description of when and how to call the tool. */
  readonly description: string;
  /** JSON Schema of the `args` object; an explicit object node. */
  readonly parameters: unknown;
}

/**
 * A registered tool: its schema plus the canonical output contract and the
 * execution body.
 */
export interface ToolDefinition extends ToolSchema {
  /**
   * Run one accepted call.
   *
   * Contract: `args` arrives losslessly snapshotted and frozen; async work
   * must observe `exec.signal` and settle only after owned work reaches
   * quiescence; the return value must satisfy the tool's declared canonical
   * output schema.
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

/** Execution identity and cancellation for one tool call. */
export interface ToolRunContext {
  /** Abort when the owning turn is cancelled, times out, or the agent is disposed. */
  readonly signal: AbortSignal;
}

// TODO(m3): implement the registry (register returns a disposer), the schema
// allowlist (model-facing projection), and the guarded execution pipeline.
