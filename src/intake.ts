import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const INTAKE_SCHEMA_VERSION = 1
export const INTAKE_DOCUMENT_PATH = '.dsh/plan-lattice/v1/INTAKE.md'
const INTAKE_RECORD_PATH = '.dsh/plan-lattice/v1/intake.json'

export type IntakeDecision = 'guided' | 'autonomous'

export interface IntakeQuestion {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

export interface IntakeAnswer {
  id: string
  selected: string[]
  custom?: string
}

export interface IntakeFraming {
  requestSummary: string
  estimatedSteps: number
  systemBoundary: string
  timeHorizon: string
  desiredOutcome: string
  confirmedFacts: string[]
  decisions: string[]
  invariants: string[]
  changeables: string[]
  forces: string[]
  keyVariables: string[]
  assumptions: string[]
  unknowns: string[]
  readiness: 'ready' | 'conditional'
  readinessRationale: string
}

export interface IntakeReceipt {
  id: string
  schemaVersion: typeof INTAKE_SCHEMA_VERSION
  sessionId: string
  decision: IntakeDecision
  estimatedSteps: number
  documentPath: typeof INTAKE_DOCUMENT_PATH
  documentDigest: string
  createdAt: string
}

interface IntakeRecord extends IntakeReceipt {
  framing: IntakeFraming
  questions: IntakeQuestion[]
  answers: IntakeAnswer[]
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function renderList(values: string[], empty: string): string {
  return values.length === 0 ? `- ${empty}` : values.map(value => `- ${value}`).join('\n')
}

function renderAnswers(questions: IntakeQuestion[], answers: IntakeAnswer[]): string {
  if (questions.length === 0) return '- No clarification round was requested; explicit assumptions below govern autonomous execution.'
  const answerById = new Map(answers.map(answer => [answer.id, answer]))
  return questions.map(question => {
    const answer = answerById.get(question.id)
    const selected = answer?.selected.length === 0 ? 'None' : answer?.selected.join(', ')
    const custom = answer?.custom === undefined ? '' : `\n- Custom answer: ${answer.custom}`
    return `### ${question.header ?? question.id}\n\n${question.question}\n\n- Selected: ${selected ?? 'None'}${custom}`
  }).join('\n\n')
}

export function renderIntakeContract(input: {
  receiptId: string
  decision: IntakeDecision
  framing: IntakeFraming
  questions: IntakeQuestion[]
  answers: IntakeAnswer[]
  createdAt: string
}): string {
  const { framing } = input
  return `# Execution Intake Contract

- Receipt: ${input.receiptId}
- Decision: ${input.decision}
- Estimated atomic steps: ${framing.estimatedSteps}
- Created: ${input.createdAt}

## Request

${framing.requestSummary}

## System Boundary

${framing.systemBoundary}

## Time Horizon

${framing.timeHorizon}

## Desired Outcome

${framing.desiredOutcome}

## Evidence-Supported Facts

${renderList(framing.confirmedFacts, 'No repository or user-confirmed fact was supplied.')}

## User And Product Decisions

${renderList(framing.decisions, 'No explicit decision was supplied.')}

## Invariants

${renderList(framing.invariants, 'No invariant was supplied.')}

## Changeable Forms

${renderList(framing.changeables, 'No changeable form was supplied.')}

## Directional Forces

${renderList(framing.forces, 'No directional force was supplied.')}

## Minimal Causal Variables

${renderList(framing.keyVariables, 'No key variable was supplied.')}

## Explicit Assumptions

${renderList(framing.assumptions, 'No assumption was supplied.')}

## Known Unknowns

${renderList(framing.unknowns, 'No unresolved unknown was supplied.')}

## Execution Readiness

- Status: ${framing.readiness}
- Rationale: ${framing.readinessRationale}

## Human Clarifications

${renderAnswers(input.questions, input.answers)}

## Operating Rule

User-confirmed answers and decisions outrank model assumptions. Preserve the invariants and desired outcome. Adapt changeable forms in response to directional forces. When readiness is conditional, keep choices reversible around every listed unknown. Reopen clarification when a new unknown can materially change scope, risk, investment, acceptance criteria, or irreversible work.
`
}

function assertRecord(value: unknown): asserts value is IntakeRecord {
  if (typeof value !== 'object' || value === null) throw new Error('intake record is not an object')
  const record = value as Partial<IntakeRecord>
  if (record.schemaVersion !== INTAKE_SCHEMA_VERSION
    || typeof record.id !== 'string'
    || typeof record.sessionId !== 'string'
    || (record.decision !== 'guided' && record.decision !== 'autonomous')
    || !Number.isSafeInteger(record.estimatedSteps)
    || (record.estimatedSteps ?? 0) < 1
    || record.documentPath !== INTAKE_DOCUMENT_PATH
    || typeof record.documentDigest !== 'string'
    || typeof record.createdAt !== 'string') {
    throw new Error('intake record has an unsupported or malformed schema')
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

export async function persistIntake(input: {
  workspace: string
  sessionId: string
  decision: IntakeDecision
  framing: IntakeFraming
  questions: IntakeQuestion[]
  answers: IntakeAnswer[]
  receiptId?: string
  createdAt?: string
}): Promise<{ receipt: IntakeReceipt; markdown: string }> {
  const id = input.receiptId ?? randomUUID()
  const createdAt = input.createdAt ?? new Date().toISOString()
  const markdown = renderIntakeContract({
    receiptId: id,
    decision: input.decision,
    framing: input.framing,
    questions: input.questions,
    answers: input.answers,
    createdAt,
  })
  const receipt: IntakeReceipt = {
    id,
    schemaVersion: INTAKE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    decision: input.decision,
    estimatedSteps: input.framing.estimatedSteps,
    documentPath: INTAKE_DOCUMENT_PATH,
    documentDigest: digest(markdown),
    createdAt,
  }
  const record: IntakeRecord = {
    ...receipt,
    framing: input.framing,
    questions: input.questions,
    answers: input.answers,
  }
  await atomicWrite(join(input.workspace, INTAKE_DOCUMENT_PATH), markdown)
  // The JSON record is the commit marker. A crash between these writes leaves
  // a digest mismatch or no record, never an accepted partial contract.
  await atomicWrite(join(input.workspace, INTAKE_RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`)
  return { receipt, markdown }
}

export async function verifyIntake(input: {
  workspace: string
  sessionId: string
  receiptId: string
  requiredDecision?: IntakeDecision
}): Promise<IntakeReceipt> {
  let record: unknown
  try {
    record = JSON.parse(await readFile(join(input.workspace, INTAKE_RECORD_PATH), 'utf8'))
  } catch (cause) {
    throw new Error('intake receipt is missing or unreadable; call lattice_intake before opening the lattice', { cause })
  }
  assertRecord(record)
  if (record.id !== input.receiptId || record.sessionId !== input.sessionId) {
    throw new Error('intake receipt is stale or belongs to another session; call lattice_intake again')
  }
  if (input.requiredDecision !== undefined && record.decision !== input.requiredDecision) {
    throw new Error(`intake mode requires a ${input.requiredDecision} receipt`)
  }
  const markdown = await readFile(join(input.workspace, INTAKE_DOCUMENT_PATH), 'utf8')
  if (digest(markdown) !== record.documentDigest) {
    throw new Error('intake contract changed after confirmation; call lattice_intake again')
  }
  return {
    id: record.id,
    schemaVersion: record.schemaVersion,
    sessionId: record.sessionId,
    decision: record.decision,
    estimatedSteps: record.estimatedSteps,
    documentPath: record.documentPath,
    documentDigest: record.documentDigest,
    createdAt: record.createdAt,
  }
}
