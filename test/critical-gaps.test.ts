import { describe, expect, it } from 'vitest'
import type { IntakeFraming, IntakeQuestion } from '../src/intake.js'
import {
  assessCriticalGapCoverage,
  CRITICAL_GAP_DIMENSIONS,
  findCriticalGaps,
  findUncoveredRequiredCriticalGaps,
} from '../src/critical-gaps.js'

function framing(overrides: Partial<IntakeFraming> = {}): IntakeFraming {
  return {
    requestSummary: 'Implement the requested application.',
    estimatedSteps: 8,
    systemBoundary: 'Unknown',
    timeHorizon: 'One implementation cycle.',
    desiredOutcome: 'TBD',
    confirmedFacts: [],
    decisions: [],
    invariants: [],
    changeables: [],
    forces: [],
    keyVariables: [],
    assumptions: [],
    unknowns: [],
    readiness: 'conditional',
    readinessRationale: 'More information is required.',
    ...overrides,
  }
}

function question(id: string, text: string): IntakeQuestion {
  return { id, question: text }
}

describe('critical gap coverage', () => {
  it('returns every missing dimension in stable order', () => {
    expect(findCriticalGaps(framing())).toEqual(CRITICAL_GAP_DIMENSIONS)
  })

  it('uses explicit outcome and boundary evidence without treating them as other dimensions', () => {
    const result = assessCriticalGapCoverage(framing({
      desiredOutcome: 'Operators can resolve support cases without losing data.',
      systemBoundary: 'Only this repository is in scope; deployment is excluded.',
    }))

    expect(result.gaps).toEqual(['truth-source', 'authority', 'acceptance'])
    expect(result.coverage.find(item => item.dimension === 'outcome')?.authoritativeEvidence).toEqual([
      { field: 'desiredOutcome', value: 'Operators can resolve support cases without losing data.' },
    ])
    expect(result.coverage.find(item => item.dimension === 'side-effects')?.authoritativeEvidence).toEqual([
      { field: 'systemBoundary', value: 'Only this repository is in scope; deployment is excluded.' },
    ])
  })

  it('accepts authoritative facts, decisions, and invariants for the remaining dimensions', () => {
    const complete = framing({
      desiredOutcome: 'Customers can recover a saved draft.',
      systemBoundary: 'Only the editor service is in scope.',
      confirmedFacts: ['PostgreSQL is the canonical source of truth for drafts.'],
      decisions: ['The release owner must approve deployment.'],
      invariants: [
        'No production write or deployment occurs without rollback.',
        'Unit and integration tests must pass as acceptance criteria.',
      ],
    })

    expect(findCriticalGaps(complete)).toEqual([])
  })

  it('does not treat assumptions, unknowns, variables, or readiness claims as authoritative', () => {
    const result = findCriticalGaps(framing({
      assumptions: ['PostgreSQL is probably the source of truth.'],
      unknowns: ['Who can approve the production deployment?'],
      keyVariables: ['Acceptance criteria and success metrics.'],
      readinessRationale: 'Outcome, scope, truth source, authority, side effects, and acceptance are known.',
    }))

    expect(result).toEqual(CRITICAL_GAP_DIMENSIONS)
  })

  it('does not let one unrelated question satisfy critical mode', () => {
    const gaps = findCriticalGaps(framing(), [question('color', 'Which accent color should the header use?')])
    expect(gaps).toEqual(CRITICAL_GAP_DIMENSIONS)
  })

  it('does not let model-authored framing close a gap found in the original request', () => {
    const modelFraming = framing({
      desiredOutcome: 'Operators can resolve support cases.',
      systemBoundary: 'Only this repository is in scope.',
      confirmedFacts: ['PostgreSQL is the source of truth.'],
      decisions: ['The administrator approves access.'],
      invariants: ['Deployment is reversible and all acceptance tests pass.'],
    })

    expect(findCriticalGaps(modelFraming)).toEqual([])
    expect(findUncoveredRequiredCriticalGaps(
      ['outcome', 'scope', 'acceptance'],
      [question('color', 'Which accent color should the header use?')],
    )).toEqual(['outcome', 'scope', 'acceptance'])
  })

  it('closes only the required dimensions explicitly covered by questions', () => {
    expect(findUncoveredRequiredCriticalGaps(
      ['outcome', 'scope', 'acceptance'],
      [
        question('outcome-scope', 'What observable result must users achieve, and which modules are in scope?'),
        question('acceptance', 'Which tests and observable proof must pass for acceptance?'),
      ],
    )).toEqual([])
  })

  it('credits a question only to dimensions its semantics cover', () => {
    const result = assessCriticalGapCoverage(framing(), [
      question('acceptance', 'Which tests and observable proof must pass for acceptance?'),
    ])

    expect(result.gaps).toEqual(['outcome', 'scope', 'truth-source', 'authority', 'side-effects'])
    expect(result.coverage.find(item => item.dimension === 'acceptance')?.questionIds).toEqual(['acceptance'])
    expect(result.coverage.filter(item => item.dimension !== 'acceptance').every(item => item.questionIds.length === 0)).toBe(true)
  })

  it('allows one question to cover multiple dimensions when it asks about each one', () => {
    const result = assessCriticalGapCoverage(framing(), [
      question('release', 'Who may approve deployment, and must it support rollback?'),
    ])

    expect(result.coverage.find(item => item.dimension === 'authority')?.questionIds).toEqual(['release'])
    expect(result.coverage.find(item => item.dimension === 'side-effects')?.questionIds).toEqual(['release'])
    expect(result.gaps).toEqual(['outcome', 'scope', 'truth-source', 'acceptance'])
  })

  it('examines question headers and option descriptions but never question ids', () => {
    const questions: IntakeQuestion[] = [{
      id: 'truth-source-authority-acceptance',
      header: 'Canonical records',
      question: 'Choose the data policy.',
      options: [
        { label: 'Database', description: 'PostgreSQL is the authoritative source of truth.' },
        { label: 'Cache', description: 'Redis is the canonical record.' },
      ],
    }]
    const result = assessCriticalGapCoverage(framing(), questions)

    expect(result.coverage.find(item => item.dimension === 'truth-source')?.questionIds).toEqual([
      'truth-source-authority-acceptance',
    ])
    expect(result.coverage.find(item => item.dimension === 'authority')?.questionIds).toEqual([])
    expect(result.coverage.find(item => item.dimension === 'acceptance')?.questionIds).toEqual([])
  })

  it('combines evidence and focused questions across all six dimensions', () => {
    const base = framing({
      desiredOutcome: 'Operators can find and resolve the correct case.',
      systemBoundary: 'Only the support API and UI are in scope.',
    })
    const questions = [
      question('truth', 'Which database is the authoritative source of truth for cases?'),
      question('authority', 'Who may approve access to archived cases?'),
      question('effects', 'Should this deploy to production, and what rollback is required?'),
      question('acceptance', 'What checks and success metrics must pass for acceptance?'),
    ]

    expect(findCriticalGaps(base, questions)).toEqual([])
  })

  it('recognizes equivalent non-English semantics while keeping source ASCII', () => {
    const questions = [
      question('outcome', '\u7528\u6237\u7684\u9884\u671f\u7ed3\u679c\u662f\u4ec0\u4e48\uff1f'),
      question('scope', '\u54ea\u4e9b\u6a21\u5757\u5728\u8303\u56f4\u5185\uff0c\u54ea\u4e9b\u9700\u8981\u6392\u9664\uff1f'),
      question('truth', '\u54ea\u4e2a\u6570\u636e\u5e93\u662f\u6743\u5a01\u6765\u6e90\uff1f'),
      question('authority', '\u8c01\u53ef\u4ee5\u5ba1\u6279\u8fd9\u4e2a\u64cd\u4f5c\uff1f'),
      question('effects', '\u662f\u5426\u5141\u8bb8\u90e8\u7f72\uff0c\u5982\u4f55\u56de\u6eda\uff1f'),
      question('acceptance', '\u9a8c\u6536\u65f6\u5fc5\u987b\u901a\u8fc7\u54ea\u4e9b\u9a8c\u8bc1\uff1f'),
    ]

    expect(findCriticalGaps(framing(), questions)).toEqual([])
  })

  it('does not mutate framing or question inputs', () => {
    const input = framing({ decisions: ['The owner approves publication.'] })
    const questions = [question('acceptance', 'What tests must pass?')]
    const before = JSON.stringify({ input, questions })

    assessCriticalGapCoverage(input, questions)

    expect(JSON.stringify({ input, questions })).toBe(before)
  })
})
