import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ClarificationPolicy, ControlLevel } from './router.js'
import type { IntakeAnswer, IntakeFraming, IntakeQuestion } from './intake.js'

export const CONTRACT_SCHEMA_VERSION = 2
export const CONTRACT_DOCUMENT_PATH = '.dsh/plan-lattice/v2/CONTRACT.md'
export const CONTRACT_RECORD_PATH = '.dsh/plan-lattice/v2/contract.json'

export type AnswerBindingTarget = 'confirmedFact' | 'decision' | 'invariant' | 'unknown'

export interface AnswerBinding {
  questionId: string
  target: AnswerBindingTarget
  statement: string
}

export interface AuthoritySource {
  seq: number
  messageId: string
  digest: string
}

export interface ContractReceipt {
  id: string
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION
  sessionId: string
  controlLevel: Exclude<ControlLevel, 'bypass'>
  clarificationPolicy: ClarificationPolicy
  estimatedSteps: number
  documentPath: typeof CONTRACT_DOCUMENT_PATH
  documentDigest: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ContractRecord extends ContractReceipt {
  framing: IntakeFraming
  /** Immutable human messages in the durable Session log; raw content is never copied into workspace state. */
  authoritySources?: AuthoritySource[]
  questions: IntakeQuestion[]
  answers: IntakeAnswer[]
  answerBindings: AnswerBinding[]
}

function rawAnswerText(answer: IntakeAnswer): string {
  return [answer.selected.join(', '), answer.custom]
    .filter(value => value !== undefined && value.trim() !== '')
    .join('; ')
}

export function canonicalAnswerBindingStatement(question: IntakeQuestion, answer: IntakeAnswer): string {
  const raw = rawAnswerText(answer)
  if (raw === '') throw new Error(`clarification answer ${JSON.stringify(answer.id)} has no authoritative text`)
  return `Question: ${question.question} Answer: ${raw}`
}

function validateAnswerBindings(
  questions: IntakeQuestion[],
  answers: IntakeAnswer[],
  bindings: AnswerBinding[],
): AnswerBinding[] {
  const questionById = new Map(questions.map(question => [question.id, question]))
  const answerById = new Map(answers.map(answer => [answer.id, answer]))
  if (questionById.size !== questions.length || answerById.size !== answers.length) {
    throw new Error('contract questions and answers must have unique ids')
  }
  if (questions.length !== answers.length || questions.some(question => !answerById.has(question.id))) {
    throw new Error('every contract question must have exactly one human answer')
  }
  const seen = new Set<string>()
  const validated = bindings.map(binding => {
    if (seen.has(binding.questionId)) throw new Error('every clarification answer must have exactly one binding')
    const question = questionById.get(binding.questionId)
    const answer = answerById.get(binding.questionId)
    if (question === undefined || answer === undefined) {
      throw new Error('answer binding refers to an unknown clarification question')
    }
    if (binding.target !== 'confirmedFact' && binding.target !== 'decision'
      && binding.target !== 'invariant' && binding.target !== 'unknown') {
      throw new Error('answer binding has an unsupported target')
    }
    const statement = canonicalAnswerBindingStatement(question, answer)
    if (binding.statement !== statement) {
      throw new Error('answer binding statement must be the canonical, verbatim human answer; model-authored reinterpretation is not authoritative')
    }
    seen.add(binding.questionId)
    return { ...binding, statement }
  })
  if (seen.size !== questions.length) throw new Error('every clarification answer must have exactly one binding')
  return validated
}

function validateReadiness(framing: IntakeFraming): void {
  if (framing.readiness === 'ready' && framing.unknowns.length > 0) {
    throw new Error('ready execution cannot retain unresolved unknowns')
  }
  if (framing.readiness === 'conditional' && framing.unknowns.length === 0) {
    throw new Error('conditional readiness requires at least one explicit unresolved unknown')
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function renderList(values: string[], empty: string): string {
  return values.length === 0 ? `- ${empty}` : values.map(value => `- ${value}`).join('\n')
}

export function applyAnswerBindings(framing: IntakeFraming, bindings: AnswerBinding[]): IntakeFraming {
  const next: IntakeFraming = {
    ...framing,
    confirmedFacts: [...framing.confirmedFacts],
    decisions: [...framing.decisions],
    invariants: [...framing.invariants],
    unknowns: [...framing.unknowns],
  }
  for (const binding of bindings) {
    if (binding.target === 'confirmedFact') next.confirmedFacts.push(binding.statement)
    else if (binding.target === 'decision') next.decisions.push(binding.statement)
    else if (binding.target === 'invariant') next.invariants.push(binding.statement)
    else next.unknowns.push(binding.statement)
  }
  return next
}

export function renderContract(input: {
  receiptId: string
  controlLevel: Exclude<ControlLevel, 'bypass'>
  clarificationPolicy: ClarificationPolicy
  framing: IntakeFraming
  authoritySources: AuthoritySource[]
  questions: IntakeQuestion[]
  answers: IntakeAnswer[]
  answerBindings: AnswerBinding[]
  revision: number
  createdAt: string
  updatedAt: string
}): string {
  const { framing } = input
  return `# Plan Lattice Execution Contract

- Schema: v${CONTRACT_SCHEMA_VERSION}
- Receipt: ${input.receiptId}
- Revision: ${input.revision}
- Control level: ${input.controlLevel}
- Clarification policy: ${input.clarificationPolicy}
- Estimated atomic steps: ${framing.estimatedSteps}
- Created: ${input.createdAt}
- Updated: ${input.updatedAt}

## Immutable Human Authority

${input.authoritySources.length === 0
    ? '- No durable human authority source was available; this is a legacy v2 contract.'
    : input.authoritySources.map(source => `- Session event ${source.seq}; message ${source.messageId}; sha256:${source.digest}`).join('\n')}

These references bind the complete human-authored messages in the durable Session log. The raw messages are re-read from that log after context replacement, restart, and delegation; they are not copied into this workspace contract.

## Request And Boundary

${framing.requestSummary}

- System boundary: ${framing.systemBoundary}
- Time horizon: ${framing.timeHorizon}
- Observable outcome: ${framing.desiredOutcome}

## Evidence-Supported Facts

${renderList(framing.confirmedFacts, 'None recorded.')}

## Decisions

${renderList(framing.decisions, 'None recorded.')}

## Invariants

${renderList(framing.invariants, 'None recorded.')}

## Changeable Forms

${renderList(framing.changeables, 'None recorded.')}

## Directional Forces

${renderList(framing.forces, 'None recorded.')}

## Minimal Causal Variables

${renderList(framing.keyVariables, 'None recorded.')}

## Explicit Assumptions

${renderList(framing.assumptions, 'None recorded.')}

## Known Unknowns

${renderList(framing.unknowns, 'None recorded.')}

## Acceptance Readiness

- Status: ${framing.readiness}
- Rationale: ${framing.readinessRationale}

## Operating Rule

Preserve the desired outcome and invariants, not a frozen implementation form. Reframe before guarded work when a material fact, decision, authority boundary, truth source, or acceptance criterion changes. Assumptions remain explicit and reversible. Original clarification questions, raw answers, binding targets, and provenance remain in the anchored JSON audit record; each bound answer appears exactly once above in its authoritative semantic section.
`
}

function assertRecord(value: unknown): asserts value is ContractRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('contract record is not an object')
  const record = value as Partial<ContractRecord>
  if (record.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || typeof record.id !== 'string'
    || typeof record.sessionId !== 'string'
    || (record.controlLevel !== 'contract' && record.controlLevel !== 'lattice')
    || (record.clarificationPolicy !== 'critical' && record.clarificationPolicy !== 'always' && record.clarificationPolicy !== 'never')
    || !Number.isSafeInteger(record.estimatedSteps)
    || !Number.isSafeInteger(record.revision)
    || (record.revision ?? 0) < 1
    || record.documentPath !== CONTRACT_DOCUMENT_PATH
    || typeof record.documentDigest !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || typeof record.framing !== 'object'
    || (record.authoritySources !== undefined && (!Array.isArray(record.authoritySources)
      || record.authoritySources.some(source => typeof source !== 'object' || source === null
        || !Number.isSafeInteger(source.seq) || source.seq < 0
        || typeof source.messageId !== 'string' || source.messageId.length === 0
        || typeof source.digest !== 'string' || !/^[0-9a-f]{64}$/.test(source.digest))))
    || !Array.isArray(record.questions)
    || !Array.isArray(record.answers)
    || !Array.isArray(record.answerBindings)) {
    throw new Error('contract record has an unsupported or malformed schema')
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function persistContract(input: {
  workspace: string
  sessionId: string
  controlLevel: Exclude<ControlLevel, 'bypass'>
  clarificationPolicy: ClarificationPolicy
  framing: IntakeFraming
  authoritySources?: AuthoritySource[]
  questions: IntakeQuestion[]
  answers: IntakeAnswer[]
  answerBindings: AnswerBinding[]
  receiptId?: string
  revision?: number
  createdAt?: string
}, options: {
  /** Persist a trust anchor before workspace-controlled contract files change. */
  beforeWrite?: (record: ContractRecord) => Promise<void>
} = {}): Promise<{ receipt: ContractReceipt; record: ContractRecord; markdown: string }> {
  const id = input.receiptId ?? randomUUID()
  const now = new Date().toISOString()
  const createdAt = input.createdAt ?? now
  const revision = input.revision ?? 1
  const answerBindings = validateAnswerBindings(input.questions, input.answers, input.answerBindings)
  const framing = applyAnswerBindings(input.framing, answerBindings)
  const authoritySources = [...(input.authoritySources ?? [])]
  if (new Set(authoritySources.map(source => `${source.seq}\0${source.messageId}`)).size !== authoritySources.length) {
    throw new Error('contract authority sources must be unique')
  }
  validateReadiness(framing)
  const markdown = renderContract({
    receiptId: id,
    controlLevel: input.controlLevel,
    clarificationPolicy: input.clarificationPolicy,
    framing,
    authoritySources,
    questions: input.questions,
    answers: input.answers,
    answerBindings,
    revision,
    createdAt,
    updatedAt: now,
  })
  const receipt: ContractReceipt = {
    id,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    controlLevel: input.controlLevel,
    clarificationPolicy: input.clarificationPolicy,
    estimatedSteps: framing.estimatedSteps,
    documentPath: CONTRACT_DOCUMENT_PATH,
    documentDigest: digest(markdown),
    revision,
    createdAt,
    updatedAt: now,
  }
  const record: ContractRecord = {
    ...receipt,
    framing,
    authoritySources,
    questions: input.questions,
    answers: input.answers,
    answerBindings,
  }
  await options.beforeWrite?.(record)
  await atomicWrite(join(input.workspace, CONTRACT_DOCUMENT_PATH), markdown)
  await atomicWrite(join(input.workspace, CONTRACT_RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`)
  return { receipt, record, markdown }
}

export function readContractRecordSync(workspace: string): ContractRecord | undefined {
  try {
    const record: unknown = JSON.parse(readFileSync(join(workspace, CONTRACT_RECORD_PATH), 'utf8'))
    assertRecord(record)
    return record
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function readContractSync(workspace: string): ContractRecord | undefined {
  const record = readContractRecordSync(workspace)
  if (record === undefined) return undefined
  const markdown = readFileSync(join(workspace, CONTRACT_DOCUMENT_PATH), 'utf8')
  if (digest(markdown) !== record.documentDigest) throw new Error('execution contract changed after confirmation')
  return record
}

export async function verifyContract(input: {
  workspace: string
  sessionId?: string
  receiptId?: string
  allowDifferentSession?: boolean
}): Promise<ContractRecord> {
  let record: unknown
  try {
    record = JSON.parse(await readFile(join(input.workspace, CONTRACT_RECORD_PATH), 'utf8'))
  } catch (cause) {
    throw new Error('v2 execution contract is missing or unreadable; call lattice_intake first', { cause })
  }
  assertRecord(record)
  if (input.receiptId !== undefined && record.id !== input.receiptId) throw new Error('execution contract receipt is stale')
  if (input.sessionId !== undefined && !input.allowDifferentSession && record.sessionId !== input.sessionId) {
    throw new Error('execution contract belongs to another root session')
  }
  const markdown = await readFile(join(input.workspace, CONTRACT_DOCUMENT_PATH), 'utf8')
  if (digest(markdown) !== record.documentDigest) throw new Error('execution contract changed after confirmation; call lattice_reframe')
  return record
}
