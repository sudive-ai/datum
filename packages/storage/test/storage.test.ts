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
    const { session } = await openPersistentSessionLog({ context: ctx, storage })
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
      const { session } = await openPersistentSessionLog({ context: ctx, storage })
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
      const { session } = await openPersistentSessionLog({ context: ctx, storage })
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

test('memory store (sqlite): put upserts by key, list is recency-ordered, remove deletes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-mem-'))
  try {
    const storage = createSqliteStorage({ path: join(dir, 'datum.db') })
    const first = await storage.memories.put('user-language', '中文')
    await storage.memories.put('project', 'datum')
    const updated = await storage.memories.put('user-language', '中文 / English')
    assert.equal(updated.id, first.id, 'upsert keeps the id')
    assert.equal(updated.createdAt, first.createdAt)
    const list = await storage.memories.list()
    assert.deepEqual(list.map(entry => [entry.key, entry.content]), [
      ['user-language', '中文 / English'],
      ['project', 'datum'],
    ])
    assert.equal(await storage.memories.remove(first.id), true)
    assert.equal(await storage.memories.remove(first.id), false)
    assert.deepEqual((await storage.memories.list()).map(entry => entry.key), ['project'])
    await storage.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleteSession removes the log and the registry row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-del-'))
  try {
    const storage = createSqliteStorage({ path: join(dir, 'datum.db') })
    const ctx = new Context()
    const session = new SessionLog({ sessionId: SESSION, context: ctx, clock: () => 0 })
    const dispose = mountSessionPersistence({ context: ctx, session, storage })
    session.append('turn/start', { sessionId: SESSION, turnId: brand<'TurnId'>('t-1'), trigger: brand<'MessageId'>('m-1') })
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    await dispose()
    await storage.deleteSession(SESSION)
    assert.deepEqual(await storage.load(SESSION), [])
    assert.deepEqual(await storage.listSessions(), [])
    await storage.close()
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

test('crash repair: a dangling turn/start is closed as aborted at restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-repair-'))
  try {
    const storage = createSqliteStorage({ path: join(dir, 'datum.db') })
    const ctx = new Context()
    const session = new SessionLog({ sessionId: SESSION, context: ctx, clock: () => 0 })
    const dispose = mountSessionPersistence({ context: ctx, session, storage })
    session.append('user/message', {
      sessionId: SESSION,
      messageId: brand<'MessageId'>('m-1'),
      content: [{ kind: 'text', text: 'hello' }],
      source: { kind: 'human', surface: 'test' },
    })
    session.append('turn/start', { sessionId: SESSION, turnId: brand<'TurnId'>('t-1'), trigger: brand<'MessageId'>('m-1') })
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    await dispose()
    await storage.close() // the "crash": no turn/end was ever written

    // Restore: the dangling turn is repaired with an aborted terminal fact.
    const reopened = createSqliteStorage({ path: join(dir, 'datum.db') })
    const restored = await openPersistentSessionLog({ context: ctx, storage: reopened })
    const types = restored.session.entries.map(entry => entry.type)
    assert.deepEqual(types, ['user/message', 'turn/start', 'turn/end'])
    const end = restored.session.entries.at(-1)!
    assert.equal(end.type, 'turn/end')
    const ended = end as Extract<SessionEvent, { type: 'turn/end' }>
    assert.deepEqual(ended.payload.reason, { kind: 'aborted' })
    // And the repair fact itself persisted.
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    assert.equal((await reopened.load(SESSION)).length, 3)
    await reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessions carry titles: register, rename, list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'datum-title-'))
  try {
    const storage = createSqliteStorage({ path: join(dir, 'datum.db') })
    await storage.registerSession(SESSION, 'agent', '新会话')
    await storage.renameSession(SESSION, '帮我美化页面')
    const sessions = await storage.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.title, '帮我美化页面')
    await storage.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
