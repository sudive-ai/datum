import { brand, type ApprovalId, type StepId, type TopCallId, type TurnId } from '@sudive-ai/datum-vocabulary'

let turnCounter = 0
let stepCounter = 0
let topCallCounter = 0

/**
 * Mint a fresh turn id. Ids are unique per process; their persistence comes
 * from the log, not from the minter.
 *
 * @returns a new `TurnId`.
 */
export function newTurnId(): TurnId {
  return brand<'TurnId'>(`turn-${++turnCounter}-${Math.random().toString(36).slice(2, 8)}`)
}

/**
 * Mint a fresh step id.
 *
 * @returns a new `StepId`.
 */
export function newStepId(): StepId {
  return brand<'StepId'>(`step-${++stepCounter}-${Math.random().toString(36).slice(2, 8)}`)
}

/**
 * Mint a fresh top-call id.
 *
 * @returns a new `TopCallId`.
 */
export function newTopCallId(): TopCallId {
  return brand<'TopCallId'>(`call-${++topCallCounter}-${Math.random().toString(36).slice(2, 8)}`)
}

let approvalCounter = 0

/**
 * Mint a fresh approval-case id.
 *
 * @returns a new `ApprovalId`.
 */
export function newApprovalId(): ApprovalId {
  return brand<'ApprovalId'>(`appr-${++approvalCounter}-${Math.random().toString(36).slice(2, 8)}`)
}
