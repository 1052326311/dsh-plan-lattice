import { classifyRouteText } from './router-classifier.js'
import { assessTaskInvariants, type TaskInvariantAssessment } from './task-invariants.js'

export type ActivationMode = 'off' | 'auto' | 'always'
export type ClarificationPolicy = 'critical' | 'always' | 'never'
export type ControlCeiling = 'contract' | 'lattice'
export type ControlLevel = 'bypass' | 'contract' | 'lattice'
export type RoutePhase = ControlLevel | 'probe'

export interface RouteConfig {
  activationMode: ActivationMode
  clarificationPolicy: ClarificationPolicy
  controlCeiling: ControlCeiling
  longTaskThreshold: number
}

export interface RouteAssessment {
  phase: RoutePhase
  confidence: 'high' | 'needs-evidence'
  executionSpan: number
  productDefinitionGap: number
  outcomeCritical: boolean
  clarificationPolicy: ClarificationPolicy
  reasons: string[]
}

const BYPASS_OVERRIDE = /(?:do not|don't|without|disable|skip)\s+(?:use\s+)?plan[- ]?lattice|不要(?:使用|启用)?\s*plan[- ]?lattice|禁用\s*plan[- ]?lattice/i
const LATTICE_OVERRIDE = /(?:use|enable|force)\s+(?:the\s+)?full\s+(?:plan[- ]?)?lattice|使用(?:完整|全量)(?:的)?\s*(?:plan[- ]?)?lattice|启用完整\s*(?:plan[- ]?)?lattice/i
const NO_QUESTIONS_OVERRIDE = /(?:do not|don't|without)\s+(?:ask|clarify)|make reasonable assumptions|不要提问|无需提问|合理假设/i

export function extractMessageText(message: { content?: readonly unknown[] }): string {
  if (!Array.isArray(message.content)) return ''
  return message.content.flatMap(block => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as { type?: unknown; text?: unknown }
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  }).join('\n').trim()
}

export function isMaterialChange(text: string): boolean {
  return /(?:change|instead|new requirement|remove|cancel|scope (?:changed|change)|fact (?:changed|change)|改成|改为|新增需求|需求变了|取消|删除需求|范围变化|事实变化|不要再)/i.test(text)
}

function isOutcomeCritical(invariants: TaskInvariantAssessment): boolean {
  return invariants.authorityImpact >= 4
    || invariants.boundaryCoupling >= 6
    || invariants.definitionGap >= 4
    || invariants.changeVolatility >= 7
}

function requiresLongControl(invariants: TaskInvariantAssessment): boolean {
  return invariants.executionSpan >= 8
    || invariants.declaredLongHorizon
    || invariants.programCommitment && invariants.boundaryCoupling >= 4
    || invariants.structuralRefactor && invariants.boundaryCoupling >= 4
    || invariants.recoveryUnavailable
    || invariants.changeVolatility >= 7
      && (invariants.boundaryCoupling >= 4 || invariants.coordinationLoad >= 4)
    || invariants.coordinationLoad >= 6 && invariants.executionSpan >= 5
    || invariants.stateTransition
      && invariants.boundaryCoupling >= 6
      && invariants.executionSpan >= 6
}

function permitsZeroOverheadBypass(invariants: TaskInvariantAssessment): boolean {
  return (invariants.boundedChange || invariants.informationalRequest)
    && invariants.definitionGap <= 2
    && invariants.executionSpan <= 3
    && invariants.authorityImpact < 4
    && invariants.boundaryCoupling < 4
    && invariants.changeVolatility < 3
    && invariants.coordinationLoad < 3
    && invariants.reversible
}

function requiresContract(invariants: TaskInvariantAssessment): boolean {
  return invariants.definitionGap >= 4
    || invariants.authorityImpact >= 4
    || invariants.boundaryCoupling >= 6
    || invariants.irreversibleSideEffect
}

function supportsLearnedPrior(invariants: TaskInvariantAssessment): boolean {
  return invariants.executionSpan >= 4
    || invariants.definitionGap >= 2
    || invariants.boundaryCoupling >= 2
    || invariants.authorityImpact >= 2
    || invariants.coordinationLoad >= 2
    || invariants.productDefinition
}

export function routeRequest(textInput: string, config: RouteConfig): RouteAssessment {
  const text = textInput.trim()
  const clarificationPolicy = NO_QUESTIONS_OVERRIDE.test(text)
    ? 'never'
    : config.clarificationPolicy

  if (BYPASS_OVERRIDE.test(text)) {
    return {
      phase: 'bypass', confidence: 'high', executionSpan: 0, productDefinitionGap: 0,
      outcomeCritical: false, clarificationPolicy, reasons: ['explicit bypass'],
    }
  }
  if (LATTICE_OVERRIDE.test(text)) {
    return {
      phase: 'lattice', confidence: 'high', executionSpan: 10, productDefinitionGap: 0,
      outcomeCritical: true, clarificationPolicy, reasons: ['explicit full-lattice override'],
    }
  }
  if (config.activationMode === 'off') {
    return {
      phase: 'bypass', confidence: 'high', executionSpan: 0, productDefinitionGap: 0,
      outcomeCritical: false, clarificationPolicy, reasons: ['activationMode is off'],
    }
  }
  if (config.activationMode === 'always') {
    return {
      phase: config.controlCeiling, confidence: 'high',
      executionSpan: config.controlCeiling === 'lattice' ? 8 : 5,
      productDefinitionGap: 0, outcomeCritical: false, clarificationPolicy,
      reasons: ['activationMode is always'],
    }
  }

  const invariants = assessTaskInvariants(text, config.longTaskThreshold)
  const learnedPrior = classifyRouteText(text)
  const evidence = invariants.evidence.length === 0
    ? ['no decisive task invariant is explicit']
    : invariants.evidence
  const outcomeCritical = isOutcomeCritical(invariants)
  const result = (
    phase: RoutePhase,
    confidence: RouteAssessment['confidence'],
    reasons: string[],
  ): RouteAssessment => ({
    phase,
    confidence,
    executionSpan: invariants.executionSpan,
    productDefinitionGap: invariants.definitionGap,
    outcomeCritical: phase === 'bypass' ? false : outcomeCritical,
    clarificationPolicy,
    reasons,
  })

  if (requiresLongControl(invariants)) {
    return result(config.controlCeiling, 'high', evidence)
  }
  if (permitsZeroOverheadBypass(invariants)) {
    return result('bypass', 'high', evidence)
  }
  if (requiresContract(invariants)) {
    const learnedLongControl = learnedPrior.label === 'lattice'
      && learnedPrior.confidence >= 0.72
      && (invariants.executionSpan >= 5
        || invariants.boundaryCoupling >= 6
        || invariants.coordinationLoad >= 4)
    return result(
      learnedLongControl ? config.controlCeiling : 'contract',
      'high',
      [...evidence, `offline prior: ${learnedPrior.label} ${learnedPrior.confidence.toFixed(3)}`],
    )
  }

  const priorHasSupport = supportsLearnedPrior(invariants)
  if (learnedPrior.label === 'lattice' && learnedPrior.confidence >= 0.75 && priorHasSupport) {
    return result(config.controlCeiling, 'high', [
      ...evidence,
      `offline prior confirms long control at ${learnedPrior.confidence.toFixed(3)}`,
    ])
  }
  if (learnedPrior.label === 'contract' && learnedPrior.confidence >= 0.70 && priorHasSupport) {
    return result('contract', 'high', [
      ...evidence,
      `offline prior confirms contract control at ${learnedPrior.confidence.toFixed(3)}`,
    ])
  }
  if (learnedPrior.label === 'bypass' && learnedPrior.confidence >= 0.72 && !outcomeCritical) {
    return result('bypass', 'high', [
      ...evidence,
      `offline prior confirms bounded execution at ${learnedPrior.confidence.toFixed(3)}`,
    ])
  }
  return result('probe', 'needs-evidence', [
    ...evidence,
    `offline prior is not decisive: ${learnedPrior.label} ${learnedPrior.confidence.toFixed(3)}, margin ${learnedPrior.margin.toFixed(3)}`,
  ])
}
