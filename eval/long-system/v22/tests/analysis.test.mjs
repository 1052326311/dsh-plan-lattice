import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeV22Pair } from '../analysis.mjs'

function manifest() {
  return {
    protocolId: 'v22-test',
    status: 'preregistered-unexecuted',
    executionAllowed: true,
    resultClaimsAllowed: false,
    order: ['native', 'v0.4-native-continuity'],
    thresholds: {
      maximumRecoverySnapshotBytes: 65_536,
      minimumCandidateRecoverySnapshots: 2,
      maximumCandidateInputTokensExclusive: 4_000_000,
      maximumCandidateInputTokenRatio: 1.1,
      requiredCandidateScore: 100,
      minimumPairedScoreDelta: 15,
      maximumCandidateHardRequirementsMissed: 0,
      maximumCandidateStaleRequirementsRetained: 0,
      minimumCandidateAffectedArtifactCoverage: 1,
      maximumCandidateClarificationQuestions: 0,
      maximumCandidateForbiddenControlCalls: 0,
    },
  }
}

function attempt(arm, inputTokens = 1_000_000) {
  return {
    arm,
    status: 'completed',
    budgetWithinLimits: true,
    lifecycle: { valid: true, nativeForegroundPair: true, childCompletedTurn: true },
    metrics: {
      score: arm === 'native' ? 80 : 100,
      inputTokens,
      hardRequirementsMissed: 0,
      staleRequirementsRetained: 0,
      affectedArtifactCoverage: 1,
      clarificationQuestions: 0,
      forbiddenAutomaticControlCalls: [],
      subagentToolSchemaSha256: 'a'.repeat(64),
    },
    ...(arm === 'v0.4-native-continuity' ? {
      continuity: {
        valid: true,
        violations: [],
        totalSnapshots: 2,
        totalOwnReplacements: 2,
        maximumObservedSnapshotBytes: 4096,
      },
    } : {}),
  }
}

test('permits only the narrow mechanism result while release remains disabled', () => {
  const result = analyzeV22Pair({
    manifest: manifest(),
    attempts: [attempt('native'), attempt('v0.4-native-continuity', 1_050_000)],
  })
  assert.equal(result.mechanismResultAllowed, true)
  assert.equal(result.releaseAllowed, false)
  assert.equal(result.resultClaimAllowed, false)
})

test('rejects incomplete native lifecycle even when the workspace score is preserved', () => {
  const native = attempt('native')
  const candidate = attempt('v0.4-native-continuity')
  candidate.lifecycle.childCompletedTurn = false
  const result = analyzeV22Pair({ manifest: manifest(), attempts: [native, candidate] })
  assert.equal(result.mechanismResultAllowed, false)
  assert.equal(result.integrity.passed, false)
})

test('rejects unbounded, duplicate, or fresh-child recovery', () => {
  const candidate = attempt('v0.4-native-continuity')
  candidate.continuity = {
    valid: false,
    violations: [{ kind: 'fresh-child-injection' }, { kind: 'duplicate-snapshot-for-replacement' }],
    totalSnapshots: 3,
    totalOwnReplacements: 2,
    maximumObservedSnapshotBytes: 70_000,
  }
  const result = analyzeV22Pair({ manifest: manifest(), attempts: [attempt('native'), candidate] })
  assert.equal(result.mechanismResultAllowed, false)
  assert.equal(result.mechanism.passed, false)
})

test('rejects candidate input exhaustion or paired overhead above ten percent', () => {
  const result = analyzeV22Pair({
    manifest: manifest(),
    attempts: [attempt('native', 3_000_000), attempt('v0.4-native-continuity', 3_600_000)],
  })
  assert.equal(result.mechanismResultAllowed, false)
  assert.equal(result.comparison.inputTokenRatio, 1.2)
})

test('rejects a candidate that does not complete the behavior contract or clear stale requirements', () => {
  const candidate = attempt('v0.4-native-continuity')
  candidate.metrics.score = 94
  candidate.metrics.hardRequirementsMissed = 1
  candidate.metrics.staleRequirementsRetained = 1
  candidate.metrics.affectedArtifactCoverage = 0.5
  const result = analyzeV22Pair({ manifest: manifest(), attempts: [attempt('native'), candidate] })
  assert.equal(result.mechanismResultAllowed, false)
  assert.equal(result.mechanism.passed, false)
})

test('rejects an inert candidate that never restores authority after native replacement', () => {
  const candidate = attempt('v0.4-native-continuity')
  candidate.continuity.totalSnapshots = 0
  const result = analyzeV22Pair({ manifest: manifest(), attempts: [attempt('native'), candidate] })
  assert.equal(result.mechanismResultAllowed, false)
  assert.equal(result.mechanism.gates.find(gate => gate.name.includes('exercises the frozen recovery mechanism'))?.passed, false)
})
