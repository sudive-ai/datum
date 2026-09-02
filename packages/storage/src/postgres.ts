import postgres from 'postgres'
import type { SessionEvent, SessionId } from '@sudive-ai/datum-vocabulary'
import { validateSessionEnvelope } from '@sudive-ai/datum-session'
import type { MemoryEntry, MemoryStore, SessionSummary, StorageAdapter } from './seam.ts'

/** Configuration for {@link createPostgresStorage}; every field required (fail loud). */
export interface PostgresStorageConfig {
  /** Full connection string, e.g. `postgres://user:pass@host:5432/db`. */
  readonly connectionString: string
}

/**
 * The PostgreSQL storage engine — the optional, connection-configured
 * persistence for shared/multi-host deployments.
 *
 * Driver: `postgres` (postgres.js), ESM, no native compilation. Same schema
 * shape as the SQLite engine: one row per session event keyed
 * (session_id, seq) with `on conflict do nothing`, one registry row per
 * session.
 *
 * @param config — see {@link PostgresStorageConfig}.
 * @returns the adapter.
 */
export function createPostgresStorage(config: PostgresStorageConfig): StorageAdapter {
  if (!config.connectionString) {
    throw new TypeError('postgres storage: connectionString is required (mount the password from the environment, never from config files or the log)')
  }
  const sql = postgres(config.connectionString)
  let initialized = false

  async function ensureSchema(): Promise<void> {
    if (initialized) return
    await sql`
      create table if not exists datum_session_events (
        session_id text not null,
        seq        bigint not null,
        time       bigint not null,
        type       text not null,
        payload    jsonb not null,
        primary key (session_id, seq)
      )
    `
    await sql`
      create table if not exists datum_sessions (
        session_id text primary key,
        created_at bigint not null,
        agent      text not null default '',
        title      text not null default ''
      )
    `
    await sql`
      create table if not exists datum_memories (
        id         text primary key,
        key        text not null unique,
        content    text not null,
        created_at bigint not null,
        updated_at bigint not null
      )
    `
    // Lightweight migration for databases created before these columns.
    for (const [column, definition] of [['title', "text not null default ''"], ['agent', "text not null default ''"]] as const) {
      try {
        await sql.unsafe(`alter table datum_sessions add column ${column} ${definition}`)
      } catch {
        // column already exists (42701 duplicate column)
      }
    }
    initialized = true
  }

  const memories: MemoryStore = {
    async put(key: string, content: string): Promise<MemoryEntry> {
      const now = Date.now()
      const id = `mem-${Math.random().toString(36).slice(2, 10)}`
      const rows = await sql`
        insert into datum_memories (id, key, content, created_at, updated_at)
        values (${id}, ${key}, ${content}, ${now}, ${now})
        on conflict(key) do update set content = excluded.content, updated_at = excluded.updated_at
        returning id, created_at
      ` as Array<{ id: string; created_at: string | number }>
      const stored = rows[0]!
      return { id: stored.id, key, content, createdAt: Number(stored.created_at), updatedAt: now }
    },
    list: async () => (await sql`select id, key, content, created_at, updated_at from datum_memories order by updated_at desc` as Array<Record<string, unknown>>)
      .map(row => ({
        id: String(row['id']),
        key: String(row['key']),
        content: String(row['content']),
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
      })),
    remove: async (id: string) => (await sql`delete from datum_memories where id = ${id} returning 1`).count > 0,
  }

  return {
    name: 'postgres',

    async append(event: SessionEvent): Promise<void> {
      await ensureSchema()
      await sql`
        insert into datum_session_events (session_id, seq, time, type, payload)
        values (${event.payload.sessionId}, ${event.seq}, ${event.time}, ${event.type}, ${sql.json(event)}::jsonb)
        on conflict (session_id, seq) do nothing
      `
      await sql`
        insert into datum_sessions (session_id, created_at)
        values (${event.payload.sessionId}, ${event.time})
        on conflict (session_id) do nothing
      `
    },

    async load(sessionId: SessionId): Promise<readonly SessionEvent[]> {
      await ensureSchema()
      const rows = await sql`
        select payload from datum_session_events
        where session_id = ${sessionId}
        order by seq
      ` as Array<{ payload: unknown }>
      return rows.map((row, index) => validateSessionEnvelope(row.payload, index + 1))
    },

    async listSessions(): Promise<readonly SessionSummary[]> {
      await ensureSchema()
      const rows = await sql`
        select s.session_id as session_id,
               s.title as title,
               coalesce(min(e.time), s.created_at) as first_time,
               coalesce(max(e.time), s.created_at) as last_time,
               count(e.seq) as entries
        from datum_sessions s
        left join datum_session_events e on e.session_id = s.session_id
        group by s.session_id
        order by last_time desc
      ` as Array<{ session_id: string; title: string; first_time: number; last_time: number; entries: number }>
      return rows.map(row => ({
        sessionId: row.session_id as SessionId,
        title: row.title,
        firstTime: Number(row.first_time),
        lastTime: Number(row.last_time),
        entries: Number(row.entries),
      }))
    },

    registerSession: async (sessionId, agent, title) => {
      await sql`
        insert into datum_sessions (session_id, created_at, agent, title)
        values (${sessionId}, ${Date.now()}, ${agent}, ${title ?? ''})
        on conflict (session_id) do nothing
      `
    },

    renameSession: async (sessionId, title) => {
      await sql`update datum_sessions set title = ${title} where session_id = ${sessionId}`
    },

    async deleteSession(sessionId: SessionId): Promise<void> {
      await sql`delete from datum_session_events where session_id = ${sessionId}`
      await sql`delete from datum_sessions where session_id = ${sessionId}`
    },

    memories,

    close: async () => sql.end(),
  }
}
