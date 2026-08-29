/**
 * Datum session — the append-only event log and the single source of truth.
 *
 * Every fact is an immutable {@link SessionEvent}: a `type` from the closed
 * {@link SessionEventMap} vocabulary, a monotonic `seq`, a `time`, and frozen
 * JSON `data`. Message history is **derived** from the log (`derive`), never
 * stored beside it; persistence, replay, forks, UI, and audit are all
 * projections of this stream.
 *
 * Red lines (see /AGENTS.md):
 * - **Model-visible ⟺ logged**: anything that reaches a model request must be
 *   reconstructable from the log; a new model-visible input requires a new
 *   member in `SessionEventMap`.
 * - **Fail closed on read**: a reader that meets an event type absent from the
 *   vocabulary refuses the log; it never skips an unknown event.
 * - `append` validates inline: data must be JSON-serializable, events are
 *   deep-frozen, `seq` is strictly monotonic.
 */

/** Monotonic position of an event inside its log. Strictly increasing. */
export type Seq = number;

/** Error thrown when a log contains an event type the reading build does not know. */
export class SessionFormatUnsupportedError extends Error {}

/** Envelope of every persisted fact. Immutable once appended. */
export interface SessionEvent<T extends string = string, D = unknown> {
  /** Vocabulary key from `SessionEventMap`; a discriminant tag. */
  readonly type: T;
  /** Monotonic position in the log (`log.length` at append time). */
  readonly seq: Seq;
  /** Wall-clock append time in epoch milliseconds. */
  readonly time: number;
  /** Lossless JSON payload; deep-frozen after append. */
  readonly data: D;
}

/**
 * The event vocabulary — the closed union of every durable fact the runtime
 * can record. Extending it is a protocol, not a shortcut: every build that
 * reads a log must know every member it encounters, so a new member lands
 * together with every consumer that folds it.
 *
 * The first core event types land in M1 (see docs/ROADMAP.md): turn and step
 * boundaries, user/assistant messages, request headers, tool calls/results.
 */
export interface SessionEventMap {
  // Deliberately empty in the skeleton: no fact exists until its type,
  // its fold, and its consumers exist in the same change.
}

/** A member of the vocabulary. */
export type SessionEventType = keyof SessionEventMap;

/** The discriminated union of every durable fact. */
export type SessionEventOf<T extends SessionEventType = SessionEventType> = SessionEvent<T, SessionEventMap[T]>;

// TODO(m1): implement Session (append + incremental derive cache), JSONL
// serialization, and the fail-closed loader (KNOWN_SESSION_EVENT_TYPES set,
// SessionFormatUnsupportedError on unknown types).
