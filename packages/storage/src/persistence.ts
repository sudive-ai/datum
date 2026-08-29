import type { Context } from '@sudive-ai/cordis'
import type { SessionEvent } from '@sudive-ai/datum-vocabulary'
import { SessionLog } from '@sudive-ai/datum-session'
import type { StorageAdapter } from './seam.ts'

/**
 * Wire one session log to one storage engine: every appended entry is
 * persisted through {@link StorageAdapter.append}.
 *
 * Persistence rides the `session/event` broadcast (the same ordering guarantee
 * UI projections use), so an engine swap touches nothing else. A failed write
 * is *named*, never swallowed: it goes to the context logger with the engine
 * and seq, and the rejection is surfaced (the process must not pretend the
 * fact was stored when it was not).
 *
 * @param options — the context, the log, and the engine.
 * @returns a disposer that unsubscribes the writer and then **drains** —
 *   awaits every in-flight write — so closing after disposal cannot lose the
 *   tail of the log. The engine itself is closed by its owner.
 */
export function mountSessionPersistence(options: {
  context: Context
  session: SessionLog
  storage: StorageAdapter
}): () => Promise<void> {
  const { context, session, storage } = options
  const pending = new Set<Promise<void>>()
  const unsubscribe = context.on('session/event', (event: SessionEvent) => {
    const write = storage.append(event).catch((error: unknown) => {
      context.logger.error(
        `storage ${storage.name}: failed to persist ${event.type} seq ${event.seq} of ${session.sessionId}: ${String(error)}`,
      )
      throw error // surface it — silence is never a success path
    })
    pending.add(write)
    void write.then(() => pending.delete(write), () => pending.delete(write))
  })
  return async () => {
    unsubscribe()
    await Promise.all(pending)
  }
}

/**
 * Restore-or-create one session log from a storage engine.
 *
 * Restores the most recently active session (or the one named) by loading
 * its entries through the engine's fail-closed read; when nothing is stored
 * yet, a fresh log begins and persists from its first fact on.
 *
 * @param options — the context, the engine, and optionally a session id.
 * @returns the rehydrated log, persistence already mounted.
 */
export async function openPersistentSessionLog(options: {
  context: Context
  storage: StorageAdapter
  sessionId?: import('@sudive-ai/datum-vocabulary').SessionId
}): Promise<SessionLog> {
  const { context, storage } = options
  const sessions = await storage.listSessions()
  const stored = options.sessionId ?? sessions[0]?.sessionId
  const entries = stored ? await storage.load(stored) : []
  const session = stored !== undefined
    ? new SessionLog({ context, sessionId: stored, entries })
    : new SessionLog({ context, entries })
  mountSessionPersistence({ context, session, storage })
  return session
}
