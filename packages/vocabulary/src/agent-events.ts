import type { SessionEvent } from './session-events.ts'
import type { JsonRecord, JsonValue } from './json.ts'
import type { MessageId, SessionId, StepId, TopCallId, TurnId } from './ids.ts'

/**
 * Coarse lifecycle state of a running agent, carried by `agent/status`.
 */
export type AgentState = 'idle' | 'thinking' | 'acting' | 'stopping'

/** A status report broadcast whenever the agent's coarse state changes. */
export interface AgentStatus {
  readonly state: AgentState
  /** Human-readable context for the state (current turn, step, or stop reason). */
  readonly detail: JsonValue
}

/**
 * What one step intends to do, before the model is consulted.
 *
 * `agent/pre-step` (waterfall) is the only place a step may be rewritten or
 * refused: the system prompt segments and the tool roster are assembled here.
 * The spec is a **draft** — a listener rewrites it by mutating the fields it
 * owns, then calls `next()`; returning a {@link StepVeto} instead of calling
 * `next()` closes the turn as `blocked`, with the refusal traceable in the log.
 *
 * Kernel waterfall contract: `next()` takes no arguments. Values thread by
 * draft mutation, never by passing arguments through `next()`.
 */
export interface StepSpec {
  /** Identity — fixed for the life of the step; never rewrite. */
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly stepId: StepId
  /** The assembled system prompt for this step; rewrite by assignment. */
  systemPrompt: string
  /** The tool names this step may call; rewrite by assignment. */
  toolNames: readonly string[]
}

/** A pre-step refusal: the turn closes as `blocked` carrying this reason. */
export interface StepVeto {
  readonly blocked: string
}

/**
 * The call-time configuration of a model request — also a **draft** under the
 * same kernel waterfall contract as {@link StepSpec}.
 *
 * `agent/request` (waterfall) may adjust call configuration only — provider,
 * model, limits. Message content is deliberately absent from this type: the
 * model-visible context cannot be rewritten at the seam, because it must
 * equal what `request/context` logged (model-visible ⟺ logged).
 */
export interface RequestSpec {
  /** The model identifier as the provider understands it. */
  model: string
  /** Hard output-token budget for the call. */
  maxTokens: number
  /** Provider-specific call options (temperature, top_p, …). */
  options: JsonRecord
}

/**
 * The runtime (non-persistent) agent event vocabulary, merged into the kernel's
 * `Events` interface so `ctx.emit('agent/…')` is fully typed.
 *
 * Each event declares its dispatch mode with an `@mode` tag; tooling compares
 * declarations against dispatch sites. Persistent facts live exclusively in
 * `SessionEventMap` — this bus carries runtime coordination, and the mirror
 * `session/event` broadcast is the only bridge from the log to live consumers.
 */
export interface AgentEventMap {
  /**
   * A session was mounted onto the runtime.
   *
   * @mode parallel
   */
  'agent/session-start'(sessionId: SessionId, surface: string): void

  /**
   * The agent's coarse lifecycle state changed.
   *
   * @mode emit
   */
  'agent/status'(sessionId: SessionId, status: AgentStatus): void

  /**
   * A message was queued for its next turn.
   *
   * @mode emit
   */
  'agent/inbox/next-turn'(sessionId: SessionId, messageId: MessageId): void

  /**
   * A tool round was queued for the next step of the open turn.
   *
   * @mode emit
   */
  'agent/inbox/next-step'(sessionId: SessionId, topCallId: TopCallId): void

  /**
   * A step is about to be planned; rewrite the draft or veto the step.
   * A listener that returns a {@link StepVeto} without calling `next()` owns
   * the decision: the turn closes as `blocked`. `next()` takes no arguments —
   * rewrite happens by mutating the {@link StepSpec} draft.
   *
   * @mode waterfall
   */
  'agent/pre-step'(spec: StepSpec, next: () => StepSpec): StepSpec | StepVeto

  /**
   * A model request is about to be placed; adjust call configuration only.
   * The message context is intentionally not reachable here (see
   * {@link RequestSpec}).
   *
   * @mode waterfall
   */
  'agent/request'(spec: RequestSpec, next: () => RequestSpec): RequestSpec

  /**
   * A model request failed after its header was logged.
   *
   * @mode emit
   */
  'agent/request-error'(sessionId: SessionId, topCallId: TopCallId, error: unknown): void

  /**
   * A turn is stopping; listeners are awaited in order and must not write
   * terminal facts — terminal `turn/end` remains the loop's exclusive duty.
   * Listener order must not affect the outcome.
   *
   * @mode serial
   */
  'agent/turn-stopping'(sessionId: SessionId, turnId: TurnId): void | Promise<void>

  /**
   * A session event was appended to the log; the broadcast that persistence
   * plugins (JSONL) and UI projections subscribe to. Emitted synchronously
   * after append, before the append call returns.
   *
   * @mode emit
   */
  'session/event'(event: SessionEvent): void
}

declare module '@sudive-ai/cordis' {
  // The runtime agent vocabulary joins the kernel's event interface, so
  // ctx.emit / ctx.on see every agent event fully typed.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Events extends AgentEventMap {}
}

/** The keys of the runtime agent vocabulary. */
export type AgentEventType = keyof AgentEventMap
