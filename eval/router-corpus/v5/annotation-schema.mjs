export const confidenceValues = ['high', 'medium', 'low']
export const completenessValues = ['complete', 'partial', 'incomplete']
export const riskValues = ['low', 'medium', 'high']

const annotationKeys = [
  'authoritativeMutationBasis',
  'confidence',
  'id',
  'outcomeCritical',
  'rationale',
  'route',
]
const basisKeys = ['basisCompleteness', 'expiryExposure', 'staleImpact']

function assertExactKeys(value, expected, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`)
  }
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} must contain exactly ${expected.join(', ')}`)
  }
}

export function validateAnnotation(row, routes, context) {
  assertExactKeys(row, annotationKeys, context)
  if (typeof row.id !== 'string' || row.id.trim() === '') throw new Error(`${context}.id must be non-empty`)
  if (!routes.includes(row.route)) throw new Error(`${context}.route must be ${routes.join(', ')}; probe is prediction-only`)
  if (typeof row.outcomeCritical !== 'boolean') throw new Error(`${context}.outcomeCritical must be boolean`)
  if (row.outcomeCritical && row.route === 'bypass') throw new Error(`${context} cannot combine outcomeCritical=true with bypass`)
  if (!confidenceValues.includes(row.confidence)) throw new Error(`${context}.confidence must be ${confidenceValues.join(', ')}`)
  if (typeof row.rationale !== 'string' || row.rationale.trim() === '') throw new Error(`${context}.rationale must be non-empty`)
  assertExactKeys(row.authoritativeMutationBasis, basisKeys, `${context}.authoritativeMutationBasis`)
  if (!completenessValues.includes(row.authoritativeMutationBasis.basisCompleteness)) {
    throw new Error(`${context}.basisCompleteness must be ${completenessValues.join(', ')}`)
  }
  for (const key of ['expiryExposure', 'staleImpact']) {
    if (!riskValues.includes(row.authoritativeMutationBasis[key])) {
      throw new Error(`${context}.${key} must be ${riskValues.join(', ')}`)
    }
  }
  return row
}

export function validateAnnotationSet(candidateRows, annotationRows, routes, name, expectedIds = candidateRows.map(row => row.id)) {
  const candidateIds = new Set(candidateRows.map(row => row.id))
  if (candidateIds.size !== candidateRows.length) throw new Error('candidate IDs must be unique')
  const expected = new Set(expectedIds)
  if (expected.size !== expectedIds.length) throw new Error(`${name} expected IDs must be unique`)
  const result = new Map()
  for (const [index, row] of annotationRows.entries()) {
    validateAnnotation(row, routes, `${name}:${index + 1}`)
    if (!candidateIds.has(row.id)) throw new Error(`${name} contains unknown candidate ${row.id}`)
    if (!expected.has(row.id)) throw new Error(`${name} contains unexpected annotation ${row.id}`)
    if (result.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    result.set(row.id, row)
  }
  const missing = [...expected].filter(id => !result.has(id))
  if (missing.length > 0) throw new Error(`${name} is missing ${missing.join(', ')}`)
  return result
}

export function disagreementIds(candidateRows, left, right) {
  return candidateRows
    .filter(candidate => {
      const a = left.get(candidate.id)
      const b = right.get(candidate.id)
      return a.route !== b.route || a.outcomeCritical !== b.outcomeCritical
    })
    .map(candidate => candidate.id)
}
