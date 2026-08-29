/**
 * Datum loop — the public Agent contract and the default turn/step driver.
 *
 * The contract lives here; the concrete driver registers itself through the
 * factory seam, so consumers depend on the contract and never on a concrete
 * loop implementation. Interception is deliberately narrow: `pre-step` is the
 * only waterfall that may rewrite or reject the messages entering a step;
 * `request` may replace call configuration but can never touch messages —
 * that power asymmetry is the "model-visible ⟺ logged" invariant, projected
 * into the loop.
 *
 * Delivery: an agent owns an inbox of pending input (next-turn and next-step
 * queues, themselves durable projections). `send` delivers and optionally
 * wakes; cancellation threads one AbortSignal from `cancel` through every
 * pending await — the signal is the only cancellation mechanism.
 */

/** Stable identity of an agent; shares identity with its durable log. */
export type AgentId = string & { readonly __brand: "AgentId" };

/** Why an active driver was cancelled. */
export type CancelCause =
  | { readonly kind: "user" }
  | { readonly kind: "parent" }
  | { readonly kind: "policy"; readonly reason: string }
  | { readonly kind: "disposed" };

/** Target queue for delivered input. */
export type InboxTarget = "next-turn" | "next-step";

/** The public live-agent handle every consumer programs against. */
export interface Agent {
  /** Session-backed identity; the agent's log is the durable source of truth. */
  readonly id: AgentId;

  /**
   * Deliver identified input to an inbox boundary and optionally wake the
   * driver. Waking input opens a turn; non-waking input waits for the next
   * wake.
   */
  send(input: unknown, target: InboxTarget, wakeup: boolean): void;

  /**
   * Abort active work and clear pending input. The first cause wins; the
   * cause is carried on the active operation's signal and lands in the
   * durable turn outcome.
   */
  cancel(cause: CancelCause): void;

  /** Resolve after the agent reaches quiescence: no active driver remains. */
  whenIdle(): Promise<void>;
}

/** Creation seam: the default driver registers here; consumers never import it. */
export interface AgentFactory {
  /** Create an agent (and its session) under one caller-supplied identity. */
  create(id: AgentId): Promise<Agent> | Agent;
}

// TODO(m2): implement the inbox (durable splice projections), the turn/step
// state machine, pre-step/request waterfalls, the AbortSignal chain, and the
// factory registration with ordered teardown.
