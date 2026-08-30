import type { Context } from '@sudive-ai/cordis'
import type {
  ApprovalId,
  ChatMessage,
  ContentBlock,
  FinishReason,
  JsonRecord,
  JsonValue,
  MessageId,
  StepSpec,
  StepVeto,
  TopCallId,
  TurnEndReason,
  TurnId,
} from '@sudive-ai/datum-vocabulary'
import { deriveMessages, newMessageId, SessionLog } from '@sudive-ai/datum-session'
import {
  ApprovalDeniedError,
  ApprovalUnavailableError,
  LlmService,
  ToolService,
} from '@sudive-ai/datum-tools'
import type { ChatRequest } from '@sudive-ai/datum-tools'
import type { AgentSpec } from './agent.ts'
import { newApprovalId, newStepId, newTopCallId, newTurnId } from './ids.ts'

/** Everything an {@link AgentLoop} drives; all seams, no concretes. */
export interface LoopDeps {
  /** Kernel context; the bus for agent events and waterfalls. */
  readonly context: Context
  /** The session log — every fact the loop produces lands here. */
  readonly session: SessionLog
  /** The LLM seam consumer. */
  readonly llm: LlmService
  /** The tool registry. */
  readonly tools: ToolService
  /** The agent composition this loop drives. */
  readonly spec: AgentSpec
}

/**
 * The default harness — the turn/step state machine of the fixed language.
 *
 * One turn = one user intent driven to a terminal fact. One step = one model
 * call plus its tool round. Invariants the loop owns:
 * - terminal `turn/end` is written exactly once per turn, by the loop only;
 * - every model call is preceded by `request/header` + `request/context`
 *   (model-visible ⟺ logged) and followed by chunks + an assembled message;
 * - a vetoed pre-step closes the turn as `blocked` with the refusal
 *   traceable in the log; an error closes it as `error`; a cancel closes it
 *   as `aborted` — success, cancel, and failure all land in the log.
 */
export class AgentLoop {
  /** The session this loop drives. */
  readonly session: SessionLog

  private readonly _context: Context
  private readonly _llm: LlmService
  private readonly _tools: ToolService
  private readonly _spec: AgentSpec
  private _controller: AbortController | undefined

  /**
   * @param deps — see {@link LoopDeps}.
   */
  constructor(deps: LoopDeps) {
    this._context = deps.context
    this.session = deps.session
    this._llm = deps.llm
    this._tools = deps.tools
    this._spec = deps.spec
    this._context.events.emit('agent/session-start', this.session.sessionId, this._spec.surface)
  }

  /** The agent identity this loop drives. */
  get name(): string {
    return this._spec.name
  }

  /** Whether a turn is currently driving. */
  get running(): boolean {
    return this._controller !== undefined
  }

  /**
   * Append one user message and announce it on the inbox.
   *
   * @param text — the user's text.
   * @param surface — where the message came from; defaults to the agent surface.
   * @returns the message id.
   */
  submit(text: string, surface: string = this._spec.surface): MessageId {
    const messageId = newMessageId()
    this.session.append('user/message', {
      sessionId: this.session.sessionId,
      messageId,
      content: [{ kind: 'text', text }],
      source: { kind: 'human', surface },
    })
    this._context.events.emit('agent/inbox/next-turn', this.session.sessionId, messageId)
    return messageId
  }

  /**
   * Drive one turn from a submitted message to a terminal fact.
   *
   * @param messageId — the trigger message, already in the log.
   * @returns the terminal reason.
   * @throws when a turn is already running (one driver per loop).
   */
  async runTurn(messageId: MessageId): Promise<TurnEndReason> {
    if (this._controller) {
      throw new Error('agent loop: a turn is already running')
    }
    const controller = new AbortController()
    this._controller = controller
    const turnId = newTurnId()
    const sessionId = this.session.sessionId
    this.session.append('turn/start', { sessionId, turnId, trigger: messageId })
    this._status('thinking', `turn ${turnId} started`)
    let ended = false
    const end = async (reason: TurnEndReason): Promise<void> => {
      if (!ended) {
        ended = true
        await this._endTurn(turnId, reason)
      }
    }
    try {
      const reason = await this._driveSteps(turnId, controller.signal)
      await end(reason)
      return reason
    } catch (error) {
      const reason: TurnEndReason = { kind: 'error', message: String(error) }
      await end(reason)
      return reason
    } finally {
      this._controller = undefined
      this._status('idle', 'turn finished')
    }
  }

  /**
   * Cancel the running turn, if any. The AbortSignal reaches every pending
   * await; the turn still ends with a terminal fact (`aborted`).
   */
  cancel(): void {
    this._controller?.abort()
  }

  /** Drive steps until the model stops asking for tools or the turn ends early. */
  private async _driveSteps(turnId: TurnId, signal: AbortSignal): Promise<TurnEndReason> {
    const sessionId = this.session.sessionId
    let round = 0
    while (true) {
      round++
      const stepId = newStepId()
      this.session.append('step/start', { sessionId, turnId, stepId })

      // Pre-step waterfall: the only place a step is rewritten or refused.
      const draft: StepSpec = {
        sessionId,
        turnId,
        stepId,
        systemPrompt: this._spec.systemPrompt,
        toolNames: this._tools.list().map(tool => tool.name),
      }
      const preStep = this._context.waterfall(
        'agent/pre-step',
        draft,
        () => draft,
      ) as StepSpec | StepVeto
      if (isStepVeto(preStep)) {
        this.session.append('step/end', {
          sessionId, turnId, stepId,
          finishReason: { kind: 'error', message: `pre-step refused: ${preStep.blocked}` },
        })
        return { kind: 'blocked', reason: preStep.blocked }
      }

      // Request waterfall: call configuration only, never message content.
      const requestDraft = {
        model: this._spec.model,
        maxTokens: this._spec.maxTokens,
        options: { ...this._spec.options },
      }
      this._context.waterfall('agent/request', requestDraft, () => requestDraft)

      const topCallId = newTopCallId()
      this.session.append('request/header', {
        sessionId,
        turnId,
        topCallId,
        reason: round === 1 ? 'initial' : 'series',
        model: requestDraft.model,
      })
      const messages = this._modelMessages()
      const chatRequest: ChatRequest = {
        model: requestDraft.model,
        maxTokens: requestDraft.maxTokens,
        options: requestDraft.options,
        systemPrompt: draft.systemPrompt,
        messages,
        tools: this._tools.view(),
        signal,
      }
      // Model-visible ⟺ logged: the logged context is exactly the request.
      this.session.append('request/context', {
        sessionId,
        topCallId,
        context: requestSurface(chatRequest),
      })

      this._status('acting', `step ${round} requesting ${requestDraft.model}`)
      let response
      let chunkSeq = 0
      try {
        response = await this._llm.stream(chatRequest, delta => {
          // Replay fidelity: every streamed piece is its own logged chunk.
          this.session.append('assistant/chunk', {
            sessionId, topCallId, chunkSeq,
            delta: { kind: delta.kind, text: delta.delta },
          })
          chunkSeq++
        })
      } catch (error) {
        // An aborted signal turns any provider failure into cancellation —
        // the cancel-leak contract: the turn ends `aborted`, never `error`.
        const cancelled = signal.aborted
        this._context.events.emit('agent/request-error', sessionId, topCallId, error)
        this.session.append('step/end', {
          sessionId, turnId, stepId,
          finishReason: cancelled ? { kind: 'cancelled' } : { kind: 'error', message: String(error) },
        })
        return cancelled ? { kind: 'aborted' } : { kind: 'error', message: String(error) }
      }

      // A non-streaming adapter produced no deltas: the full response lands
      // as one chunk, so every message always references its chunks.
      if (chunkSeq === 0) {
        this.session.append('assistant/chunk', {
          sessionId, topCallId, chunkSeq: 0, delta: { content: response.content },
        })
        chunkSeq = 1
      }
      const messageId = newMessageId()
      this.session.append('assistant/message', {
        sessionId, topCallId, messageId,
        content: response.content,
        chunkSeqs: Array.from({ length: chunkSeq }, (_, index) => index),
        finishReason: response.finishReason,
      })

      if (response.finishReason.kind !== 'tool_call') {
        this.session.append('step/end', { sessionId, turnId, stepId, finishReason: response.finishReason })
        return finishToTurnEnd(response.finishReason)
      }

      this.session.append('step/end', { sessionId, turnId, stepId, finishReason: response.finishReason })
      const executed = await this._executeToolCalls(turnId, topCallId, response.content, signal)
      if (executed !== undefined) return executed
      // Loop: the tool feedback is now in the log as model-visible input.
    }
  }

  /** Execute every requested tool call, logging each call and result. */
  private async _executeToolCalls(
    turnId: TurnId,
    topCallId: TopCallId,
    content: readonly ContentBlock[],
    signal: AbortSignal,
  ): Promise<TurnEndReason | undefined> {
    const sessionId = this.session.sessionId
    for (const block of content) {
      if (block.kind !== 'tool_call') continue
      this.session.append('tool/call', {
        sessionId, topCallId,
        toolCallId: block.toolCallId,
        name: block.name,
        input: block.input,
      })
      // Governance is a logged fact: a guarded tool opens an approval case
      // before the chokepoint, and the decision lands whatever it is.
      let approvalId: ApprovalId | undefined
      let requiresApproval = false
      try {
        requiresApproval = this._tools.get(block.name).requiresApproval === true
      } catch {
        requiresApproval = false // unknown tool: the execute chokepoint refuses below
      }
      if (requiresApproval) {
        approvalId = newApprovalId()
        this.session.append('approval/requested', {
          sessionId,
          approvalId,
          toolCallId: block.toolCallId,
          action: { tool: block.name, input: block.input },
        })
      }
      let output: JsonRecord
      let isError = false
      try {
        output = await this._tools.execute(block.name, block.input, { signal })
        if (approvalId) {
          this.session.append('approval/decided', {
            sessionId, approvalId,
            decision: 'granted',
            approver: this._tools.approver ?? 'unknown',
          })
        }
      } catch (error) {
        if (approvalId) {
          this.session.append('approval/decided', {
            sessionId, approvalId,
            decision: error instanceof ApprovalUnavailableError
              ? 'unavailable'
              : error instanceof ApprovalDeniedError ? 'denied' : 'denied',
            approver: error instanceof ApprovalDeniedError
              ? error.approver
              : error instanceof ApprovalUnavailableError ? 'none' : this._tools.approver ?? 'unknown',
          })
        }
        output = { message: String(error) }
        isError = true
      }
      this.session.append('tool/result', { sessionId, toolCallId: block.toolCallId, output, isError })
      // Tool feedback is model-visible input: it lands as a user-side message
      // with a `tool` source, so the derived history carries it verbatim.
      this.session.append('user/message', {
        sessionId,
        messageId: newMessageId(),
        content: [{ kind: 'text', text: JSON.stringify({ tool: block.name, output, isError }) }],
        source: { kind: 'tool', toolCallId: block.toolCallId },
      })
      if (signal.aborted) {
        return { kind: 'aborted' }
      }
    }
    return undefined
  }

  /** The model-visible history, derived from the log and from nothing else. */
  private _modelMessages(): readonly ChatMessage[] {
    return deriveMessages(this.session.entries)
  }

  /**
   * Write the terminal fact of a turn.
   *
   * `agent/turn-stopping` runs first through the kernel's `serial` dispatch —
   * listeners are awaited in order and have no terminal write duty; the
   * terminal `turn/end` remains this loop's exclusive write.
   */
  private async _endTurn(turnId: TurnId, reason: TurnEndReason): Promise<void> {
    this._status('stopping', `turn ${turnId} ${reason.kind}`)
    await this._context.serial('agent/turn-stopping', this.session.sessionId, turnId)
    this.session.append('turn/end', { sessionId: this.session.sessionId, turnId, reason })
  }

  /** Broadcast a coarse status change. */
  private _status(state: 'idle' | 'thinking' | 'acting' | 'stopping', detail: string): void {
    this._context.events.emit('agent/status', this.session.sessionId, { state, detail })
  }
}

/** Narrow a pre-step waterfall result into a veto, if it is one. */
function isStepVeto(result: StepSpec | StepVeto): result is StepVeto {
  return typeof (result as StepVeto).blocked === 'string'
}

/** A finished call that did not ask for tools completed its step's intent. */
function finishToTurnEnd(finish: FinishReason): TurnEndReason {
  switch (finish.kind) {
    case 'stop':
    case 'length':
      return { kind: finish.kind === 'stop' ? 'completed' : 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted' }
    case 'error':
      return { kind: 'error', message: finish.message }
    case 'tool_call':
      return { kind: 'completed' }
    default:
      return { kind: 'completed' }
  }
}

/**
 * The exact model-visible surface of a request, as persisted by
 * `request/context`. The signal is the only exclusion — it is not
 * model-visible content.
 *
 * @param request — the request about to be placed.
 * @returns the JSON surface that must equal what the provider receives.
 */
export function requestSurface(request: ChatRequest): JsonRecord {
  return {
    model: request.model,
    maxTokens: request.maxTokens,
    options: request.options,
    systemPrompt: request.systemPrompt,
    // ChatMessage/ToolView are structurally JSON; the casts only supply the
    // index signatures their named interfaces cannot declare.
    messages: request.messages as unknown as JsonValue,
    tools: request.tools as unknown as JsonValue,
  }
}

/**
 * The factory seam: how `createAgentLoop` builds loops. Replaceable as a
 * whole — the default harness is itself swappable, not privileged.
 */
export type LoopFactory = (deps: LoopDeps) => AgentLoop

let loopFactory: LoopFactory = deps => new AgentLoop(deps)

/**
 * Replace the loop factory; the returned disposer restores the previous one.
 *
 * @param factory — the new factory.
 * @returns a disposer restoring the previous factory; `true` when it was
 *   still installed.
 */
export function setLoopFactory(factory: LoopFactory): () => boolean {
  const previous = loopFactory
  loopFactory = factory
  return () => {
    if (loopFactory === factory) {
      loopFactory = previous
      return true
    }
    return false
  }
}

/**
 * Build a loop through the installed factory.
 *
 * @param deps — see {@link LoopDeps}.
 * @returns the loop instance.
 */
export function createAgentLoop(deps: LoopDeps): AgentLoop {
  return loopFactory(deps)
}
