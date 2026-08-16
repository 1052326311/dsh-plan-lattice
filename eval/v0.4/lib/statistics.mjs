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
} = {}) {
  if (differences.length === 0) return { lower: null, upper: null, confidence, samples }
  const random = seededRandom(seed)
  const estimates = []
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)]
    }
    estimates.push(total / differences.length)
  }
  const alpha = (1 - confidence) / 2
  return {
    lower: percentile(estimates, alpha),
    upper: percentile(estimates, 1 - alpha),
    confidence,
    samples,
  }
}

export function reductionRate(candidate, baseline) {
  const baselineMean = mean(baseline)
  const candidateMean = mean(candidate)
  if (baselineMean === 0) return candidateMean === 0 ? 1 : Number.NEGATIVE_INFINITY
  return (baselineMean - candidateMean) / baselineMean
}
