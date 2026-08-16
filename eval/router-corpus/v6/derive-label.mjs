export const factDomains = {
  episodeEligibility: ['eligible', 'non-executable'],
  mutationAuthorization: ['none', 'read-only', 'write'],
  basisClosure: ['closed', 'user-decision-gap', 'repository-evidence-gap'],
  authorizationEpochs: ['one', 'few', 'many'],
  invalidationDriver: [
    'none',
    'context-replacement',
    'stage-output',
    'external-truth',
    'human-reframe',
    'handoff',
    'parallel-executors',
    'delayed-verification',
  ],
  verificationHorizon: ['immediate', 'staged', 'delayed'],
  staleActionLoss: ['low', 'material', 'irreversible'],
  recovery: ['direct', 'planned', 'unavailable'],
}

export const nuisanceDomains = {
  reportedIssueSeverity: ['low', 'material', 'high', 'unknown'],
  implementationScope: ['bounded', 'cross-boundary', 'unknown'],
  runtimeDynamism: ['static', 'dynamic', 'unknown'],
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function validateCausalFacts(facts, context = 'causal facts') {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) throw new Error(`${context} must be an object`)
  for (const [field, domain] of Object.entries(factDomains)) {
    if (!domain.includes(facts[field])) throw new Error(`${context}.${field} must be ${domain.join(', ')}`)
  }
  if (facts.causalChain === null || typeof facts.causalChain !== 'object' || Array.isArray(facts.causalChain)) {
    throw new Error(`${context}.causalChain must be an object`)
  }
  const chainFields = ['basisItem', 'invalidationEvent', 'laterMutation', 'staleAction', 'detectionAndConsequence']
  if (JSON.stringify(Object.keys(facts.causalChain).sort()) !== JSON.stringify(chainFields.sort())) {
    throw new Error(`${context}.causalChain must contain exactly ${chainFields.join(', ')}`)
  }
  const hasDriver = facts.invalidationDriver !== 'none'
  const populatedChain = chainFields.every(field => nonEmpty(facts.causalChain[field]))
  const emptyChain = chainFields.every(field => facts.causalChain[field] === '')
  if (hasDriver && (!populatedChain || facts.authorizationEpochs === 'one')) {
    throw new Error(`${context} with an invalidation driver requires a complete chain and multiple authorization epochs`)
  }
  if (!hasDriver && !emptyChain) throw new Error(`${context} without an invalidation driver must keep the chain empty`)
  if (facts.authorizationEpochs === 'many' && !hasDriver) {
    throw new Error(`${context} with many epochs must identify the basis invalidation driver`)
  }
  if (facts.episodeEligibility === 'non-executable' && facts.mutationAuthorization !== 'none') {
    throw new Error(`${context} cannot authorize mutation for a non-executable episode`)
  }
  return facts
}

export function deriveLabel(input) {
  const facts = validateCausalFacts(input)
  if (facts.episodeEligibility === 'non-executable') return { eligible: false, route: undefined, outcomeCritical: false }
  if (facts.mutationAuthorization !== 'write') return { eligible: true, route: 'bypass', outcomeCritical: false }

  const outcomeCritical = facts.basisClosure === 'user-decision-gap'
    || facts.staleActionLoss !== 'low'
    || facts.recovery === 'unavailable'
  if (facts.basisClosure === 'repository-evidence-gap') return { eligible: true, route: 'probe', outcomeCritical }
  if (facts.basisClosure === 'user-decision-gap') return { eligible: true, route: 'contract', outcomeCritical }
  if (facts.invalidationDriver !== 'none') return { eligible: true, route: 'lattice', outcomeCritical }
  if (facts.authorizationEpochs === 'few'
    || facts.verificationHorizon !== 'immediate'
    || facts.staleActionLoss !== 'low'
    || facts.recovery !== 'direct') {
    return { eligible: true, route: 'contract', outcomeCritical }
  }
  return { eligible: true, route: 'bypass', outcomeCritical }
}
