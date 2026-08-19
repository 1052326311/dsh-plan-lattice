function gate(name, passed, observed, required) {
  return { name, passed: Boolean(passed), observed, required }
}

function armById(attempts, id) {
  const matches = attempts.filter(attempt => attempt?.arm === id)
  return matches.length === 1 ? matches[0] : undefined
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function analyzeV19Pair({ manifest, attempts }) {
  if (!manifest || typeof manifest !== 'object') throw new Error('V19 analysis requires the frozen manifest')
  if (!Array.isArray(attempts)) throw new Error('V19 analysis requires retained arm attempts')
  const expectedOrder = manifest.order ?? []
  const native = armById(attempts, 'native')
  const candidate = armById(attempts, 'v0.4-native-continuity')
  const thresholds = manifest.thresholds ?? {}

  const integrityGates = [
    gate('frozen protocol is execution-authorized',
      manifest.status === 'preregistered-unexecuted' && manifest.executionAllowed === true,
      { status: manifest.status, executionAllowed: manifest.executionAllowed },
      { status: 'preregistered-unexecuted', executionAllowed: true }),
    gate('exactly one retained attempt per frozen arm',
      attempts.length === expectedOrder.length
        && expectedOrder.every(id => attempts.filter(attempt => attempt?.arm === id).length === 1),
      attempts.map(attempt => attempt?.arm), expectedOrder),
    gate('frozen execution order preserved',
      JSON.stringify(attempts.map(attempt => attempt?.arm)) === JSON.stringify(expectedOrder),
      attempts.map(attempt => attempt?.arm), expectedOrder),
    gate('both arm executions completed',
      native?.status === 'completed' && candidate?.status === 'completed',
      { native: native?.status, candidate: candidate?.status }, 'completed/completed'),
    gate('both arm budgets remained valid',
      native?.budgetWithinLimits === true && candidate?.budgetWithinLimits === true,
      { native: native?.budgetWithinLimits, candidate: candidate?.budgetWithinLimits }, true),
    gate('both arms completed the native lifecycle',
      native?.lifecycle?.valid === true && candidate?.lifecycle?.valid === true,
      { native: native?.lifecycle?.valid, candidate: candidate?.lifecycle?.valid }, true),
    gate('both arms exposed the exact same native subagent schema',
      typeof native?.metrics?.subagentToolSchemaSha256 === 'string'
        && native.metrics.subagentToolSchemaSha256 === candidate?.metrics?.subagentToolSchemaSha256,
      { native: native?.metrics?.subagentToolSchemaSha256, candidate: candidate?.metrics?.subagentToolSchemaSha256 },
      'identical SHA-256'),
  ]

  const scoreDelta = finite(candidate?.metrics?.score) && finite(native?.metrics?.score)
    ? candidate.metrics.score - native.metrics.score
    : null
  const candidateGates = [
    gate('candidate reaches the complete product score',
      candidate?.metrics?.score === thresholds.requiredCandidateScore,
      candidate?.metrics?.score, thresholds.requiredCandidateScore),
    gate('paired score delta reaches the preregistered minimum',
      finite(scoreDelta) && scoreDelta >= thresholds.minimumPairedScoreDelta,
      scoreDelta, `>= ${thresholds.minimumPairedScoreDelta}`),
    gate('candidate misses no hard requirement',
      finite(candidate?.metrics?.hardRequirementsMissed)
        && candidate.metrics.hardRequirementsMissed <= thresholds.maximumCandidateHardRequirementsMissed,
      candidate?.metrics?.hardRequirementsMissed, `<= ${thresholds.maximumCandidateHardRequirementsMissed}`),
    gate('candidate retains no stale superseded requirement',
      finite(candidate?.metrics?.staleRequirementsRetained)
        && candidate.metrics.staleRequirementsRetained <= thresholds.maximumCandidateStaleRequirementsRetained,
      candidate?.metrics?.staleRequirementsRetained, `<= ${thresholds.maximumCandidateStaleRequirementsRetained}`),
    gate('candidate preserves delegated artifact behavior',
      finite(candidate?.metrics?.affectedArtifactCoverage)
        && candidate.metrics.affectedArtifactCoverage >= thresholds.minimumCandidateAffectedArtifactCoverage,
      candidate?.metrics?.affectedArtifactCoverage, `>= ${thresholds.minimumCandidateAffectedArtifactCoverage}`),
    gate('candidate stays inside the input-token ceiling',
      finite(candidate?.metrics?.inputTokens)
        && candidate.metrics.inputTokens < thresholds.maximumCandidateInputTokensExclusive,
      candidate?.metrics?.inputTokens, `< ${thresholds.maximumCandidateInputTokensExclusive}`),
    gate('automatic mode makes no forbidden Plan Lattice control call',
      Array.isArray(candidate?.metrics?.forbiddenAutomaticControlCalls)
        && candidate.metrics.forbiddenAutomaticControlCalls.length <= thresholds.maximumCandidateForbiddenControlCalls,
      candidate?.metrics?.forbiddenAutomaticControlCalls?.length,
      `<= ${thresholds.maximumCandidateForbiddenControlCalls}`),
    gate('candidate asks no evaluation clarification question',
      finite(candidate?.metrics?.clarificationQuestions)
        && candidate.metrics.clarificationQuestions <= thresholds.maximumCandidateClarificationQuestions,
      candidate?.metrics?.clarificationQuestions, `<= ${thresholds.maximumCandidateClarificationQuestions}`),
    gate('candidate crossed the required native compaction boundaries',
      finite(candidate?.metrics?.compactionSummaries)
        && candidate.metrics.compactionSummaries >= thresholds.minimumCandidateCompactionSummaries
        && finite(candidate?.metrics?.surfaceReplacements)
        && candidate.metrics.surfaceReplacements >= thresholds.minimumCandidateSurfaceReplacements,
      {
        compactionSummaries: candidate?.metrics?.compactionSummaries,
        surfaceReplacements: candidate?.metrics?.surfaceReplacements,
      }, {
        compactionSummaries: `>= ${thresholds.minimumCandidateCompactionSummaries}`,
        surfaceReplacements: `>= ${thresholds.minimumCandidateSurfaceReplacements}`,
      }),
    gate('candidate used all scheduled process epochs',
      finite(candidate?.metrics?.processEpochs)
        && candidate.metrics.processEpochs >= thresholds.minimumCandidateProcessEpochs,
      candidate?.metrics?.processEpochs, `>= ${thresholds.minimumCandidateProcessEpochs}`),
    gate('candidate used exactly one durable model-facing foreground child',
      candidate?.metrics?.foregroundDelegations === thresholds.requiredForegroundDelegationsPerArm
        && candidate?.lifecycle?.nativeForegroundPair === true
        && candidate?.lifecycle?.childCompletedTurn === true,
      {
        foregroundDelegations: candidate?.metrics?.foregroundDelegations,
        nativeForegroundPair: candidate?.lifecycle?.nativeForegroundPair,
        childCompletedTurn: candidate?.lifecycle?.childCompletedTurn,
      }, {
        foregroundDelegations: thresholds.requiredForegroundDelegationsPerArm,
        nativeForegroundPair: true,
        childCompletedTurn: true,
      }),
  ]
  const gates = [...integrityGates, ...candidateGates]
  const releaseAllowed = gates.every(entry => entry.passed)
  return {
    schemaVersion: 1,
    protocolId: manifest.protocolId,
    manifestDigest: manifest.manifestDigest,
    releaseAllowed,
    resultClaimAllowed: releaseAllowed,
    scope: 'one preregistered paired five-stage DSH rc.7 long-system execution; no global ranking or universal quality claim',
    comparison: {
      nativeScore: native?.metrics?.score ?? null,
      candidateScore: candidate?.metrics?.score ?? null,
      scoreDelta,
      inputTokenDelta: finite(candidate?.metrics?.inputTokens) && finite(native?.metrics?.inputTokens)
        ? candidate.metrics.inputTokens - native.metrics.inputTokens
        : null,
      durationDeltaMs: finite(candidate?.metrics?.durationMs) && finite(native?.metrics?.durationMs)
        ? candidate.metrics.durationMs - native.metrics.durationMs
        : null,
    },
    integrity: { passed: integrityGates.every(entry => entry.passed), gates: integrityGates },
    candidate: { passed: candidateGates.every(entry => entry.passed), gates: candidateGates },
    statement: releaseAllowed
      ? 'All preregistered V19 gates passed. The retained pair supports a targeted continuity result for this frozen task and budget.'
      : 'Release blocked. This V19 result set does not permit a positive continuity-uplift claim.',
  }
}
