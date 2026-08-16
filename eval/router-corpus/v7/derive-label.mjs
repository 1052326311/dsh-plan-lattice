export const factDomains = {
  episodeMode: ['non-executable', 'non-mutating', 'mutating'],
  decisionAuthority: ['not-applicable', 'supplied', 'missing-user-choice'],
  classificationEvidence: ['not-applicable', 'sufficient-from-request', 'requires-repository-read'],
  continuityHazard: [
    'none',
    'host-context-replacement',
    'stage-feedback',
    'changing-basis',
    'handoff',
    'parallel-execution',
    'delayed-verification',
  ],
  protectedEffect: ['none', 'reversible-external', 'irreversible-or-authority'],
}

const chainFields = ['basisItem', 'invalidationEvent', 'laterMutation', 'staleAction', 'detectionAndConsequence']

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function validateObservableFacts(facts, context = 'observable facts') {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new Error(`${context} must be an object`)
  }
  for (const [field, domain] of Object.entries(factDomains)) {
    if (!domain.includes(facts[field])) throw new Error(`${context}.${field} must be ${domain.join(', ')}`)
  }
  if (facts.causalChain === null || typeof facts.causalChain !== 'object' || Array.isArray(facts.causalChain)) {
    throw new Error(`${context}.causalChain must be an object`)
  }
  if (JSON.stringify(Object.keys(facts.causalChain).sort()) !== JSON.stringify([...chainFields].sort())) {
    throw new Error(`${context}.causalChain must contain exactly ${chainFields.join(', ')}`)
  }

  const chainComplete = chainFields.every(field => nonEmpty(facts.causalChain[field]))
  const chainEmpty = chainFields.every(field => facts.causalChain[field] === '')
  if (facts.continuityHazard === 'none' && !chainEmpty) {
    throw new Error(`${context} without a continuity hazard must keep the causal chain empty`)
  }
  if (facts.continuityHazard !== 'none' && !chainComplete) {
    throw new Error(`${context} with a continuity hazard requires a complete invalidation chain`)
  }

  if (facts.episodeMode !== 'mutating') {
    if (facts.decisionAuthority !== 'not-applicable'
      || facts.classificationEvidence !== 'not-applicable'
      || facts.continuityHazard !== 'none'
      || facts.protectedEffect !== 'none') {
      throw new Error(`${context} for a non-mutating episode must use not-applicable control facts`)
    }
  } else {
    if (facts.decisionAuthority === 'not-applicable') {
      throw new Error(`${context}.decisionAuthority must apply to a mutating episode`)
    }
    if (facts.classificationEvidence === 'not-applicable') {
      throw new Error(`${context}.classificationEvidence must apply to a mutating episode`)
    }
  }
  return facts
}

export function deriveLabel(input) {
  const facts = validateObservableFacts(input)
  if (facts.episodeMode === 'non-executable') {
    return { eligible: false, route: undefined, outcomeCritical: false }
  }
  if (facts.episodeMode === 'non-mutating') {
    return { eligible: true, route: 'bypass', outcomeCritical: false }
  }

  const outcomeCritical = facts.decisionAuthority === 'missing-user-choice'
    || facts.protectedEffect === 'irreversible-or-authority'
  if (facts.decisionAuthority === 'missing-user-choice') {
    return { eligible: true, route: 'contract', outcomeCritical }
  }
  if (facts.classificationEvidence === 'requires-repository-read') {
    return { eligible: true, route: 'probe', outcomeCritical }
  }
  if (facts.continuityHazard !== 'none') {
    return { eligible: true, route: 'lattice', outcomeCritical }
  }
  if (facts.protectedEffect !== 'none') {
    return { eligible: true, route: 'contract', outcomeCritical }
  }
  return { eligible: true, route: 'bypass', outcomeCritical }
}
