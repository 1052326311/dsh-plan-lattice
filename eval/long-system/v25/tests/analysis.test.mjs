import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeV25, V25_THRESHOLDS } from '../analysis.mjs'

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
  return {
    id,
    arm: 'native',
    status: 'completed',
    budgetWithinLimits: true,
    productGrade: grade,
    metrics: {
      score: grade.rewardScore,
      cumulativeCaseScore: grade.cumulativeCaseScore,
      historicalRequirementRegressions: grade.historicalRequirementRegressions,
      hardRequirementsMissed: 9 - passedRounds,
      inputTokens: 1000,
      maxTokenProductTerminals: 2,
      ...overrides,
    },
  }
}

function nativeSet(passed = [5, 5, 5, 5, 5]) {
  return passed.map((count, index) => nativeAttempt(`native-${index + 1}`, count))
}

function candidate(overrides = {}) {
  const grade = productGrade(9, 0)
  return {
    id: 'candidate-1',
    arm: 'v0.4-native-continuity',
    status: 'completed',
    budgetWithinLimits: true,
    productGrade: grade,
    metrics: {
      score: grade.rewardScore,
      cumulativeCaseScore: grade.cumulativeCaseScore,
      historicalRequirementRegressions: 0,
      hardRequirementsMissed: 0,
      inputTokens: 1100,
      maxTokenProductTerminals: 0,
      ...overrides,
    },
    trace: { valid: true },
  }
}

test('accepts an official discrete-score result that clears every release boundary', () => {
  const attempts = nativeSet()
  const result = analyzeV25({ protocolId: 'v25-boundary', attempts: [...attempts, candidate()] })

  assert.equal(result.releaseAllowed, true)
  assert.ok(result.comparison.nativeScoreSpread <= V25_THRESHOLDS.maximumNativeScoreSpread)
  assert.ok(result.comparison.scoreDelta >= V25_THRESHOLDS.minimumCandidateAbsoluteScoreImprovement)
  assert.ok(result.comparison.remainingGapClosed >= V25_THRESHOLDS.minimumCandidateRemainingGapClosed)
  assert.equal(result.comparison.historicalRequirementRegressionReduction, 1)
  assert.equal(result.comparison.inputTokenRatio, V25_THRESHOLDS.maximumCandidateInputTokenRatio)

  const floorNatives = Array.from({ length: 5 }, (_, index) => nativeAttempt(
    `native-floor-${index + 1}`,
    0,
    {},
    0,
  ))
  const floor = analyzeV25({ attempts: [...floorNatives, candidate()] })
  assert.equal(floor.releaseAllowed, true)
  assert.equal(floor.comparison.remainingGapClosed, 1)

  const nativeCeiling = nativeSet([6, 7, 8, 8, 9])
  const rejected = analyzeV25({ attempts: nativeCeiling })
  assert.equal(rejected.candidateExecutionAllowed, false)
  assert.equal(rejected.qualification.gates.find(entry => entry.name.includes('below the ceiling')).passed, false)
})

test('prohibits candidate execution when native calibration is unstable or too strong', () => {
  const result = analyzeV25({ attempts: nativeSet([5, 5, 5, 7, 8]) })

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
  const result = analyzeV25({ attempts })
  assert.equal(result.candidateExecutionAllowed, false)
  assert.equal(result.qualification.gates.find(entry => entry.name.includes('max-token')).passed, false)
})

test('accepts a verifier-backed product terminal and strict zero padding', () => {
  const grade = terminalProductGrade()
  const attempts = Array.from({ length: 5 }, (_, index) => ({
    ...nativeAttempt(`native-terminal-${index + 1}`, 0, {}, 0),
    productGrade: grade,
    metrics: {
      score: 0,
      cumulativeCaseScore: 0,
      historicalRequirementRegressions: 0,
      hardRequirementsMissed: 9,
      inputTokens: 20_000,
      maxTokenProductTerminals: 1,
    },
  }))
  const result = analyzeV25({ attempts })
  assert.equal(result.candidateExecutionAllowed, true)

  const forged = structuredClone(attempts)
  forged[0].productGrade.rounds[1].reached = true
  assert.equal(analyzeV25({ attempts: forged }).candidateExecutionAllowed, false)
})

test('allows the candidate run but blocks release when the qualified calibration has no candidate result', () => {
  const result = analyzeV25({ nativeAttempts: nativeSet(), candidateAttempt: null })

  assert.equal(result.candidateExecutionAllowed, true)
  assert.equal(result.candidate.executed, false)
  assert.equal(result.candidate.passed, false)
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(entry => entry.name.includes('exactly one candidate')).passed, false)
})

test('rejects caller-authored metrics that are not backed by nine official round receipts', () => {
  const forged = nativeSet().map(attempt => ({ ...attempt, productGrade: undefined }))
  const result = analyzeV25({ attempts: forged })
  assert.equal(result.candidateExecutionAllowed, false)
  assert.equal(result.qualification.gates.find(entry => entry.name.includes('complete valid metrics')).passed, false)
})

test('allows release only when every preregistered candidate advantage gate passes', () => {
  const result = analyzeV25({
    attempts: [...nativeSet(), candidate({
      inputTokens: 1050,
    })],
  })

  assert.equal(result.candidateExecutionAllowed, true)
  assert.equal(result.candidate.passed, true)
  assert.equal(result.releaseAllowed, true)
  assert.equal(result.qualification.gates.every(entry => entry.passed), true)
  assert.equal(result.candidate.gates.every(entry => entry.passed), true)
})

test('blocks a candidate that reaches max-tokens even when product tests pass', () => {
  const result = analyzeV25({
    attempts: [...nativeSet(), candidate({ maxTokenProductTerminals: 1 })],
  })
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.candidate.gates.find(entry => entry.name.includes('max-token')).passed, false)
})
