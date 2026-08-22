import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeV28,
  V28_EXECUTION_PLAN,
  V28_PROTOCOL_ID,
  V28_THRESHOLDS,
} from '../analysis.mjs'

function grade(passedRounds, reachedRounds = passedRounds === 9 ? 9 : Math.max(1, passedRounds + 1)) {
  const rounds = Array.from({ length: 9 }, (_, index) => {
    const round = index + 1
    if (round > reachedRounds) {
      return {
        round, reached: false, reward: 0, total: 0, successes: 0,
        failures: 0, caseRatio: 0, summaryPresent: false, cases: [],
      }
    }
    const passed = round <= passedRounds
    return {
      round,
      reached: true,
      reward: passed ? 1 : 0,
      total: 1,
      successes: passed ? 1 : 0,
      failures: passed ? 0 : 1,
      caseRatio: passed ? 1 : 0,
      summaryPresent: true,
      cases: [{
        identity: `round-${round}:fixture:case-${round}`,
        originRound: round,
        status: passed ? 'success' : 'fail',
      }],
    }
  })
  return {
    hidden: true,
    hiddenAssetsSha256: 'a'.repeat(64),
    rounds,
    reachedRounds,
    rewardScore: 100 * passedRounds / 9,
    cumulativeCaseScore: 100 * passedRounds / 9,
    historicalRequirementRegressions: 0,
    historicalRegressionKeys: [],
  }
}

function attempt(slot, passedRounds, options = {}) {
  const complete = passedRounds === 9 && options.terminalKind === undefined
  const reachedRounds = options.reachedRounds ?? (complete ? 9 : Math.max(1, passedRounds + 1))
  const productGrade = grade(passedRounds, reachedRounds)
  const terminalKind = options.terminalKind ?? (complete ? 'completed' : 'max-tokens')
  const premature = terminalKind === 'completed' ? 0 : 1
  const id = `fixture-${slot.label}`
  const inputTokens = options.inputTokens ?? (slot.arm === 'native' ? 1_000 : 5_000)
  const outputTokens = options.outputTokens ?? 100
  const modelTurns = options.modelTurns ?? 10
  return {
    id,
    arm: slot.arm,
    status: 'completed',
    productGrade,
    metrics: {
      score: productGrade.rewardScore,
      cumulativeCaseScore: productGrade.cumulativeCaseScore,
      historicalRequirementRegressions: options.regressions ?? 0,
      hardRequirementsMissed: 9 - passedRounds,
      inputTokens,
      outputTokens,
      modelTurns,
      maxTokenProductTerminals: terminalKind === 'max-tokens' ? 1 : 0,
      prematureTaskTerminals: premature,
      attemptBudgetTerminals: terminalKind === 'attempt-budget-exhausted' ? 1 : 0,
    },
    trace: slot.arm === 'native' ? null : { valid: options.traceValid ?? true },
    budget: {
      attemptId: id,
      agentRequests: modelTurns,
      inputTokens,
      outputTokens,
      missingUsageResponses: 0,
      budgetRejections: 0,
      localBudgetRejections: 0,
      upstreamHttp429: 0,
      upstreamTransportErrors: 0,
      agentRequestSequence: modelTurns,
      firstBudgetRejection: null,
      limits: { maxAgentRequests: 100, maxInputTokens: 10_000, maxOutputTokens: 10_000 },
    },
    evidence: {
      outcome: terminalKind === 'completed'
        ? { class: 'completed', terminalKind, stageId: 'round-9' }
        : { class: 'premature-terminal', terminalKind, stageId: `round-${reachedRounds}` },
      terminalOutcomes: Array.from({ length: reachedRounds }, (_, index) => ({
        stageId: `round-${index + 1}`,
        kind: 'product',
        terminalKind: index === reachedRounds - 1 ? terminalKind : 'completed',
      })),
      budgetTerminalReceipts: [],
    },
  }
}

function matrix(
  candidatePassedRounds = Array(12).fill(9),
  nativePassedRounds = Array(12).fill(0),
) {
  return V28_EXECUTION_PLAN.map(slot => attempt(
    slot,
    slot.arm === 'native' ? nativePassedRounds[slot.pair - 1] : candidatePassedRounds[slot.pair - 1],
  ))
}

function analyze(attempts) {
  return analyzeV28({ protocolId: V28_PROTOCOL_ID, attempts })
}

test('releases a complete twelve-pair result with a large reproducible continuity advantage', () => {
  const result = analyze(matrix())
  assert.equal(result.releaseAllowed, true)
  assert.equal(result.comparison.nativeMedianScore, 0)
  assert.equal(result.comparison.candidateMedianScore, 100)
  assert.equal(result.comparison.scoreDelta, 100)
  assert.equal(result.comparison.continuityPairWins, 12)
  assert.equal(result.comparison.candidateFullCompletions, 12)
  assert.equal(result.comparison.inputTokenRatio, 5)
  assert.ok(result.comparison.completionMcNemarP <= 0.025)
  assert.ok(result.comparison.continuitySignFlipP <= 0.025)
})

test('allows two disclosed candidate failures but still requires ten full completions', () => {
  const result = analyze(matrix([9, 9, 0, 9, 9, 9, 9, 9, 0, 9, 9, 9]))
  assert.equal(result.releaseAllowed, true)
  assert.equal(result.comparison.candidateFullCompletions, 10)
  assert.equal(result.comparison.continuityPairWins, 10)

  const weak = analyze(matrix([9, 9, 0, 0, 9, 9, 9, 9, 0, 9, 9, 9]))
  assert.equal(weak.releaseAllowed, false)
  assert.equal(weak.candidate.gates.find(gate => gate.name.includes('fully completes')).passed, false)
})

test('requires ten contemporaneous continuity wins rather than a cherry-picked median', () => {
  const result = analyze(matrix(Array(12).fill(9), [9, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  assert.equal(result.comparison.candidateMedianScore, 100)
  assert.equal(result.comparison.continuityPairWins, 9)
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(gate => gate.name.includes('ten contemporaneous')).passed, false)
})

test('rejects a ceiling baseline that cannot demonstrate a meaningful advantage', () => {
  const result = analyze(matrix(Array(12).fill(9), Array(12).fill(9)))
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(gate => gate.name.includes('non-ceiling')).passed, false)
})

test('authorizes only an exact prefix of the frozen AB/BA execution plan', () => {
  const prefix = matrix().slice(0, 3)
  assert.equal(analyze(prefix).candidateExecutionAllowed, true)
  const swapped = [prefix[1], prefix[0], prefix[2]]
  assert.equal(analyze(swapped).candidateExecutionAllowed, false)
  assert.equal(analyze(matrix().slice(0, 9)).releaseAllowed, false)
})

test('reproduces budget-terminal evidence after canonical serialization reorders object keys', () => {
  const attempts = matrix()
  const index = V28_EXECUTION_PLAN.findIndex(slot => slot.label === 'pair-3-native')
  const base = attempts[index]
  const sessionId = `${base.id}-session`
  const terminalId = 'b'.repeat(64)
  const exhausted = [{ actual: base.metrics.inputTokens, limit: base.metrics.inputTokens, metric: 'inputTokens' }]
  attempts[index] = {
    ...base,
    metrics: {
      ...base.metrics,
      maxTokenProductTerminals: 0,
      attemptBudgetTerminals: 1,
      prematureTaskTerminals: 1,
    },
    budget: {
      ...base.budget,
      budgetRejections: 1,
      localBudgetRejections: 1,
      agentRequestSequence: base.metrics.modelTurns + 1,
      limits: { ...base.budget.limits, maxInputTokens: base.metrics.inputTokens },
      firstBudgetRejection: {
        terminalId,
        attemptId: base.id,
        sessionId,
        requestSequence: base.metrics.modelTurns + 1,
        exhausted,
        acceptedSnapshot: {
          agentRequests: base.metrics.modelTurns,
          inputTokens: base.metrics.inputTokens,
          outputTokens: base.metrics.outputTokens,
          missingUsageResponses: 0,
        },
      },
    },
    evidence: {
      ...base.evidence,
      outcome: { class: 'premature-terminal', terminalKind: 'attempt-budget-exhausted', stageId: 'round-1' },
      terminalOutcomes: [{ stageId: 'round-1', kind: 'product', terminalKind: 'attempt-budget-exhausted' }],
      budgetTerminalReceipts: [{
        kind: 'attempt-budget-exhausted', terminalId, attemptId: base.id, sessionId,
        requestSequence: base.metrics.modelTurns + 1, budgetRejections: 1, exhausted,
        receiptDigest: 'c'.repeat(64),
      }],
    },
  }
  const roundTripped = JSON.parse(JSON.stringify(attempts))
  assert.equal(analyze(roundTripped).releaseAllowed, true)
})

test('rejects caller-authored scores that disagree with hidden round evidence', () => {
  const attempts = matrix()
  attempts[0].metrics.score = 100
  const result = analyze(attempts)
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(gate => gate.name.includes('reproducible metrics')).passed, false)
})

test('blocks candidate regressions and invalid continuity traces', () => {
  const regression = matrix()
  const candidateIndex = V28_EXECUTION_PLAN.findIndex(slot => slot.arm === 'v0.4-native-continuity')
  regression[candidateIndex].metrics.historicalRequirementRegressions = 1
  assert.equal(analyze(regression).releaseAllowed, false)

  const invalidTrace = matrix()
  invalidTrace[candidateIndex].trace.valid = false
  const result = analyze(invalidTrace)
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(gate => gate.name.includes('continuity audit')).passed, false)
})

test('freezes the minimum public claim thresholds', () => {
  assert.equal(V28_THRESHOLDS.minimumCandidateMedianAbsoluteScoreImprovement, 15)
  assert.equal(V28_THRESHOLDS.minimumCandidateMedianRemainingGapClosed, 0.30)
  assert.equal(V28_THRESHOLDS.minimumCandidateFullCompletions, 10)
  assert.equal(V28_THRESHOLDS.minimumContinuityPairWins, 10)
  assert.equal(V28_THRESHOLDS.bootstrapSamples, 100_000)
})
