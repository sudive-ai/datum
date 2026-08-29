/**
 * Datum kernel — the fixed language layer every other package builds on.
 *
 * Owns three primitives and nothing else:
 *
 * 1. **Reversible registration.** Every registration returns a {@link Disposer};
 *    a {@link Scope} keeps them and replays them in reverse order on dispose.
 *    An irreversible registration API must never exist.
 * 2. **Typed events.** `emit` observes; `waterfall` composes listeners around the
 *    caller's default behavior — the default is the innermost `next()`, and a
 *    listener that returns without calling `next()` owns the decision.
 * 3. **Service discovery.** Services claim a stable key on a context; consumers
 *    look services up by key and never import a concrete implementation.
 *
 * Red lines (see /AGENTS.md): no hidden defaults inside operations — defaults
 * are an explicit `resolve(request): Spec` step owned by the implementation;
 * fail loud at the earliest resolvable point.
 */

/** A reversible registration handle. Every registration API returns one. */
export type Disposer = () => void;

/**
 * A registration scope that owns the disposers of everything registered
 * through it and unwinds them in reverse order, exactly once.
 *
 * Contract:
 * - `effect(fn)` runs `fn` immediately; its return value (a disposer, an
 *   array of disposers, or nothing) joins the scope's teardown stack.
 * - `dispose()` replays collected disposers LIFO exactly once; effects
 *   registered after dispose begins are rejected (fail loud).
 * - Scopes compose: disposing a child is itself one effect on its parent,
 *   so teardown order stays total and observable.
 */
export interface Scope {
  /** Run `fn` now and keep its disposer(s) for reverse-order teardown. */
  effect(fn: () => Disposer | Disposer[] | void): void;
  /** Replay every collected disposer in reverse order, exactly once. */
  dispose(): Promise<void> | void;
}

// TODO(m1): implement Scope; add the emit/waterfall event bus and the keyed
// service registry. Waterfall contract: listeners run outermost-first; the
// dispatch caller passes the default behavior as the innermost `next`.
