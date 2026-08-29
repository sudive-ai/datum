import type { Branded } from './brand.ts'

/**
 * The core branded identifiers of the fixed language.
 *
 * New identifiers may be added by higher layers (they are plain type aliases,
 * not an open interface), but every identifier here crosses at least one
 * package boundary and therefore must be branded — never a bare string or
 * number.
 */

/** Identifies one session: one append-only log, one agent instance. */
export type SessionId = Branded<'SessionId'>

/**
 * Identifies one model request at the top level of a step.
 *
 * A top call spans `request/header` → `assistant/chunk`* → `assistant/message`
 * (and any `tool/call`s it emitted); it is the unit that chunk streams and
 * request errors refer back to.
 */
export type TopCallId = Branded<'TopCallId'>

/** Identifies one turn: one user intent driven to completion. */
export type TurnId = Branded<'TurnId'>

/** Identifies one step inside a turn: one top call plus its tool round. */
export type StepId = Branded<'StepId'>

/** Identifies one message derived from the log (user or assistant). */
export type MessageId = Branded<'MessageId'>

/** Identifies one tool invocation, as referenced by `tool/call`/`tool/result`. */
export type ToolCallId = Branded<'ToolCallId'>

/** The monotonic sequence number of a log entry; 0-based, gap-free per session. */
export type EntrySeq = Branded<'EntrySeq', number>
