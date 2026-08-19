function finite(value) {
  return Number.isFinite(value)
}

function gate(name, passed, actual, expected) {
  return { name, passed: passed === true, actual: actual ?? null, expected }
}

export function analyzeV21Pair({ manifest, attempts }) {
  const thresholds = manifest.thresholds
  const native = attempts.find(attempt => attempt.arm === 'native')
  const candidate = attempts.find(attempt => attempt.arm === 'v0.4-native-continuity')
  const inputRatio = finite(candidate?.metrics?.inputTokens) && finite(native?.metrics?.inputTokens)
    && native.metrics.inputTokens > 0
    ? candidate.metrics.inputTokens / native.metrics.inputTokens
    : null
  const integrityGates = [
    gate('result is bound to a preregistered executable manifest',
      manifest.status === 'preregistered-unexecuted'
        && manifest.executionAllowed === true
        && manifest.resultClaimsAllowed === false,
      { status: manifest.status, executionAllowed: manifest.executionAllowed },
      { status: 'preregistered-unexecuted', executionAllowed: true }),
    gate('one result exists for each fixed arm',
      attempts.length === 2 && native !== undefined && candidate !== undefined,
      attempts.map(attempt => attempt.arm), manifest.order),
    gate('both arms complete the DSH lifecycle',
      native?.status === 'completed'
        && candidate?.status === 'completed'
        && native?.lifecycle?.valid === true
        && candidate?.lifecycle?.valid === true
        && native?.lifecycle?.childCompletedTurn === true
        && candidate?.lifecycle?.childCompletedTurn === true,
      { native: native?.lifecycle, candidate: candidate?.lifecycle }, 'complete native lifecycle in both arms'),
    gate('both arms expose the same native subagent schema',
      typeof native?.metrics?.subagentToolSchemaSha256 === 'string'
        && native.metrics.subagentToolSchemaSha256 === candidate?.metrics?.subagentToolSchemaSha256,
      {
        native: native?.metrics?.subagentToolSchemaSha256,
        candidate: candidate?.metrics?.subagentToolSchemaSha256,
      }, 'identical SHA-256'),
  ]
  const mechanismGates = [
    gate('candidate continuity audit passes',
      candidate?.continuity?.valid === true && candidate.continuity.violations?.length === 0,
      candidate?.continuity?.violations, []),
    gate('fresh child receives no Plan Lattice runtime snapshot',
      candidate?.continuity?.violations?.every(violation => violation.kind !== 'fresh-child-injection') === true,
      candidate?.continuity?.violations?.filter(violation => violation.kind === 'fresh-child-injection'), []),
    gate('every recovery snapshot follows a child-owned or root-owned replacement',
      candidate?.continuity?.violations?.every(violation => violation.kind !== 'snapshot-without-own-replacement') === true,
      candidate?.continuity?.violations?.filter(violation => violation.kind === 'snapshot-without-own-replacement'), []),
    gate('at most one recovery snapshot is committed per replacement',
      finite(candidate?.continuity?.totalSnapshots)
        && finite(candidate?.continuity?.totalOwnReplacements)
        && candidate.continuity.totalSnapshots <= candidate.continuity.totalOwnReplacements,
      {
        snapshots: candidate?.continuity?.totalSnapshots,
        replacements: candidate?.continuity?.totalOwnReplacements,
      }, 'snapshots <= replacements'),
    gate('every recovery snapshot stays within the frozen byte bound',
      finite(candidate?.continuity?.maximumObservedSnapshotBytes)
        && candidate.continuity.maximumObservedSnapshotBytes <= thresholds.maximumRecoverySnapshotBytes,
      candidate?.continuity?.maximumObservedSnapshotBytes, `<= ${thresholds.maximumRecoverySnapshotBytes}`),
    gate('candidate completes within its absolute input budget',
      candidate?.budgetWithinLimits === true
        && finite(candidate?.metrics?.inputTokens)
        && candidate.metrics.inputTokens < thresholds.maximumCandidateInputTokensExclusive,
      candidate?.metrics?.inputTokens, `< ${thresholds.maximumCandidateInputTokensExclusive}`),
    gate('candidate input remains within the paired overhead bound',
      finite(inputRatio) && inputRatio <= thresholds.maximumCandidateInputTokenRatio,
      inputRatio, `<= ${thresholds.maximumCandidateInputTokenRatio}`),
    gate('candidate does not regress frozen task behavior',
      finite(candidate?.metrics?.score)
        && finite(native?.metrics?.score)
        && candidate.metrics.score >= native.metrics.score,
      { native: native?.metrics?.score, candidate: candidate?.metrics?.score }, 'candidate >= native'),
  ]
  const mechanismResultAllowed = [...integrityGates, ...mechanismGates].every(entry => entry.passed)
  return {
    schemaVersion: 1,
    protocolId: manifest.protocolId,
    releaseAllowed: false,
    resultClaimAllowed: false,
    mechanismResultAllowed,
    scope: 'one preregistered DSH rc.7 native-boundary pair; no release, ranking, or general quality claim',
    comparison: {
      nativeScore: native?.metrics?.score ?? null,
      candidateScore: candidate?.metrics?.score ?? null,
      inputTokenRatio: inputRatio,
    },
    integrity: { passed: integrityGates.every(entry => entry.passed), gates: integrityGates },
    mechanism: { passed: mechanismGates.every(entry => entry.passed), gates: mechanismGates },
    statement: mechanismResultAllowed
      ? 'The frozen V21 pair may support only the preregistered native-continuity mechanism statement.'
      : 'V21 mechanism evidence is blocked; no positive statement is permitted.',
  }
}
