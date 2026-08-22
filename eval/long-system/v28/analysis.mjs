import { budgetSnapshotWithinLimits } from '../../pilots/driver/budget-proxy.mjs'
import { canonicalJson } from '../../v0.4/lib/canonical.mjs'
import {
  ATTEMPT_BUDGET_TERMINAL,
  budgetMatchesSession,
  budgetTerminalEvidence,
  retainedResponseBudgetCrossing,
} from './budget-terminal.mjs'

export const V28_PROTOCOL_ID = 'plan-lattice-rc7-evocode-jobforge-v28'

const PAIR_ORDERS = Object.freeze([
  'native-first', 'candidate-first', 'native-first', 'candidate-first',
  'candidate-first', 'native-first', 'candidate-first', 'native-first',
  'native-first', 'candidate-first', 'candidate-first', 'native-first',
])

export const V28_EXECUTION_PLAN = Object.freeze(PAIR_ORDERS.flatMap((order, index) => {
  const pair = index + 1
  const arms = order === 'native-first'
    ? ['native', 'v0.4-native-continuity']
    : ['v0.4-native-continuity', 'native']
  return arms.map(arm => Object.freeze({
    pair,
    arm,
    label: `pair-${pair}-${arm === 'native' ? 'native' : 'candidate'}`,
  }))
}))

export const V28_THRESHOLDS = Object.freeze({
  requiredPairs: 12,
  requiredAttemptsPerArm: 12,
  maximumNativeMedianScore: 85,
  maximumNativeFullCompletions: 4,
  minimumCandidateMedianAbsoluteScoreImprovement: 15,
  minimumCandidateMedianRemainingGapClosed: 0.30,
  minimumCandidateFullCompletions: 10,
  minimumCandidateCleanTerminals: 10,
  minimumCompletionRateDelta: 0.50,
  maximumCompletionMcNemarP: 0.025,
  minimumMeanContinuityDepthDelta: 4,
  minimumContinuityPairWins: 10,
  maximumContinuitySignFlipP: 0.025,
  minimumContinuityBootstrapLower: 2,
  minimumCandidateMedianScore: 100,
  minimumMeanScoreDelta: 30,
  minimumMeanCaseScoreDelta: 20,
  minimumCaseScoreBootstrapLowerExclusive: 0,
  maximumCandidateHistoricalRegressions: 0,
  maximumCompletedCandidateInvalidTraces: 0,
  bootstrapSamples: 100_000,
  bootstrapSeed: 0x27a11ce,
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

function mean(values) {
  return values.length > 0 && values.every(finite)
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function binomialCoefficient(n, k) {
  const reduced = Math.min(k, n - k)
  let value = 1
  for (let index = 1; index <= reduced; index += 1) {
    value = value * (n - reduced + index) / index
  }
  return value
}

function oneSidedMcNemar(improved, worsened) {
  const discordant = improved + worsened
  if (discordant === 0) return 1
  let tail = 0
  for (let successes = improved; successes <= discordant; successes += 1) {
    tail += binomialCoefficient(discordant, successes)
  }
  return tail / (2 ** discordant)
}

function pairedSignFlipP(deltas) {
  if (deltas.length === 0 || deltas.some(value => !finite(value))) return null
  const observed = mean(deltas)
  let atLeastObserved = 0
  const permutations = 2 ** deltas.length
  for (let mask = 0; mask < permutations; mask += 1) {
    let total = 0
    for (let index = 0; index < deltas.length; index += 1) {
      total += (mask & (2 ** index)) === 0 ? deltas[index] : -deltas[index]
    }
    if (total / deltas.length >= observed - 1e-12) atLeastObserved += 1
  }
  return atLeastObserved / permutations
}

function bootstrapMeanInterval(values, seed) {
  if (values.length === 0 || values.some(value => !finite(value))) return null
  let state = seed >>> 0
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  const means = new Array(V28_THRESHOLDS.bootstrapSamples)
  for (let sample = 0; sample < means.length; sample += 1) {
    let total = 0
    for (let draw = 0; draw < values.length; draw += 1) total += values[next() % values.length]
    means[sample] = total / values.length
  }
  means.sort((left, right) => left - right)
  return {
    lower: means[Math.floor(0.025 * (means.length - 1))],
    median: means[Math.floor(0.5 * (means.length - 1))],
    upper: means[Math.floor(0.975 * (means.length - 1))],
  }
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
  return canonicalJson(left) === canonicalJson(right)
}

function validateAttemptEvidence(attempt) {
  const outcomes = attempt?.evidence?.terminalOutcomes
  if (!Array.isArray(outcomes) || outcomes.length < 1) return false
  const productOutcomes = outcomes.filter(item => item?.kind === 'product')
  if (productOutcomes.length < 1 || productOutcomes.length > 9
    || productOutcomes.some((item, index) => item?.stageId !== `round-${index + 1}`)
    || productOutcomes.slice(0, -1).some(item => item?.terminalKind !== 'completed')) return false
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
    const finalCrossing = outcome?.class === 'completed'
      ? retainedResponseBudgetCrossing(budget)
      : null
    return receipts.length === 0
      && budget?.budgetRejections === 0
      && budget?.localBudgetRejections === 0
      && budget?.firstBudgetRejection === null
      && (budgetSnapshotWithinLimits(budget) || finalCrossing !== null)
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

function continuityDepth(attempt) {
  const outcomes = attempt?.evidence?.terminalOutcomes
  if (!Array.isArray(outcomes)) return null
  return outcomes.filter(item => item?.kind === 'product' && item?.terminalKind === 'completed').length
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

export function analyzeV28(input) {
  if (!input || typeof input !== 'object') throw new Error('V28 analysis requires a result object')
  const attempts = normalizeAttempts(input)
  const nativeAttempts = attempts.filter(attempt => attempt?.arm === 'native')
  const candidateAttempts = attempts.filter(attempt => attempt?.arm === 'v0.4-native-continuity')
  const unknownArms = attempts.filter(attempt => !['native', 'v0.4-native-continuity'].includes(attempt?.arm))
  const uniqueAttemptIds = new Set(attempts.map(attempt => attempt?.id))
  const observedOrder = attempts.map(attempt => attempt?.arm)
  const expectedPrefix = V28_EXECUTION_PLAN.slice(0, attempts.length).map(entry => entry.arm)
  const protocolMatches = input.protocolId === V28_PROTOCOL_ID
  const legalPrefix = attempts.length <= V28_EXECUTION_PLAN.length
    && uniqueAttemptIds.size === attempts.length
    && attempts.every(attempt => typeof attempt?.id === 'string' && attempt.id.length >= 8)
    && same(observedOrder, expectedPrefix)
    && unknownArms.length === 0

  const nativeScores = nativeAttempts.map(attempt => metric(attempt, 'score'))
  const nativeCaseScores = nativeAttempts.map(attempt => metric(attempt, 'caseScore', 'cumulativeCaseScore'))
  const nativeRegressions = nativeAttempts.map(attempt => metric(attempt, 'historicalRequirementRegressions'))
  const nativeInputTokens = nativeAttempts.map(attempt => metric(attempt, 'inputTokens'))
  const candidateScores = candidateAttempts.map(attempt => metric(attempt, 'score'))
  const candidateCaseScores = candidateAttempts.map(attempt => metric(attempt, 'caseScore', 'cumulativeCaseScore'))
  const candidateRegressions = candidateAttempts.map(attempt => metric(attempt, 'historicalRequirementRegressions'))
  const candidateInputTokens = candidateAttempts.map(attempt => metric(attempt, 'inputTokens'))
  const nativeMedianScore = median(nativeScores)
  const nativeMedianCaseScore = median(nativeCaseScores)
  const nativeMedianRegressions = median(nativeRegressions)
  const nativeMedianInputTokens = median(nativeInputTokens)
  const candidateMedianScore = median(candidateScores)
  const candidateMedianCaseScore = median(candidateCaseScores)
  const candidateMedianRegressions = median(candidateRegressions)
  const candidateMedianInputTokens = median(candidateInputTokens)
  const nativeScoreSpread = nativeScores.length > 0 && nativeScores.every(finite)
    ? Math.max(...nativeScores) - Math.min(...nativeScores)
    : null
  const candidateScoreSpread = candidateScores.length > 0 && candidateScores.every(finite)
    ? Math.max(...candidateScores) - Math.min(...candidateScores)
    : null

  const qualificationGates = [
    gate('report uses the exact frozen V28 protocol',
      protocolMatches,
      input.protocolId ?? null, V28_PROTOCOL_ID),
    gate('attempts are a legal prefix of the preregistered AB/BA plan',
      legalPrefix,
      { ids: attempts.map(attempt => attempt?.id ?? null), arms: observedOrder },
      V28_EXECUTION_PLAN.map(entry => entry.arm)),
  ]
  const candidateExecutionAllowed = qualificationGates.every(entry => entry.passed)

  const scoreDelta = finite(candidateMedianScore) && finite(nativeMedianScore)
    ? candidateMedianScore - nativeMedianScore
    : null
  const remainingGapClosed = finite(scoreDelta) && finite(nativeMedianScore) && nativeMedianScore < 100
    ? scoreDelta / (100 - nativeMedianScore)
    : null
  const inputTokenRatio = ratio(candidateMedianInputTokens, nativeMedianInputTokens)
  const fullCompletion = attempt => metric(attempt, 'score') === 100
    && metric(attempt, 'hardRequirementsMissed') === 0
    && attempt?.productGrade?.reachedRounds === 9
    && metric(attempt, 'prematureTaskTerminals') === 0
    && attempt?.evidence?.outcome?.class === 'completed'
  const nativeFullCompletions = nativeAttempts.filter(fullCompletion).length
  const candidateFullCompletions = candidateAttempts.filter(fullCompletion).length
  const candidateCleanTerminals = candidateAttempts
    .filter(attempt => metric(attempt, 'prematureTaskTerminals') === 0).length
  const completedCandidateInvalidTraces = candidateAttempts
    .filter(attempt => fullCompletion(attempt) && attempt?.trace?.valid !== true).length
  const pairs = Array.from({ length: V28_THRESHOLDS.requiredPairs }, (_, index) => {
    const pair = index + 1
    const entries = attempts.filter((_, attemptIndex) => V28_EXECUTION_PLAN[attemptIndex]?.pair === pair)
    const native = entries.find(attempt => attempt?.arm === 'native')
    const candidate = entries.find(attempt => attempt?.arm === 'v0.4-native-continuity')
    const nativeScore = metric(native, 'score')
    const candidateScore = metric(candidate, 'score')
    const nativeCaseScore = metric(native, 'caseScore', 'cumulativeCaseScore')
    const candidateCaseScore = metric(candidate, 'caseScore', 'cumulativeCaseScore')
    const nativeDepth = continuityDepth(native)
    const candidateDepth = continuityDepth(candidate)
    return {
      pair,
      nativeScore: nativeScore ?? null,
      candidateScore: candidateScore ?? null,
      scoreDelta: finite(nativeScore) && finite(candidateScore) ? candidateScore - nativeScore : null,
      nativeCaseScore: nativeCaseScore ?? null,
      candidateCaseScore: candidateCaseScore ?? null,
      caseScoreDelta: finite(nativeCaseScore) && finite(candidateCaseScore)
        ? candidateCaseScore - nativeCaseScore
        : null,
      nativeContinuityDepth: nativeDepth,
      candidateContinuityDepth: candidateDepth,
      continuityDepthDelta: finite(nativeDepth) && finite(candidateDepth)
        ? candidateDepth - nativeDepth
        : null,
      nativeFullCompletion: fullCompletion(native),
      candidateFullCompletion: fullCompletion(candidate),
    }
  })
  const completePairMatrix = attempts.length === V28_EXECUTION_PLAN.length
    && pairs.every(entry => finite(entry.scoreDelta)
      && finite(entry.caseScoreDelta) && finite(entry.continuityDepthDelta))
  const scoreDeltas = pairs.map(entry => entry.scoreDelta)
  const caseScoreDeltas = pairs.map(entry => entry.caseScoreDelta)
  const continuityDepthDeltas = pairs.map(entry => entry.continuityDepthDelta)
  const meanScoreDelta = completePairMatrix ? mean(scoreDeltas) : null
  const meanCaseScoreDelta = completePairMatrix ? mean(caseScoreDeltas) : null
  const meanContinuityDepthDelta = completePairMatrix ? mean(continuityDepthDeltas) : null
  const continuityPairWins = completePairMatrix
    ? continuityDepthDeltas.filter(value => value > 0).length
    : null
  const improvedCompletions = completePairMatrix
    ? pairs.filter(entry => entry.candidateFullCompletion && !entry.nativeFullCompletion).length
    : null
  const worsenedCompletions = completePairMatrix
    ? pairs.filter(entry => entry.nativeFullCompletion && !entry.candidateFullCompletion).length
    : null
  const nativeCompletionRate = completePairMatrix
    ? nativeFullCompletions / V28_THRESHOLDS.requiredPairs
    : null
  const candidateCompletionRate = completePairMatrix
    ? candidateFullCompletions / V28_THRESHOLDS.requiredPairs
    : null
  const completionRateDelta = finite(nativeCompletionRate) && finite(candidateCompletionRate)
    ? candidateCompletionRate - nativeCompletionRate
    : null
  const completionMcNemarP = completePairMatrix
    ? oneSidedMcNemar(improvedCompletions, worsenedCompletions)
    : null
  const continuitySignFlipP = completePairMatrix
    ? pairedSignFlipP(continuityDepthDeltas)
    : null
  const continuityBootstrap = completePairMatrix
    ? bootstrapMeanInterval(continuityDepthDeltas, V28_THRESHOLDS.bootstrapSeed)
    : null
  const caseScoreBootstrap = completePairMatrix
    ? bootstrapMeanInterval(caseScoreDeltas, V28_THRESHOLDS.bootstrapSeed ^ 0x51ca5e)
    : null

  const resultGates = [
    gate('all twenty-four preregistered AB/BA attempts are retained',
      attempts.length === V28_EXECUTION_PLAN.length
        && nativeAttempts.length === V28_THRESHOLDS.requiredAttemptsPerArm
        && candidateAttempts.length === V28_THRESHOLDS.requiredAttemptsPerArm
        && legalPrefix,
      { total: attempts.length, native: nativeAttempts.length, candidate: candidateAttempts.length },
      { total: 24, native: 12, candidate: 12 }),
    gate('every retained attempt has reproducible metrics and terminal evidence',
      nativeAttempts.length === V28_THRESHOLDS.requiredAttemptsPerArm
        && candidateAttempts.length === V28_THRESHOLDS.requiredAttemptsPerArm
        && nativeAttempts.every(validNativeAttempt)
        && candidateAttempts.every(validCandidateAttempt),
      attempts.map(attempt => ({ id: attempt?.id ?? null, status: attempt?.status ?? null })),
      'twenty-four completed, evidence-valid attempts'),
    gate('native remains a non-ceiling long-task baseline',
      finite(nativeMedianScore)
        && nativeMedianScore <= V28_THRESHOLDS.maximumNativeMedianScore
        && nativeFullCompletions <= V28_THRESHOLDS.maximumNativeFullCompletions,
      { medianScore: nativeMedianScore, fullCompletions: nativeFullCompletions },
      { maximumMedianScore: V28_THRESHOLDS.maximumNativeMedianScore,
        maximumFullCompletions: V28_THRESHOLDS.maximumNativeFullCompletions }),
    gate('candidate median absolute score improvement reaches the minimum',
      finite(scoreDelta) && scoreDelta >= V28_THRESHOLDS.minimumCandidateMedianAbsoluteScoreImprovement,
      scoreDelta, `>= ${V28_THRESHOLDS.minimumCandidateMedianAbsoluteScoreImprovement}`),
    gate('candidate median closes the minimum share of the remaining score gap',
      finite(remainingGapClosed)
        && remainingGapClosed >= V28_THRESHOLDS.minimumCandidateMedianRemainingGapClosed,
      remainingGapClosed, `>= ${V28_THRESHOLDS.minimumCandidateMedianRemainingGapClosed}`),
    gate('candidate median strict reward score reaches 100',
      candidateMedianScore === V28_THRESHOLDS.minimumCandidateMedianScore,
      candidateMedianScore, V28_THRESHOLDS.minimumCandidateMedianScore),
    gate('candidate fully completes at least ten of twelve nine-round tasks',
      candidateFullCompletions >= V28_THRESHOLDS.minimumCandidateFullCompletions,
      candidateFullCompletions, `>= ${V28_THRESHOLDS.minimumCandidateFullCompletions}`),
    gate('candidate full-completion rate improves by at least fifty percentage points',
      finite(completionRateDelta)
        && completionRateDelta >= V28_THRESHOLDS.minimumCompletionRateDelta,
      completionRateDelta, `>= ${V28_THRESHOLDS.minimumCompletionRateDelta}`),
    gate('candidate completion advantage passes the paired exact McNemar test',
      finite(completionMcNemarP)
        && completionMcNemarP <= V28_THRESHOLDS.maximumCompletionMcNemarP,
      { p: completionMcNemarP, improved: improvedCompletions, worsened: worsenedCompletions },
      `p <= ${V28_THRESHOLDS.maximumCompletionMcNemarP}`),
    gate('candidate mean continuity depth improves by at least four rounds',
      finite(meanContinuityDepthDelta)
        && meanContinuityDepthDelta >= V28_THRESHOLDS.minimumMeanContinuityDepthDelta,
      meanContinuityDepthDelta, `>= ${V28_THRESHOLDS.minimumMeanContinuityDepthDelta}`),
    gate('candidate continuity depth wins at least ten contemporaneous pairs',
      Number.isInteger(continuityPairWins)
        && continuityPairWins >= V28_THRESHOLDS.minimumContinuityPairWins,
      continuityPairWins, `>= ${V28_THRESHOLDS.minimumContinuityPairWins}`),
    gate('continuity depth passes the paired exact sign-flip test',
      finite(continuitySignFlipP)
        && continuitySignFlipP <= V28_THRESHOLDS.maximumContinuitySignFlipP,
      continuitySignFlipP, `p <= ${V28_THRESHOLDS.maximumContinuitySignFlipP}`),
    gate('continuity depth bootstrap lower bound exceeds two rounds',
      finite(continuityBootstrap?.lower)
        && continuityBootstrap.lower > V28_THRESHOLDS.minimumContinuityBootstrapLower,
      continuityBootstrap, `lower > ${V28_THRESHOLDS.minimumContinuityBootstrapLower}`),
    gate('candidate paired mean strict reward score improves by at least thirty points',
      finite(meanScoreDelta) && meanScoreDelta >= V28_THRESHOLDS.minimumMeanScoreDelta,
      meanScoreDelta, `>= ${V28_THRESHOLDS.minimumMeanScoreDelta}`),
    gate('candidate paired mean hidden case score improves by at least twenty points',
      finite(meanCaseScoreDelta)
        && meanCaseScoreDelta >= V28_THRESHOLDS.minimumMeanCaseScoreDelta,
      meanCaseScoreDelta, `>= ${V28_THRESHOLDS.minimumMeanCaseScoreDelta}`),
    gate('hidden case-score bootstrap lower bound is positive',
      finite(caseScoreBootstrap?.lower)
        && caseScoreBootstrap.lower > V28_THRESHOLDS.minimumCaseScoreBootstrapLowerExclusive,
      caseScoreBootstrap, `lower > ${V28_THRESHOLDS.minimumCaseScoreBootstrapLowerExclusive}`),
    gate('candidate has at least ten clean task terminals',
      candidateCleanTerminals >= V28_THRESHOLDS.minimumCandidateCleanTerminals,
      candidateCleanTerminals, `>= ${V28_THRESHOLDS.minimumCandidateCleanTerminals}`),
    gate('candidate case score does not regress at the median',
      finite(candidateMedianCaseScore) && finite(nativeMedianCaseScore)
        && candidateMedianCaseScore >= nativeMedianCaseScore,
      { nativeMedian: nativeMedianCaseScore, candidateMedian: candidateMedianCaseScore },
      'candidate >= native median'),
    gate('candidate introduces no historical requirement regression',
      candidateAttempts.length === V28_THRESHOLDS.requiredAttemptsPerArm
        && candidateRegressions.every(value => value === V28_THRESHOLDS.maximumCandidateHistoricalRegressions),
      candidateRegressions,
      Array(V28_THRESHOLDS.requiredAttemptsPerArm).fill(V28_THRESHOLDS.maximumCandidateHistoricalRegressions)),
    gate('every fully completed candidate satisfies the frozen continuity audit',
      completedCandidateInvalidTraces === V28_THRESHOLDS.maximumCompletedCandidateInvalidTraces,
      completedCandidateInvalidTraces, V28_THRESHOLDS.maximumCompletedCandidateInvalidTraces),
  ]
  const resultPassed = resultGates.every(entry => entry.passed)
  const releaseAllowed = candidateExecutionAllowed && resultPassed

  return {
    schemaVersion: 2,
    protocolId: input.protocolId ?? null,
    thresholds: V28_THRESHOLDS,
    executionPlan: V28_EXECUTION_PLAN,
    candidateExecutionAllowed,
    releaseAllowed,
    comparison: {
      nativeScores,
      candidateScores,
      nativeMedianScore,
      candidateMedianScore,
      nativeScoreSpread,
      candidateScoreSpread,
      nativeMedianCaseScore,
      candidateMedianCaseScore,
      nativeMedianHistoricalRequirementRegressions: nativeMedianRegressions,
      candidateMedianHistoricalRequirementRegressions: candidateMedianRegressions,
      nativeMedianInputTokens,
      candidateMedianInputTokens,
      scoreDelta,
      remainingGapClosed,
      inputTokenRatio,
      nativeFullCompletions,
      candidateFullCompletions,
      candidateCleanTerminals,
      nativeCompletionRate,
      candidateCompletionRate,
      completionRateDelta,
      improvedCompletions,
      worsenedCompletions,
      completionMcNemarP,
      meanContinuityDepthDelta,
      continuityPairWins,
      continuitySignFlipP,
      continuityBootstrap,
      meanScoreDelta,
      meanCaseScoreDelta,
      caseScoreBootstrap,
      pairs,
    },
    qualification: {
      passed: candidateExecutionAllowed,
      gates: qualificationGates,
    },
    candidate: {
      executed: candidateAttempts.length > 0,
      passed: resultPassed,
      gates: resultGates,
    },
    statement: releaseAllowed
      ? 'All preregistered V28 paired-comparison gates passed; the frozen result may be released.'
      : candidateExecutionAllowed
        ? 'The V28 execution prefix is authorized, but release remains blocked until every paired-comparison gate passes.'
        : 'The V28 execution prefix is invalid; candidate execution and release are prohibited.',
  }
}
