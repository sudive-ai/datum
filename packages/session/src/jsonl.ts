import type { SessionEvent } from '@sudive-ai/datum-vocabulary'
import { assertKnownSessionEventType, SESSION_FORMAT_VERSION, type EntrySeq } from '@sudive-ai/datum-vocabulary'
import { deepFreeze } from './freeze.ts'

/**
 * A structural violation of the session-log format — a line that parses as
 * JSON but is not a well-formed, internally consistent log entry. Distinct
 * from `SessionFormatUnsupportedError` (a healthy entry whose *type* the
 * reader does not know).
 */
export class SessionFormatError extends Error {
  /** 1-based line number in the serialized log. */
  readonly line: number

  /**
   * @param message — what is wrong with the entry.
   * @param line — 1-based line number in the serialized log.
   * @param options — standard Error options (`cause`).
   */
  constructor(message: string, line: number, options?: ErrorOptions) {
    super(`session log line ${line}: ${message}`, options)
    this.name = 'SessionFormatError'
    this.line = line
  }
}

/**
 * Serialize log entries to the JSONL session-log format: one JSON envelope
 * per line, terminated by a single trailing newline.
 *
 * @param entries — the entries to serialize, oldest first.
 * @returns the JSONL text (empty string for an empty log).
 */
export function serializeSessionLog(entries: readonly SessionEvent[]): string {
  if (entries.length === 0) return ''
  return entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
}

/**
 * Parse and validate a JSONL session log — the fail-closed reader.
 *
 * Every line must be a well-formed envelope whose event type is present in
 * the reader's vocabulary. An unknown type refuses the whole log with
 * `SessionFormatUnsupportedError`; a structurally broken line refuses with
 * {@link SessionFormatError}. Nothing is ever silently skipped. Seqs must be
 * gap-free and monotonic from 0, so a truncated or tampered log cannot
 * masquerade as complete.
 *
 * @param text — the serialized log (empty string is a valid empty log).
 * @returns the entries, oldest first, deep-frozen.
 * @throws SessionFormatUnsupportedError on an unknown event type.
 * @throws SessionFormatError on a malformed line or a broken seq sequence.
 */
export function parseSessionLog(text: string): readonly SessionEvent[] {
  const lines = text.split('\n')
  // A trailing newline yields one empty final chunk; anything else mid-log is broken.
  const trailing = lines.pop()
  if (lines.length === 0 && trailing === '') return []
  if (trailing !== '') {
    throw new SessionFormatError('log does not end with a newline', lines.length + 1)
  }

  const entries: SessionEvent[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const lineNumber = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (cause) {
      throw new SessionFormatError('line is not valid JSON', lineNumber, { cause })
    }
    entries.push(validateSessionEnvelope(parsed, lineNumber))
  }
  return entries
}

/**
 * Validate one parsed envelope against the format contract — the shared
 * fail-closed gate for every storage engine, not just the JSONL reader.
 *
 * @param parsed — a JSON-decoded entry.
 * @param line — 1-based position, for error messages.
 * @returns the entry, deep-frozen.
 */
export function validateSessionEnvelope(parsed: unknown, line = 1): SessionEvent {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionFormatError('entry is not a JSON object', line)
  }
  const envelope = parsed as Record<string, unknown>
  const { seq, time, type, payload } = envelope

  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new SessionFormatError('seq must be a non-negative safe integer', line)
  }
  if (seq !== line - 1) {
    throw new SessionFormatError(`seq ${seq} breaks the gap-free monotonic sequence (expected ${line - 1})`, line)
  }
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new SessionFormatError('time must be a finite epoch-milliseconds number', line)
  }
  if (typeof type !== 'string') {
    throw new SessionFormatError('type must be a string', line)
  }
  assertKnownSessionEventType(type, SESSION_FORMAT_VERSION)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SessionFormatError('payload must be a JSON object', line)
  }
  return deepFreeze({ seq: seq as EntrySeq, time, type, payload } as SessionEvent)
}
