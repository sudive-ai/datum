import { DatabaseSync, type DatabaseSync as Database } from 'node:sqlite'
import type { SessionEvent, SessionId } from '@sudive-ai/datum-vocabulary'
import { validateSessionEnvelope } from '@sudive-ai/datum-session'
import type { SessionSummary, StorageAdapter } from './seam.ts'

/** Configuration for {@link createSqliteStorage}; every field required. */
export interface SqliteStorageConfig {
  /** Database file path (`:memory:` works for tests). Created if missing. */
  readonly path: string
}

/**
 * The SQLite storage engine — the default local persistence.
 *
 * Built on Node's built-in `node:sqlite` (no native compilation). One row
 * per session event, keyed (session_id, seq); one row per session for the
 * registry. Appends are `INSERT OR IGNORE`, making replay idempotent by
 * construction.
 *
 * Requires Node's `--experimental-sqlite` flag on Node 22.x (unflagged from
 * 23.4+).
 *
 * @param config — see {@link SqliteStorageConfig}.
 * @returns the adapter.
 */
export function createSqliteStorage(config: SqliteStorageConfig): StorageAdapter {
  if (!config.path) throw new TypeError('sqlite storage: path is required')
  const db: Database = new DatabaseSync(config.path)
  db.exec(`
    create table if not exists datum_session_events (
      session_id text not null,
      seq        integer not null,
      time       integer not null,
      type       text not null,
      payload    text not null,
      primary key (session_id, seq)
    );
    create table if not exists datum_sessions (
      session_id text primary key,
      created_at integer not null,
      agent      text not null default ''
    );
  `)

  return {
    name: 'sqlite',

    async append(event: SessionEvent): Promise<void> {
      db.prepare('insert or ignore into datum_session_events (session_id, seq, time, type, payload) values (?, ?, ?, ?, ?)')
        .run(event.payload.sessionId, event.seq, event.time, event.type, JSON.stringify(event))
      db.prepare('insert or ignore into datum_sessions (session_id, created_at) values (?, ?)')
        .run(event.payload.sessionId, event.time)
    },

    async load(sessionId: SessionId): Promise<readonly SessionEvent[]> {
      const rows = db.prepare('select payload from datum_session_events where session_id = ? order by seq')
        .all(sessionId) as Array<{ payload: string }>
      return rows.map((row, index) => validateSessionEnvelope(JSON.parse(row.payload), index + 1))
    },

    async listSessions(): Promise<readonly SessionSummary[]> {
      const rows = db.prepare(`
        select session_id,
               min(time) as first_time,
               max(time) as last_time,
               count(*)  as entries
        from datum_session_events
        group by session_id
        order by last_time desc
      `).all() as Array<{ session_id: string; first_time: number; last_time: number; entries: number }>
      return rows.map(row => ({
        sessionId: row.session_id as SessionId,
        firstTime: row.first_time,
        lastTime: row.last_time,
        entries: row.entries,
      }))
    },

    close: async () => db.close(),
  }
}
