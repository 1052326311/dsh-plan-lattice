import { deriveLabel, factDomains, nuisanceDomains, validateCausalFacts } from './derive-label.mjs'

export const confidenceValues = ['high', 'medium', 'low']
const annotationKeys = ['confidence', 'facts', 'id', 'nuisance', 'rationale']
const factKeys = [...Object.keys(factDomains), 'causalChain']
const nuisanceKeys = Object.keys(nuisanceDomains)

function assertExactKeys(value, expected, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} must contain exactly ${expected.join(', ')}`)
  }
}

export function validateAnnotation(row, context = 'annotation') {
  assertExactKeys(row, annotationKeys, context)
  if (typeof row.id !== 'string' || row.id.trim() === '') throw new Error(`${context}.id must be non-empty`)
  if (!confidenceValues.includes(row.confidence)) throw new Error(`${context}.confidence must be ${confidenceValues.join(', ')}`)
  if (typeof row.rationale !== 'string' || row.rationale.trim().length < 40) {
    throw new Error(`${context}.rationale must state row-specific evidence in at least 40 characters`)
  }
  assertExactKeys(row.facts, factKeys, `${context}.facts`)
  validateCausalFacts(row.facts, `${context}.facts`)
  assertExactKeys(row.nuisance, nuisanceKeys, `${context}.nuisance`)
  for (const [field, domain] of Object.entries(nuisanceDomains)) {
    if (!domain.includes(row.nuisance[field])) throw new Error(`${context}.nuisance.${field} must be ${domain.join(', ')}`)
  }
  return { ...row, derived: deriveLabel(row.facts) }
}

export function validateAnnotationSet(candidateRows, annotationRows, name) {
  const candidateIds = new Set(candidateRows.map(row => row.id))
  if (candidateIds.size !== candidateRows.length) throw new Error('candidate IDs must be unique')
  const result = new Map()
  for (const [index, row] of annotationRows.entries()) {
    const validated = validateAnnotation(row, `${name}:${index + 1}`)
    if (!candidateIds.has(row.id)) throw new Error(`${name} contains unknown candidate ${row.id}`)
    if (result.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    result.set(row.id, validated)
  }
  const missing = [...candidateIds].filter(id => !result.has(id))
  if (missing.length > 0) throw new Error(`${name} is missing ${missing.join(', ')}`)
  return result
}
