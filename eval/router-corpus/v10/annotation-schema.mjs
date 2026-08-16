import { deriveLabel, factDomains, validateObservableFacts } from './derive-label.mjs'

export const confidenceValues = ['high', 'medium', 'low']
const annotationKeys = ['confidence', 'evidence', 'facts', 'id', 'rationale']
const factKeys = [...Object.keys(factDomains), 'causalChain']
const evidenceKeys = [
  'episodeQuote',
  'decisionGapQuote',
  'repositoryQuestion',
  'repositoryAlternatives',
  'repositoryImpact',
  'continuityQuotes',
  'protectedEffectQuote',
]

function exactKeys(value, expected, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} must contain exactly ${expected.join(', ')}`)
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function validateAnnotation(row, context = 'annotation') {
  exactKeys(row, annotationKeys, context)
  if (!nonEmpty(row.id)) throw new Error(`${context}.id must be non-empty`)
  if (!confidenceValues.includes(row.confidence)) throw new Error(`${context}.confidence is invalid`)
  if (!nonEmpty(row.rationale) || row.rationale.trim().length < 40) {
    throw new Error(`${context}.rationale must contain at least 40 row-specific characters`)
  }
  exactKeys(row.facts, factKeys, `${context}.facts`)
  validateObservableFacts(row.facts, `${context}.facts`)
  exactKeys(row.evidence, evidenceKeys, `${context}.evidence`)
  if (!nonEmpty(row.evidence.episodeQuote)) throw new Error(`${context}.evidence.episodeQuote must quote the request`)
  if (!Array.isArray(row.evidence.repositoryAlternatives)
    || !Array.isArray(row.evidence.continuityQuotes)
    || row.evidence.repositoryAlternatives.some(value => !nonEmpty(value))
    || row.evidence.continuityQuotes.some(value => !nonEmpty(value))) {
    throw new Error(`${context}.evidence arrays must contain only non-empty strings`)
  }
  const decisionGap = row.facts.decisionAuthority === 'missing-user-choice'
  if (decisionGap !== nonEmpty(row.evidence.decisionGapQuote)) {
    throw new Error(`${context}.evidence.decisionGapQuote must exist exactly for a missing user choice`)
  }
  const repositoryGap = row.facts.classificationEvidence === 'requires-repository-read'
  const impactedRoutes = new Set(String(row.evidence.repositoryImpact).match(/\b(?:bypass|contract|lattice|probe)\b/g) ?? [])
  const repositoryEvidence = nonEmpty(row.evidence.repositoryQuestion)
    && row.evidence.repositoryAlternatives.length >= 2
    && impactedRoutes.size >= 2
  if (repositoryGap !== repositoryEvidence) {
    throw new Error(`${context}.evidence must give a repository question, alternatives, and different route outcomes exactly for probe`)
  }
  if (!repositoryGap && (row.evidence.repositoryQuestion !== ''
    || row.evidence.repositoryAlternatives.length !== 0
    || row.evidence.repositoryImpact !== '')) {
    throw new Error(`${context}.evidence repository fields must be empty without probe`)
  }
  const continuity = row.facts.continuityHazard !== 'none'
  if (continuity !== (row.evidence.continuityQuotes.length > 0)) {
    throw new Error(`${context}.evidence.continuityQuotes must exist exactly for a continuity hazard`)
  }
  const protectedEffect = row.facts.protectedEffect !== 'none'
  if (protectedEffect !== nonEmpty(row.evidence.protectedEffectQuote)) {
    throw new Error(`${context}.evidence.protectedEffectQuote must exist exactly for a protected effect`)
  }
  return { ...row, derived: deriveLabel(row.facts) }
}

export function validateAnnotationSet(candidates, rows, name) {
  const candidateIds = new Set(candidates.map(row => row.id))
  if (candidateIds.size !== candidates.length) throw new Error('candidate IDs must be unique')
  const result = new Map()
  for (const [index, row] of rows.entries()) {
    const validated = validateAnnotation(row, `${name}:${index + 1}`)
    if (!candidateIds.has(row.id)) throw new Error(`${name} contains unknown candidate ${row.id}`)
    if (result.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    result.set(row.id, validated)
  }
  const missing = [...candidateIds].filter(id => !result.has(id))
  if (missing.length > 0) throw new Error(`${name} is missing ${missing.join(', ')}`)
  return result
}
