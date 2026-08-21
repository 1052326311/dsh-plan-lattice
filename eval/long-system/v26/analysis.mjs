import { budgetSnapshotWithinLimits } from '../../pilots/driver/budget-proxy.mjs'
import {
  ATTEMPT_BUDGET_TERMINAL,
  budgetMatchesSession,
  budgetTerminalEvidence,
} from './budget-terminal.mjs'

export const V26_PROTOCOL_ID = 'plan-lattice-rc7-evocode-jobforge-v26'

export const V26_THRESHOLDS = Object.freeze({
  requiredNativeAttempts: 5,
  maximumNativeScoreExclusive: 90,
  maximumNativeMedianScore: 85,
  maximumNativeScoreSpread: 15,
  minimumCandidateAbsoluteScoreImprovement: 15,
  minimumCandidateRemainingGapClosed: 0.30,
  minimumHistoricalRequirementRegressionReduction: 0.50,
  maximumCandidateHardRequirementsMissed: 0,
  maximumCandidatePrematureTaskTerminals: 0,
  maximumCandidateInputTokenRatio: 1.10,
  minimumNativeMedianMaxTokenProductTerminals: 1,
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

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateAttemptEvidence(attempt) {
  const outcomes = attempt?.evidence?.terminalOutcomes
  if (!Array.isArray(outcomes) || outcomes.length < 1) return false
  const noncompleted = outcomes.filter(item => item?.terminalKind !== 'completed')
  const maxTokenProductTerminals = outcomes.filter(item => (
    item?.kind === 'product' && item?.terminalKind === 'max-tokens'
  )).length
  const attemptBudgetTerminals = outcomes.filter(item => (
    item?.terminalKind === ATTEMPT_BUDGET_TERMINAL
  )).length
  if (noncompleted.length > 1
    || metric(attempt, 'maxTokenProductTerminals') !== maxTokenProductTerminals
    || metric(attempt, 'attemptBudgetTerminals') !== attemptBudgetTerminals
    || metric(attempt, 'prematureTaskTerminals') !== noncompleted.length) return false

  const outcome = attempt?.evidence?.outcome
  if (noncompleted.length === 0) {
    if (outcome?.class !== 'completed' || outcome?.terminalKind !== 'completed') return false
  } else if (outcome?.class !== 'premature-terminal'
    || outcome?.terminalKind !== noncompleted[0]?.terminalKind
    || outcome?.stageId !== noncompleted[0]?.stageId) return false

  const budget = attempt?.budget
  if (!budgetMatchesSession(budget, attempt?.metrics)
    || budget?.attemptId !== attempt?.id
    || budget?.upstreamHttp429 !== 0
    || budget?.upstreamTransportErrors !== 0
    || budget?.missingUsageResponses !== 0) return false
  const receipts = attempt?.evidence?.budgetTerminalReceipts
  if (!Array.isArray(receipts)) return false
  if (attemptBudgetTerminals === 0) {
    return receipts.length === 0
      && budget?.budgetRejections === 0
      && budget?.localBudgetRejections === 0
      && budget?.firstBudgetRejection === null
      && budgetSnapshotWithinLimits(budget)
  }
  const terminal = budgetTerminalEvidence(budget, attempt.id, undefined)
  return attemptBudgetTerminals === 1
    && terminal !== null
    && receipts.length === 1
    && receipts[0]?.terminalId === terminal.terminalId
    && receipts[0]?.attemptId === terminal.attemptId
    && receipts[0]?.sessionId === terminal.sessionId
    && receipts[0]?.requestSequence === terminal.requestSequence
    && same(receipts[0]?.exhausted, terminal.exhausted)
    && /^[0-9a-f]{64}$/.test(receipts[0]?.receiptDigest ?? '')
}

function validateProductGrade(attempt) {
  const grade = attempt?.productGrade
  if (!grade || typeof grade !== 'object' || !Array.isArray(grade.rounds) || grade.rounds.length !== 9) return false
  const previous = new Map()
  const regressions = new Set()
  let reward = 0
  let caseRatio = 0
  let reachedRounds = 0
  let sawUnreachedRound = false
  for (const [index, round] of grade.rounds.entries()) {
    if (round?.round !== index + 1 || (round.reward !== 0 && round.reward !== 1)
      || !Number.isInteger(round.total)
      || !Number.isInteger(round.successes) || !Number.isInteger(round.failures)
      || round.total !== round.successes + round.failures
      || !Array.isArray(round.cases) || round.cases.length !== round.total) return false
    if (round.reached === false) {
      sawUnreachedRound = true
      if (round.reward !== 0 || round.total !== 0 || round.successes !== 0 || round.failures !== 0
        || round.caseRatio !== 0 || round.summaryPresent !== false || round.cases.length !== 0) return false
      continue
    }
    if (round.reached !== true || sawUnreachedRound || round.total <= 0) return false
    reachedRounds += 1
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
    && grade.reachedRounds === reachedRounds
    && reachedRounds >= 1
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
    && validateAttemptEvidence(attempt)
    && validateProductGrade(attempt)
    && validScore(metric(attempt, 'score'))
    && validScore(metric(attempt, 'caseScore', 'cumulativeCaseScore'))
    && Number.isInteger(metric(attempt, 'historicalRequirementRegressions'))
    && metric(attempt, 'historicalRequirementRegressions') >= 0
    && Number.isInteger(metric(attempt, 'inputTokens'))
    && metric(attempt, 'inputTokens') > 0
    && Number.isInteger(metric(attempt, 'maxTokenProductTerminals'))
    && metric(attempt, 'maxTokenProductTerminals') >= 0
    && metric(attempt, 'maxTokenProductTerminals') <= 1
    && Number.isInteger(metric(attempt, 'prematureTaskTerminals'))
    && metric(attempt, 'prematureTaskTerminals') >= 0
    && metric(attempt, 'prematureTaskTerminals') <= 1
    && Number.isInteger(metric(attempt, 'attemptBudgetTerminals'))
    && metric(attempt, 'attemptBudgetTerminals') >= 0
    && metric(attempt, 'attemptBudgetTerminals') <= 1
    && metric(attempt, 'maxTokenProductTerminals')
      + metric(attempt, 'attemptBudgetTerminals')
      <= metric(attempt, 'prematureTaskTerminals')
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

export function analyzeV26(input) {
  if (!input || typeof input !== 'object') throw new Error('V26 analysis requires a result object')
  const attempts = normalizeAttempts(input)
  const nativeAttempts = attempts.filter(attempt => attempt?.arm === 'native')
  const candidateAttempts = attempts.filter(attempt => attempt?.arm === 'v0.4-native-continuity')
  const unknownArms = attempts.filter(attempt => !['native', 'v0.4-native-continuity'].includes(attempt?.arm))
  const uniqueAttemptIds = new Set(attempts.map(attempt => attempt?.id))
  const orderedArms = attempts.map(attempt => attempt?.arm)
  const expectedArms = [
    ...Array(Math.min(attempts.length, V26_THRESHOLDS.requiredNativeAttempts)).fill('native'),
    ...(attempts.length > V26_THRESHOLDS.requiredNativeAttempts ? ['v0.4-native-continuity'] : []),
  ]

  const nativeScores = nativeAttempts.map(attempt => metric(attempt, 'score'))
  const nativeCaseScores = nativeAttempts.map(attempt => metric(attempt, 'caseScore', 'cumulativeCaseScore'))
  const nativeRegressions = nativeAttempts.map(attempt => metric(attempt, 'historicalRequirementRegressions'))
  const nativeInputTokens = nativeAttempts.map(attempt => metric(attempt, 'inputTokens'))
  const nativeMaxTokenProductTerminals = nativeAttempts
    .map(attempt => metric(attempt, 'maxTokenProductTerminals'))
  const nativeMedianScore = median(nativeScores)
  const nativeMedianCaseScore = median(nativeCaseScores)
  const nativeMedianRegressions = median(nativeRegressions)
  const nativeMedianInputTokens = median(nativeInputTokens)
  const nativeMedianMaxTokenProductTerminals = median(nativeMaxTokenProductTerminals)
  const nativeScoreSpread = nativeScores.length > 0 && nativeScores.every(finite)
    ? Math.max(...nativeScores) - Math.min(...nativeScores)
    : null

  const qualificationGates = [
    gate('report uses the exact frozen V26 protocol',
      input.protocolId === V26_PROTOCOL_ID,
      input.protocolId ?? null, V26_PROTOCOL_ID),
    gate('attempt IDs are unique and arms follow the preregistered order',
      attempts.length <= V26_THRESHOLDS.requiredNativeAttempts + 1
        && uniqueAttemptIds.size === attempts.length
        && attempts.every(attempt => typeof attempt?.id === 'string' && attempt.id.length >= 8)
        && same(orderedArms, expectedArms),
      { ids: attempts.map(attempt => attempt?.id ?? null), arms: orderedArms },
      'five native attempts followed by at most one candidate'),
    gate('exactly five native calibrations are retained',
      nativeAttempts.length === V26_THRESHOLDS.requiredNativeAttempts,
      nativeAttempts.length, V26_THRESHOLDS.requiredNativeAttempts),
    gate('native calibrations contain complete valid metrics',
      nativeAttempts.length === V26_THRESHOLDS.requiredNativeAttempts
        && nativeAttempts.every(validNativeAttempt),
      nativeAttempts.map(attempt => ({ id: attempt?.id ?? null, status: attempt?.status ?? null })),
      'five completed attempts with valid score, case score, regressions, and input tokens'),
    gate('no unregistered arm is retained',
      unknownArms.length === 0,
      unknownArms.map(attempt => attempt?.arm ?? null), []),
    gate('every native score is below the ceiling',
      nativeScores.length === V26_THRESHOLDS.requiredNativeAttempts
        && nativeScores.every(score => validScore(score) && score < V26_THRESHOLDS.maximumNativeScoreExclusive),
      nativeScores, `each < ${V26_THRESHOLDS.maximumNativeScoreExclusive}`),
    gate('native median score is at or below the ceiling',
      finite(nativeMedianScore) && nativeMedianScore <= V26_THRESHOLDS.maximumNativeMedianScore,
      nativeMedianScore, `<= ${V26_THRESHOLDS.maximumNativeMedianScore}`),
    gate('native score spread is within the stability bound',
      finite(nativeScoreSpread) && nativeScoreSpread <= V26_THRESHOLDS.maximumNativeScoreSpread,
      nativeScoreSpread, `<= ${V26_THRESHOLDS.maximumNativeScoreSpread}`),
    gate('native median reproduces at least one max-token product terminal',
      finite(nativeMedianMaxTokenProductTerminals)
        && nativeMedianMaxTokenProductTerminals
          >= V26_THRESHOLDS.minimumNativeMedianMaxTokenProductTerminals,
      nativeMedianMaxTokenProductTerminals,
      `>= ${V26_THRESHOLDS.minimumNativeMedianMaxTokenProductTerminals}`),
  ]
  const candidateExecutionAllowed = qualificationGates.every(entry => entry.passed)

  const candidate = candidateAttempts.length === 1 ? candidateAttempts[0] : undefined
  const candidateScore = metric(candidate, 'score')
  const candidateCaseScore = metric(candidate, 'caseScore', 'cumulativeCaseScore')
  const candidateRegressions = metric(candidate, 'historicalRequirementRegressions')
  const candidateInputTokens = metric(candidate, 'inputTokens')
  const candidateMaxTokenProductTerminals = metric(candidate, 'maxTokenProductTerminals')
  const candidatePrematureTaskTerminals = metric(candidate, 'prematureTaskTerminals')
  const scoreDelta = finite(candidateScore) && finite(nativeMedianScore)
    ? candidateScore - nativeMedianScore
    : null
  const remainingGapClosed = finite(scoreDelta) && finite(nativeMedianScore) && nativeMedianScore < 100
    ? scoreDelta / (100 - nativeMedianScore)
    : null
  const historicalRequirementRegressionReduction = finite(nativeMedianRegressions)
    && nativeMedianRegressions > 0
    && finite(candidateRegressions)
    ? (nativeMedianRegressions - candidateRegressions) / nativeMedianRegressions
    : null
  const inputTokenRatio = ratio(candidateInputTokens, nativeMedianInputTokens)
  const historicalRegressionGatePassed = nativeMedianRegressions === 0
    ? candidateRegressions === 0
    : finite(historicalRequirementRegressionReduction)
      && historicalRequirementRegressionReduction
        >= V26_THRESHOLDS.minimumHistoricalRequirementRegressionReduction

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
      finite(scoreDelta) && scoreDelta >= V26_THRESHOLDS.minimumCandidateAbsoluteScoreImprovement,
      scoreDelta, `>= ${V26_THRESHOLDS.minimumCandidateAbsoluteScoreImprovement}`),
    gate('candidate closes the minimum share of the remaining score gap',
      finite(remainingGapClosed)
        && remainingGapClosed >= V26_THRESHOLDS.minimumCandidateRemainingGapClosed,
      remainingGapClosed, `>= ${V26_THRESHOLDS.minimumCandidateRemainingGapClosed}`),
    gate('candidate case score does not regress',
      finite(candidateCaseScore) && finite(nativeMedianCaseScore)
        && candidateCaseScore >= nativeMedianCaseScore,
      { nativeMedian: nativeMedianCaseScore, candidate: candidateCaseScore ?? null },
      'candidate >= native median'),
    gate('candidate halves measurable historical regressions or preserves a zero baseline',
      historicalRegressionGatePassed,
      {
        nativeMedian: nativeMedianRegressions,
        candidate: candidateRegressions ?? null,
        reduction: historicalRequirementRegressionReduction,
      },
      nativeMedianRegressions === 0
        ? 'candidate regressions = 0'
        : `reduction >= ${V26_THRESHOLDS.minimumHistoricalRequirementRegressionReduction}`),
    gate('candidate has no hard requirement miss',
      metric(candidate, 'hardRequirementsMissed') === V26_THRESHOLDS.maximumCandidateHardRequirementsMissed,
      metric(candidate, 'hardRequirementsMissed') ?? null,
      V26_THRESHOLDS.maximumCandidateHardRequirementsMissed),
    gate('candidate has no premature task terminal',
      candidatePrematureTaskTerminals
        === V26_THRESHOLDS.maximumCandidatePrematureTaskTerminals,
      candidatePrematureTaskTerminals ?? null,
      V26_THRESHOLDS.maximumCandidatePrematureTaskTerminals),
    gate('candidate trace audit is valid',
      candidate?.trace?.valid === true,
      candidate?.trace?.valid ?? null, true),
    gate('candidate input remains within the paired token bound',
      finite(inputTokenRatio) && inputTokenRatio <= V26_THRESHOLDS.maximumCandidateInputTokenRatio,
      inputTokenRatio, `<= ${V26_THRESHOLDS.maximumCandidateInputTokenRatio}`),
  ]
  const candidatePassed = candidateGates.every(entry => entry.passed)
  const releaseAllowed = candidateExecutionAllowed && candidatePassed

  return {
    schemaVersion: 1,
    protocolId: input.protocolId ?? null,
    thresholds: V26_THRESHOLDS,
    candidateExecutionAllowed,
    releaseAllowed,
    comparison: {
      nativeScores,
      nativeMedianScore,
      nativeScoreSpread,
      nativeMedianCaseScore,
      nativeMedianHistoricalRequirementRegressions: nativeMedianRegressions,
      nativeMedianInputTokens,
      nativeMedianMaxTokenProductTerminals,
      candidateScore: candidateScore ?? null,
      candidateCaseScore: candidateCaseScore ?? null,
      candidateHistoricalRequirementRegressions: candidateRegressions ?? null,
      scoreDelta,
      remainingGapClosed,
      historicalRequirementRegressionReduction,
      candidateMaxTokenProductTerminals: candidateMaxTokenProductTerminals ?? null,
      candidatePrematureTaskTerminals: candidatePrematureTaskTerminals ?? null,
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
      ? 'All preregistered V26 qualification and candidate gates passed; the frozen result may be released.'
      : candidateExecutionAllowed
        ? 'Native qualification passed, but release remains blocked until every candidate gate passes.'
        : 'Native qualification failed; candidate execution and release are prohibited.',
  }
}
