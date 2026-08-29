/**
 * @sudive-ai/datum-storage — the Datum storage seam.
 *
 * Pluggable persistence for the ordered facts (log, trace, trajectory) and
 * the session registry: SQLite as the default local engine (Node's built-in
 * `node:sqlite`), PostgreSQL as the optional connection-configured engine.
 * Every read path goes through the session package's fail-closed envelope
 * validation — an unknown event type refuses the load no matter the engine.
 */

/** The storage seam's Definition: adapter contract and session summaries. */
export * from './seam.ts'
/** The default local engine: SQLite via node:sqlite. */
export * from './sqlite.ts'
/** The optional engine: PostgreSQL via postgres.js. */
export * from './postgres.ts'
/** Persistence mounting and restore-or-create session rehydration. */
export * from './persistence.ts'
