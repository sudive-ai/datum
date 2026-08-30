import { Service, type Context } from '@sudive-ai/cordis'
import type { JsonRecord } from '@sudive-ai/datum-vocabulary'
import type { ToolView } from '../llm/seam.ts'

/** Cancellation-scoped context handed to a tool's execute. */
export interface ToolContext {
  /** Abort signal; a tool must stop promptly when aborted. */
  readonly signal: AbortSignal | undefined
}

/**
 * One executable capability, registered by name.
 *
 * A tool is domain logic arriving as a *composition*: the runtime ships no
 * tools, owners register them through this seam and stay swappable.
 */
export interface ToolDefinition {
  /** Registration name; the model sees it verbatim. */
  readonly name: string
  /** Human/model-readable description of what the tool does. */
  readonly description: string
  /** JSON Schema of the input object the model must produce. */
  readonly parameters: JsonRecord
  /** When true, every execution must pass the mounted guard — default deny. */
  readonly requiresApproval?: boolean | undefined
  /**
   * Execute the tool.
   *
   * @param input — the model-produced input (validated by the schema owner).
   * @param context — cancellation scope.
   * @returns the result payload; JSON-serializable.
   */
  execute(input: JsonRecord, context: ToolContext): JsonRecord | Promise<JsonRecord>
}

/**
 * The tool registry, mounted as `ctx.tools`.
 *
 * Registrations are reversible effects: `register` returns a disposer, and
 * teardown (fiber unload) removes exactly what the fiber added.
 */
/** The approval chokepoint: decides whether a guarded tool may run. */
export type ExecutionGuard = (tool: ToolDefinition, input: JsonRecord) => void | Promise<void>

/**
 * A guarded tool needed approval but no approver is mounted — the
 * fail-closed default. Distinct from a denial so callers can tell
 * "nobody could decide" from "somebody said no".
 */
export class ApprovalUnavailableError extends Error {
  /** The tool that was refused. */
  readonly tool: string

  /**
   * @param tool — the tool that was refused.
   */
  constructor(tool: string) {
    super(`approval unavailable: tool ${JSON.stringify(tool)} requires approval and no approver is mounted`)
    this.name = 'ApprovalUnavailableError'
    this.tool = tool
  }
}

/** An approver explicitly refused a guarded action. */
export class ApprovalDeniedError extends Error {
  /** The tool that was refused. */
  readonly tool: string
  /** The approver identity that said no. */
  readonly approver: string

  /**
   * @param tool — the tool that was refused.
   * @param approver — who said no.
   * @param detail — the denial reason.
   * @param options — standard Error options (`cause`).
   */
  constructor(tool: string, approver: string, detail: string, options?: ErrorOptions) {
    super(`approval denied for tool ${JSON.stringify(tool)} by ${approver}: ${detail}`, options)
    this.name = 'ApprovalDeniedError'
    this.tool = tool
    this.approver = approver
  }
}

export class ToolService extends Service {
  private readonly _tools = new Map<string, ToolDefinition>()
  private _guard: ExecutionGuard | undefined
  private _approver = 'mounted-approver'

  /** The mounted approver's identity, when one is mounted. */
  get approver(): string | undefined {
    return this._guard ? this._approver : undefined
  }

  /**
   * Mount (or with `undefined`, unmount) the approval chokepoint.
   *
   * @param guard — invoked before every `requiresApproval` tool executes.
   *   Throw inside the guard to refuse; any throw is normalized into
   *   {@link ApprovalDeniedError}. With no guard mounted, guarded tools
   *   refuse outright with {@link ApprovalUnavailableError} (fail closed —
   *   nothing degrades into allow).
   * @param approver — the mount's identity, carried on decisions.
   */
  setGuard(guard: ExecutionGuard | undefined, approver: string = 'mounted-approver'): void {
    this._guard = guard
    this._approver = approver
  }

  /**
   * Register one tool.
   *
   * @param definition — the tool to register.
   * @returns a disposer unregistering it; `true` when it was still registered.
   * @throws when a tool of the same name is already registered (fail loud —
   *   silent overwrite would make capability sets ambiguous).
   */
  register(definition: ToolDefinition): () => boolean {
    this.ctx.fiber.assertActive()
    if (this._tools.has(definition.name)) {
      throw new Error(`tool registry: a tool named ${JSON.stringify(definition.name)} is already registered`)
    }
    this._tools.set(definition.name, definition)
    return () => this._tools.delete(definition.name)
  }

  /**
   * Look up one tool by name.
   *
   * @param name — the registration name.
   * @returns the tool.
   * @throws when no such tool is registered — the model must never be shown
   *   a tool the registry cannot execute.
   */
  get(name: string): ToolDefinition {
    const tool = this._tools.get(name)
    if (!tool) {
      throw new Error(`tool registry: no tool named ${JSON.stringify(name)}`)
    }
    return tool
  }

  /** Every registered tool, registration order. */
  list(): readonly ToolDefinition[] {
    return [...this._tools.values()]
  }

  /**
   * Execute one tool through the chokepoint — the only sanctioned path.
   *
   * @param name — the registration name.
   * @param input — the model-produced input.
   * @param context — cancellation scope.
   * @returns the tool's result.
   * @throws {@link ApprovalUnavailableError} when the tool requires approval
   *   and no approver is mounted; {@link ApprovalDeniedError} when the
   *   mounted approver refuses; any tool execution failure passes through.
   */
  async execute(name: string, input: JsonRecord, context: ToolContext): Promise<JsonRecord> {
    const tool = this.get(name)
    if (tool.requiresApproval === true) {
      if (!this._guard) throw new ApprovalUnavailableError(name)
      try {
        await this._guard(tool, input)
      } catch (error) {
        if (error instanceof ApprovalDeniedError) throw error
        throw new ApprovalDeniedError(name, this._approver, String(error), { cause: error })
      }
    }
    return tool.execute(input, context)
  }

  /** The provider-facing view of the registry, for LLM requests. */
  view(): readonly ToolView[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }
}

declare module '@sudive-ai/cordis' {
  interface Context {
    /** The tool registry; capabilities register via `ctx.tools.register(...)`. */
    tools: ToolService
  }
}
