import postgres from 'postgres'
import type { SessionEvent, SessionId } from '@sudive-ai/datum-vocabulary'
import { validateSessionEnvelope } from '@sudive-ai/datum-session'
import type { SessionSummary, StorageAdapter } from './seam.ts'

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
        agent      text not null default ''
      )
    `
    initialized = true
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
        select session_id,
               min(time) as first_time,
               max(time) as last_time,
               count(*)  as entries
        from datum_session_events
        group by session_id
        order by last_time desc
      ` as Array<{ session_id: string; first_time: number; last_time: number; entries: number }>
      return rows.map(row => ({
        sessionId: row.session_id as SessionId,
        firstTime: Number(row.first_time),
        lastTime: Number(row.last_time),
        entries: Number(row.entries),
      }))
    },

    close: async () => sql.end(),
  }
}
