import { seededRandom } from './canonical.mjs'

export function mean(values) {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

export function percentile(values, probability) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function median(values) {
  return percentile(values, 0.5)
}

export function relativeOverhead(candidate, baseline) {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY
  return (candidate - baseline) / baseline
}

export function pairedBootstrapInterval(differences, {
  confidence = 0.95,
  samples = 20_000,
  seed = 'plan-lattice-v0.4-bootstrap',
  clusters,
} = {}) {
  if (clusters !== undefined && clusters.length !== differences.length) {
    throw new Error('paired bootstrap clusters must align with every observed difference')
  }
  const units = clusters === undefined
    ? differences
    : [...differences.reduce((groups, difference, index) => {
        const key = String(clusters[index])
        const values = groups.get(key) ?? []
        values.push(difference)
        groups.set(key, values)
        return groups
      }, new Map()).values()].map(values => mean(values))
  if (units.length === 0) {
    return { lower: null, upper: null, confidence, samples, observations: differences.length, independentUnits: 0 }
  }
  const random = seededRandom(seed)
  const estimates = []
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0
    for (let index = 0; index < units.length; index += 1) {
      total += units[Math.floor(random() * units.length)]
    }
    estimates.push(total / units.length)
  }
  const alpha = (1 - confidence) / 2
  return {
    lower: percentile(estimates, alpha),
    upper: percentile(estimates, 1 - alpha),
    confidence,
    samples,
    observations: differences.length,
    independentUnits: units.length,
  }
}

export function reductionRate(candidate, baseline) {
  const baselineMean = mean(baseline)
  const candidateMean = mean(candidate)
  if (baselineMean === 0) return candidateMean === 0 ? 1 : Number.NEGATIVE_INFINITY
  return (baselineMean - candidateMean) / baselineMean
}
