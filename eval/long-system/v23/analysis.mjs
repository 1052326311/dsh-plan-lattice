function finite(value) {
  return Number.isFinite(value)
}

function gate(name, passed, actual, expected) {
  return { name, passed: passed === true, actual: actual ?? null, expected }
}

export function analyzeV23Pair({ manifest, attempts }) {
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
    gate('candidate projects the DSH-native workflow through persisted root snapshots',
      finite(candidate?.continuity?.totalWorkflowSnapshots)
        && candidate.continuity.totalWorkflowSnapshots >= thresholds.minimumCandidateWorkflowSnapshots,
      candidate?.continuity?.totalWorkflowSnapshots, `>= ${thresholds.minimumCandidateWorkflowSnapshots}`),
    gate('candidate gives the native child exactly one post-prompt read-only capsule',
      candidate?.continuity?.totalDelegatedCapsules === thresholds.requiredCandidateDelegatedCapsules,
      candidate?.continuity?.totalDelegatedCapsules, thresholds.requiredCandidateDelegatedCapsules),
    gate('every Plan Lattice context snapshot stays within the frozen byte bound',
      finite(candidate?.continuity?.maximumObservedSnapshotBytes)
        && candidate.continuity.maximumObservedSnapshotBytes <= thresholds.maximumContextSnapshotBytes,
      candidate?.continuity?.maximumObservedSnapshotBytes, `<= ${thresholds.maximumContextSnapshotBytes}`),
    gate('candidate records enough native Todo transitions to cover every staged task',
      finite(candidate?.metrics?.todoWrites)
        && candidate.metrics.todoWrites >= thresholds.minimumCandidateTodoWrites,
      candidate?.metrics?.todoWrites, `>= ${thresholds.minimumCandidateTodoWrites}`),
    gate('candidate durably completes a native Todo in every staged task',
      finite(candidate?.metrics?.completedTodoWrites)
        && candidate.metrics.completedTodoWrites >= thresholds.minimumCandidateCompletedTodoWrites,
      candidate?.metrics?.completedTodoWrites, `>= ${thresholds.minimumCandidateCompletedTodoWrites}`),
    gate('candidate emits no invalid native Todo snapshot',
      Array.isArray(candidate?.metrics?.invalidTodoWrites)
        && candidate.metrics.invalidTodoWrites.length === 0,
      candidate?.metrics?.invalidTodoWrites, []),
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
    gate('candidate reaches the frozen complete behavior score',
      finite(candidate?.metrics?.score)
        && candidate.metrics.score >= thresholds.requiredCandidateScore,
      candidate?.metrics?.score, `>= ${thresholds.requiredCandidateScore}`),
    gate('candidate improves enough to avoid a ceiling or trivial comparison',
      finite(candidate?.metrics?.score)
        && finite(native?.metrics?.score)
        && candidate.metrics.score - native.metrics.score >= thresholds.minimumPairedScoreDelta,
      finite(candidate?.metrics?.score) && finite(native?.metrics?.score)
        ? candidate.metrics.score - native.metrics.score
        : null,
      `>= ${thresholds.minimumPairedScoreDelta}`),
    gate('candidate misses no frozen hard requirement',
      finite(candidate?.metrics?.hardRequirementsMissed)
        && candidate.metrics.hardRequirementsMissed <= thresholds.maximumCandidateHardRequirementsMissed,
      candidate?.metrics?.hardRequirementsMissed,
      `<= ${thresholds.maximumCandidateHardRequirementsMissed}`),
    gate('candidate retains no stale superseded requirement',
      finite(candidate?.metrics?.staleRequirementsRetained)
        && candidate.metrics.staleRequirementsRetained <= thresholds.maximumCandidateStaleRequirementsRetained,
      candidate?.metrics?.staleRequirementsRetained,
      `<= ${thresholds.maximumCandidateStaleRequirementsRetained}`),
    gate('candidate covers every affected artifact boundary',
      finite(candidate?.metrics?.affectedArtifactCoverage)
        && candidate.metrics.affectedArtifactCoverage >= thresholds.minimumCandidateAffectedArtifactCoverage,
      candidate?.metrics?.affectedArtifactCoverage,
      `>= ${thresholds.minimumCandidateAffectedArtifactCoverage}`),
    gate('automatic candidate asks no evaluator-supplied clarification',
      finite(candidate?.metrics?.clarificationQuestions)
        && candidate.metrics.clarificationQuestions <= thresholds.maximumCandidateClarificationQuestions,
      candidate?.metrics?.clarificationQuestions,
      `<= ${thresholds.maximumCandidateClarificationQuestions}`),
    gate('automatic candidate invokes no legacy controller tool',
      Array.isArray(candidate?.metrics?.forbiddenAutomaticControlCalls)
        && candidate.metrics.forbiddenAutomaticControlCalls.length <= thresholds.maximumCandidateForbiddenControlCalls,
      candidate?.metrics?.forbiddenAutomaticControlCalls?.length,
      `<= ${thresholds.maximumCandidateForbiddenControlCalls}`),
  ]
  const mechanismResultAllowed = [...integrityGates, ...mechanismGates].every(entry => entry.passed)
  return {
    schemaVersion: 1,
    protocolId: manifest.protocolId,
    releaseAllowed: false,
    resultClaimAllowed: false,
    mechanismResultAllowed,
    scope: 'one preregistered DSH rc.7 native-workflow pair; no release, ranking, or general quality claim',
    comparison: {
      nativeScore: native?.metrics?.score ?? null,
      candidateScore: candidate?.metrics?.score ?? null,
      inputTokenRatio: inputRatio,
    },
    integrity: { passed: integrityGates.every(entry => entry.passed), gates: integrityGates },
    mechanism: { passed: mechanismGates.every(entry => entry.passed), gates: mechanismGates },
    statement: mechanismResultAllowed
      ? 'The frozen V23 pair may support only the preregistered DSH-native workflow mechanism statement.'
      : 'V23 mechanism evidence is blocked; no positive statement is permitted.',
  }
}
