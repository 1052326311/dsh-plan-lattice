export const ATTEMPT_BUDGET_TERMINAL = 'attempt-budget-exhausted'
export const ATTEMPT_BUDGET_ERROR_MESSAGE = 'preregistered pilot budget exhausted'

const DIMENSIONS = Object.freeze([
  ['agentRequests', 'maxAgentRequests'],
  ['inputTokens', 'maxInputTokens'],
  ['outputTokens', 'maxOutputTokens'],
])

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

export function budgetTerminalEvidence(snapshot, expectedAttemptId, expectedSessionId) {
  if (!snapshot || typeof snapshot !== 'object'
    || snapshot.attemptId !== expectedAttemptId
    || !nonnegativeInteger(snapshot.budgetRejections) || snapshot.budgetRejections < 1
    || snapshot.localBudgetRejections !== snapshot.budgetRejections
    || snapshot.upstreamHttp429 !== 0
    || snapshot.upstreamTransportErrors !== 0
    || snapshot.missingUsageResponses !== 0
    || !snapshot.limits || typeof snapshot.limits !== 'object') return null

  const exhausted = []
  for (const [metric, limitName] of DIMENSIONS) {
    const actual = snapshot[metric]
    const limit = snapshot.limits[limitName]
    if (!nonnegativeInteger(actual) || !Number.isSafeInteger(limit) || limit < 1) return null
    if (actual >= limit) exhausted.push({ metric, actual, limit })
  }
  if (exhausted.length === 0) return null
  const first = snapshot.firstBudgetRejection
  if (!first || first.attemptId !== expectedAttemptId
    || typeof first.sessionId !== 'string' || first.sessionId.length < 8
    || (expectedSessionId !== undefined && first.sessionId !== expectedSessionId)
    || !/^[0-9a-f]{64}$/.test(first.terminalId ?? '')
    || first.requestSequence !== snapshot.agentRequests + 1
    || first.acceptedSnapshot?.agentRequests !== snapshot.agentRequests
    || first.acceptedSnapshot?.inputTokens !== snapshot.inputTokens
    || first.acceptedSnapshot?.outputTokens !== snapshot.outputTokens
    || first.acceptedSnapshot?.missingUsageResponses !== 0
    || JSON.stringify(first.exhausted) !== JSON.stringify(exhausted)) return null
  return {
    kind: ATTEMPT_BUDGET_TERMINAL,
    terminalId: first.terminalId,
    attemptId: expectedAttemptId,
    sessionId: first.sessionId,
    requestSequence: first.requestSequence,
    budgetRejections: snapshot.budgetRejections,
    exhausted,
  }
}

export function budgetTerminalEvidenceSince(snapshot, before, expectedAttemptId) {
  if (!before || before.attemptId !== expectedAttemptId
    || before.firstBudgetRejection !== null
    || before.budgetRejections !== 0
    || before.localBudgetRejections !== 0
    || !nonnegativeInteger(before.agentRequestSequence)
    || !nonnegativeInteger(before.agentRequests)
    || !nonnegativeInteger(before.inputTokens)
    || !nonnegativeInteger(before.outputTokens)) return null

  const evidence = budgetTerminalEvidence(snapshot, expectedAttemptId, undefined)
  if (evidence === null
    || evidence.requestSequence <= before.agentRequestSequence
    || snapshot.agentRequests < before.agentRequests
    || snapshot.inputTokens < before.inputTokens
    || snapshot.outputTokens < before.outputTokens) return null
  return evidence
}

export function budgetMatchesSession(snapshot, metrics) {
  return snapshot?.agentRequests === metrics?.modelTurns
    && snapshot?.inputTokens === metrics?.inputTokens
    && snapshot?.outputTokens === metrics?.outputTokens
}
