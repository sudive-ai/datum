/**
 * @sudive-ai/datum-loop — the Datum M2 reliable-execution layer.
 *
 * The default harness: an agent is a composition (`AgentSpec`), a turn is one
 * intent driven to a terminal logged fact, a step is one model call plus its
 * tool round. Cancellation reaches every pending await; refusal, error, and
 * cancel all leave traces in the log.
 */

/** The Agent contract: an agent is a preset, never runtime code. */
export * from './agent.ts'
/** Loop-local id minting. */
export * from './ids.ts'
/** The turn/step state machine, the waterfalls, cancellation, the factory seam. */
export * from './loop.ts'
