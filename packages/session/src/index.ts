/**
 * @sudive-ai/datum-session — the Datum M1 session facts layer.
 *
 * An append-only log per session is the single source of truth: entries are
 * deep-frozen facts with gap-free monotonic seqs, serialized as JSONL, and
 * reloaded fail-closed (unknown event types refuse the log; malformed ones
 * refuse loudly). Derived state — chat history today, projections tomorrow —
 * folds from the entries and from nothing else.
 */

/** Deep-freeze helper for logged facts. */
export * from './freeze.ts'
/** The append-only session log. */
export * from './session-log.ts'
/** JSONL serialization and the fail-closed reader. */
export * from './jsonl.ts'
/** Derived conversation-history projection. */
export * from './derive.ts'
