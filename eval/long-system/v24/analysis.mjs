export const V24_THRESHOLDS = Object.freeze({
  requiredNativeAttempts: 5,
  maximumNativeScoreExclusive: 90,
  maximumNativeMedianScore: 85,
  maximumNativeScoreSpread: 15,
  minimumCandidateAbsoluteScoreImprovement: 15,
  minimumCandidateRelativeScoreImprovement: 0.30,
  minimumHistoricalRequirementRegressionReduction: 0.50,
  maximumCandidateHardRequirementsMissed: 0,
  maximumCandidateInputTokenRatio: 1.10,
  maximumNativeMedianForCandidateReachability: 100 / 1.30,
  minimumNativeMedianRegressionsForCandidateReachability: 1,
})

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function metric(attempt, primary, fallback) {
  const value = attempt?.metrics?.[primary]
  return value === undefined && fallback ? attempt?.metrics?.[fallback] : value
}

function median(values) {
  if (values.length === 0 || values.some(value => !finite(value))) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function gate(name, passed, actual, expected) {
  return { name, passed: passed === true, actual: actual ?? null, expected }
}

function validScore(value) {
  return finite(value) && value >= 0 && value <= 100
}

function close(left, right) {
  return finite(left) && finite(right) && Math.abs(left - right) <= 1e-9
}

function validateProductGrade(attempt) {
  const grade = attempt?.productGrade
  if (!grade || typeof grade !== 'object' || !Array.isArray(grade.rounds) || grade.rounds.length !== 9) return false
  const previous = new Map()
  const regressions = new Set()
  let reward = 0
  let caseRatio = 0
  for (const [index, round] of grade.rounds.entries()) {
    if (round?.round !== index + 1 || round.reached !== true || (round.reward !== 0 && round.reward !== 1)
      || !Number.isInteger(round.total) || round.total <= 0
      || !Number.isInteger(round.successes) || !Number.isInteger(round.failures)
      || round.total !== round.successes + round.failures
      || !Array.isArray(round.cases) || round.cases.length !== round.total) return false
    const identities = new Set()
    for (const entry of round.cases) {
      if (typeof entry?.identity !== 'string' || entry.identity.length === 0 || identities.has(entry.identity)
        || !['success', 'fail'].includes(entry.status)) return false
      identities.add(entry.identity)
      if (previous.get(entry.identity) === 'success' && entry.status === 'fail'
        && Number.isInteger(entry.originRound) && entry.originRound < round.round) {
        regressions.add(entry.identity)
      }
      previous.set(entry.identity, entry.status)
    }
    const actualSuccesses = round.cases.filter(entry => entry.status === 'success').length
    if (actualSuccesses !== round.successes || round.failures !== round.total - actualSuccesses) return false
    const expectedReward = round.failures === 0 ? 1 : 0
    if (round.reward !== expectedReward || !close(round.caseRatio, round.successes / round.total)) return false
    reward += round.reward
    caseRatio += round.caseRatio
  }
  const expectedRegressionKeys = [...regressions].sort()
  return grade.hidden === true
    && typeof grade.hiddenAssetsSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(grade.hiddenAssetsSha256)
    && grade.reachedRounds === 9
    && close(grade.rewardScore, 100 * reward / 9)
    && close(grade.cumulativeCaseScore, 100 * caseRatio / 9)
    && grade.historicalRequirementRegressions === regressions.size
    && JSON.stringify(grade.historicalRegressionKeys) === JSON.stringify(expectedRegressionKeys)
    && close(metric(attempt, 'score'), grade.rewardScore)
    && close(metric(attempt, 'caseScore', 'cumulativeCaseScore'), grade.cumulativeCaseScore)
    && metric(attempt, 'historicalRequirementRegressions') === regressions.size
    && metric(attempt, 'hardRequirementsMissed') === 9 - reward
}

function validNativeAttempt(attempt) {
  return attempt?.status === 'completed'
    && attempt?.budgetWithinLimits === true
    && validateProductGrade(attempt)
    && validScore(metric(attempt, 'score'))
    && validScore(metric(attempt, 'caseScore', 'cumulativeCaseScore'))
    && Number.isInteger(metric(attempt, 'historicalRequirementRegressions'))
    && metric(attempt, 'historicalRequirementRegressions') >= 0
    && Number.isInteger(metric(attempt, 'inputTokens'))
    && metric(attempt, 'inputTokens') > 0
}

function validCandidateAttempt(attempt) {
  return validNativeAttempt(attempt)
    && Number.isInteger(metric(attempt, 'hardRequirementsMissed'))
    && metric(attempt, 'hardRequirementsMissed') >= 0
    && typeof attempt?.trace?.valid === 'boolean'
}

function ratio(numerator, denominator) {
  return finite(numerator) && finite(denominator) && denominator > 0
    ? numerator / denominator
    : null
}

function normalizeAttempts(input) {
  if (Array.isArray(input?.attempts)) return input.attempts
  const nativeAttempts = Array.isArray(input?.nativeAttempts) ? input.nativeAttempts : []
  return input?.candidateAttempt == null
    ? nativeAttempts
    : [...nativeAttempts, input.candidateAttempt]
}

export function analyzeV24(input) {
  if (!input || typeof input !== 'object') throw new Error('V24 analysis requires a result object')
  const attempts = normalizeAttempts(input)
  const nativeAttempts = attempts.filter(attempt => attempt?.arm === 'native')
  const candidateAttempts = attempts.filter(attempt => attempt?.arm === 'v0.4-native-continuity')
  const unknownArms = attempts.filter(attempt => !['native', 'v0.4-native-continuity'].includes(attempt?.arm))

  const nativeScores = nativeAttempts.map(attempt => metric(attempt, 'score'))
  const nativeCaseScores = nativeAttempts.map(attempt => metric(attempt, 'caseScore', 'cumulativeCaseScore'))
  const nativeRegressions = nativeAttempts.map(attempt => metric(attempt, 'historicalRequirementRegressions'))
  const nativeInputTokens = nativeAttempts.map(attempt => metric(attempt, 'inputTokens'))
  const nativeMedianScore = median(nativeScores)
  const nativeMedianCaseScore = median(nativeCaseScores)
  const nativeMedianRegressions = median(nativeRegressions)
  const nativeMedianInputTokens = median(nativeInputTokens)
  const nativeScoreSpread = nativeScores.length > 0 && nativeScores.every(finite)
    ? Math.max(...nativeScores) - Math.min(...nativeScores)
    : null

  const qualificationGates = [
    gate('exactly five native calibrations are retained',
      nativeAttempts.length === V24_THRESHOLDS.requiredNativeAttempts,
      nativeAttempts.length, V24_THRESHOLDS.requiredNativeAttempts),
    gate('native calibrations contain complete valid metrics',
      nativeAttempts.length === V24_THRESHOLDS.requiredNativeAttempts
        && nativeAttempts.every(validNativeAttempt),
      nativeAttempts.map(attempt => ({ id: attempt?.id ?? null, status: attempt?.status ?? null })),
      'five completed attempts with valid score, case score, regressions, and input tokens'),
    gate('no unregistered arm is retained',
      unknownArms.length === 0,
      unknownArms.map(attempt => attempt?.arm ?? null), []),
    gate('every native score is below the ceiling',
      nativeScores.length === V24_THRESHOLDS.requiredNativeAttempts
        && nativeScores.every(score => validScore(score) && score < V24_THRESHOLDS.maximumNativeScoreExclusive),
      nativeScores, `each < ${V24_THRESHOLDS.maximumNativeScoreExclusive}`),
    gate('native median score is at or below the ceiling',
      finite(nativeMedianScore) && nativeMedianScore <= V24_THRESHOLDS.maximumNativeMedianScore,
      nativeMedianScore, `<= ${V24_THRESHOLDS.maximumNativeMedianScore}`),
    gate('native score spread is within the stability bound',
      finite(nativeScoreSpread) && nativeScoreSpread <= V24_THRESHOLDS.maximumNativeScoreSpread,
      nativeScoreSpread, `<= ${V24_THRESHOLDS.maximumNativeScoreSpread}`),
    gate('native median leaves the preregistered relative uplift mathematically reachable',
      finite(nativeMedianScore)
        && nativeMedianScore <= V24_THRESHOLDS.maximumNativeMedianForCandidateReachability,
      nativeMedianScore,
      `<= ${V24_THRESHOLDS.maximumNativeMedianForCandidateReachability}`),
    gate('native history contains enough regressions for the reduction claim to be measurable',
      finite(nativeMedianRegressions)
        && nativeMedianRegressions >= V24_THRESHOLDS.minimumNativeMedianRegressionsForCandidateReachability,
      nativeMedianRegressions,
      `>= ${V24_THRESHOLDS.minimumNativeMedianRegressionsForCandidateReachability}`),
  ]
  const candidateExecutionAllowed = qualificationGates.every(entry => entry.passed)

  const candidate = candidateAttempts.length === 1 ? candidateAttempts[0] : undefined
  const candidateScore = metric(candidate, 'score')
  const candidateCaseScore = metric(candidate, 'caseScore', 'cumulativeCaseScore')
  const candidateRegressions = metric(candidate, 'historicalRequirementRegressions')
  const candidateInputTokens = metric(candidate, 'inputTokens')
  const scoreDelta = finite(candidateScore) && finite(nativeMedianScore)
    ? candidateScore - nativeMedianScore
    : null
  const relativeScoreImprovement = ratio(scoreDelta, nativeMedianScore)
  const historicalRequirementRegressionReduction = finite(nativeMedianRegressions)
    && nativeMedianRegressions > 0
    && finite(candidateRegressions)
    ? (nativeMedianRegressions - candidateRegressions) / nativeMedianRegressions
    : null
  const inputTokenRatio = ratio(candidateInputTokens, nativeMedianInputTokens)

  const candidateGates = [
    gate('exactly one candidate result is retained',
      candidateAttempts.length === 1,
      candidateAttempts.length, 1),
    gate('candidate execution was authorized by native calibration',
      candidateExecutionAllowed,
      candidateExecutionAllowed, true),
    gate('candidate result contains complete valid metrics and trace verdict',
      candidateAttempts.length === 1 && validCandidateAttempt(candidate),
      candidate == null ? null : { status: candidate.status, traceValid: candidate.trace?.valid ?? null },
      'one completed candidate with valid metrics and trace verdict'),
    gate('candidate absolute score improvement reaches the minimum',
      finite(scoreDelta) && scoreDelta >= V24_THRESHOLDS.minimumCandidateAbsoluteScoreImprovement,
      scoreDelta, `>= ${V24_THRESHOLDS.minimumCandidateAbsoluteScoreImprovement}`),
    gate('candidate relative score improvement reaches the minimum',
      finite(relativeScoreImprovement)
        && relativeScoreImprovement >= V24_THRESHOLDS.minimumCandidateRelativeScoreImprovement,
      relativeScoreImprovement, `>= ${V24_THRESHOLDS.minimumCandidateRelativeScoreImprovement}`),
    gate('candidate case score does not regress',
      finite(candidateCaseScore) && finite(nativeMedianCaseScore)
        && candidateCaseScore >= nativeMedianCaseScore,
      { nativeMedian: nativeMedianCaseScore, candidate: candidateCaseScore ?? null },
      'candidate >= native median'),
    gate('candidate historical requirement regressions fall by at least half',
      finite(historicalRequirementRegressionReduction)
        && historicalRequirementRegressionReduction >= V24_THRESHOLDS.minimumHistoricalRequirementRegressionReduction,
      historicalRequirementRegressionReduction,
      `>= ${V24_THRESHOLDS.minimumHistoricalRequirementRegressionReduction}`),
    gate('candidate has no hard requirement miss',
      metric(candidate, 'hardRequirementsMissed') === V24_THRESHOLDS.maximumCandidateHardRequirementsMissed,
      metric(candidate, 'hardRequirementsMissed') ?? null,
      V24_THRESHOLDS.maximumCandidateHardRequirementsMissed),
    gate('candidate trace audit is valid',
      candidate?.trace?.valid === true,
      candidate?.trace?.valid ?? null, true),
    gate('candidate input remains within the paired token bound',
      finite(inputTokenRatio) && inputTokenRatio <= V24_THRESHOLDS.maximumCandidateInputTokenRatio,
      inputTokenRatio, `<= ${V24_THRESHOLDS.maximumCandidateInputTokenRatio}`),
  ]
  const candidatePassed = candidateGates.every(entry => entry.passed)
  const releaseAllowed = candidateExecutionAllowed && candidatePassed

  return {
    schemaVersion: 1,
    protocolId: input.protocolId ?? 'dsh-plan-lattice-v24',
    thresholds: V24_THRESHOLDS,
    candidateExecutionAllowed,
    releaseAllowed,
    comparison: {
      nativeScores,
      nativeMedianScore,
      nativeScoreSpread,
      nativeMedianCaseScore,
      nativeMedianHistoricalRequirementRegressions: nativeMedianRegressions,
      nativeMedianInputTokens,
      candidateScore: candidateScore ?? null,
      candidateCaseScore: candidateCaseScore ?? null,
      candidateHistoricalRequirementRegressions: candidateRegressions ?? null,
      scoreDelta,
      relativeScoreImprovement,
      historicalRequirementRegressionReduction,
      inputTokenRatio,
    },
    qualification: {
      passed: candidateExecutionAllowed,
      gates: qualificationGates,
    },
    candidate: {
      executed: candidateAttempts.length > 0,
      passed: candidatePassed,
      gates: candidateGates,
    },
    statement: releaseAllowed
      ? 'All preregistered V24 qualification and candidate gates passed; the frozen result may be released.'
      : candidateExecutionAllowed
        ? 'Native qualification passed, but release remains blocked until every candidate gate passes.'
        : 'Native qualification failed; candidate execution and release are prohibited.',
  }
}
