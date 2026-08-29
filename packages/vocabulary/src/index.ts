/**
 * @sudive-ai/datum-vocabulary — the Datum L1 type vocabulary.
 *
 * The fixed language every higher layer speaks and extends by declaration
 * merging: five dispatch modes, five word maps, the agent event vocabulary,
 * branded IDs, and the twelve core persistent session events with their
 * fail-closed reader contract.
 *
 * Runtime surface is deliberately minimal: constants, one error class, and
 * two brand constructors. Everything else is compile-time only.
 */

/** JSON value vocabulary for anything crossing the log boundary. */
export * from './json.ts'
/** Nominal branding for identifiers. */
export * from './brand.ts'
/** Core branded IDs. */
export * from './ids.ts'
/** The five dispatch modes and their semantics. */
export * from './dispatch.ts'
/** The five word maps and their derived unions. */
export * from './vocabulary.ts'
/** The twelve core persistent session events and the fail-closed contract. */
export * from './session-events.ts'
/** The model-visible conversation history shape. */
export * from './messages.ts'
/** The runtime agent event vocabulary, merged into the kernel's Events. */
export * from './agent-events.ts'
