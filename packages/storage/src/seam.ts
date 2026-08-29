import type { SessionEvent } from '@sudive-ai/datum-vocabulary'
import type { SessionId } from '@sudive-ai/datum-vocabulary'

/** One stored session's summary, for the workbench session list. */
export interface SessionSummary {
  readonly sessionId: SessionId
  /** Epoch ms of the first entry. */
  readonly firstTime: number
  /** Epoch ms of the last entry. */
  readonly lastTime: number
  /** Entry count. */
  readonly entries: number
}

/**
 * The storage seam's Definition role: everything a consumer may rely on and
 * an engine must fulfill.
 *
 * Engines persist session events — the log, the trace, and the trajectory
 * are the same ordered facts — plus the session registry. Reads are
 * fail-closed: an engine hands rows back through the session package's
 * shared envelope validation, so an unknown event type refuses the load no
 * matter where the bytes came from.
 */
export interface StorageAdapter {
  /** Engine identity, e.g. `'sqlite'` or `'postgres'`. */
  readonly name: string
  /**
   * Persist one session event. Must be idempotent per (session, seq):
   * re-appending an existing entry is a no-op, not an error — broadcast
   * replays and crash retries must not corrupt the log.
   *
   * @param event — the entry to persist.
   */
  append(event: SessionEvent): Promise<void>
  /**
   * Load one session's entries, oldest first, fail-closed.
   *
   * @param sessionId — the session to load.
   * @returns the entries; an empty array when the session is unknown.
   */
  load(sessionId: SessionId): Promise<readonly SessionEvent[]>
  /** Summaries of every stored session, most recently active first. */
  listSessions(): Promise<readonly SessionSummary[]>
  /** Close the engine's connections; idempotent. */
  close(): Promise<void>
}
