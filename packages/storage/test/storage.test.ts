import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@sudive-ai/cordis'
import { brand } from '@sudive-ai/datum-vocabulary'
import type { SessionEvent, SessionId } from '@sudive-ai/datum-vocabulary'
import { SessionLog } from '@sudive-ai/datum-session'
import { createPostgresStorage, createSqliteStorage, mountSessionPersistence, openPersistentSessionLog } from '../src/index.ts'
import type { StorageAdapter } from '../src/index.ts'

const SESSION = brand<'SessionId'>('sess-store')

/** Drive the same fact sequence through any engine — the shared conformance run. */
async function conformance(storage: StorageAdapter): Promise<void> {
  const ctx = new Context()
  const session = new SessionLog({ sessionId: SESSION, context: ctx, clock: () => 42 })
  const dispose = mountSessionPersistence({ context: ctx, session, storage })

  session.append('user/message', {
    sessionId: SESSION,
    messageId: brand<'MessageId'>('m-1'),
    content: [{ kind: 'text', text: 'persist me' }],
    source: { kind: 'human', surface: 'test' },
  })
  session.append('turn/start', { sessionId: SESSION, turnId: brand<'TurnId'>('t-1'), trigger: brand<'MessageId'>('m-1') })
  // Wait for the async writes to settle.
  await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))

  const loaded = await storage.load(SESSION)
  assert.equal(loaded.length, 2)
  assert.deepEqual(loaded.map(event => [event.seq, event.type]), [[0, 'user/message'], [1, 'turn/start']])
  const first = loaded[0]! as Extract<SessionEvent, { type: 'user/message' }>
  assert.deepEqual(first.payload.content, [{ kind: 'text', text: 'persist me' }])

  const sessions = await storage.listSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.sessionId, SESSION)
  assert.equal(sessions[0]!.entries, 2)

  // Replay idempotence: re-appending an existing seq is a no-op.
  await storage.append(session.entries[0]!)
  assert.equal((await storage.load(SESSION)).length, 2)

  // Unknown-session loads are empty, not errors.
  assert.deepEqual(await storage.load(brand<'SessionId'>('sess-none')), [])

  await dispose()
  await storage.close()
}

test('sqlite engine (default local): conformance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-sqlite-'))
  try {
    await conformance(createSqliteStorage({ path: join(dir, 'datum.db') }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite engine: create fails loud without a path', () => {
  // @ts-expect-error the config field is required
  assert.throws(() => createSqliteStorage({}), /path is required/)
})

test('restore-or-create: a fresh session persists from its first fact on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-restore-'))
  try {
    const storage = createSqliteStorage({ path: join(dir, 'datum.db') })
    const ctx = new Context()
    const session = await openPersistentSessionLog({ context: ctx, storage })
    session.append('user/message', {
      sessionId: session.sessionId,
      messageId: brand<'MessageId'>('m-1'),
      content: [{ kind: 'text', text: 'first fact' }],
      source: { kind: 'human', surface: 'test' },
    })
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    assert.deepEqual((await storage.load(session.sessionId)).map(event => event.type), ['user/message'])
    await storage.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restart recovery: close, reopen the same file, the session rehydrates fully', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-restart-'))
  const dbPath = join(dir, 'datum.db')
  try {
    let originalId: SessionId | undefined
    { // first process lifetime
      const storage = createSqliteStorage({ path: dbPath })
      const ctx = new Context()
      const session = await openPersistentSessionLog({ context: ctx, storage })
      originalId = session.sessionId
      session.append('user/message', {
        sessionId: session.sessionId,
        messageId: brand<'MessageId'>('m-1'),
        content: [{ kind: 'text', text: 'before restart' }],
        source: { kind: 'human', surface: 'test' },
      })
      session.append('assistant/message', {
        sessionId: session.sessionId,
        topCallId: brand<'TopCallId'>('c-1'),
        messageId: brand<'MessageId'>('m-2'),
        content: [{ kind: 'text', text: 'me too' }],
        chunkSeqs: [0],
        finishReason: { kind: 'stop' },
      })
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
      await storage.close()
    }
    { // second process lifetime: same file, same facts, seqs continue gap-free
      const storage = createSqliteStorage({ path: dbPath })
      const ctx = new Context()
      const session = await openPersistentSessionLog({ context: ctx, storage })
      assert.equal(session.sessionId, originalId)
      assert.deepEqual(session.entries.map((event: SessionEvent) => event.type), ['user/message', 'assistant/message'])
      // The next append continues the restored log without collision.
      session.append('session/end-seed', { sessionId: session.sessionId, reason: { kind: 'completed' } })
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
      const reloaded = await storage.load(session.sessionId)
      assert.equal(reloaded.length, 3)
      assert.equal(reloaded[2]!.seq, 2)
      await storage.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('postgres engine: creation fails loud without a connection string', () => {
  // @ts-expect-error the config field is required
  assert.throws(() => createPostgresStorage({}), /connectionString is required/)
})

test('postgres engine: connection failure surfaces as a loud append error', async () => {
  const storage = createPostgresStorage({ connectionString: 'postgres://nobody:nope@127.0.0.1:1/nothing' })
  const ctx = new Context()
  const session = new SessionLog({ sessionId: SESSION, context: ctx, clock: () => 0 })
  mountSessionPersistence({ context: ctx, session, storage })
  await assert.rejects(
    storage.append({
      seq: 0 as never,
      time: 0,
      type: 'user/message',
      payload: {
        sessionId: SESSION,
        messageId: brand<'MessageId'>('m-1'),
        content: [{ kind: 'text', text: 'x' }],
        source: { kind: 'human', surface: 'test' },
      },
    } as SessionEvent),
    /ECONNREFUSED|connect|Failed to connect/,
  )
  await storage.close().catch(() => undefined)
})
