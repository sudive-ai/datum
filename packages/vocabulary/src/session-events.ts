import type { Content, ContentBlock, FinishReason, MessageSource, TurnEndReason } from './vocabulary.ts'
import type { JsonRecord } from './json.ts'
import type { Branded } from './brand.ts'
import type { EntrySeq, MessageId, SessionId, StepId, ToolCallId, TopCallId, TurnId } from './ids.ts'

/** How a governance decision came out. */
export type ApprovalDecision = 'granted' | 'denied' | 'unavailable'

/**
 * The version of the persisted session-log format this vocabulary defines.
 *
 * Bump when the meaning of an existing event type changes incompatibly; adding
 * a brand-new event type does not bump the version — it only extends the known
 * set, and older readers refuse the new entries (fail closed) instead of
 * misreading them.
 */
export const SESSION_FORMAT_VERSION = 0

/**
 * The 12 core persistent event types of {@link SessionEventMap}.
 *
 * This tuple is the runtime "known set" a reader checks against: a log entry
 * whose type is absent from it refuses to load. The compile-time coverage
 * assertion below keeps this tuple and the map from drifting apart.
 */
export const KNOWN_SESSION_EVENT_TYPES = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'request/header',
  'request/context',
  'session/end-seed',
  'approval/requested',
  'approval/decided',
  'context/compacted',
] as const satisfies readonly (keyof SessionEventMap)[]

/**
 * The persistent event vocabulary: every fact a session log can hold.
 *
 * The map is open for extension by declaration merging, but the fail-closed
 * rule applies unchanged: a reader whose vocabulary lacks a type refuses the
 * log — never skips it. Every payload is fully required (required-on-read)
 * and every payload carries the owning {@link SessionId}.
 */
export interface SessionEventMap {
  /** A turn opened, triggered by the referenced user message. */
  'turn/start': {
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly trigger: MessageId
  }
  /** A turn closed; success, cancel, and failure all land here. */
  'turn/end': {
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly reason: TurnEndReason
  }
  /** A step opened inside a turn. */
  'step/start': {
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly stepId: StepId
  }
  /** A step closed with how its top model call finished. */
  'step/end': {
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly stepId: StepId
    readonly finishReason: FinishReason
  }
  /** A user-side message entered the log; the model-visible input fact. */
  'user/message': {
    readonly sessionId: SessionId
    readonly messageId: MessageId
    readonly content: readonly Content[]
    readonly source: MessageSource
  }
  /** One streamed chunk of a model response; replay fidelity lives here. */
  'assistant/chunk': {
    readonly sessionId: SessionId
    readonly topCallId: TopCallId
    readonly chunkSeq: number
    readonly delta: JsonRecord
  }
  /** The assembled assistant message, referencing the chunks it folds. */
  'assistant/message': {
    readonly sessionId: SessionId
    readonly topCallId: TopCallId
    readonly messageId: MessageId
    readonly content: readonly ContentBlock[]
    readonly chunkSeqs: readonly number[]
    readonly finishReason: FinishReason
  }
  /** The model requested one tool invocation. */
  'tool/call': {
    readonly sessionId: SessionId
    readonly topCallId: TopCallId
    readonly toolCallId: ToolCallId
    readonly name: string
    readonly input: JsonRecord
  }
  /** A tool invocation produced its result (success or failure). */
  'tool/result': {
    readonly sessionId: SessionId
    readonly toolCallId: ToolCallId
    readonly output: JsonRecord
    readonly isError: boolean
  }
  /** A model request opened; the header fact (why and with what model). */
  'request/header': {
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly topCallId: TopCallId
    readonly reason: 'initial' | 'change' | 'series'
    readonly model: string
  }
  /** The exact model-visible context of a request; model-visible ⟺ logged. */
  'request/context': {
    readonly sessionId: SessionId
    readonly topCallId: TopCallId
    readonly context: JsonRecord
  }
  /** The seed that closes a session; downstream projections fold it. */
  'session/end-seed': {
    readonly sessionId: SessionId
    readonly reason: TurnEndReason
  }
  /** A guarded action asked for approval — the chokepoint opened a case. */
  'approval/requested': {
    readonly sessionId: SessionId
    readonly approvalId: ApprovalId
    readonly toolCallId: ToolCallId | undefined
    /** What wants to run: tool name, input, and any policy context. */
    readonly action: JsonRecord
  }
  /** The decision on an approval case — every governance decision is a fact. */
  'approval/decided': {
    readonly sessionId: SessionId
    readonly approvalId: ApprovalId
    readonly decision: ApprovalDecision
    /** Who decided (approver identity: 'ui', 'policy-plugin', …). */
    readonly approver: string
  }
  /** Entries up to `upToSeq` were folded into `summary`; derivation keeps `keptFromSeq` onward. */
  'context/compacted': {
    readonly sessionId: SessionId
    /** Everything at or before this seq is folded into the summary. */
    readonly upToSeq: EntrySeq
    /** Derivation starts from the first entry after this seq. */
    readonly keptFromSeq: EntrySeq
    /** The folded summary — the model-visible replacement for what was compacted. */
    readonly summary: string
  }
}

/** Identity of one approval case. */
export type ApprovalId = Branded<'ApprovalId'>

/** A core event type: one of the members of {@link KNOWN_SESSION_EVENT_TYPES}. */
export type CoreSessionEventType = (typeof KNOWN_SESSION_EVENT_TYPES)[number]

/** Any event type in the current vocabulary (core types plus merged extensions). */
export type SessionEventType = keyof SessionEventMap

/**
 * Compile-time coverage: every vocabulary member must appear in the known set,
 * so extending `SessionEventMap` without extending the reader vocabulary fails
 * the build here first — the fail-closed rule surfaces at compile time for the
 * owner, and at read time for everyone else.
 */
type _KnownSetCoversVocabulary = Exclude<SessionEventType, CoreSessionEventType> extends never
  ? true
  : ['event types missing from KNOWN_SESSION_EVENT_TYPES', Exclude<SessionEventType, CoreSessionEventType>]

/**
 * A persisted, ordered, typed log entry — a discriminated union over the
 * vocabulary, so narrowing on `type` narrows `payload` too.
 */
export type SessionEvent<K extends SessionEventType = SessionEventType> = K extends K
  ? {
      /** Monotonic 0-based position in the session log; gap-free. */
      readonly seq: EntrySeq
      /** Epoch milliseconds at append time. */
      readonly time: number
      /** The event type — one of {@link SessionEventMap}'s keys. */
      readonly type: K
      /** The typed payload; fully required (required-on-read). */
      readonly payload: SessionEventMap[K]
    }
  : never

/**
 * The reader-side refusal for a log written in an unsupported vocabulary.
 *
 * Raised when a log entry's event type is absent from the reader's known set.
 * Readers must never skip unknown entries — refusing the whole log is the
 * contract that keeps derived state trustworthy.
 */
export class SessionFormatUnsupportedError extends Error {
  /** The offending event type. */
  readonly eventType: string
  /** The format version the reader is built for. */
  readonly formatVersion: number

  /**
   * @param eventType — the event type absent from the vocabulary.
   * @param formatVersion — the reader's `SESSION_FORMAT_VERSION`.
   * @param options — standard Error options (`cause`).
   */
  constructor(eventType: string, formatVersion: number = SESSION_FORMAT_VERSION, options?: ErrorOptions) {
    super(
      `refusing to read session log: event type ${JSON.stringify(eventType)} is absent from the reader's `
        + `vocabulary (SESSION_FORMAT_VERSION=${formatVersion}); skipping unknown events is not allowed`,
      options,
    )
    this.name = 'SessionFormatUnsupportedError'
    this.eventType = eventType
    this.formatVersion = formatVersion
  }
}

/**
 * Fail-closed vocabulary check for one log entry's event type.
 *
 * @param type — the event type read from a log entry.
 * @param formatVersion — the reader's format version, for the error message.
 * @throws {@link SessionFormatUnsupportedError} when `type` is not a core type.
 */
export function assertKnownSessionEventType(type: string, formatVersion: number = SESSION_FORMAT_VERSION): void {
  if (!(KNOWN_SESSION_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new SessionFormatUnsupportedError(type, formatVersion)
  }
}
