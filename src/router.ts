import { assessTaskInvariants, type TaskInvariantAssessment } from './task-invariants.js'
import type { CriticalGapDimension } from './critical-gaps.js'

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
  criticalGaps: CriticalGapDimension[]
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
  return invariants.staleMutationImpact >= 4
    || invariants.definitionGap >= 4
    || invariants.recoveryUnavailable
}

function requiresLongControl(invariants: TaskInvariantAssessment): boolean {
  if (invariants.basisInvalidationChannels.length === 0) return false
  return invariants.basisExpiryExposure >= 7
    || invariants.declaredLongHorizon
    || invariants.programCommitment
    || invariants.adaptiveSequence
    || invariants.delayedVerification
    || invariants.coordinated
    || invariants.changeVolatility >= 7
    || invariants.basisInvalidationChannels.includes('changing external source of truth')
}

function permitsZeroOverheadBypass(invariants: TaskInvariantAssessment): boolean {
  return (invariants.boundedChange || invariants.informationalRequest)
    && invariants.basisCompleteness >= 8
    && invariants.basisExpiryExposure <= 2
    && invariants.staleMutationImpact <= 2
    && invariants.reversible
}

function requiresContract(invariants: TaskInvariantAssessment): boolean {
  return invariants.definitionGap >= 4
    || invariants.staleMutationImpact >= 4
    || invariants.staleMutationImpact >= 3 && invariants.diagnosticClosure
    || invariants.mutationEpochs >= 3 && invariants.basisInvalidationChannels.length > 0
    || invariants.irreversibleSideEffect
}

export function routeRequest(textInput: string, config: RouteConfig): RouteAssessment {
  const text = textInput.trim()
  const clarificationPolicy = NO_QUESTIONS_OVERRIDE.test(text)
    ? 'never'
    : config.clarificationPolicy

  if (BYPASS_OVERRIDE.test(text)) {
    return {
      phase: 'bypass', confidence: 'high', executionSpan: 0, productDefinitionGap: 0,
      outcomeCritical: false, criticalGaps: [], clarificationPolicy, reasons: ['explicit bypass'],
    }
  }
  if (LATTICE_OVERRIDE.test(text)) {
    return {
      phase: config.controlCeiling, confidence: 'high', executionSpan: 10, productDefinitionGap: 0,
      outcomeCritical: true, criticalGaps: [], clarificationPolicy,
      reasons: [config.controlCeiling === 'lattice'
        ? 'explicit full-lattice override'
        : 'explicit full-lattice override capped by controlCeiling'],
    }
  }
  if (config.activationMode === 'off') {
    return {
      phase: 'bypass', confidence: 'high', executionSpan: 0, productDefinitionGap: 0,
      outcomeCritical: false, criticalGaps: [], clarificationPolicy, reasons: ['activationMode is off'],
    }
  }
  if (config.activationMode === 'always') {
    return {
      phase: config.controlCeiling, confidence: 'high',
      executionSpan: config.controlCeiling === 'lattice' ? 8 : 5,
      productDefinitionGap: 0, outcomeCritical: false, criticalGaps: [], clarificationPolicy,
      reasons: ['activationMode is always'],
    }
  }

  const invariants = assessTaskInvariants(text, config.longTaskThreshold)
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
    outcomeCritical,
    criticalGaps: invariants.criticalGaps,
    clarificationPolicy,
    reasons,
  })

  if (invariants.informationalRequest) {
    return result('bypass', 'high', [...evidence, 'no mutation was authorized'])
  }
  if (requiresLongControl(invariants)) {
    // Auto mode uses DSH's native plan, todo, compaction, and Session tree.
    // Long horizon alone requires continuity recovery and mutation gating, not
    // a second model-maintained execution graph. Full Lattice stays available
    // through the explicit override and activationMode=always paths above.
    return result('contract', 'high', [...evidence, 'DSH-native continuity control'])
  }
  if (invariants.targetDiscoveryRequired) {
    return result('probe', 'needs-evidence', evidence)
  }
  if (permitsZeroOverheadBypass(invariants)) {
    return result('bypass', 'high', evidence)
  }
  if (requiresContract(invariants)) {
    return result('contract', 'high', evidence)
  }
  if (invariants.productDefinition) return result('contract', 'high', evidence)
  return result('probe', 'needs-evidence', [
    ...evidence,
    'repository evidence is required to close the mutation authorization chain',
  ])
}
