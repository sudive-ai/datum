import { DatabaseSync, type DatabaseSync as Database } from 'node:sqlite'
import type { SessionEvent, SessionId } from '@sudive-ai/datum-vocabulary'
import { validateSessionEnvelope } from '@sudive-ai/datum-session'
import type { MemoryEntry, MemoryStore, SessionSummary, StorageAdapter } from './seam.ts'

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
      agent      text not null default '',
      title      text not null default ''
    );
    create table if not exists datum_memories (
      id         text primary key,
      key        text not null unique,
      content    text not null,
      created_at integer not null,
      updated_at integer not null
    );
  `)
  // Lightweight migration: databases created before a column existed get it
  // added on open (duplicate add attempts fail silently per column).
  const addColumn = (column: string, definition: string): void => {
    try {
      db.exec(`alter table datum_sessions add column ${column} ${definition}`)
    } catch {
      // column already exists — the only expected failure
    }
  }
  addColumn('title', "text not null default ''")
  addColumn('agent', "text not null default ''")

  const memories: MemoryStore = {
    async put(key: string, content: string): Promise<MemoryEntry> {
      const now = Date.now()
      const existing = db.prepare('select id, created_at from datum_memories where key = ?').get(key) as { id: string; created_at: number } | undefined
      const id = existing?.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`
      db.prepare(`
        insert into datum_memories (id, key, content, created_at, updated_at) values (?, ?, ?, ?, ?)
        on conflict(key) do update set content = excluded.content, updated_at = excluded.updated_at
      `).run(id, key, content, existing?.created_at ?? now, now)
      return { id, key, content, createdAt: existing?.created_at ?? now, updatedAt: now }
    },
    list: async () => (db.prepare('select id, key, content, created_at, updated_at from datum_memories order by updated_at desc').all() as Array<Record<string, unknown>>)
      .map(row => ({
        id: String(row['id']),
        key: String(row['key']),
        content: String(row['content']),
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
      })),
    remove: async (id: string) => (db.prepare('delete from datum_memories where id = ?').run(id).changes as number) > 0,
  }

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
        select s.session_id as session_id,
               s.title as title,
               coalesce(min(e.time), s.created_at) as first_time,
               coalesce(max(e.time), s.created_at) as last_time,
               count(e.seq) as entries
        from datum_sessions s
        left join datum_session_events e on e.session_id = s.session_id
        group by s.session_id
        order by last_time desc
      `).all() as Array<{ session_id: string; title: string; first_time: number; last_time: number; entries: number }>
      return rows.map(row => ({
        sessionId: row.session_id as SessionId,
        title: row.title,
        firstTime: row.first_time,
        lastTime: row.last_time,
        entries: row.entries,
      }))
    },

    registerSession: async (sessionId, agent, title) => {
      db.prepare('insert or ignore into datum_sessions (session_id, created_at, agent, title) values (?, ?, ?, ?)')
        .run(sessionId, Date.now(), agent, title ?? '')
    },

    renameSession: async (sessionId, title) => {
      db.prepare('update datum_sessions set title = ? where session_id = ?').run(title, sessionId)
    },

    async deleteSession(sessionId: SessionId): Promise<void> {
      db.prepare('delete from datum_session_events where session_id = ?').run(sessionId)
      db.prepare('delete from datum_sessions where session_id = ?').run(sessionId)
    },

    memories,

    close: async () => db.close(),
  }
}
