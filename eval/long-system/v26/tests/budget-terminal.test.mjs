import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ATTEMPT_BUDGET_TERMINAL,
  budgetTerminalEvidence,
  budgetTerminalEvidenceSince,
} from '../budget-terminal.mjs'
import { validateAttemptBudget } from '../run-calibrations.mjs'

const ATTEMPT_ID = 'v26-budget-attempt'
const SESSION_ID = 'plan-lattice-v26-budget-session'
const TERMINAL_ID = 'b'.repeat(64)

function terminalSnapshot() {
  return {
    attemptId: ATTEMPT_ID,
    agentRequests: 2,
    inputTokens: 101,
    outputTokens: 12,
    missingUsageResponses: 0,
    budgetRejections: 3,
    localBudgetRejections: 3,
    upstreamHttp429: 0,
    upstreamTransportErrors: 0,
    agentRequestSequence: 5,
    limits: { maxAgentRequests: 10, maxInputTokens: 100, maxOutputTokens: 100 },
    firstBudgetRejection: {
      terminalId: TERMINAL_ID,
      attemptId: ATTEMPT_ID,
      sessionId: SESSION_ID,
      requestSequence: 3,
      exhausted: [{ metric: 'inputTokens', actual: 101, limit: 100 }],
      acceptedSnapshot: {
        agentRequests: 2,
        inputTokens: 101,
        outputTokens: 12,
        missingUsageResponses: 0,
      },
    },
  }
}

function preTerminalSnapshot() {
  return {
    ...terminalSnapshot(),
    agentRequests: 2,
    inputTokens: 101,
    outputTokens: 12,
    budgetRejections: 0,
    localBudgetRejections: 0,
    agentRequestSequence: 2,
    firstBudgetRejection: null,
  }
}

function terminalResult() {
  return {
    rootSessionId: SESSION_ID,
    outcome: { class: 'premature-terminal', terminalKind: ATTEMPT_BUDGET_TERMINAL },
    metrics: { modelTurns: 2, inputTokens: 101, outputTokens: 12 },
    budgetTerminalReceipts: [{
      terminalId: TERMINAL_ID,
      attemptId: ATTEMPT_ID,
      sessionId: SESSION_ID,
      requestSequence: 3,
      exhausted: [{ metric: 'inputTokens', actual: 101, limit: 100 }],
      receiptDigest: 'a'.repeat(64),
    }],
  }
}

test('accepts only a first local budget rejection bound to the attempt and Session', () => {
  const evidence = budgetTerminalEvidence(terminalSnapshot(), ATTEMPT_ID, SESSION_ID)
  assert.equal(evidence?.kind, ATTEMPT_BUDGET_TERMINAL)
  assert.equal(evidence?.terminalId, TERMINAL_ID)
  assert.deepEqual(evidence?.exhausted, [
    { metric: 'inputTokens', actual: 101, limit: 100 },
  ])

  const upstream = terminalSnapshot()
  upstream.upstreamHttp429 = 1
  assert.equal(budgetTerminalEvidence(upstream, ATTEMPT_ID, SESSION_ID), null)

  const wrongSession = terminalSnapshot()
  wrongSession.firstBudgetRejection.sessionId = 'another-session'
  assert.equal(budgetTerminalEvidence(wrongSession, ATTEMPT_ID, SESSION_ID), null)
})

test('attributes a budget terminal only to the stage window where its first rejection appeared', () => {
  assert.equal(
    budgetTerminalEvidenceSince(terminalSnapshot(), preTerminalSnapshot(), ATTEMPT_ID)?.terminalId,
    TERMINAL_ID,
  )
  assert.equal(budgetTerminalEvidenceSince(terminalSnapshot(), terminalSnapshot(), ATTEMPT_ID), null)
})

test('allows first-response overshoot only for a host-authenticated budget terminal', () => {
  const valid = validateAttemptBudget({
    attemptId: ATTEMPT_ID,
    result: terminalResult(),
    budget: terminalSnapshot(),
  })
  assert.equal(valid.withinLimits, false)
  assert.equal(valid.metricsMatch, true)
  assert.equal(valid.receiptEvidenceValid, true)
  assert.equal(valid.protocolValid, true)

  const forged = terminalResult()
  forged.budgetTerminalReceipts[0].terminalId = 'c'.repeat(64)
  assert.equal(validateAttemptBudget({
    attemptId: ATTEMPT_ID,
    result: forged,
    budget: terminalSnapshot(),
  }).protocolValid, false)
})

test('keeps generic or upstream 429 failures outside the product score', () => {
  const upstream = terminalSnapshot()
  upstream.upstreamHttp429 = 1
  upstream.localBudgetRejections = 0
  upstream.budgetRejections = 0
  upstream.firstBudgetRejection = null
  assert.equal(validateAttemptBudget({
    attemptId: ATTEMPT_ID,
    result: terminalResult(),
    budget: upstream,
  }).protocolValid, false)
})
