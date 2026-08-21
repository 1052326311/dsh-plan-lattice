import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeV26, V26_PROTOCOL_ID, V26_THRESHOLDS } from '../analysis.mjs'

const HIDDEN_SHA256 = 'a'.repeat(64)

function productGrade(passedRounds, regressions) {
  const rounds = []
  const regressionKeys = Array.from({ length: regressions }, (_, index) => `round-1:history:history-${index + 1}`)
  for (let round = 1; round <= 9; round += 1) {
    const passed = round <= passedRounds
    const cases = [{
      identity: `round-${round}:round:primary-${round}`,
      originRound: round,
      status: passed ? 'success' : 'fail',
    }]
    for (const [index, identity] of regressionKeys.entries()) {
      cases.push({
        identity,
        originRound: 1,
        status: !passed && round === passedRounds + 1 ? 'fail' : 'success',
        scenario: `history-${index + 1}`,
      })
    }
    const successes = cases.filter(entry => entry.status === 'success').length
    rounds.push({
      round,
      reached: true,
      reward: passed ? 1 : 0,
      total: cases.length,
      successes,
      failures: cases.length - successes,
      caseRatio: successes / cases.length,
      cases,
    })
  }
  return {
    hidden: true,
    hiddenAssetsSha256: HIDDEN_SHA256,
    rounds,
    reachedRounds: 9,
    rewardScore: 100 * passedRounds / 9,
    cumulativeCaseScore: 100 * rounds.reduce((sum, round) => sum + round.caseRatio, 0) / 9,
    historicalRequirementRegressions: regressions,
    historicalRegressionKeys: regressionKeys,
  }
}

function terminalProductGrade() {
  const base = productGrade(0, 0)
  const rounds = base.rounds.map((round, index) => index === 0 ? round : ({
    round: index + 1,
    reached: false,
    reward: 0,
    total: 0,
    successes: 0,
    failures: 0,
    caseRatio: 0,
    summaryPresent: false,
    cases: [],
  }))
  return {
    ...base,
    rounds,
    reachedRounds: 1,
    rewardScore: 0,
    cumulativeCaseScore: 0,
  }
}

function nativeAttempt(id, passedRounds, overrides = {}, regressions = 2) {
  const grade = productGrade(passedRounds, regressions)
  const terminalStage = `round-${Math.max(1, passedRounds)}`
  return {
    id,
    arm: 'native',
    status: 'completed',
    budgetWithinLimits: true,
    budgetProtocolValid: true,
    productGrade: grade,
    metrics: {
      score: grade.rewardScore,
      cumulativeCaseScore: grade.cumulativeCaseScore,
      historicalRequirementRegressions: grade.historicalRequirementRegressions,
      hardRequirementsMissed: 9 - passedRounds,
      inputTokens: 1000,
      outputTokens: 100,
      modelTurns: 10,
      maxTokenProductTerminals: 1,
      prematureTaskTerminals: 1,
      attemptBudgetTerminals: 0,
      ...overrides,
    },
    budget: {
      attemptId: id,
      agentRequests: 10,
      inputTokens: 1000,
      outputTokens: 100,
      missingUsageResponses: 0,
      budgetRejections: 0,
      localBudgetRejections: 0,
      upstreamHttp429: 0,
      upstreamTransportErrors: 0,
      agentRequestSequence: 10,
      firstBudgetRejection: null,
      limits: { maxAgentRequests: 100, maxInputTokens: 10_000, maxOutputTokens: 10_000 },
    },
    evidence: {
      outcome: { class: 'premature-terminal', terminalKind: 'max-tokens', stageId: terminalStage },
      terminalOutcomes: [{ stageId: terminalStage, kind: 'product', terminalKind: 'max-tokens' }],
      budgetTerminalReceipts: [],
    },
  }
}

function nativeSet(passed = [5, 5, 5, 5, 5]) {
  return passed.map((count, index) => nativeAttempt(`native-${index + 1}`, count))
}

function candidate(overrides = {}) {
  const grade = productGrade(9, 0)
  const id = 'candidate-1'
  return {
    id,
    arm: 'v0.4-native-continuity',
    status: 'completed',
    budgetWithinLimits: true,
    budgetProtocolValid: true,
    productGrade: grade,
    metrics: {
      score: grade.rewardScore,
      cumulativeCaseScore: grade.cumulativeCaseScore,
      historicalRequirementRegressions: 0,
      hardRequirementsMissed: 0,
      inputTokens: 1100,
      outputTokens: 100,
      modelTurns: 10,
      maxTokenProductTerminals: 0,
      prematureTaskTerminals: 0,
      attemptBudgetTerminals: 0,
      ...overrides,
    },
    budget: {
      attemptId: id,
      agentRequests: overrides.modelTurns ?? 10,
      inputTokens: overrides.inputTokens ?? 1100,
      outputTokens: overrides.outputTokens ?? 100,
      missingUsageResponses: 0,
      budgetRejections: 0,
      localBudgetRejections: 0,
      upstreamHttp429: 0,
      upstreamTransportErrors: 0,
      agentRequestSequence: 10,
      firstBudgetRejection: null,
      limits: { maxAgentRequests: 100, maxInputTokens: 10_000, maxOutputTokens: 10_000 },
    },
    evidence: {
      outcome: { class: 'completed', terminalKind: 'completed', stageId: 'round-9' },
      terminalOutcomes: [{ stageId: 'round-9', kind: 'product', terminalKind: 'completed' }],
      budgetTerminalReceipts: [],
    },
    trace: { valid: true },
  }
}

function withBudgetTerminal(attempt) {
  const sessionId = `${attempt.id}-child-session`
  const terminalId = 'b'.repeat(64)
  const exhausted = [{ metric: 'inputTokens', actual: attempt.metrics.inputTokens, limit: attempt.metrics.inputTokens }]
  return {
    ...attempt,
    metrics: {
      ...attempt.metrics,
      maxTokenProductTerminals: 0,
      prematureTaskTerminals: 1,
      attemptBudgetTerminals: 1,
    },
    budget: {
      ...attempt.budget,
      budgetRejections: 1,
      localBudgetRejections: 1,
      agentRequestSequence: attempt.metrics.modelTurns + 1,
      limits: { ...attempt.budget.limits, maxInputTokens: attempt.metrics.inputTokens },
      firstBudgetRejection: {
        terminalId,
        attemptId: attempt.id,
        sessionId,
        requestSequence: attempt.metrics.modelTurns + 1,
        exhausted,
        acceptedSnapshot: {
          agentRequests: attempt.metrics.modelTurns,
          inputTokens: attempt.metrics.inputTokens,
          outputTokens: attempt.metrics.outputTokens,
          missingUsageResponses: 0,
        },
      },
    },
    evidence: {
      ...attempt.evidence,
      outcome: { class: 'premature-terminal', terminalKind: 'attempt-budget-exhausted', stageId: 'round-3' },
      terminalOutcomes: [{ stageId: 'round-3', kind: 'product', terminalKind: 'attempt-budget-exhausted' }],
      budgetTerminalReceipts: [{
        kind: 'attempt-budget-exhausted', terminalId, attemptId: attempt.id, sessionId,
        requestSequence: attempt.metrics.modelTurns + 1, budgetRejections: 1, exhausted,
        receiptDigest: 'c'.repeat(64),
      }],
    },
  }
}

function analyze(attempts) {
  return analyzeV26({ protocolId: V26_PROTOCOL_ID, attempts })
}

test('accepts an official discrete-score result that clears every release boundary', () => {
  const attempts = nativeSet()
  const result = analyze([...attempts, candidate()])

  assert.equal(result.releaseAllowed, true)
  assert.ok(result.comparison.nativeScoreSpread <= V26_THRESHOLDS.maximumNativeScoreSpread)
  assert.ok(result.comparison.scoreDelta >= V26_THRESHOLDS.minimumCandidateAbsoluteScoreImprovement)
  assert.ok(result.comparison.remainingGapClosed >= V26_THRESHOLDS.minimumCandidateRemainingGapClosed)
  assert.equal(result.comparison.historicalRequirementRegressionReduction, 1)
  assert.equal(result.comparison.inputTokenRatio, V26_THRESHOLDS.maximumCandidateInputTokenRatio)

  const floorNatives = Array.from({ length: 5 }, (_, index) => nativeAttempt(
    `native-floor-${index + 1}`,
    0,
    {},
    0,
  ))
  const floor = analyze([...floorNatives, candidate()])
  assert.equal(floor.releaseAllowed, true)
  assert.equal(floor.comparison.remainingGapClosed, 1)

  const nativeCeiling = nativeSet([6, 7, 8, 8, 9])
  const rejected = analyze(nativeCeiling)
  assert.equal(rejected.candidateExecutionAllowed, false)
  assert.equal(rejected.qualification.gates.find(entry => entry.name.includes('below the ceiling')).passed, false)
})

test('prohibits candidate execution when native calibration is unstable or too strong', () => {
  const result = analyze(nativeSet([5, 5, 5, 7, 8]))

  assert.equal(result.candidateExecutionAllowed, false)
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.qualification.passed, false)
  assert.equal(result.qualification.gates.find(entry => entry.name.includes('median score is at')).passed, true)
  assert.equal(result.qualification.gates.find(entry => entry.name.includes('spread')).passed, false)
  assert.match(result.statement, /candidate execution and release are prohibited/)
})

test('requires a reproducible native max-token terminal before exposing the candidate', () => {
  const attempts = nativeSet().map(attempt => ({
    ...attempt,
    metrics: { ...attempt.metrics, maxTokenProductTerminals: 0 },
  }))
  const result = analyze(attempts)
  assert.equal(result.candidateExecutionAllowed, false)
  assert.equal(result.qualification.gates.find(entry => entry.name.includes('max-token')).passed, false)
})

test('accepts a verifier-backed product terminal and strict zero padding', () => {
  const grade = terminalProductGrade()
  const attempts = Array.from({ length: 5 }, (_, index) => {
    const base = nativeAttempt(`native-terminal-${index + 1}`, 0, {}, 0)
    return {
    ...base,
    productGrade: grade,
    metrics: {
      score: 0,
      cumulativeCaseScore: 0,
      historicalRequirementRegressions: 0,
      hardRequirementsMissed: 9,
      inputTokens: 20_000,
      outputTokens: 100,
      modelTurns: 10,
      maxTokenProductTerminals: 1,
      prematureTaskTerminals: 1,
      attemptBudgetTerminals: 0,
    },
    budget: {
      ...base.budget,
      inputTokens: 20_000,
      limits: { ...base.budget.limits, maxInputTokens: 30_000 },
    },
  }})
  const result = analyze(attempts)
  assert.equal(result.candidateExecutionAllowed, true)

  const forged = structuredClone(attempts)
  forged[0].productGrade.rounds[1].reached = true
  assert.equal(analyze(forged).candidateExecutionAllowed, false)
})

test('retains a host-authenticated budget terminal without weakening the native max-token gate', () => {
  const attempts = nativeSet()
  attempts[2] = withBudgetTerminal(attempts[2])
  const result = analyze(attempts)
  assert.equal(result.candidateExecutionAllowed, true)
  assert.equal(result.comparison.nativeMedianMaxTokenProductTerminals, 1)

  const candidateBudgetTerminal = withBudgetTerminal(candidate())
  const candidateResult = analyze([...attempts, candidateBudgetTerminal])
  assert.equal(candidateResult.releaseAllowed, false)
  assert.equal(candidateResult.candidate.gates.find(entry => entry.name.includes('premature')).passed, false)
})

test('allows the candidate run but blocks release when the qualified calibration has no candidate result', () => {
  const result = analyzeV26({ protocolId: V26_PROTOCOL_ID, nativeAttempts: nativeSet(), candidateAttempt: null })

  assert.equal(result.candidateExecutionAllowed, true)
  assert.equal(result.candidate.executed, false)
  assert.equal(result.candidate.passed, false)
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(entry => entry.name.includes('exactly one candidate')).passed, false)
})

test('rejects caller-authored metrics that are not backed by nine official round receipts', () => {
  const forged = nativeSet().map(attempt => ({ ...attempt, productGrade: undefined }))
  const result = analyze(forged)
  assert.equal(result.candidateExecutionAllowed, false)
  assert.equal(result.qualification.gates.find(entry => entry.name.includes('complete valid metrics')).passed, false)
})

test('allows release only when every preregistered candidate advantage gate passes', () => {
  const result = analyze([...nativeSet(), candidate({
      inputTokens: 1050,
    })])

  assert.equal(result.candidateExecutionAllowed, true)
  assert.equal(result.candidate.passed, true)
  assert.equal(result.releaseAllowed, true)
  assert.equal(result.qualification.gates.every(entry => entry.passed), true)
  assert.equal(result.candidate.gates.every(entry => entry.passed), true)
})

test('blocks a candidate that reaches a premature terminal even when product tests pass', () => {
  const result = analyze([...nativeSet(), candidate({
      maxTokenProductTerminals: 1,
      prematureTaskTerminals: 1,
    })])
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(entry => entry.name.includes('premature')).passed, false)
})
