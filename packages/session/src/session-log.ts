import type { Context } from '@sudive-ai/cordis'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@sudive-ai/datum-vocabulary'
import { brand, brandNumber, type EntrySeq, type SessionId } from '@sudive-ai/datum-vocabulary'
import { deepFreeze } from './freeze.ts'

/** Options for constructing a {@link SessionLog}. */
export interface SessionLogOptions {
  /** Identity of the session; defaults to a fresh `sess-<random>` id. */
  sessionId?: SessionId
  /** Pre-existing entries to restore (e.g. reloaded from a storage engine). */
  entries?: readonly SessionEvent[]
  /**
   * Kernel context used to broadcast `session/event` on every append. When
   * absent the log stays a pure data structure with no bus traffic.
   */
  context?: Context
  /** Wall clock; epoch milliseconds. Overridable for deterministic tests. */
  clock?: () => number
}

/**
 * An append-only session log — the single source of truth for one session.
 *
 * Contract:
 * - `append` is the only writer. It assigns the next monotonic 0-based
 *   {@link EntrySeq}, stamps the time, deep-freezes the entry, and broadcasts
 *   it as `session/event` when a context is mounted. No edit or delete path
 *   exists.
 * - Payloads must be JSON-serializable; an append that is not representable
 *   in the log format fails loudly instead of persisting a lossy fact.
 */
export class SessionLog {
  /** Identity of this session. */
  readonly sessionId: SessionId

  private readonly _entries: SessionEvent[] = []
  private readonly _context: Context | undefined
  private readonly _clock: () => number

  /**
   * @param options — see {@link SessionLogOptions}.
   */
  constructor(options: SessionLogOptions = {}) {
    this.sessionId = options.sessionId ?? brand<'SessionId'>(`sess-${Math.random().toString(36).slice(2, 10)}`)
    this._context = options.context
    this._clock = options.clock ?? (() => Date.now())
    if (options.entries) {
      options.entries.forEach((entry, index) => {
        if (entry.seq !== index) {
          throw new Error(`session restore: entry ${index} carries seq ${entry.seq}; the restored log must be gap-free from 0`)
        }
        this._entries.push(entry)
      })
    }
  }

  /** Every entry appended so far, oldest first; do not mutate. */
  get entries(): readonly SessionEvent[] {
    return this._entries
  }

  /** The seq the next append will receive. */
  get nextSeq(): EntrySeq {
    return brandNumber<'EntrySeq'>(this._entries.length)
  }

  /**
   * Append one fact as the next log entry.
   *
   * @param type — the event type; must be a member of `SessionEventMap`.
   * @param payload — the typed payload; must be JSON-serializable.
   * @returns the appended entry (deep-frozen).
   * @throws TypeError when the payload cannot survive a JSON round-trip
   *   (the log format would silently lose the fact otherwise).
   */
  append<K extends SessionEventType>(type: K, payload: SessionEventMap[K]): SessionEvent<K> {
    assertJsonSerializable(payload, `session event ${type}`)
    const entry = {
      seq: brandNumber<'EntrySeq'>(this._entries.length),
      time: this._clock(),
      type,
      payload,
    } as unknown as SessionEvent<K>
    this._entries.push(entry)
    this._context?.events.emit('session/event', entry)
    return deepFreeze(entry)
  }
}

/**
 * Fail loud when a value would not survive the log's JSON representation.
 *
 * `JSON.stringify` alone is not enough — it silently *drops* functions and
 * `undefined` values, which would persist a lossy fact. This walk accepts
 * exactly the persisted vocabulary: `null`, finite numbers, strings,
 * booleans, arrays, and plain objects, recursively.
 *
 * @param value — the value about to be persisted.
 * @param label — what is being persisted, for the error message.
 */
function assertJsonSerializable(value: unknown, label: string): void {
  const stack: Array<{ value: unknown; path: string }> = [{ value, path: 'payload' }]
  while (stack.length > 0) {
    const { value: current, path } = stack.pop()!
    switch (typeof current) {
      case 'string':
      case 'boolean':
        continue
      case 'number':
        if (Number.isFinite(current)) continue
        throw new TypeError(`${label}: ${path} is not a finite number`)
      case 'object':
        break // inspected below
      default:
        throw new TypeError(`${label}: ${path} has unsupported runtime type ${typeof current}`)
    }
    if (current === null) continue
    if (Array.isArray(current)) {
      current.forEach((item, index) => stack.push({ value: item, path: `${path}[${index}]` }))
      continue
    }
    const proto = Object.getPrototypeOf(current)
    if (proto !== null && proto !== Object.prototype) {
      throw new TypeError(`${label}: ${path} is not a plain JSON object`)
    }
    for (const key of Object.keys(current as Record<string, unknown>)) {
      stack.push({ value: (current as Record<string, unknown>)[key], path: `${path}.${key}` })
    }
  }
}
