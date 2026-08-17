import type { IntakeFraming, IntakeQuestion } from './intake.js'

export const CRITICAL_GAP_DIMENSIONS = [
  'outcome',
  'scope',
  'truth-source',
  'authority',
  'side-effects',
  'acceptance',
] as const

export type CriticalGapDimension = typeof CRITICAL_GAP_DIMENSIONS[number]

export type AuthoritativeFramingField =
  | 'requestSummary'
  | 'systemBoundary'
  | 'desiredOutcome'
  | 'confirmedFacts'
  | 'decisions'
  | 'invariants'

export interface CriticalGapEvidence {
  field: AuthoritativeFramingField
  value: string
}

export interface CriticalGapCoverage {
  dimension: CriticalGapDimension
  covered: boolean
  authoritativeEvidence: CriticalGapEvidence[]
  questionIds: string[]
}

export interface CriticalGapAssessment {
  coverage: CriticalGapCoverage[]
  gaps: CriticalGapDimension[]
}

const UNCERTAIN_VALUE = /^(?:unknown|unspecified|undecided|tbd|to be (?:decided|determined)|not (?:known|decided|specified)|none|n\/a)\b/i

const DIMENSION_PATTERNS: Record<CriticalGapDimension, RegExp> = {
  outcome: /(?:\b(?:desired outcome|outcome|goal|user value|business value|expected behaviou?r|observable result)\b|\b(?:users?|operators?|customers?|admins?)\s+(?:can|must|will be able to)\b|\bwhat\s+(?:should|must|will)\b.{0,48}\b(?:achieve|enable|experience|observe|result)\b|\bso that\b|\bin order to\b|\u76ee\u6807|\u9884\u671f(?:\u884c\u4e3a|\u7ed3\u679c)|\u7528\u6237\u4ef7\u503c|\u4e1a\u52a1\u4ef7\u503c|\u4e3a\u4e86)/i,
  scope: /(?:\b(?:in scope|out of scope|scope|system boundary|project boundary)\b|\b(?:include|exclude|limited to|only (?:the|this|these)|repository only|which (?:components?|modules?|services?|systems?|environments?))\b|\bpreserve all other\b|\u8303\u56f4|\u8fb9\u754c|\u5305\u542b|\u6392\u9664|\u4e0d\u5305\u542b|\u4ec5\u9650|\u53ea\u4fee\u6539|\u4fdd\u6301\u5176\u4ed6)/i,
  'truth-source': /(?:\b(?:source of truth|truth source|authoritative source|canonical (?:source|record|data|system)|system of record|master data|official record)\b|\bwhich\b.{0,48}\b(?:source|record|database|api|schema)\b.{0,32}\b(?:authoritative|canonical|trusted)\b|\bwhere\b.{0,48}\b(?:read|load|derive|obtain)\b.{0,24}\b(?:data|state|records?|facts?)\b|\u771f\u6e90|\u6743\u5a01\u6765\u6e90|\u89c4\u8303\u6765\u6e90|\u552f\u4e00\u6570\u636e\u6e90|\u4ee5.{0,24}\u4e3a\u51c6)/i,
  authority: /(?:\b(?:permission|authorization|authority|approv(?:al|er|es?)|owner|ownership|authorized|allowed to|responsible role)\b|\bwho\b.{0,40}\b(?:can|may|must|approves?|authorizes?|owns?|is responsible)\b|\bwhich (?:role|team|user)\b.{0,36}\b(?:can|may|approves?|owns?)\b|\u6743\u9650|\u6388\u6743|\u5ba1\u6279|\u8d1f\u8d23\u4eba|\u6240\u6709\u8005|\u8c01(?:\u53ef\u4ee5|\u80fd|\u6709\u6743|\u8d1f\u8d23))/i,
  'side-effects': /(?:\b(?:side effects?|external actions?|irreversible|destructive|rollback|roll back|reversible|production write|data migration|deployment|publication|deletion|migration)\b|\b(?:deploy|publish|release|delete|drop|send|charge|bill|migrate|rotate|grant|revoke)\b|\bwrite\b.{0,24}\b(?:production|external|customer|tenant)\b|\u526f\u4f5c\u7528|\u4e0d\u53ef\u9006|\u53ef\u9006|\u56de\u6eda|\u90e8\u7f72|\u53d1\u5e03|\u5220\u9664|\u53d1\u9001|\u6263\u6b3e|\u8fc1\u79fb|\u751f\u4ea7\u5199\u5165)/i,
  acceptance: /(?:\b(?:acceptance|acceptance criteria|done when|definition of done|success criteria|success metric|verification|validation|observable proof|must pass|required checks?)\b|\bhow\b.{0,36}\b(?:verify|validate|prove|measure|test)\b|\bwhat\b.{0,36}\b(?:tests?|checks?|metrics?|evidence)\b.{0,24}\b(?:pass|prove|required|show)\b|\u9a8c\u6536|\u5b8c\u6210\u6807\u51c6|\u5fc5\u987b\u901a\u8fc7|\u5982\u4f55\u9a8c\u8bc1|\u6210\u529f\u6307\u6807|\u53ef\u89c2\u5bdf\u8bc1\u636e|\u8bc1\u660e)/i,
}

function substantive(value: string): boolean {
  const normalized = value.trim()
  return normalized !== '' && !UNCERTAIN_VALUE.test(normalized)
}

function authoritativeEntries(framing: IntakeFraming): CriticalGapEvidence[] {
  const scalar: Array<[AuthoritativeFramingField, string]> = [
    ['requestSummary', framing.requestSummary],
    ['systemBoundary', framing.systemBoundary],
    ['desiredOutcome', framing.desiredOutcome],
  ]
  const lists: Array<[AuthoritativeFramingField, string[]]> = [
    ['confirmedFacts', framing.confirmedFacts],
    ['decisions', framing.decisions],
    ['invariants', framing.invariants],
  ]
  return [
    ...scalar.map(([field, value]) => ({ field, value })),
    ...lists.flatMap(([field, values]) => values.map(value => ({ field, value }))),
  ].filter(entry => substantive(entry.value))
}

function questionText(question: IntakeQuestion): string {
  return [
    question.header,
    question.question,
    ...(question.options ?? []).flatMap(option => [option.label, option.description]),
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '').join('\n')
}

export function assessCriticalGapCoverage(
  framing: IntakeFraming,
  questions: readonly IntakeQuestion[] = [],
): CriticalGapAssessment {
  const evidence = authoritativeEntries(framing)
  const questionRecords = questions.map((question, index) => ({
    id: question.id.trim() || `question-${index + 1}`,
    text: questionText(question),
  }))
  const coverage = CRITICAL_GAP_DIMENSIONS.map<CriticalGapCoverage>(dimension => {
    const pattern = DIMENSION_PATTERNS[dimension]
    const authoritativeEvidence = evidence.filter(entry => pattern.test(entry.value))
    const questionIds = questionRecords.filter(question => pattern.test(question.text)).map(question => question.id)
    return {
      dimension,
      covered: authoritativeEvidence.length > 0 || questionIds.length > 0,
      authoritativeEvidence,
      questionIds,
    }
  })
  return {
    coverage,
    gaps: coverage.filter(item => !item.covered).map(item => item.dimension),
  }
}

export function findCriticalGaps(
  framing: IntakeFraming,
  questions: readonly IntakeQuestion[] = [],
): CriticalGapDimension[] {
  return assessCriticalGapCoverage(framing, questions).gaps
}

export function findUncoveredRequiredCriticalGaps(
  required: readonly CriticalGapDimension[],
  questions: readonly IntakeQuestion[],
): CriticalGapDimension[] {
  const questionRecords = questions.map(questionText)
  return CRITICAL_GAP_DIMENSIONS.filter(dimension => required.includes(dimension))
    .filter(dimension => !questionRecords.some(text => DIMENSION_PATTERNS[dimension].test(text)))
}
