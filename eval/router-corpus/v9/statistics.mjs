import { languages as protocolLanguages, releaseGates } from './protocol.mjs'

const LANCZOS_COEFFICIENTS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
]

const CONTINUED_FRACTION_EPSILON = 3e-14
const CONTINUED_FRACTION_FLOOR = 1e-300
const MAX_CONTINUED_FRACTION_ITERATIONS = 10_000
const MAX_BISECTION_ITERATIONS = 200

export const V9_CONFIDENCE_LEVEL = releaseGates.confidence
export const V9_HARD_GATE_THRESHOLDS = Object.freeze({
  bypassFalseActivationUpperMax: releaseGates.bypassFalseActivationUpperMax,
  contractRecallLowerMin: releaseGates.contractRecallLowerMin,
  latticeRecallLowerMin: releaseGates.latticeRecallLowerMin,
  probeRecallLowerMin: releaseGates.probeRecallLowerMin,
  outcomeCriticalBypassMax: releaseGates.outcomeCriticalBypassMax,
  probeFalsePositiveUpperMax: releaseGates.probeFalsePositiveUpperMax,
})

const CLUSTER_UNITS = ['source-family-or-repository', 'source-family', 'repository']

function assertProbability(value, name) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(`${name} must be greater than 0 and less than 1`)
  }
}

function assertBinomialCounts(successes, trials) {
  if (!Number.isInteger(trials) || trials <= 0) {
    throw new RangeError('trials must be a positive integer')
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) {
    throw new RangeError('successes must be an integer between 0 and trials')
  }
}

function logGamma(value) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('logGamma requires a positive finite value')
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value)
  }

  const shifted = value - 1
  let series = LANCZOS_COEFFICIENTS[0]
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index += 1) {
    series += LANCZOS_COEFFICIENTS[index] / (shifted + index)
  }
  const scale = shifted + LANCZOS_COEFFICIENTS.length - 1.5
  return 0.5 * Math.log(2 * Math.PI)
    + (shifted + 0.5) * Math.log(scale)
    - scale
    + Math.log(series)
}

function betaContinuedFraction(a, b, x) {
  const sum = a + b
  const aPlusOne = a + 1
  const aMinusOne = a - 1
  let c = 1
  let d = 1 - (sum * x) / aPlusOne
  if (Math.abs(d) < CONTINUED_FRACTION_FLOOR) d = CONTINUED_FRACTION_FLOOR
  d = 1 / d
  let result = d

  for (let iteration = 1; iteration <= MAX_CONTINUED_FRACTION_ITERATIONS; iteration += 1) {
    const doubled = 2 * iteration
    let coefficient = (iteration * (b - iteration) * x)
      / ((aMinusOne + doubled) * (a + doubled))
    d = 1 + coefficient * d
    if (Math.abs(d) < CONTINUED_FRACTION_FLOOR) d = CONTINUED_FRACTION_FLOOR
    c = 1 + coefficient / c
    if (Math.abs(c) < CONTINUED_FRACTION_FLOOR) c = CONTINUED_FRACTION_FLOOR
    d = 1 / d
    result *= d * c

    coefficient = -((a + iteration) * (sum + iteration) * x)
      / ((a + doubled) * (aPlusOne + doubled))
    d = 1 + coefficient * d
    if (Math.abs(d) < CONTINUED_FRACTION_FLOOR) d = CONTINUED_FRACTION_FLOOR
    c = 1 + coefficient / c
    if (Math.abs(c) < CONTINUED_FRACTION_FLOOR) c = CONTINUED_FRACTION_FLOOR
    d = 1 / d
    const delta = d * c
    result *= delta
    if (Math.abs(delta - 1) <= CONTINUED_FRACTION_EPSILON) return result
  }

  throw new Error('incomplete beta continued fraction did not converge')
}

function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const logFront = logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log1p(-x)
  const front = Math.exp(logFront)
  if (x < (a + 1) / (a + b + 2)) {
    return Math.min(1, Math.max(0, (front * betaContinuedFraction(a, b, x)) / a))
  }
  const complement = (front * betaContinuedFraction(b, a, 1 - x)) / b
  return Math.min(1, Math.max(0, 1 - complement))
}

function inverseRegularizedIncompleteBeta(probability, a, b) {
  assertProbability(probability, 'probability')
  if (probability > 0.5) {
    return 1 - inverseRegularizedIncompleteBeta(1 - probability, b, a)
  }

  let low = 0
  let high = 1
  for (let iteration = 0; iteration < MAX_BISECTION_ITERATIONS; iteration += 1) {
    const midpoint = low + (high - low) / 2
    const cumulative = regularizedIncompleteBeta(midpoint, a, b)
    if (cumulative < probability) low = midpoint
    else high = midpoint
    if (high - low <= 8 * Number.EPSILON * Math.max(1, midpoint)) break
  }
  return low + (high - low) / 2
}

export function clopperPearsonLowerBound(successes, trials, confidenceLevel = V9_CONFIDENCE_LEVEL) {
  assertBinomialCounts(successes, trials)
  assertProbability(confidenceLevel, 'confidenceLevel')
  if (successes === 0) return 0
  const alpha = 1 - confidenceLevel
  if (successes === trials) return Math.exp(Math.log(alpha) / trials)
  return inverseRegularizedIncompleteBeta(alpha, successes, trials - successes + 1)
}

export function clopperPearsonUpperBound(successes, trials, confidenceLevel = V9_CONFIDENCE_LEVEL) {
  assertBinomialCounts(successes, trials)
  assertProbability(confidenceLevel, 'confidenceLevel')
  if (successes === trials) return 1
  const alpha = 1 - confidenceLevel
  if (successes === 0) return -Math.expm1(Math.log(alpha) / trials)
  return inverseRegularizedIncompleteBeta(confidenceLevel, successes + 1, trials - successes)
}

export function clopperPearsonOneSided(successes, trials, confidenceLevel = V9_CONFIDENCE_LEVEL) {
  return {
    confidenceLevel,
    lower: clopperPearsonLowerBound(successes, trials, confidenceLevel),
    upper: clopperPearsonUpperBound(successes, trials, confidenceLevel),
  }
}

export const clopperPearsonLower = clopperPearsonLowerBound
export const clopperPearsonUpper = clopperPearsonUpperBound

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function rowField(row, primary, alternatives = []) {
  if (row[primary] !== undefined) return row[primary]
  for (const alternative of alternatives) {
    if (row[alternative] !== undefined) return row[alternative]
  }
  return undefined
}

function sourceField(row, names) {
  for (const name of names) {
    if (row[name] !== undefined) return row[name]
    if (row.source && row.source[name] !== undefined) return row.source[name]
  }
  return undefined
}

function clusterForRow(row, index, clusterUnit) {
  const repositoryValue = sourceField(row, ['repository', 'repo'])
  const familyValue = sourceField(row, [
    'sourceFamily', 'sourceFamilyId', 'taskEpisode', 'taskEpisodeId', 'episodeId',
    'duplicateCluster', 'duplicateClusterId', 'family', 'familyId',
  ])
  const repository = repositoryValue === undefined ? '' : nonEmptyString(repositoryValue, `rows[${index}].repository`)
  const family = familyValue === undefined ? '' : nonEmptyString(familyValue, `rows[${index}].sourceFamily`)
  if (clusterUnit !== 'repository' && family !== '') {
    return {
      id: JSON.stringify(['family', repository, family]),
      kind: 'source-family',
      family,
      repository: repository || null,
    }
  }
  if (clusterUnit !== 'source-family' && repository !== '') {
    return {
      id: JSON.stringify(['repository', repository]),
      kind: 'repository',
      family: null,
      repository,
    }
  }
  throw new Error(`rows[${index}] cannot be clustered by ${clusterUnit}`)
}

function normalizedRow(row, index, clusterUnit) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`rows[${index}] must be an object`)
  }
  if (typeof row.outcomeCritical !== 'boolean') throw new Error(`rows[${index}].outcomeCritical must be boolean`)
  return {
    value: row,
    language: nonEmptyString(row.language, `rows[${index}].language`),
    expected: nonEmptyString(rowField(row, 'expected', ['expectedRoute']), `rows[${index}].expected`),
    actual: nonEmptyString(rowField(row, 'actual', ['actualRoute', 'predicted']), `rows[${index}].actual`),
    outcomeCritical: row.outcomeCritical,
    cluster: clusterForRow(row, index, clusterUnit),
  }
}

function normalizedClusterUnit(value) {
  if (!CLUSTER_UNITS.includes(value)) {
    throw new Error(`clusterUnit must be one of ${CLUSTER_UNITS.join(', ')}`)
  }
  return value
}

export function familyExactOutcomes(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be a non-empty array')
  const clusterUnit = normalizedClusterUnit(options.clusterUnit ?? 'source-family-or-repository')
  const groups = new Map()
  for (const [index, value] of rows.entries()) {
    const row = normalizedRow(value, index, clusterUnit)
    const key = JSON.stringify([row.language, row.expected, row.cluster.id])
    const group = groups.get(key) ?? {
      language: row.language,
      route: row.expected,
      clusterKind: row.cluster.kind,
      family: row.cluster.family,
      repository: row.cluster.repository,
      rows: [],
    }
    group.rows.push(row)
    groups.set(key, group)
  }

  return [...groups.values()]
    .map(group => {
      if (new Set(group.rows.map(row => row.outcomeCritical)).size !== 1) {
        throw new Error(`source family ${group.family ?? group.repository} mixes outcomeCritical values`)
      }
      return {
        language: group.language,
        route: group.route,
        clusterKind: group.clusterKind,
        family: group.family,
        repository: group.repository,
        sampleCount: group.rows.length,
        exactOutcome: group.rows.every(row => row.actual === group.route),
        outcomeCritical: group.rows[0].outcomeCritical,
        predictedBypass: group.rows.some(row => row.actual === 'bypass'),
        predictedProbe: group.rows.some(row => row.actual === 'probe'),
      }
    })
    .sort((left, right) => JSON.stringify([
      left.language, left.route, left.repository, left.family,
    ]).localeCompare(JSON.stringify([
      right.language, right.route, right.repository, right.family,
    ])))
}

function recallMetric(successes, trials, confidenceLevel) {
  return {
    successes,
    trials,
    pointEstimate: successes / trials,
    lowerConfidenceBound: clopperPearsonLowerBound(successes, trials, confidenceLevel),
  }
}

function falseActivationMetric(falseActivations, trials, confidenceLevel) {
  return {
    falseActivations,
    trials,
    pointEstimate: falseActivations / trials,
    upperConfidenceBound: clopperPearsonUpperBound(falseActivations, trials, confidenceLevel),
  }
}

export function computeRouteStatistics(rows, options = {}) {
  const confidenceLevel = options.confidenceLevel ?? V9_CONFIDENCE_LEVEL
  assertProbability(confidenceLevel, 'confidenceLevel')
  const clusterUnit = normalizedClusterUnit(options.clusterUnit ?? 'source-family-or-repository')
  const outcomes = familyExactOutcomes(rows, { clusterUnit })
  const strata = new Map()

  for (const outcome of outcomes) {
    const key = JSON.stringify([outcome.language, outcome.route])
    const stratum = strata.get(key) ?? {
      language: outcome.language,
      route: outcome.route,
      rowCount: 0,
      familyCount: 0,
      exactOutcomeCount: 0,
    }
    stratum.rowCount += outcome.sampleCount
    stratum.familyCount += 1
    if (outcome.exactOutcome) stratum.exactOutcomeCount += 1
    strata.set(key, stratum)
  }

  const resultStrata = [...strata.values()]
    .sort((left, right) => JSON.stringify([left.language, left.route])
      .localeCompare(JSON.stringify([right.language, right.route])))
    .map(stratum => {
      const recall = recallMetric(stratum.exactOutcomeCount, stratum.familyCount, confidenceLevel)
      return {
        ...stratum,
        exactOutcomeFailureCount: stratum.familyCount - stratum.exactOutcomeCount,
        recall,
        bypassFalseActivation: stratum.route === 'bypass'
          ? falseActivationMetric(stratum.familyCount - stratum.exactOutcomeCount, stratum.familyCount, confidenceLevel)
          : null,
      }
    })

  const byLanguageRoute = {}
  for (const stratum of resultStrata) {
    byLanguageRoute[stratum.language] ??= {}
    byLanguageRoute[stratum.language][stratum.route] = stratum
  }

  const safetyByLanguage = Object.fromEntries(protocolLanguages.map(language => {
    const scoped = outcomes.filter(outcome => outcome.language === language)
    const critical = scoped.filter(outcome => outcome.outcomeCritical)
    const nonProbe = scoped.filter(outcome => outcome.route !== 'probe')
    const criticalBypassCount = critical.filter(outcome => outcome.predictedBypass).length
    const probeFalsePositiveCount = nonProbe.filter(outcome => outcome.predictedProbe).length
    return [language, {
      outcomeCritical: { families: critical.length, bypassCount: criticalBypassCount },
      probeFalsePositive: nonProbe.length === 0
        ? { families: 0, falsePositives: 0, pointEstimate: null, upperConfidenceBound: null }
        : {
            families: nonProbe.length,
            ...falseActivationMetric(probeFalsePositiveCount, nonProbe.length, confidenceLevel),
          },
    }]
  }))

  return {
    confidenceLevel,
    clusterUnit,
    languages: Object.keys(byLanguageRoute).sort(),
    strata: resultStrata,
    byLanguageRoute,
    safetyByLanguage,
    familyOutcomes: outcomes,
  }
}

export function evaluateRouteHardGate(rows, options = {}) {
  if (options.confidenceLevel !== undefined && options.confidenceLevel !== V9_CONFIDENCE_LEVEL) {
    throw new Error(`V9 hard gates require confidenceLevel=${V9_CONFIDENCE_LEVEL}`)
  }
  if (options.thresholds !== undefined) throw new Error('V9 hard-gate thresholds are frozen by the protocol')
  const statistics = computeRouteStatistics(rows, options)
  const thresholds = V9_HARD_GATE_THRESHOLDS
  const checks = []
  const recallGates = [
    ['contract', thresholds.contractRecallLowerMin],
    ['lattice', thresholds.latticeRecallLowerMin],
    ['probe', thresholds.probeRecallLowerMin],
  ]

  for (const language of protocolLanguages) {
    for (const [route, threshold] of recallGates) {
      const stratum = statistics.byLanguageRoute[language]?.[route]
      const confidenceBound = stratum?.recall.lowerConfidenceBound ?? null
      checks.push({
        language,
        route,
        metric: 'recall',
        comparison: 'lower-confidence-bound>=minimum',
        threshold,
        families: stratum?.familyCount ?? 0,
        pointEstimate: stratum?.recall.pointEstimate ?? null,
        confidenceBound,
        passed: confidenceBound !== null && confidenceBound >= threshold,
      })
    }

    const bypass = statistics.byLanguageRoute[language]?.bypass
    const confidenceBound = bypass?.bypassFalseActivation?.upperConfidenceBound ?? null
    checks.push({
      language,
      route: 'bypass',
      metric: 'false-activation',
      comparison: 'upper-confidence-bound<=maximum',
      threshold: thresholds.bypassFalseActivationUpperMax,
      families: bypass?.familyCount ?? 0,
      pointEstimate: bypass?.bypassFalseActivation?.pointEstimate ?? null,
      confidenceBound,
      passed: confidenceBound !== null && confidenceBound <= thresholds.bypassFalseActivationUpperMax,
    })

    const critical = statistics.safetyByLanguage[language].outcomeCritical
    checks.push({
      language,
      route: 'outcome-critical',
      metric: 'bypass-count',
      comparison: 'count<=maximum',
      threshold: thresholds.outcomeCriticalBypassMax,
      families: critical.families,
      pointEstimate: critical.bypassCount,
      confidenceBound: null,
      passed: critical.families > 0 && critical.bypassCount <= thresholds.outcomeCriticalBypassMax,
    })

    const probeFalsePositive = statistics.safetyByLanguage[language].probeFalsePositive
    checks.push({
      language,
      route: 'non-probe',
      metric: 'probe-false-positive',
      comparison: 'upper-confidence-bound<=maximum',
      threshold: thresholds.probeFalsePositiveUpperMax,
      families: probeFalsePositive.families,
      pointEstimate: probeFalsePositive.pointEstimate,
      confidenceBound: probeFalsePositive.upperConfidenceBound,
      passed: probeFalsePositive.upperConfidenceBound !== null
        && probeFalsePositive.upperConfidenceBound <= thresholds.probeFalsePositiveUpperMax,
    })
  }

  return {
    ...statistics,
    thresholds,
    checks,
    hardGatePassed: checks.length > 0 && checks.every(check => check.passed),
  }
}

export const routeStatistics = computeRouteStatistics
export const routeHardGate = evaluateRouteHardGate
export const repositoryClusterStatistics = (rows, options = {}) => computeRouteStatistics(rows, {
  ...options,
  clusterUnit: 'repository',
})
