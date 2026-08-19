import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeV20Pair } from '../analysis.mjs'

const digestA = 'a'.repeat(64)

function manifest() {
  return {
    protocolId: 'v20-test',
    manifestDigest: 'f'.repeat(64),
    status: 'preregistered-unexecuted',
    executionAllowed: true,
    order: ['native', 'v0.4-native-continuity'],
    thresholds: {
      requiredCandidateScore: 100,
      minimumPairedScoreDelta: 15,
      maximumCandidateHardRequirementsMissed: 0,
      maximumCandidateStaleRequirementsRetained: 0,
      minimumCandidateAffectedArtifactCoverage: 1,
      maximumCandidateInputTokensExclusive: 4_000_000,
      maximumCandidateForbiddenControlCalls: 0,
      maximumCandidateClarificationQuestions: 0,
      minimumCandidateCompactionSummaries: 2,
      minimumCandidateSurfaceReplacements: 2,
      minimumCandidateProcessEpochs: 5,
      requiredForegroundDelegationsPerArm: 1,
    },
  }
}

function attempt(arm, score) {
  return {
    arm,
    status: 'completed',
    budgetWithinLimits: true,
    lifecycle: { valid: true, nativeForegroundPair: true, childCompletedTurn: true },
    metrics: {
      score,
      hardRequirementsMissed: score === 100 ? 0 : 1,
      staleRequirementsRetained: 0,
      affectedArtifactCoverage: 1,
      inputTokens: 1000,
      durationMs: 100,
      forbiddenAutomaticControlCalls: [],
      clarificationQuestions: 0,
      compactionSummaries: 2,
      surfaceReplacements: 2,
      processEpochs: 5,
      foregroundDelegations: 1,
      subagentToolSchemaSha256: digestA,
    },
  }
}

test('allows only a complete paired result above the frozen delta', () => {
  const analysis = analyzeV20Pair({
    manifest: manifest(),
    attempts: [attempt('native', 80), attempt('v0.4-native-continuity', 100)],
  })
  assert.equal(analysis.releaseAllowed, true)
  assert.equal(analysis.comparison.scoreDelta, 20)
})

test('blocks a cherry-picked small delta even when candidate is complete', () => {
  const analysis = analyzeV20Pair({
    manifest: manifest(),
    attempts: [attempt('native', 90), attempt('v0.4-native-continuity', 100)],
  })
  assert.equal(analysis.releaseAllowed, false)
  assert.equal(analysis.candidate.gates.find(entry => entry.name.includes('score delta')).passed, false)
})

test('blocks a mismatched native tool schema or incomplete child lifecycle', () => {
  const native = attempt('native', 80)
  const candidate = attempt('v0.4-native-continuity', 100)
  candidate.metrics.subagentToolSchemaSha256 = 'b'.repeat(64)
  candidate.lifecycle.childCompletedTurn = false
  const analysis = analyzeV20Pair({ manifest: manifest(), attempts: [native, candidate] })
  assert.equal(analysis.releaseAllowed, false)
  assert.equal(analysis.integrity.passed, false)
})
