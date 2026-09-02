import type { SessionEvent } from '@sudive-ai/datum-vocabulary'
import type { SessionId } from '@sudive-ai/datum-vocabulary'

/** One long-term memory entry — authored content, curatable by the agent. */
export interface MemoryEntry {
  readonly id: string
  /** Stable slug the model addresses the memory by (e.g. `user-language`). */
  readonly key: string
  readonly content: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** The memory store's Definition: upsert by key, list, remove. */
export interface MemoryStore {
  /**
   * Create or overwrite the entry addressed by `key`.
   *
   * @param key — the memory's stable slug.
   * @param content — the memory content.
   * @returns the stored entry.
   */
  put(key: string, content: string): Promise<MemoryEntry>
  /** Every entry, most recently updated first. */
  list(): Promise<readonly MemoryEntry[]>
  /**
   * Remove one entry.
   *
   * @param id — the entry id.
   * @returns `true` when an entry was removed.
   */
  remove(id: string): Promise<boolean>
}

/** One stored session's summary, for the workbench session list. */
export interface SessionSummary {
  readonly sessionId: SessionId
  /** Human-facing title (derived from the first user message); may be empty. */
  readonly title: string
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
  /**
   * Register a freshly created session so it lists before its first fact
   * lands.
   *
   * @param sessionId — the new session's identity.
   * @param agent — the agent name it runs.
   * @param title — optional human-facing title; updateable via renameSession.
   */
  registerSession(sessionId: SessionId, agent: string, title?: string | undefined): Promise<void>
  /**
   * Set a session's human-facing title.
   *
   * @param sessionId — the session to rename.
   * @param title — the new title.
   */
  renameSession(sessionId: SessionId, title: string): Promise<void>
  /**
   * Delete one session and all its entries.
   *
   * @param sessionId — the session to delete.
   */
  deleteSession(sessionId: SessionId): Promise<void>
  /** The engine's long-term memory store. */
  readonly memories: MemoryStore
  /** Close the engine's connections; idempotent. */
  close(): Promise<void>
}
