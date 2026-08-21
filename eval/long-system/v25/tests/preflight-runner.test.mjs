import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectModelEnvironment } from '../preflight.mjs'
import { runGatedCalibrations } from '../run-calibrations.mjs'

function grade(passedRounds, regressions) {
  const regressionKeys = Array.from({ length: regressions }, (_, index) => `round-1:history:h${index}`)
  const rounds = Array.from({ length: 9 }, (_, index) => {
    const round = index + 1
    const passed = round <= passedRounds
    const cases = [{ identity: `round-${round}:round:p${round}`, originRound: round, status: passed ? 'success' : 'fail' }]
    for (const identity of regressionKeys) {
      cases.push({ identity, originRound: 1, status: !passed && round === passedRounds + 1 ? 'fail' : 'success' })
    }
    const successes = cases.filter(entry => entry.status === 'success').length
    return {
      round, reached: true, reward: passed ? 1 : 0,
      total: cases.length, successes, failures: cases.length - successes,
      caseRatio: successes / cases.length, cases,
    }
  })
  return {
    hidden: true,
    hiddenAssetsSha256: 'a'.repeat(64),
    rounds,
    reachedRounds: 9,
    rewardScore: 100 * passedRounds / 9,
    cumulativeCaseScore: 100 * rounds.reduce((sum, round) => sum + round.caseRatio, 0) / 9,
    historicalRequirementRegressions: regressions,
    historicalRegressionKeys: regressionKeys,
  }
}

function attempt(arm, passedRounds, overrides = {}) {
  const productGrade = grade(passedRounds, arm === 'native' ? 2 : 0)
  return {
    id: `${arm}-${passedRounds}`,
    arm,
    status: 'completed',
    budgetWithinLimits: true,
    productGrade,
    metrics: {
      score: productGrade.rewardScore,
      cumulativeCaseScore: productGrade.cumulativeCaseScore,
      historicalRequirementRegressions: productGrade.historicalRequirementRegressions,
      hardRequirementsMissed: 9 - passedRounds,
      inputTokens: 1000,
      maxTokenProductTerminals: arm === 'native' ? 2 : 0,
      ...overrides,
    },
    trace: { valid: true },
  }
}

test('reports credential presence without returning the secret', () => {
  const secret = 'test-only-secret-value'
  const result = inspectModelEnvironment({
    DEEPSEEK_API_KEY: secret,
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  })
  assert.deepEqual(result, {
    credentialPresent: true,
    endpointValid: true,
    endpoint: 'https://api.deepseek.com/',
  })
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
  assert.equal(inspectModelEnvironment({ DEEPSEEK_API_KEY: secret, DEEPSEEK_BASE_URL: 'https://user:secret@example.com' }).endpointValid, false)
})

test('never invokes the candidate when five native calibrations fail qualification', async () => {
  const passed = [5, 5, 5, 7, 8]
  const calls = []
  const checkpoints = []
  const result = await runGatedCalibrations({
    protocolId: 'v25-test',
    async executeAttempt({ arm, ordinal }) {
      calls.push(arm)
      assert.equal(arm, 'native')
      return attempt(arm, passed[ordinal - 1])
    },
    async writeCheckpoint(name) { checkpoints.push(name) },
  })

  assert.deepEqual(calls, Array(5).fill('native'))
  assert.equal(result.qualification.candidateExecutionAllowed, false)
  assert.equal(result.candidateExecuted, false)
  assert.equal(result.analysis.releaseAllowed, false)
  assert.ok(checkpoints.includes('native-qualification.json'))
  assert.ok(!checkpoints.includes('candidate.json'))
})

test('stops after an incomplete native attempt and still records a blocking qualification', async () => {
  let calls = 0
  const result = await runGatedCalibrations({
    protocolId: 'v25-test',
    async executeAttempt({ arm }) {
      calls += 1
      return calls === 2
        ? { ...attempt(arm, 5), status: 'failed' }
        : attempt(arm, 5)
    },
  })
  assert.equal(calls, 2)
  assert.equal(result.attempts.length, 2)
  assert.equal(result.candidateExecuted, false)
  assert.equal(result.qualification.candidateExecutionAllowed, false)
})

test('runs exactly one candidate after qualification and releases only after all candidate gates pass', async () => {
  const passed = [5, 5, 5, 5, 5]
  const calls = []
  const result = await runGatedCalibrations({
    protocolId: 'v25-test',
    async executeAttempt({ arm, ordinal }) {
      calls.push(arm)
      if (arm === 'native') return attempt(arm, passed[ordinal - 1])
      return attempt(arm, 9, {
        inputTokens: 1100,
      })
    },
  })

  assert.deepEqual(calls, [...Array(5).fill('native'), 'v0.4-native-continuity'])
  assert.equal(result.qualification.candidateExecutionAllowed, true)
  assert.equal(result.candidateExecuted, true)
  assert.equal(result.analysis.releaseAllowed, true)
})
