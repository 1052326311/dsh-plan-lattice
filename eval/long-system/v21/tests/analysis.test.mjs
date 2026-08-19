import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeV21Pair } from '../analysis.mjs'

function manifest() {
  return {
    protocolId: 'v21-test',
    status: 'preregistered-unexecuted',
    executionAllowed: true,
    resultClaimsAllowed: false,
    order: ['native', 'v0.4-native-continuity'],
    thresholds: {
      maximumRecoverySnapshotBytes: 65_536,
      maximumCandidateInputTokensExclusive: 4_000_000,
      maximumCandidateInputTokenRatio: 1.1,
    },
  }
}

function attempt(arm, inputTokens = 1_000_000) {
  return {
    arm,
    status: 'completed',
    budgetWithinLimits: true,
    lifecycle: { valid: true, nativeForegroundPair: true, childCompletedTurn: true },
    metrics: { score: 80, inputTokens, subagentToolSchemaSha256: 'a'.repeat(64) },
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
  const result = analyzeV21Pair({
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
  const result = analyzeV21Pair({ manifest: manifest(), attempts: [native, candidate] })
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
  const result = analyzeV21Pair({ manifest: manifest(), attempts: [attempt('native'), candidate] })
  assert.equal(result.mechanismResultAllowed, false)
  assert.equal(result.mechanism.passed, false)
})

test('rejects candidate input exhaustion or paired overhead above ten percent', () => {
  const result = analyzeV21Pair({
    manifest: manifest(),
    attempts: [attempt('native', 3_000_000), attempt('v0.4-native-continuity', 3_600_000)],
  })
  assert.equal(result.mechanismResultAllowed, false)
  assert.equal(result.comparison.inputTokenRatio, 1.2)
})
