/**
 * Fractal Ledger: an evidence-gated recursive work graph for long-horizon agents.
 *
 * A lattice is deliberately not another todo list. Every controlled mutation
 * must rejoin authoritative intent (the full contract and current node plan)
 * with authoritative fact (the exact target body) immediately before action.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  assertBranchingCapacity,
  assertExpectedRevision,
  assertMutable,
  assertText,
  completeAndCollapse,
  createNode,
  findNode,
  isLeaf,
  LATTICE_SCHEMA_VERSION,
  nodeChildren,
  projectStatus,
  type LatticeDelta,
  type LatticeNode,
  type LatticeReceipt,
  type LatticeState,
} from './domain.js'
import { issueReceipt, readProjectContext, readProjectContextSync, validateContextPaths } from './context.js'
import {
  CONTRACT_DOCUMENT_PATH,
  type AnswerBinding,
  type AnswerBindingTarget,
  type ContractRecord,
  type ContractReceipt,
  persistContract,
  readContractRecordSync,
  readContractSync,
  verifyContract,
} from './contract.js'
import {
  contractMatchesAnchor,
  defaultContractAnchorRoot,
  persistContractAnchor,
  readContractAnchorSync,
} from './contract-anchor.js'
import {
  INTAKE_DOCUMENT_PATH,
  type IntakeAnswer,
  type IntakeDecision,
  type IntakeFraming,
  type IntakeQuestion,
  persistIntake,
  renderIntakeContract,
  verifyIntake,
} from './intake.js'
import {
  type ActivationMode,
  type ClarificationPolicy,
  type ControlCeiling,
  type RouteAssessment,
  type RoutePhase,
  extractMessageText,
  isMaterialChange,
  routeRequest,
} from './router.js'
import { LatticeStore } from './store.js'
import {
  type MutationBasis,
  mutationTargetFromTool,
  nodeExecutionPlan,
  normalizeMutationTarget,
  readMutationTargets,
  structuralPlanView,
  type StructuralPlanView,
  verifyMutationTargetSync,
} from './mutation-context.js'

export const name = 'plan-lattice'
export const inject = ['tools']

export interface Config {
  /** Legacy v0.3 intake policy. Do not mix with v0.4 activation fields. */
  intakeMode?: 'off' | 'adaptive' | 'guided'
  /** Task activation policy. Defaults to zero-call automatic routing. */
  activationMode?: ActivationMode
  /** Which unknowns may be asked before the execution contract is committed. */
  clarificationPolicy?: ClarificationPolicy
  /** Highest automatic control level, useful for lightweight deployments and ablations. */
  controlCeiling?: ControlCeiling
  /** Estimated atomic-step count used as one long-task signal. */
  longTaskThreshold?: number
  /** Tools that cannot run without an active, synchronized lattice leaf. */
  guardedTools?: string[]
  /** Include all bash calls in the guard; commands cannot be reliably classified as read-only. */
  strictBash?: boolean
  /** Maximum combined byte size of the full context contract rendered to the agent. */
  maxContextBytes?: number
  /** At most this many root nodes may exist at once. */
  topLevelLimit?: number
  /** At most this many non-root children may exist at once. */
  nestedLimit?: number
  /** Number of deltas between materialized snapshots. */
  snapshotEvery?: number
  /** Durable trust root for session contract anchors. Keep it outside agent-writable workspaces. */
  contractAnchorRoot?: string
}

interface ResolvedConfig {
  legacyIntakeMode?: 'off' | 'adaptive' | 'guided'
  activationMode: ActivationMode
  clarificationPolicy: ClarificationPolicy
  controlCeiling: ControlCeiling
  longTaskThreshold: number
  guardedTools: Set<string>
  maxContextBytes: number
  topLevelLimit: number
  nestedLimit: number
  snapshotEvery: number
  contractAnchorRoot: string
}

interface ExecutionLease {
  workspace: string
  nodeId: string
  revision: number
  dirty: boolean
  /** Contract that was last rendered to the model before this lease may write. */
  contextDigest: string
  contextPaths: string[]
  /** The durable event that replaced model-visible history after the last explicit context read. */
  compactionSeq?: number
  /** One mutation basis rendered after checkout: contract + node lineage + exact target bodies. */
  mutationBasis?: MutationBasis
}

interface AgentLike {
  session: {
    id: unknown
    header: { cwd?: string; parentSession?: unknown; origin?: 'subagent'; delegationDepth?: number }
  }
}

interface AgentControl {
  phase: RoutePhase
  clarificationPolicy: ClarificationPolicy
  reasons: string[]
  rootSessionId: string
  contract?: ContractRecord
  reframePending: boolean
  compactionSeq?: number
  /** Contract-tier equivalent of the mutation basis (there is no node lineage). */
  mutationBasis?: MutationBasis
  restriction?: () => void
}

interface PendingIntake {
  id: string
  workspace: string
  sessionId: string
  kind: 'intake' | 'reframe'
  controlLevel: 'contract' | 'lattice'
  clarificationPolicy: ClarificationPolicy
  framing: IntakeFraming
  questions: IntakeQuestion[]
  answers: IntakeAnswer[]
  previousContract?: ContractRecord
  replaceUntrustedContract?: boolean
  latticeRevision?: number
}

const LATTICE_TOOL_NAMES = [
  'lattice_route',
  'lattice_intake',
  'lattice_commit_intake',
  'lattice_open',
  'lattice_status',
  'lattice_refresh_context',
  'lattice_adopt_context',
  'lattice_reframe',
  'lattice_add',
  'lattice_split',
  'lattice_update',
  'lattice_archive',
  'lattice_checkout',
  'lattice_checkpoint',
] as const

/** The Harness validates every tool value at runtime; this boundary keeps the domain types isolated. */
function json(value: unknown): never {
  return value as never
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${field} must be a positive safe integer`)
  return resolved
}

function resolveConfig(config: Config): ResolvedConfig {
  const usesNewActivation = config.activationMode !== undefined
    || config.clarificationPolicy !== undefined
    || config.controlCeiling !== undefined
  if (config.intakeMode !== undefined && usesNewActivation) {
    throw new Error('intakeMode is a v0.3 compatibility field and cannot be mixed with activationMode, clarificationPolicy, or controlCeiling; migrate off -> activationMode always + clarificationPolicy never, adaptive -> activationMode always + clarificationPolicy critical, or guided -> activationMode always + clarificationPolicy always')
  }
  if (config.intakeMode !== undefined
    && config.intakeMode !== 'off'
    && config.intakeMode !== 'adaptive'
    && config.intakeMode !== 'guided') {
    throw new Error('intakeMode must be off, adaptive, or guided')
  }
  const activationMode = config.intakeMode === undefined ? config.activationMode ?? 'auto' : 'always'
  const clarificationPolicy = config.intakeMode === undefined
    ? config.clarificationPolicy ?? 'critical'
    : config.intakeMode === 'guided' ? 'always' : config.intakeMode === 'adaptive' ? 'critical' : 'never'
  const controlCeiling = config.controlCeiling ?? 'lattice'
  if (activationMode !== 'off' && activationMode !== 'auto' && activationMode !== 'always') {
    throw new Error('activationMode must be off, auto, or always')
  }
  if (clarificationPolicy !== 'critical' && clarificationPolicy !== 'always' && clarificationPolicy !== 'never') {
    throw new Error('clarificationPolicy must be critical, always, or never')
  }
  if (controlCeiling !== 'contract' && controlCeiling !== 'lattice') {
    throw new Error('controlCeiling must be contract or lattice')
  }
  const guardedTools = new Set(config.guardedTools ?? ['write', 'edit', 'str_replace_editor'])
  if (config.strictBash === true) guardedTools.add('bash')
  for (const tool of guardedTools) {
    if (tool.trim().length === 0) throw new Error('guardedTools must not contain an empty name')
  }
  return {
    ...(config.intakeMode === undefined ? {} : { legacyIntakeMode: config.intakeMode }),
    activationMode,
    clarificationPolicy,
    controlCeiling,
    longTaskThreshold: positiveInteger(config.longTaskThreshold, 8, 'longTaskThreshold'),
    guardedTools,
    maxContextBytes: positiveInteger(config.maxContextBytes, 256 * 1024, 'maxContextBytes'),
    topLevelLimit: positiveInteger(config.topLevelLimit, 2, 'topLevelLimit'),
    nestedLimit: positiveInteger(config.nestedLimit, 5, 'nestedLimit'),
    snapshotEvery: positiveInteger(config.snapshotEvery, 1024, 'snapshotEvery'),
    contractAnchorRoot: resolve(config.contractAnchorRoot ?? defaultContractAnchorRoot()),
  }
}

function statusNodeLimit(value: number | undefined): number {
  const limit = positiveInteger(value, 16, 'maxNodes')
  if (limit > 64) throw new Error('maxNodes must not exceed 64')
  return limit
}

function sessionKey(agent: AgentLike): string {
  return String(agent.session.id)
}

async function workspaceFor(agent: AgentLike | undefined): Promise<string> {
  if (agent === undefined) throw new Error('plan lattice tools require an owning agent session')
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('plan lattice tools require a session workspace')
  return realpath(cwd)
}

function renderSummary(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as { message?: unknown }
  return [{ type: 'text', text: typeof record.message === 'string' ? record.message : 'Plan lattice updated.' }]
}

function renderContext(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as {
    message?: unknown
    receipt?: { id?: unknown; revision?: unknown; digest?: unknown }
    documents?: { path: string; digest: string; content: string }[]
    executionPlan?: {
      digest: string
      lineage: Array<{ id: string; title: string; acceptanceCriteria: string; status: string }>
    }
    planContext?: StructuralPlanView
    targets?: Array<{ path: string; state: 'file' | 'missing'; digest: string; content?: string }>
  }
  const heading = typeof record.message === 'string' ? record.message : 'Read the current project context.'
  const documents = record.documents ?? []
  const receipt = record.receipt
  const receiptText = typeof receipt?.id === 'string' && Number.isSafeInteger(receipt.revision)
    ? `Fresh context receipt (copy these exact values into the next structural lattice call):\n- receiptId: ${receipt.id}\n- expectedRevision: ${receipt.revision}${typeof receipt.digest === 'string' ? `\n- contextDigest: ${receipt.digest}` : ''}`
    : ''
  return [{
    type: 'text',
    text: `${heading}${receiptText === '' ? '' : `\n\n${receiptText}`}\n\n${documents.map(document => (
      `--- ${document.path} (sha256:${document.digest}) ---\n${document.content}`
    )).join('\n\n')}${record.planContext === undefined ? '' : `\n\n--- CURRENT PLAN STRUCTURE (sha256:${record.planContext.digest}) ---\n${JSON.stringify(record.planContext, null, 2)}`}${record.executionPlan === undefined ? '' : `\n\n--- CURRENT EXECUTION PLAN (sha256:${record.executionPlan.digest}) ---\n${record.executionPlan.lineage.map((node, index) => `${index + 1}. [${node.status}] ${node.title}\n   Node: ${node.id}\n   Acceptance: ${node.acceptanceCriteria}`).join('\n')}`}${record.targets === undefined || record.targets.length === 0 ? '' : `\n\n${record.targets.map(target => target.state === 'file'
      ? `--- MUTATION TARGET ${target.path} (sha256:${target.digest}) ---\n${target.content ?? ''}`
      : `--- MUTATION TARGET ${target.path} (missing; sha256:${target.digest}) ---\nThis path did not exist when the mutation basis was issued.`).join('\n\n')}`}`,
  }]
}

function renderIntake(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as { message?: unknown; contract?: unknown; pendingIntakeId?: unknown; answers?: unknown }
  const message = typeof record.message === 'string' ? record.message : 'Execution intake confirmed.'
  const contract = typeof record.contract === 'string' ? record.contract : ''
  const pending = typeof record.pendingIntakeId === 'string'
    ? `\n\nPending intake: ${record.pendingIntakeId}\nBind every answer with lattice_commit_intake before execution.\n${JSON.stringify(record.answers ?? [], null, 2)}`
    : ''
  return [{ type: 'text', text: contract === '' ? `${message}${pending}` : `${message}\n\n${contract}${pending}` }]
}

function renderReframe(args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as { pendingIntakeId?: unknown }
  return typeof record.pendingIntakeId === 'string' ? renderIntake(args, value) : renderContext(args, value)
}

function textList(values: string[], field: string): string[] {
  return values.map((value, index) => assertText(value, `${field}[${index}]`))
}

function normalizeQuestions(questions: IntakeQuestion[]): IntakeQuestion[] {
  if (questions.length > 5) throw new Error('intake accepts at most five high-impact clarification questions')
  const ids = new Set<string>()
  return questions.map((question, index) => {
    const id = assertText(question.id, `questions[${index}].id`)
    if (ids.has(id)) throw new Error(`duplicate clarification question id ${JSON.stringify(id)}`)
    ids.add(id)
    const options = question.options?.map((option, optionIndex) => ({
      label: assertText(option.label, `questions[${index}].options[${optionIndex}].label`),
      ...(option.description === undefined
        ? {}
        : { description: assertText(option.description, `questions[${index}].options[${optionIndex}].description`) }),
    }))
    return {
      id,
      question: assertText(question.question, `questions[${index}].question`),
      ...(question.header === undefined ? {} : { header: assertText(question.header, `questions[${index}].header`) }),
      ...(options === undefined ? {} : { options }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    }
  })
}

function requireAnswers(questions: IntakeQuestion[], answers: IntakeAnswer[]): IntakeAnswer[] {
  const expected = new Set(questions.map(question => question.id))
  const seen = new Set<string>()
  for (const answer of answers) {
    if (!expected.has(answer.id) || seen.has(answer.id)) {
      throw new Error('the clarification provider returned unknown or duplicate answer ids')
    }
    if (answer.selected.length === 0 && (answer.custom === undefined || answer.custom.trim() === '')) {
      throw new Error(`clarification question ${JSON.stringify(answer.id)} was not answered`)
    }
    seen.add(answer.id)
  }
  if (seen.size !== expected.size) throw new Error('the clarification provider did not answer every question')
  return answers.map(answer => ({
    id: answer.id,
    selected: textList(answer.selected, `answer ${answer.id}.selected`),
    ...(answer.custom === undefined ? {} : { custom: assertText(answer.custom, `answer ${answer.id}.custom`) }),
  }))
}

function selectedAnswer(answers: IntakeAnswer[], id: string): IntakeAnswer {
  const matches = answers.filter(answer => answer.id === id)
  if (matches.length !== 1) throw new Error(`the user-question provider did not return exactly one ${id} answer`)
  return matches[0]!
}

function intakeReadiness(value: 'ready' | 'conditional', unknowns: string[]): 'ready' | 'conditional' {
  if (value === 'conditional' && unknowns.length === 0) {
    throw new Error('conditional readiness requires at least one explicit unresolved unknown')
  }
  return value
}

function delta(state: LatticeState, upserts: LatticeNode[], includeProject = false): LatticeDelta {
  return {
    revision: state.revision,
    ...(includeProject ? { project: state.project } : {}),
    upserts,
  }
}

/** Install the tool surface and the execution gate. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const store = new LatticeStore({ snapshotEvery: resolved.snapshotEvery })
  const receipts = new Map<string, LatticeReceipt>()
  const structuralContexts = new Map<string, { workspace: string; view: StructuralPlanView }>()
  const leases = new Map<string, ExecutionLease>()
  const intakeInProgress = new Set<string>()
  const controls = new Map<string, AgentControl>()
  const pendingIntakes = new Map<string, PendingIntake>()

  function requireContractAnchor(record: ContractRecord): ContractRecord {
    const anchor = readContractAnchorSync(resolved.contractAnchorRoot, record.sessionId)
    if (anchor === undefined) throw new Error('execution contract has no durable session anchor; call lattice_reframe')
    if (!contractMatchesAnchor(record, anchor)) {
      throw new Error('execution contract differs from its durable session anchor; call lattice_reframe')
    }
    return anchor
  }

  async function persistConfirmedContract(input: Parameters<typeof persistContract>[0]) {
    return persistContract(input, {
      beforeWrite: record => persistContractAnchor(resolved.contractAnchorRoot, record),
    })
  }

  async function verifyAnchoredContract(input: Parameters<typeof verifyContract>[0]): Promise<ContractRecord> {
    return requireContractAnchor(await verifyContract(input))
  }

  function fallbackControl(agent: AgentLike | undefined): AgentControl {
    const phase: RoutePhase = resolved.legacyIntakeMode !== undefined
      ? 'lattice'
      : resolved.activationMode === 'off'
        ? 'bypass'
        : resolved.activationMode === 'always'
          ? resolved.controlCeiling
          : 'lattice'
    const key = agent === undefined ? 'diagnostic' : sessionKey(agent)
    return {
      phase,
      clarificationPolicy: resolved.clarificationPolicy,
      reasons: ['untracked or compatibility session'],
      rootSessionId: key,
      reframePending: false,
    }
  }

  function controlFor(agent: AgentLike | undefined): AgentControl {
    return agent === undefined ? fallbackControl(undefined) : controls.get(sessionKey(agent)) ?? fallbackControl(agent)
  }

  function controlPrompt(agent: AgentLike | undefined): string {
    if (agent === undefined && resolved.legacyIntakeMode === undefined) return ''
    const control = controlFor(agent)
    if (control.phase === 'bypass') return ''
    if (control.phase === 'probe') {
      return `## Plan Lattice route probe

The request cannot yet be classified safely. Read repository evidence without mutating it, then call lattice_route exactly once with a structured risk assessment. Guarded writes are blocked until routing completes. Do not ask the user during the probe.`
    }
    const child = agent?.session.header.origin === 'subagent' || (agent?.session.header.delegationDepth ?? 0) > 0
    const contract = control.contract
    const capsule = contract === undefined ? '' : `

Execution capsule (contract revision ${contract.revision}):
- Outcome: ${contract.framing.desiredOutcome}
- Boundary: ${contract.framing.systemBoundary}
- Invariants: ${contract.framing.invariants.join('; ') || 'none recorded'}
- Decisions: ${contract.framing.decisions.join('; ') || 'none recorded'}
- Acceptance: ${contract.framing.readinessRationale}
- Unknowns: ${contract.framing.unknowns.join('; ') || 'none'}
- Current node: ${agent === undefined ? 'none' : leases.get(sessionKey(agent))?.nodeId ?? 'none'}
- Revision: ${contract.revision}`
    const policy = control.clarificationPolicy === 'never'
      ? 'Do not ask the user. Record reasonable, reversible assumptions explicitly.'
      : control.clarificationPolicy === 'always'
        ? 'Use lattice_intake for unresolved product-definition gaps before execution.'
        : 'Ask only about an outcome-critical gap that can change the P0 result, scope, authority, truth source, or acceptance.'
    const tier = control.phase === 'contract'
      ? 'Persist the execution contract before guarded writes. Before each filesystem mutation, call lattice_refresh_context with the exact targetPaths so the contract and current file bodies are read together. After commitment, work directly without node-by-node checkout or checkpoints.'
      : `Persist the execution contract, open the lattice, and use leaf leases, receipts, checkpoints, and evidence gates for protected work. After checkout and before each filesystem mutation, call lattice_refresh_context with the exact targetPaths; it must render the complete contract, current node lineage and acceptance criteria, and current target bodies together. Work estimated at ${resolved.longTaskThreshold} or more steps is only one signal; changing requirements, cross-module scope, irreversible effects, or multiple agents independently justify this tier.`
    return `## Plan Lattice ${control.phase} control

Before protected work, define the boundary and time horizon, identify invariants, separate changeable forms, identify directional forces, reduce them to the few causal variables that decide success, then adapt the path while preserving the invariants. Read repository evidence before asking anything. Keep evidence-supported facts, user decisions, model assumptions, and unresolved unknowns distinct.${resolved.legacyIntakeMode === undefined ? '' : `\n\nIntake policy is ${resolved.legacyIntakeMode}.`}

${policy}

${tier}

${child ? 'This is a delegated agent. Never question the human directly; return missing boundary information to the parent agent.' : 'Only the root agent may ask the human.'} Material changes require lattice_reframe before further guarded work. After compaction, call lattice_refresh_context and reread the complete contract.${capsule}`
  }

  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'plan:fractal-ledger',
    order: 55,
    text: assemble => controlPrompt(assemble.agent),
  }))

  function clearWorkspace(workspace: string): void {
    for (const [key, receipt] of receipts) if (receipt.workspace === workspace) receipts.delete(key)
    for (const [key, basis] of structuralContexts) if (basis.workspace === workspace) structuralContexts.delete(key)
    for (const [key, lease] of leases) if (lease.workspace === workspace) leases.delete(key)
  }

  function ensureNoActiveLease(workspace: string): void {
    for (const lease of leases.values()) {
      if (lease.workspace === workspace) {
        throw new Error(`node ${JSON.stringify(lease.nodeId)} is checked out; checkpoint it before changing the plan`)
      }
    }
  }

  async function issueCurrentReceipt(
    agent: AgentLike,
    workspace: string,
    state: LatticeState,
    targetPaths: string[] = [],
    planNodeId?: string,
  ): Promise<{
    receipt: LatticeReceipt
    documents: Awaited<ReturnType<typeof readProjectContext>>['documents']
    mutationBasis: MutationBasis
    planContext: StructuralPlanView
  }> {
    const context = await readProjectContext(workspace, state.project.contextPaths, resolved.maxContextBytes)
    const targetContext = await readMutationTargets(workspace, targetPaths, resolved.maxContextBytes)
    const lease = leases.get(sessionKey(agent))
    const planContext = structuralPlanView(state, planNodeId ?? lease?.nodeId)
    const mutationBasis: MutationBasis = {
      ...(lease?.workspace === workspace ? { nodePlan: nodeExecutionPlan(state, lease.nodeId) } : {}),
      targets: targetContext.targets,
      targetDigest: targetContext.digest,
    }
    const receipt = issueReceipt(workspace, state, context)
    receipts.set(sessionKey(agent), receipt)
    structuralContexts.set(sessionKey(agent), { workspace, view: planContext })
    return { receipt, documents: context.documents, mutationBasis, planContext }
  }

  async function conductIntake(
    agent: Agent,
    signal: AbortSignal,
    framing: IntakeFraming,
    questions: IntakeQuestion[],
  ): Promise<{
    decision: IntakeDecision
    questions: IntakeQuestion[]
    answers: IntakeAnswer[]
    receiptId: string
    createdAt: string
  }> {
    const interaction = ctx.get('userQuestions')
    if (interaction === undefined) {
      throw new Error('no user-questions channel is available; configure intakeMode off for unattended execution')
    }
    const legacyMode = resolved.legacyIntakeMode
    if (legacyMode === undefined) throw new Error('legacy intake is unavailable for v0.4 activation settings')
    let decision: IntakeDecision = legacyMode === 'guided' ? 'guided' : 'autonomous'
    if (legacyMode === 'adaptive') {
      const modeResult = await interaction.ask({
        questions: [{
          id: 'intake-mode',
          header: 'Task setup',
          question: 'How should this long task establish its execution contract?',
          options: [
            { label: 'Guided clarification', description: 'Answer the highest-impact missing questions and confirm the exact contract.' },
            { label: 'Autonomous execution', description: 'Let the agent proceed from explicit, revisable assumptions without further setup questions.' },
          ],
        }],
        agent,
        signal,
      })
      const mode = selectedAnswer(modeResult.answers, 'intake-mode')
      if (mode.custom !== undefined || mode.selected.length !== 1) {
        throw new Error('choose exactly one intake mode before execution')
      }
      if (mode.selected[0] === 'Guided clarification') decision = 'guided'
      else if (mode.selected[0] === 'Autonomous execution') decision = 'autonomous'
      else throw new Error('the selected intake mode was not one of the offered choices')
    }

    let answers: IntakeAnswer[] = []
    const receiptId = randomUUID()
    const createdAt = new Date().toISOString()
    if (decision === 'guided') {
      if (questions.length === 0) {
        throw new Error('guided intake requires one to five high-impact clarification questions')
      }
      const clarified = await interaction.ask({ questions, agent, signal })
      answers = requireAnswers(questions, clarified.answers)
      const contract = renderIntakeContract({ receiptId, decision, framing, questions, answers, createdAt })
      const confirmation = await interaction.ask({
        questions: [{
          id: 'intake-confirm',
          header: 'Execution contract',
          question: 'Approve this contract and unlock planning?',
          detail: contract,
          options: [
            { label: 'Approve contract', description: 'Persist this exact contract and allow planning or reframing to continue.' },
            { label: 'Revise contract', description: 'Return feedback to the agent; no contract is persisted.' },
          ],
          intent: { kind: 'plan-review', approve: 'Approve contract' },
        }],
        agent,
        signal,
      })
      const approval = selectedAnswer(confirmation.answers, 'intake-confirm')
      if (approval.selected.length !== 1 || approval.selected[0] !== 'Approve contract' || approval.custom !== undefined) {
        const feedback = approval.custom?.trim()
        throw new Error(feedback === undefined || feedback === ''
          ? 'the user requested contract revision; no intake was persisted'
          : `the user requested contract revision: ${feedback}`)
      }
    } else if (framing.assumptions.length === 0) {
      throw new Error('autonomous intake requires at least one explicit, revisable assumption')
    }
    return { decision, questions: decision === 'guided' ? questions : [], answers, receiptId, createdAt }
  }

  async function requireFreshReceipt(
    agent: AgentLike,
    workspace: string,
    receiptId: string,
    expectedRevision: number,
  ): Promise<LatticeState> {
    const state = await store.peek(workspace)
    if (state === undefined) throw new Error('no lattice exists for this workspace')
    assertExpectedRevision(state, expectedRevision)
    const receipt = receipts.get(sessionKey(agent))
    if (receipt === undefined || receipt.id !== receiptId) {
      throw new Error('context receipt is missing, expired, or belongs to another session; call lattice_refresh_context')
    }
    if (receipt.workspace !== workspace || receipt.revision !== state.revision) {
      throw new Error('context receipt is stale; call lattice_refresh_context')
    }
    // Every structural action reads the full contract again. A matching token
    // alone is intentionally insufficient after a document changes on disk.
    const context = await readProjectContext(workspace, state.project.contextPaths, resolved.maxContextBytes)
    if (context.digest !== receipt.digest) {
      throw new Error('project context changed after the receipt; call lattice_refresh_context and reconsider the mutation')
    }
    return state
  }

  function requireObservedPlanNode(agent: AgentLike, workspace: string, nodeId: string | undefined): void {
    const prepared = structuralContexts.get(sessionKey(agent))
    if (prepared === undefined || prepared.workspace !== workspace) {
      throw new Error('current plan structure was not read; call lattice_refresh_context before changing the plan')
    }
    if (nodeId === undefined) return
    const view = prepared.view
    const visible = new Set([
      ...view.roots.map(node => node.id),
      ...view.frontier.map(node => node.id),
      ...(view.focus?.lineage.map(node => node.id) ?? []),
      ...(view.focus?.children.map(node => node.id) ?? []),
    ])
    if (!visible.has(nodeId)) {
      throw new Error(`plan node ${JSON.stringify(nodeId)} was not in the current plan view; call lattice_refresh_context with planNodeId`)
    }
  }

  function changedContractGuard(toolName: string, lease: ExecutionLease): string | undefined {
    try {
      const current = readProjectContextSync(lease.workspace, lease.contextPaths, resolved.maxContextBytes)
      if (current.digest !== lease.contextDigest) {
        return `plan-lattice blocks ${toolName}: project context changed since its full rendered read; call lattice_refresh_context before another guarded action`
      }
      return undefined
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown context verification failure'
      return `plan-lattice blocks ${toolName}: cannot verify the current project context (${reason}); call lattice_refresh_context before another guarded action`
    }
  }

  function mutationBasisGuard(
    toolName: string,
    args: unknown,
    workspace: string,
    basis: MutationBasis | undefined,
    requireNodePlan: boolean,
  ): string | undefined {
    const target = mutationTargetFromTool(toolName, args)
    if (target.kind === 'read') return undefined
    if (basis === undefined || (requireNodePlan && basis.nodePlan === undefined)) {
      return `plan-lattice blocks ${toolName}: call lattice_refresh_context${target.kind === 'mutation' ? ' with targetPaths' : ''} before this protected action so the current contract${requireNodePlan ? ', node plan,' : ''} and relevant facts are read together`
    }
    // Custom guarded tools can represent non-filesystem side effects, so their
    // configured guard still receives a one-action contract/plan basis. Bash
    // is special: strictBash explicitly admits that command text cannot be
    // classified, therefore the agent must at least declare and reread the
    // intended filesystem targets before it may run.
    if (target.kind === 'unknown') {
      if (toolName === 'bash' && basis.targets.length === 0) {
        return 'plan-lattice blocks bash: strict Bash requires lattice_refresh_context targetPaths for every intended filesystem mutation target'
      }
      return undefined
    }
    let normalized: string
    try {
      normalized = normalizeMutationTarget(workspace, target.path!)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid mutation target'
      return `plan-lattice blocks ${toolName}: ${reason}`
    }
    const expected = basis.targets.find(item => item.path === normalized)
    if (expected === undefined) {
      return `plan-lattice blocks ${toolName}: target ${JSON.stringify(normalized)} was not included in the last lattice_refresh_context targetPaths`
    }
    try {
      const changed = verifyMutationTargetSync(workspace, expected)
      return changed === undefined
        ? undefined
        : `plan-lattice blocks ${toolName}: ${changed}; rebuild the mutation basis with lattice_refresh_context`
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown target verification failure'
      return `plan-lattice blocks ${toolName}: cannot verify the prepared target (${reason}); call lattice_refresh_context again`
    }
  }

  ctx.tools.guard(exec => {
    if (!resolved.guardedTools.has(exec.name)) return undefined
    if (exec.agent === undefined) return `plan-lattice blocks ${exec.name}: no owning agent can hold a lattice lease`
    const toolTarget = mutationTargetFromTool(exec.name, exec.arguments)
    if (toolTarget.kind === 'read') return undefined
    const tracked = controls.get(sessionKey(exec.agent))
    if (tracked?.phase === 'bypass') return undefined
    if (tracked?.phase === 'probe') {
      return `plan-lattice blocks ${exec.name}: routing is unresolved; read repository evidence and call lattice_route before writing`
    }
    if (tracked?.phase === 'contract') {
      if (tracked.reframePending) return `plan-lattice blocks ${exec.name}: a material change requires lattice_reframe`
      if (tracked.compactionSeq !== undefined) {
        return `plan-lattice blocks ${exec.name}: compaction at session event ${tracked.compactionSeq} requires lattice_refresh_context before writing`
      }
      const cwd = exec.agent.session.header.cwd
      if (cwd === undefined) return `plan-lattice blocks ${exec.name}: the agent has no workspace for its execution contract`
      try {
        const contract = readContractSync(cwd)
        if (contract === undefined) return `plan-lattice blocks ${exec.name}: call lattice_intake and commit the execution contract first`
        if (contract.sessionId !== tracked.rootSessionId) {
          return `plan-lattice blocks ${exec.name}: the execution contract belongs to another root task`
        }
        const persistedAnchor = readContractAnchorSync(resolved.contractAnchorRoot, tracked.rootSessionId)
        const inMemoryAnchor = tracked.contract
        if (persistedAnchor === undefined
          || (inMemoryAnchor !== undefined && !contractMatchesAnchor(persistedAnchor, inMemoryAnchor))
          || !contractMatchesAnchor(contract, persistedAnchor)) {
          tracked.reframePending = true
          return `plan-lattice blocks ${exec.name}: the execution contract changed outside lattice_reframe`
        }
        tracked.contract = persistedAnchor
        const mutationReason = mutationBasisGuard(exec.name, exec.arguments, cwd, tracked.mutationBasis, false)
        if (mutationReason === undefined) tracked.mutationBasis = undefined
        return mutationReason
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown contract verification failure'
        return `plan-lattice blocks ${exec.name}: ${reason}; call lattice_reframe`
      }
    }
    const lease = leases.get(sessionKey(exec.agent))
    if (lease === undefined) return `plan-lattice blocks ${exec.name}: check out one current leaf first`
    if (lease.dirty) return `plan-lattice blocks ${exec.name}: checkpoint the previous guarded action first`
    if (lease.compactionSeq !== undefined) {
      return `plan-lattice blocks ${exec.name}: compaction at session event ${lease.compactionSeq} changed model-visible history; call lattice_refresh_context before another guarded action`
    }
    if (lease.revision < 1) return `plan-lattice blocks ${exec.name}: refresh the project context first`
    const mutationReason = changedContractGuard(exec.name, lease)
      ?? mutationBasisGuard(exec.name, exec.arguments, lease.workspace, lease.mutationBasis, true)
    if (mutationReason === undefined) lease.mutationBasis = undefined
    return mutationReason
  })

  ctx.on('tools/result', (exec, result) => {
    if (result.isError || exec.agent === undefined || !resolved.guardedTools.has(exec.name)) return
    if (mutationTargetFromTool(exec.name, exec.arguments).kind === 'read') return
    const tracked = controls.get(sessionKey(exec.agent))
    if (tracked !== undefined && tracked.phase !== 'lattice') {
      tracked.mutationBasis = undefined
      return
    }
    const lease = leases.get(sessionKey(exec.agent))
    if (lease !== undefined) {
      lease.dirty = true
      lease.mutationBasis = undefined
    }
  })

  // `compaction/summary` is the durable point at which Harness has selected
  // model-visible history for replacement. We do not try to infer whether a
  // particular tool result survived the replacement: any successful summary
  // conservatively requires the next lattice transition to render the complete
  // contract again.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/summary') return
    const key = String(session.id)
    receipts.delete(key)
    structuralContexts.delete(key)
    const control = controls.get(key)
    if (control !== undefined && control.phase !== 'bypass') {
      control.compactionSeq = event.seq
      control.mutationBasis = undefined
    }
    const lease = leases.get(key)
    if (lease !== undefined) {
      lease.compactionSeq = event.seq
      lease.mutationBasis = undefined
    }
  })

  function updateRestriction(agent: Agent, control: AgentControl): void {
    control.restriction?.()
    const available = LATTICE_TOOL_NAMES.filter(name => !(
      resolved.legacyIntakeMode === 'off' && (name === 'lattice_intake' || name === 'lattice_reframe')
    ))
    const allowed = resolved.legacyIntakeMode !== undefined
      ? new Set(available.filter(name => name !== 'lattice_route' && name !== 'lattice_commit_intake'))
      : control.phase === 'probe'
        ? new Set(['lattice_route'])
        : control.phase === 'contract'
          ? new Set(['lattice_intake', 'lattice_commit_intake', 'lattice_reframe', 'lattice_refresh_context'])
          : control.phase === 'lattice'
            ? new Set(available.filter(name => name !== 'lattice_route'))
            : new Set<string>()
    const deny = available.filter(name => !allowed.has(name))
    control.restriction = agent.ctx.tools.restrict({ deny: [...deny] })
  }

  function transitionControl(agent: Agent, assessment: RouteAssessment): AgentControl {
    const current = controls.get(sessionKey(agent)) ?? fallbackControl(agent)
    current.phase = assessment.phase
    current.clarificationPolicy = assessment.clarificationPolicy
    current.reasons = [...assessment.reasons]
    controls.set(sessionKey(agent), current)
    updateRestriction(agent, current)
    return current
  }

  async function finalizePendingContract(
    pending: PendingIntake,
    bindings: AnswerBinding[],
    agent: Agent,
  ): Promise<{
    contract: string
    contractRecord: ContractRecord
    contractReceipt: ContractReceipt
    latticeReceipt?: LatticeReceipt
    documents?: Awaited<ReturnType<typeof readProjectContext>>['documents']
    project?: LatticeState['project']
  }> {
    let currentContract: ContractRecord | undefined
    try {
      currentContract = readContractSync(pending.workspace)
    } catch (error) {
      if (pending.kind !== 'reframe') throw error
      currentContract = readContractRecordSync(pending.workspace)
    }
    if (pending.kind === 'intake' && currentContract !== undefined) {
      throw new Error('an execution contract appeared while intake was pending; use lattice_reframe')
    }
    if (pending.kind === 'reframe') {
      if (pending.previousContract === undefined) {
        if (currentContract !== undefined) {
          throw new Error('a v2 execution contract appeared while the v1 reframe was pending; start lattice_reframe again')
        }
      } else if (pending.replaceUntrustedContract === true) {
        const anchor = readContractAnchorSync(resolved.contractAnchorRoot, pending.previousContract.sessionId)
        if (anchor === undefined || !contractMatchesAnchor(anchor, pending.previousContract)) {
          throw new Error('the durable contract anchor changed while reframe was pending; start lattice_reframe again')
        }
      } else if (currentContract === undefined
        || currentContract.id !== pending.previousContract.id
        || currentContract.revision !== pending.previousContract.revision
        || currentContract.documentDigest !== pending.previousContract.documentDigest) {
        throw new Error('the execution contract changed while reframe was pending; start lattice_reframe again')
      }
    }
    const persisted = await persistConfirmedContract({
      workspace: pending.workspace,
      sessionId: pending.sessionId,
      controlLevel: pending.controlLevel,
      clarificationPolicy: pending.clarificationPolicy,
      framing: pending.framing,
      questions: pending.questions,
      answers: pending.answers,
      answerBindings: bindings,
      ...(pending.previousContract === undefined ? {} : {
        revision: pending.previousContract.revision + 1,
        createdAt: pending.previousContract.createdAt,
      }),
    })

    let latticeReceipt: LatticeReceipt | undefined
    let documents: Awaited<ReturnType<typeof readProjectContext>>['documents'] | undefined
    let project: LatticeState['project'] | undefined
    if (pending.kind === 'reframe' && pending.controlLevel === 'lattice') {
      if (pending.latticeRevision === undefined) throw new Error('lattice reframe is missing its source revision')
      ensureNoActiveLease(pending.workspace)
      const current = await store.peek(pending.workspace)
      if (current === undefined) throw new Error('the lattice disappeared while reframe was pending')
      assertExpectedRevision(current, pending.latticeRevision)
      const contextPaths = validateContextPaths([
        CONTRACT_DOCUMENT_PATH,
        ...current.project.contextPaths.filter(path => path !== CONTRACT_DOCUMENT_PATH && path !== INTAKE_DOCUMENT_PATH),
      ])
      const context = await readProjectContext(pending.workspace, contextPaths, resolved.maxContextBytes)
      const result = await store.mutate(pending.workspace, 'reframe-v2', state => {
        assertExpectedRevision(state, pending.latticeRevision!)
        const now = Date.now()
        state.project = {
          ...state.project,
          objective: persisted.record.framing.desiredOutcome,
          contextPaths,
          updatedAt: now,
        }
        state.revision += 1
        return { value: { revision: state.revision, project: { ...state.project } }, delta: delta(state, [], true) }
      })
      clearWorkspace(pending.workspace)
      latticeReceipt = issueReceipt(pending.workspace, {
        schemaVersion: LATTICE_SCHEMA_VERSION,
        revision: result.revision,
        project: result.project,
        nodes: {},
      }, context)
      receipts.set(sessionKey(agent), latticeReceipt)
      documents = context.documents
      project = result.project
    }

    for (const control of controls.values()) {
      if (control.rootSessionId !== pending.sessionId) continue
      control.contract = persisted.record
      control.reframePending = false
      control.compactionSeq = undefined
      control.mutationBasis = undefined
    }
    return {
      contract: persisted.markdown,
      contractRecord: persisted.record,
      contractReceipt: persisted.receipt,
      ...(latticeReceipt === undefined ? {} : { latticeReceipt }),
      ...(documents === undefined ? {} : { documents }),
      ...(project === undefined ? {} : { project }),
    }
  }

  ctx.tools.register(defineTool({
    name: 'lattice_route',
    description: 'Resolve an uncertain Plan Lattice route after reading repository evidence. This is the only Lattice tool exposed during probe mode.',
    parameters: {
      recommendedLevel: { type: 'string', required: true, enum: ['bypass', 'contract', 'lattice'] },
      estimatedSteps: { type: 'integer', required: true, description: 'Evidence-based estimate of atomic execution steps.' },
      executionSpan: { type: 'integer', required: true, description: 'Risk score from 0 to 10 for execution horizon and cross-boundary work.' },
      productDefinitionGap: { type: 'integer', required: true, description: 'Risk score from 0 to 10 for missing user, outcome, scope, truth-source, authority, or acceptance facts.' },
      outcomeCritical: { type: 'boolean', required: true, description: 'Whether a missing fact can alter P0 outcome, authority, data truth, or acceptance.' },
      evidence: { type: 'array', required: true, items: { type: 'string' }, description: 'Concrete repository observations supporting this route.' },
      rationale: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('lattice_route requires an owning agent')
      const control = controls.get(sessionKey(exec.agent))
      if (control === undefined || control.phase !== 'probe') throw new Error('lattice_route is available only while the task route is unresolved')
      const estimatedSteps = positiveInteger(args.estimatedSteps, 1, 'estimatedSteps')
      const executionSpan = Number(args.executionSpan)
      const productDefinitionGap = Number(args.productDefinitionGap)
      if (!Number.isSafeInteger(executionSpan) || executionSpan < 0 || executionSpan > 10) throw new Error('executionSpan must be an integer from 0 to 10')
      if (!Number.isSafeInteger(productDefinitionGap) || productDefinitionGap < 0 || productDefinitionGap > 10) throw new Error('productDefinitionGap must be an integer from 0 to 10')
      const evidence = textList(args.evidence, 'evidence')
      if (evidence.length === 0) throw new Error('lattice_route requires repository evidence')
      let phase = args.recommendedLevel as RoutePhase
      if (phase === 'bypass' && (args.outcomeCritical || executionSpan > 2 || productDefinitionGap > 1 || estimatedSteps >= resolved.longTaskThreshold)) {
        throw new Error('outcome-critical, ambiguous, or long work cannot be bypassed')
      }
      if (phase === 'lattice' && resolved.controlCeiling === 'contract') phase = 'contract'
      const assessment: RouteAssessment = {
        phase,
        confidence: 'high',
        executionSpan,
        productDefinitionGap,
        outcomeCritical: args.outcomeCritical,
        clarificationPolicy: control.clarificationPolicy,
        reasons: [assertText(args.rationale, 'rationale'), ...evidence],
      }
      transitionControl(exec.agent, assessment)
      return json({
        message: `Route resolved to ${phase}. ${phase === 'bypass' ? 'No Plan Lattice state will be created.' : 'Establish the execution contract before guarded work.'}`,
        route: assessment,
      })
    },
  }))

  if (resolved.legacyIntakeMode !== 'off') {
    ctx.tools.register(defineTool({
      name: 'lattice_intake',
      description: 'Frame a long task, resolve its highest-impact unknowns through the real user-question channel, confirm the exact contract, and persist a session-bound receipt before any lattice may open.',
      parameters: {
        requestSummary: { type: 'string', required: true, description: 'Faithful summary of the user request without invented requirements.' },
        estimatedSteps: { type: 'integer', required: true, description: 'Honest estimate of atomic execution steps.' },
        systemBoundary: { type: 'string', required: true, description: 'System in scope and explicit exclusions.' },
        timeHorizon: { type: 'string', required: true, description: 'Decision and execution time horizon.' },
        desiredOutcome: { type: 'string', required: true, description: 'Observable final result, independent of a particular implementation form.' },
        confirmedFacts: { type: 'array', required: true, description: 'Facts supported by repository evidence or explicit user statements.', items: { type: 'string' } },
        decisions: { type: 'array', required: true, description: 'Explicit user or product decisions; never inferred preferences.', items: { type: 'string' } },
        invariants: { type: 'array', required: true, description: 'Stable goals, constraints, and truths that must be preserved.', items: { type: 'string' } },
        changeables: { type: 'array', required: true, description: 'Implementation forms and paths that may adapt.', items: { type: 'string' } },
        forces: { type: 'array', required: true, description: 'Directional changes and the forces likely to sustain them.', items: { type: 'string' } },
        keyVariables: { type: 'array', required: true, description: 'Smallest causal variable set that determines success.', items: { type: 'string' } },
        assumptions: { type: 'array', required: true, description: 'Model assumptions that remain explicit and revisable.', items: { type: 'string' } },
        unknowns: { type: 'array', required: true, description: 'Known missing facts and decisions.', items: { type: 'string' } },
        readiness: { type: 'string', required: true, enum: ['ready', 'conditional'], description: 'Whether execution is fully ready or must preserve options around explicit non-core unknowns.' },
        readinessRationale: { type: 'string', required: true, description: 'Why the task is ready or conditionally ready for decomposition.' },
        questions: {
          type: 'array',
          required: true,
          description: 'One to five highest-impact questions. Guided intake asks all of them before presenting the exact contract for confirmation.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              question: { type: 'string', required: true },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', required: true },
                    description: { type: 'string' },
                  },
                },
              },
              multiSelect: { type: 'boolean' },
            },
          },
        },
      },
      output: { schema: { type: 'json' }, render: renderIntake },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('lattice_intake requires an owning root agent session')
        const workspace = await workspaceFor(exec.agent)
        if (intakeInProgress.has(workspace)) throw new Error('another intake or reframe is already in progress')
        intakeInProgress.add(workspace)
        try {
          if (await store.peek(workspace) !== undefined) {
            throw new Error('a lattice already exists; use lattice_reframe to revise its execution contract')
          }
          const unknowns = textList(args.unknowns, 'unknowns')
          const framing: IntakeFraming = {
            requestSummary: assertText(args.requestSummary, 'requestSummary'),
            estimatedSteps: positiveInteger(args.estimatedSteps, 1, 'estimatedSteps'),
            systemBoundary: assertText(args.systemBoundary, 'systemBoundary'),
            timeHorizon: assertText(args.timeHorizon, 'timeHorizon'),
            desiredOutcome: assertText(args.desiredOutcome, 'desiredOutcome'),
            confirmedFacts: textList(args.confirmedFacts, 'confirmedFacts'),
            decisions: textList(args.decisions, 'decisions'),
            invariants: textList(args.invariants, 'invariants'),
            changeables: textList(args.changeables, 'changeables'),
            forces: textList(args.forces, 'forces'),
            keyVariables: textList(args.keyVariables, 'keyVariables'),
            assumptions: textList(args.assumptions, 'assumptions'),
            unknowns,
            readiness: intakeReadiness(args.readiness, unknowns),
            readinessRationale: assertText(args.readinessRationale, 'readinessRationale'),
          }
          const questions = normalizeQuestions(args.questions)
          if (resolved.legacyIntakeMode === undefined) {
            const control = controlFor(exec.agent)
            if (control.phase !== 'contract' && control.phase !== 'lattice') {
              throw new Error(`lattice_intake is unavailable while the task route is ${control.phase}`)
            }
            if (exec.agent.session.header.origin === 'subagent' || (exec.agent.session.header.delegationDepth ?? 0) > 0) {
              throw new Error('a delegated agent cannot establish or question the root execution contract; return the gap to the parent agent')
            }
            if (readContractSync(workspace) !== undefined) {
              throw new Error('an execution contract already exists; use lattice_reframe for material changes')
            }
            if (control.clarificationPolicy === 'never' && questions.length > 0) {
              throw new Error('clarificationPolicy never forbids questions; remove them and record reversible assumptions')
            }
            if (control.clarificationPolicy === 'always' && questions.length === 0) {
              throw new Error('clarificationPolicy always requires at least one clarification question')
            }
            if (control.clarificationPolicy === 'never' && framing.assumptions.length === 0) {
              throw new Error('question-free intake requires at least one explicit, reversible assumption')
            }
            if (questions.length > 0) {
              const interaction = ctx.get('userQuestions')
              if (interaction === undefined) throw new Error('no user-questions channel is available for outcome-critical clarification')
              const clarified = await interaction.ask({ questions, agent: exec.agent, signal: exec.signal })
              const answers = requireAnswers(questions, clarified.answers)
              const pendingIntakeId = randomUUID()
              pendingIntakes.set(pendingIntakeId, {
                id: pendingIntakeId,
                workspace,
                sessionId: control.rootSessionId,
                kind: 'intake',
                controlLevel: control.phase,
                clarificationPolicy: control.clarificationPolicy,
                framing,
                questions,
                answers,
              })
              return json({
                message: 'Clarification answers were collected but no execution contract has been persisted. Bind each answer into the final contract with lattice_commit_intake.',
                pendingIntakeId,
                answers,
              })
            }
            const persisted = await persistConfirmedContract({
              workspace,
              sessionId: control.rootSessionId,
              controlLevel: control.phase,
              clarificationPolicy: control.clarificationPolicy,
              framing,
              questions: [],
              answers: [],
              answerBindings: [],
            })
            control.contract = persisted.record
            return json({
              message: `Committed a v2 ${control.phase} execution contract without a clarification round.`,
              receipt: persisted.receipt,
              contract: persisted.markdown,
            })
          }
          const intake = await conductIntake(exec.agent, exec.signal, framing, questions)
          if (await store.peek(workspace) !== undefined) {
            throw new Error('a lattice was opened while intake was pending; no intake was persisted')
          }
          const persisted = await persistIntake({
            workspace,
            sessionId: sessionKey(exec.agent),
            decision: intake.decision,
            framing,
            questions: intake.questions,
            answers: intake.answers,
            receiptId: intake.receiptId,
            createdAt: intake.createdAt,
          })
          return json({
            message: intake.decision === 'guided'
              ? 'The user approved this exact execution contract. Planning is now unlocked for the same session and receipt.'
              : 'Autonomous execution was selected. Explicit assumptions are persisted and planning is now unlocked for the same session and receipt.',
            receipt: persisted.receipt,
            contract: persisted.markdown,
          })
        } finally {
          intakeInProgress.delete(workspace)
        }
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'lattice_commit_intake',
    description: 'Bind every collected clarification answer into a final fact, decision, invariant, or explicit unknown, then atomically persist the v2 execution contract.',
    parameters: {
      pendingIntakeId: { type: 'string', required: true },
      answerBindings: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            questionId: { type: 'string', required: true },
            target: { type: 'string', required: true, enum: ['confirmedFact', 'decision', 'invariant', 'unknown'] },
            statement: { type: 'string', required: true },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderIntake },
    async execute(args, exec) {
      if (resolved.legacyIntakeMode !== undefined) throw new Error('lattice_commit_intake belongs to the v0.4 contract protocol')
      if (exec.agent === undefined) throw new Error('lattice_commit_intake requires an owning root agent')
      const pendingId = assertText(args.pendingIntakeId, 'pendingIntakeId')
      const pending = pendingIntakes.get(pendingId)
      if (pending === undefined) throw new Error('pending intake is missing, expired, or belongs to another process')
      const workspace = await workspaceFor(exec.agent)
      const control = controlFor(exec.agent)
      if (pending.workspace !== workspace || pending.sessionId !== control.rootSessionId) {
        throw new Error('pending intake belongs to another workspace or root task')
      }
      const bindings = args.answerBindings.map((binding, index): AnswerBinding => ({
        questionId: assertText(binding.questionId, `answerBindings[${index}].questionId`),
        target: binding.target as AnswerBindingTarget,
        statement: assertText(binding.statement, `answerBindings[${index}].statement`),
      }))
      const expected = new Set(pending.questions.map(question => question.id))
      const seen = new Set<string>()
      for (const binding of bindings) {
        if (binding.target !== 'confirmedFact' && binding.target !== 'decision' && binding.target !== 'invariant' && binding.target !== 'unknown') {
          throw new Error('answer binding target must be confirmedFact, decision, invariant, or unknown')
        }
        if (!expected.has(binding.questionId) || seen.has(binding.questionId)) {
          throw new Error('every clarification answer must have exactly one binding')
        }
        seen.add(binding.questionId)
      }
      if (seen.size !== expected.size) throw new Error('every clarification answer must have exactly one binding')
      const persisted = await finalizePendingContract(pending, bindings, exec.agent)
      pendingIntakes.delete(pendingId)
      return json({
        message: pending.kind === 'reframe'
          ? 'Bound every clarification answer and committed the revised v2 execution contract.'
          : 'Bound every clarification answer and committed the v2 execution contract.',
        receipt: persisted.contractReceipt,
        ...(persisted.latticeReceipt === undefined ? {} : { latticeReceipt: persisted.latticeReceipt }),
        ...(persisted.project === undefined ? {} : { project: persisted.project }),
        ...(persisted.documents === undefined ? {} : { documents: persisted.documents }),
        contract: persisted.contract,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_open',
    description: `Create the workspace-local evidence-gated work graph after the execution contract is committed. The ${resolved.longTaskThreshold}-step threshold is one routing signal, not a substitute for risk assessment.`,
    parameters: {
      title: { type: 'string', required: true, description: 'Short project title.' },
      objective: { type: 'string', required: true, description: 'The durable outcome this lattice must preserve.' },
      estimatedSteps: { type: 'integer', description: 'Honest estimate of atomic execution steps. Required when intakeMode is not off.' },
      intakeReceiptId: { type: 'string', description: 'Session-bound receipt returned by lattice_intake.' },
      contextPaths: {
        type: 'array',
        required: true,
        description: 'Every workspace-relative background, product, or architecture document required for future plan changes.',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(args, exec) {
      const workspace = await workspaceFor(exec.agent)
      if (intakeInProgress.has(workspace)) {
        throw new Error('lattice_open waits until the active intake or reframe finishes')
      }
      let contextPaths = validateContextPaths(args.contextPaths)
      if (resolved.legacyIntakeMode === undefined && exec.agent !== undefined && controls.has(sessionKey(exec.agent))) {
        if (exec.agent === undefined) throw new Error('lattice_open requires an owning agent')
        const control = controlFor(exec.agent)
        if (control.phase !== 'lattice') throw new Error(`lattice_open is available only at lattice control, not ${control.phase}`)
        if (args.estimatedSteps === undefined) throw new Error('estimatedSteps is required by the v2 contract protocol')
        if (args.intakeReceiptId === undefined) throw new Error('a committed v2 execution contract is required before lattice_open')
        const estimatedSteps = positiveInteger(args.estimatedSteps, 1, 'estimatedSteps')
        const contract = await verifyAnchoredContract({
          workspace,
          sessionId: control.rootSessionId,
          receiptId: assertText(args.intakeReceiptId, 'intakeReceiptId'),
        })
        if (contract.controlLevel !== 'lattice') throw new Error('the execution contract does not authorize full lattice control')
        if (contract.estimatedSteps !== estimatedSteps) throw new Error('estimatedSteps changed after contract commitment; call lattice_reframe')
        control.contract = contract
        contextPaths = validateContextPaths([
          CONTRACT_DOCUMENT_PATH,
          ...contextPaths.filter(path => path !== CONTRACT_DOCUMENT_PATH),
        ])
      } else if (resolved.legacyIntakeMode !== undefined && resolved.legacyIntakeMode !== 'off') {
        if (args.estimatedSteps === undefined) {
          throw new Error('estimatedSteps is required when intakeMode is not off')
        }
        const estimatedSteps = positiveInteger(args.estimatedSteps, 1, 'estimatedSteps')
        const receiptRequired = estimatedSteps >= resolved.longTaskThreshold
        if (receiptRequired && args.intakeReceiptId === undefined) {
          throw new Error(`work estimated at ${estimatedSteps} steps requires lattice_intake before lattice_open`)
        }
        if (args.intakeReceiptId !== undefined) {
          const intake = await verifyIntake({
            workspace,
            sessionId: sessionKey(exec.agent!),
            receiptId: assertText(args.intakeReceiptId, 'intakeReceiptId'),
            ...(resolved.legacyIntakeMode === 'guided' ? { requiredDecision: 'guided' as const } : {}),
          })
          if (intake.estimatedSteps !== estimatedSteps) {
            throw new Error('estimatedSteps changed after intake confirmation; call lattice_intake again')
          }
          contextPaths = validateContextPaths([
            INTAKE_DOCUMENT_PATH,
            ...contextPaths.filter(path => path !== INTAKE_DOCUMENT_PATH),
          ])
        }
      }
      const context = await readProjectContext(workspace, contextPaths, resolved.maxContextBytes)
      const now = Date.now()
      const state: LatticeState = {
        schemaVersion: LATTICE_SCHEMA_VERSION,
        revision: 1,
        project: {
          title: assertText(args.title, 'title'),
          objective: assertText(args.objective, 'objective'),
          contextPaths,
          createdAt: now,
          updatedAt: now,
        },
        nodes: {},
      }
      await store.create(workspace, state, undefined)
      const receipt = issueReceipt(workspace, state, context)
      receipts.set(sessionKey(exec.agent!), receipt)
      const planContext = structuralPlanView(state)
      structuralContexts.set(sessionKey(exec.agent!), { workspace, view: planContext })
      return json({
        message: `Opened lattice revision ${state.revision}. Context is complete and current; create no more than ${resolved.topLevelLimit} root nodes before executing.`,
        project: state.project,
        receipt,
        documents: context.documents,
        planContext,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_status',
    description: 'Read a bounded durable graph summary and unfinished frontier without reinjecting the entire ledger into context.',
    parameters: {
      nodeId: { type: 'string', description: 'Optional node whose direct children should be inspected.' },
      maxNodes: { type: 'integer', description: 'Maximum frontier or child summaries to return, from 1 to 64. Defaults to 16.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const workspace = await workspaceFor(exec.agent)
      const state = await store.peek(workspace)
      if (state === undefined) return json({ message: 'No lattice exists for this workspace.', state: null })
      const active = exec.agent === undefined ? undefined : leases.get(sessionKey(exec.agent))
      const status = projectStatus(state, { nodeId: args.nodeId, maxNodes: statusNodeLimit(args.maxNodes) })
      const liveNodes = status.counts.pending + status.counts.active + status.counts.blocked + status.counts.complete
      return json({
        message: `Lattice revision ${state.revision}: ${liveNodes} live nodes; returning ${status.frontier.nodes.length} of ${status.frontier.total} actionable frontier nodes.`,
        status,
        ...(active === undefined ? {} : {
          lease: {
            nodeId: active.nodeId,
            dirty: active.dirty,
            contextRefreshRequired: active.compactionSeq !== undefined,
          },
        }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_refresh_context',
    description: 'Rebuild the authoritative pre-action context. Reads the complete contract, the checked-out node lineage and acceptance criteria, plus every declared mutation target in full before issuing a one-action freshness basis.',
    parameters: {
      targetPaths: {
        type: 'array',
        description: 'Workspace-relative or contained absolute files for the next guarded mutation. Existing files are returned in full; new paths are bound as missing.',
        items: { type: 'string' },
      },
      planNodeId: {
        type: 'string',
        description: 'Optional node whose complete lineage and direct children must be read before a targeted plan change. Roots and the bounded actionable frontier are always included.',
      },
    },
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(args, exec) {
      const workspace = await workspaceFor(exec.agent)
      const targetPaths = args.targetPaths ?? []
      const state = await store.peek(workspace)
      if (state === undefined) {
        if (exec.agent === undefined) throw new Error('no lattice exists for this workspace')
        const control = controls.get(sessionKey(exec.agent))
        if (control === undefined || control.phase !== 'contract') throw new Error('no lattice exists for this workspace')
        const contract = await verifyAnchoredContract({ workspace, sessionId: control.rootSessionId })
        const context = await readProjectContext(workspace, [CONTRACT_DOCUMENT_PATH], resolved.maxContextBytes)
        const targetContext = await readMutationTargets(workspace, targetPaths, resolved.maxContextBytes)
        control.contract = contract
        control.compactionSeq = undefined
        control.mutationBasis = {
          targets: targetContext.targets,
          targetDigest: targetContext.digest,
        }
        return json({
          message: `Reread the complete v2 execution contract at revision ${contract.revision}${targetContext.targets.length === 0 ? '' : ` and ${targetContext.targets.length} exact mutation target${targetContext.targets.length === 1 ? '' : 's'}`}.`,
          receipt: { id: contract.id, revision: contract.revision, digest: contract.documentDigest },
          documents: context.documents,
          targets: targetContext.targets,
        })
      }
      const issued = await issueCurrentReceipt(exec.agent!, workspace, state, targetPaths, args.planNodeId)
      const lease = leases.get(sessionKey(exec.agent!))
      if (lease?.workspace === workspace) {
        lease.compactionSeq = undefined
        lease.contextDigest = issued.receipt.digest
        lease.contextPaths = state.project.contextPaths
        lease.mutationBasis = issued.mutationBasis
      }
      return json({
        message: `Read ${issued.documents.length} complete contract documents, the current plan structure${issued.mutationBasis.nodePlan === undefined ? '' : ', the current execution lineage'}${issued.mutationBasis.targets.length === 0 ? '' : `, and ${issued.mutationBasis.targets.length} exact mutation target${issued.mutationBasis.targets.length === 1 ? '' : 's'}`} for lattice revision ${state.revision}.`,
        receipt: issued.receipt,
        documents: issued.documents,
        planContext: issued.planContext,
        ...(issued.mutationBasis.nodePlan === undefined ? {} : { executionPlan: issued.mutationBasis.nodePlan }),
        targets: issued.mutationBasis.targets,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_adopt_context',
    description: 'Safely add newly required project documents to the context contract. It requires a fresh read of the old contract, no active execution lease, and returns the complete new contract with a new revision-bound receipt.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh receipt for the current context contract.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision observed with the current receipt.' },
      addPaths: {
        type: 'array',
        required: true,
        description: 'Previously undeclared workspace-relative project documents that must constrain future plan changes.',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      const current = await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      ensureNoActiveLease(workspace)
      const additions = validateContextPaths(args.addPaths)
      if (additions.some(path => current.project.contextPaths.includes(path))) {
        throw new Error('addPaths may contain only documents that are not already in the context contract')
      }
      const contextPaths = validateContextPaths([...current.project.contextPaths, ...additions])
      // Read every added document before changing the durable contract. A
      // missing, unsafe, or oversized addition therefore cannot leave a
      // partial state that the model has never seen.
      const context = await readProjectContext(workspace, contextPaths, resolved.maxContextBytes)
      const result = await store.mutate(workspace, 'adopt-context', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const now = Date.now()
        state.project = { ...state.project, contextPaths, updatedAt: now }
        state.revision += 1
        return {
          value: { revision: state.revision, project: { ...state.project } },
          delta: delta(state, [], true),
        }
      })
      const receipt = issueReceipt(workspace, {
        schemaVersion: LATTICE_SCHEMA_VERSION,
        revision: result.revision,
        project: result.project,
        nodes: {},
      }, context)
      receipts.set(sessionKey(agent), receipt)
      return json({
        message: `Adopted ${additions.length} newly required context document${additions.length === 1 ? '' : 's'} at lattice revision ${result.revision}. Read the complete returned contract before the next plan change.`,
        project: result.project,
        receipt,
        documents: context.documents,
      })
    },
  }))

  if (resolved.legacyIntakeMode !== 'off') {
    ctx.tools.register(defineTool({
      name: 'lattice_reframe',
      description: 'Re-establish the execution contract when material facts change. Requires a fresh current contract, no active lease, renewed human policy, and preserves the existing graph for explicit reconciliation.',
      parameters: {
        receiptId: { type: 'string', description: 'Fresh lattice receipt. Required only when a graph already exists.' },
        expectedRevision: { type: 'integer', description: 'Exact lattice revision. Required only when a graph already exists.' },
        requestSummary: { type: 'string', required: true, description: 'Updated request summary including the material change.' },
        estimatedSteps: { type: 'integer', required: true, description: 'Updated estimate of remaining atomic execution steps.' },
        systemBoundary: { type: 'string', required: true, description: 'Updated scope and exclusions.' },
        timeHorizon: { type: 'string', required: true, description: 'Updated decision and execution horizon.' },
        desiredOutcome: { type: 'string', required: true, description: 'Updated observable outcome.' },
        confirmedFacts: { type: 'array', required: true, items: { type: 'string' } },
        decisions: { type: 'array', required: true, items: { type: 'string' } },
        invariants: { type: 'array', required: true, items: { type: 'string' } },
        changeables: { type: 'array', required: true, items: { type: 'string' } },
        forces: { type: 'array', required: true, items: { type: 'string' } },
        keyVariables: { type: 'array', required: true, items: { type: 'string' } },
        assumptions: { type: 'array', required: true, items: { type: 'string' } },
        unknowns: { type: 'array', required: true, items: { type: 'string' } },
        readiness: { type: 'string', required: true, enum: ['ready', 'conditional'] },
        readinessRationale: { type: 'string', required: true },
        questions: {
          type: 'array',
          required: true,
          description: 'Zero to five new high-impact questions. Guided policy requires at least one.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              question: { type: 'string', required: true },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', required: true },
                    description: { type: 'string' },
                  },
                },
              },
              multiSelect: { type: 'boolean' },
            },
          },
        },
      },
      output: { schema: { type: 'json' }, render: renderReframe },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('lattice_reframe requires an owning root agent session')
        const agent = exec.agent
        const workspace = await workspaceFor(agent)
        if (intakeInProgress.has(workspace)) throw new Error('another intake or reframe is already in progress')
        intakeInProgress.add(workspace)
        try {
          if (resolved.legacyIntakeMode === undefined) {
            const control = controls.get(sessionKey(agent))
            if (control === undefined || (control.phase !== 'contract' && control.phase !== 'lattice')) {
              throw new Error('lattice_reframe requires an active v2 contract or lattice task')
            }
            if (agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
              throw new Error('a delegated agent cannot revise the root contract; return the material gap to its parent')
            }
            let previous: ContractRecord | undefined
            const replacingUntrustedContract = control.reframePending && control.contract !== undefined
            if (replacingUntrustedContract) {
              previous = control.contract
            } else {
              try {
                previous = readContractSync(workspace)
              } catch {
                previous = readContractRecordSync(workspace)
                control.reframePending = true
              }
            }
            if (previous !== undefined && previous.sessionId !== control.rootSessionId) {
              throw new Error('the existing v2 execution contract belongs to another root task')
            }
            let latticeRevision: number | undefined
            if (control.phase === 'lattice') {
              if (args.receiptId === undefined || args.expectedRevision === undefined) {
                throw new Error('an active lattice requires receiptId and expectedRevision before reframe')
              }
              const current = await requireFreshReceipt(
                agent,
                workspace,
                assertText(args.receiptId, 'receiptId'),
                args.expectedRevision,
              )
              latticeRevision = current.revision
              ensureNoActiveLease(workspace)
            }
            const unknowns = textList(args.unknowns, 'unknowns')
            const framing: IntakeFraming = {
              requestSummary: assertText(args.requestSummary, 'requestSummary'),
              estimatedSteps: positiveInteger(args.estimatedSteps, 1, 'estimatedSteps'),
              systemBoundary: assertText(args.systemBoundary, 'systemBoundary'),
              timeHorizon: assertText(args.timeHorizon, 'timeHorizon'),
              desiredOutcome: assertText(args.desiredOutcome, 'desiredOutcome'),
              confirmedFacts: textList(args.confirmedFacts, 'confirmedFacts'),
              decisions: textList(args.decisions, 'decisions'),
              invariants: textList(args.invariants, 'invariants'),
              changeables: textList(args.changeables, 'changeables'),
              forces: textList(args.forces, 'forces'),
              keyVariables: textList(args.keyVariables, 'keyVariables'),
              assumptions: textList(args.assumptions, 'assumptions'),
              unknowns,
              readiness: intakeReadiness(args.readiness, unknowns),
              readinessRationale: assertText(args.readinessRationale, 'readinessRationale'),
            }
            const questions = normalizeQuestions(args.questions)
            if (control.clarificationPolicy === 'never' && questions.length > 0) {
              throw new Error('clarificationPolicy never forbids reframe questions; record reversible assumptions')
            }
            if (control.clarificationPolicy === 'always' && questions.length === 0) {
              throw new Error('clarificationPolicy always requires at least one reframe question')
            }
            if (control.clarificationPolicy === 'never' && framing.assumptions.length === 0) {
              throw new Error('question-free reframe requires at least one explicit, reversible assumption')
            }
            control.reframePending = true
            const pending: PendingIntake = {
              id: randomUUID(),
              workspace,
              sessionId: control.rootSessionId,
              kind: 'reframe',
              controlLevel: control.phase,
              clarificationPolicy: control.clarificationPolicy,
              framing,
              questions,
              answers: [],
              previousContract: previous,
              replaceUntrustedContract: replacingUntrustedContract,
              ...(latticeRevision === undefined ? {} : { latticeRevision }),
            }
            if (questions.length > 0) {
              const interaction = ctx.get('userQuestions')
              if (interaction === undefined) throw new Error('no user-questions channel is available for outcome-critical reframe')
              const clarified = await interaction.ask({ questions, agent, signal: exec.signal })
              pending.answers = requireAnswers(questions, clarified.answers)
              pendingIntakes.set(pending.id, pending)
              return json({
                message: 'Reframe answers were collected. Bind each answer with lattice_commit_intake before guarded work resumes.',
                pendingIntakeId: pending.id,
                answers: pending.answers,
              })
            }
            const persisted = await finalizePendingContract(pending, [], agent)
            return json({
              message: control.phase === 'lattice'
                ? 'Committed the revised v2 contract and advanced the lattice for node reconciliation.'
                : 'Committed the revised v2 contract; guarded contract work may resume.',
              receipt: persisted.contractReceipt,
              ...(persisted.latticeReceipt === undefined ? {} : { latticeReceipt: persisted.latticeReceipt }),
              ...(persisted.project === undefined ? {} : { project: persisted.project }),
              ...(persisted.documents === undefined ? {} : { documents: persisted.documents }),
              contract: persisted.contract,
            })
          }
          if (args.receiptId === undefined || args.expectedRevision === undefined) {
            throw new Error('legacy reframe requires receiptId and expectedRevision')
          }
          const legacyReceiptId = args.receiptId
          const legacyExpectedRevision = args.expectedRevision
          const current = await requireFreshReceipt(agent, workspace, legacyReceiptId, legacyExpectedRevision)
          ensureNoActiveLease(workspace)
          const unknowns = textList(args.unknowns, 'unknowns')
          const framing: IntakeFraming = {
            requestSummary: assertText(args.requestSummary, 'requestSummary'),
            estimatedSteps: positiveInteger(args.estimatedSteps, 1, 'estimatedSteps'),
            systemBoundary: assertText(args.systemBoundary, 'systemBoundary'),
            timeHorizon: assertText(args.timeHorizon, 'timeHorizon'),
            desiredOutcome: assertText(args.desiredOutcome, 'desiredOutcome'),
            confirmedFacts: textList(args.confirmedFacts, 'confirmedFacts'),
            decisions: textList(args.decisions, 'decisions'),
            invariants: textList(args.invariants, 'invariants'),
            changeables: textList(args.changeables, 'changeables'),
            forces: textList(args.forces, 'forces'),
            keyVariables: textList(args.keyVariables, 'keyVariables'),
            assumptions: textList(args.assumptions, 'assumptions'),
            unknowns,
            readiness: intakeReadiness(args.readiness, unknowns),
            readinessRationale: assertText(args.readinessRationale, 'readinessRationale'),
          }
          const intake = await conductIntake(agent, exec.signal, framing, normalizeQuestions(args.questions))
          // A human answer can take minutes. Recheck the exact old graph and
          // contract after the answer so concurrent work cannot be overwritten.
          await requireFreshReceipt(agent, workspace, legacyReceiptId, legacyExpectedRevision)
          ensureNoActiveLease(workspace)
          const persisted = await persistIntake({
            workspace,
            sessionId: sessionKey(agent),
            decision: intake.decision,
            framing,
            questions: intake.questions,
            answers: intake.answers,
            receiptId: intake.receiptId,
            createdAt: intake.createdAt,
          })
          const contextPaths = validateContextPaths([
            INTAKE_DOCUMENT_PATH,
            ...current.project.contextPaths.filter(path => path !== INTAKE_DOCUMENT_PATH),
          ])
          const context = await readProjectContext(workspace, contextPaths, resolved.maxContextBytes)
          const result = await store.mutate(workspace, 'reframe', state => {
            assertExpectedRevision(state, legacyExpectedRevision)
            const now = Date.now()
            state.project = {
              ...state.project,
              objective: framing.desiredOutcome,
              contextPaths,
              updatedAt: now,
            }
            state.revision += 1
            return {
              value: { revision: state.revision, project: { ...state.project } },
              delta: delta(state, [], true),
            }
          })
          clearWorkspace(workspace)
          const receipt = issueReceipt(workspace, {
            schemaVersion: LATTICE_SCHEMA_VERSION,
            revision: result.revision,
            project: result.project,
            nodes: {},
          }, context)
          receipts.set(sessionKey(agent), receipt)
          return json({
            message: `Reframed the execution contract at lattice revision ${result.revision}. Reconcile every unfinished node against the returned contract before checkout.`,
            project: result.project,
            intakeReceipt: persisted.receipt,
            receipt,
            documents: context.documents,
          })
        } finally {
          intakeInProgress.delete(workspace)
        }
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'lattice_add',
    description: 'Add one pending node after re-reading the full project context. Root nodes are capped at two and nested nodes at five by default.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh receipt returned by lattice_open or lattice_refresh_context.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision observed with the receipt.' },
      parentId: { type: 'string', description: 'Parent node id. Omit only for a root node.' },
      title: { type: 'string', required: true, description: 'Concrete child outcome.' },
      acceptanceCriteria: { type: 'string', required: true, description: 'Observable proof required before completion.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      requireObservedPlanNode(agent, workspace, args.parentId)
      ensureNoActiveLease(workspace)
      const result = await store.mutate(workspace, 'add', state => {
        assertExpectedRevision(state, args.expectedRevision)
        if (args.parentId !== undefined) assertMutable(findNode(state, args.parentId))
        assertBranchingCapacity(state, args.parentId, 1, resolved.topLevelLimit, resolved.nestedLimit)
        const node = createNode({ parentId: args.parentId, title: args.title, acceptanceCriteria: args.acceptanceCriteria, now: Date.now() })
        state.nodes[node.id] = node
        state.revision += 1
        state.project.updatedAt = Date.now()
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Added node ${result.node.id} at lattice revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_split',
    description: 'Replace a pending leaf with two to five smaller pending children after re-reading the complete project context. This is recursive decomposition, not parallel execution.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Pending leaf to decompose.' },
      children: {
        type: 'array',
        required: true,
        description: 'Two to five atomic children, each with an observable acceptance criterion.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            acceptanceCriteria: { type: 'string', required: true },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      requireObservedPlanNode(agent, workspace, args.nodeId)
      ensureNoActiveLease(workspace)
      if (args.children.length < 2) throw new Error('lattice_split requires at least two children')
      const result = await store.mutate(workspace, 'split', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const parent = findNode(state, args.nodeId)
        assertMutable(parent)
        if (!isLeaf(state, parent.id)) throw new Error('only a leaf can be split')
        assertBranchingCapacity(state, parent.id, args.children.length, resolved.topLevelLimit, resolved.nestedLimit)
        const now = Date.now()
        parent.status = 'active'
        parent.updatedAt = now
        const children = args.children.map(child => createNode({ parentId: parent.id, title: child.title, acceptanceCriteria: child.acceptanceCriteria, now }))
        for (const child of children) state.nodes[child.id] = child
        state.revision += 1
        state.project.updatedAt = now
        return { value: { children, revision: state.revision }, delta: delta(state, [parent, ...children], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Split node ${args.nodeId} into ${result.children.length} children at revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        children: result.children,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_update',
    description: 'Edit one unfinished node only after the whole context contract has been read again. Use lattice_checkpoint for execution evidence and completion.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Unfinished node to edit.' },
      title: { type: 'string', description: 'Replacement title.' },
      acceptanceCriteria: { type: 'string', description: 'Replacement observable acceptance criterion.' },
      blockedReason: { type: 'string', description: 'Non-empty reason to block this node; omit to leave its status unchanged.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      requireObservedPlanNode(agent, workspace, args.nodeId)
      ensureNoActiveLease(workspace)
      if (args.title === undefined && args.acceptanceCriteria === undefined && args.blockedReason === undefined) {
        throw new Error('lattice_update requires title, acceptanceCriteria, or blockedReason')
      }
      const result = await store.mutate(workspace, 'update', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, args.nodeId)
        assertMutable(node)
        if (args.title !== undefined) node.title = assertText(args.title, 'title')
        if (args.acceptanceCriteria !== undefined) node.acceptanceCriteria = assertText(args.acceptanceCriteria, 'acceptanceCriteria')
        if (args.blockedReason !== undefined) {
          node.blockedReason = assertText(args.blockedReason, 'blockedReason')
          node.status = 'blocked'
        }
        node.updatedAt = Date.now()
        state.revision += 1
        state.project.updatedAt = node.updatedAt
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Updated node ${args.nodeId} at lattice revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_archive',
    description: 'Archive one non-active leaf with an audit reason after rereading the full project context. Archiving preserves history; it never deletes a node.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Leaf node to archive.' },
      reason: { type: 'string', required: true, description: 'Why this path is no longer part of the current plan.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      requireObservedPlanNode(agent, workspace, args.nodeId)
      ensureNoActiveLease(workspace)
      const result = await store.mutate(workspace, 'archive', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, args.nodeId)
        assertMutable(node)
        if (node.status === 'active') throw new Error('an active node must be checkpointed or blocked before it can be archived')
        if (!isLeaf(state, node.id)) throw new Error('only a leaf can be archived')
        node.status = 'archived'
        node.blockedReason = assertText(args.reason, 'reason')
        node.updatedAt = Date.now()
        state.revision += 1
        state.project.updatedAt = node.updatedAt
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Archived node ${args.nodeId} at lattice revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_checkout',
    description: 'Acquire the sole execution lease for one current leaf. The lease is granted only after a complete context reread and permits configured write tools until the next successful guarded action requires a checkpoint.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Pending or active leaf to execute.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      const state = await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      requireObservedPlanNode(agent, workspace, args.nodeId)
      const receipt = receipts.get(sessionKey(agent))
      if (receipt === undefined) throw new Error('context receipt is missing; call lattice_refresh_context')
      ensureNoActiveLease(workspace)
      const result = await store.mutate(workspace, 'checkout', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, args.nodeId)
        if (node.status !== 'pending' && node.status !== 'active') throw new Error('only a pending or active node can be checked out')
        if (!isLeaf(state, node.id)) throw new Error('only a leaf can be checked out for execution')
        const now = Date.now()
        const touched: LatticeNode[] = []
        let current: LatticeNode | undefined = node
        while (current !== undefined) {
          if (current.status === 'pending') current.status = 'active'
          current.updatedAt = now
          touched.push(current)
          current = current.parentId === undefined ? undefined : findNode(state, current.parentId)
        }
        state.revision += 1
        state.project.updatedAt = now
        return { value: { node, revision: state.revision }, delta: delta(state, touched, true) }
      })
      clearWorkspace(workspace)
      leases.set(sessionKey(agent), {
        workspace,
        nodeId: args.nodeId,
        revision: result.revision,
        dirty: false,
        contextDigest: receipt.digest,
        contextPaths: state.project.contextPaths,
      })
      return json({
        message: `Checked out leaf ${args.nodeId} at lattice revision ${result.revision}. Guarded tools are now permitted for this leaf; refresh context before checkpointing.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_checkpoint',
    description: 'Record the result of the current minimal execution unit. This rereads context, records evidence, and either keeps the leaf active or completes it and recursively reconciles parents whose children are all complete.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      summary: { type: 'string', required: true, description: 'What changed or was verified since the previous checkpoint.' },
      references: { type: 'array', required: true, description: 'Concrete files, commands, test names, or review evidence.', items: { type: 'string' } },
      complete: { type: 'boolean', required: true, description: 'True only when the leaf acceptance criterion is satisfied.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      const lease = leases.get(sessionKey(agent))
      if (lease === undefined || lease.workspace !== workspace) throw new Error('lattice_checkpoint requires this session to hold a leaf lease')
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      const result = await store.mutate(workspace, 'checkpoint', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, lease.nodeId)
        if (!isLeaf(state, node.id)) throw new Error('the checked-out node is no longer a leaf')
        const evidence = {
          summary: assertText(args.summary, 'summary'),
          references: args.references.map(reference => assertText(reference, 'reference')),
          recordedAt: Date.now(),
        }
        const touched = args.complete
          ? completeAndCollapse(state, node.id, evidence)
          : (() => {
              assertMutable(node)
              node.evidence.push(evidence)
              node.updatedAt = evidence.recordedAt
              return [node]
            })()
        state.revision += 1
        state.project.updatedAt = evidence.recordedAt
        return { value: { touched, revision: state.revision }, delta: delta(state, touched, true) }
      })
      receipts.delete(sessionKey(agent))
      structuralContexts.delete(sessionKey(agent))
      if (args.complete) leases.delete(sessionKey(agent))
      else leases.set(sessionKey(agent), {
        ...lease,
        revision: result.revision,
        dirty: false,
        mutationBasis: undefined,
      })
      return json({
        message: args.complete
          ? `Completed ${lease.nodeId} and reconciled ${result.touched.length - 1} parent nodes at revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`
          : `Checkpointed ${lease.nodeId} at revision ${result.revision}; its execution lease remains current. Refresh context before the next checkpoint.`,
        touched: result.touched,
      })
    },
  }))

  function installControl(agent: Agent): void {
    const key = sessionKey(agent)
    if (controls.has(key)) return
    const parentId = agent.session.header.parentSession
    const parent = parentId === undefined ? undefined : controls.get(String(parentId))
    if (parent !== undefined) {
      const inherited: AgentControl = {
        phase: parent.phase,
        clarificationPolicy: parent.clarificationPolicy,
        reasons: ['inherited from parent task', ...parent.reasons],
        rootSessionId: parent.rootSessionId,
        ...(parent.contract === undefined ? {} : { contract: parent.contract }),
        reframePending: parent.reframePending,
        ...(parent.compactionSeq === undefined ? {} : { compactionSeq: parent.compactionSeq }),
      }
      controls.set(key, inherited)
      updateRestriction(agent, inherited)
      return
    }

    const cwd = agent.session.header.cwd
    let contract: ContractRecord | undefined
    let invalidContract = false
    if (cwd !== undefined) {
      let workspaceRecord: ContractRecord | undefined
      try {
        workspaceRecord = readContractRecordSync(cwd)
        const validated = readContractSync(cwd)
        if (validated !== undefined) workspaceRecord = validated
      } catch {
        invalidContract = true
      }
      if (workspaceRecord !== undefined) {
        try {
          const anchor = readContractAnchorSync(resolved.contractAnchorRoot, workspaceRecord.sessionId)
          if (anchor === undefined || !contractMatchesAnchor(workspaceRecord, anchor)) invalidContract = true
          contract = anchor ?? workspaceRecord
        } catch {
          contract = workspaceRecord
          invalidContract = true
        }
      } else {
        try {
          const orphanedAnchor = readContractAnchorSync(resolved.contractAnchorRoot, key)
          if (orphanedAnchor !== undefined) {
            contract = orphanedAnchor
            invalidContract = true
          }
        } catch {
          invalidContract = true
        }
      }
      const isDelegated = agent.session.header.origin === 'subagent'
        || (agent.session.header.delegationDepth ?? 0) > 0
        || agent.session.header.parentSession !== undefined
      if (!isDelegated && contract !== undefined && contract.sessionId !== key) invalidContract = true
    }
    const hasV1Graph = cwd !== undefined && existsSync(join(cwd, '.dsh', 'plan-lattice', 'v1', 'snapshot.json'))
    const phase: RoutePhase = hasV1Graph
      ? 'lattice'
      : contract?.controlLevel
        ?? (resolved.legacyIntakeMode !== undefined
          ? 'lattice'
          : resolved.activationMode === 'off'
            ? 'bypass'
            : resolved.activationMode === 'always'
              ? resolved.controlCeiling
              : 'probe')
    const control: AgentControl = {
      phase,
      clarificationPolicy: contract?.clarificationPolicy ?? resolved.clarificationPolicy,
      reasons: hasV1Graph
        ? ['resumed an existing v1 lattice']
        : contract !== undefined
          ? ['restored v2 execution contract']
          : invalidContract
            ? ['v2 contract exists but failed integrity validation']
            : ['awaiting first user request'],
      rootSessionId: invalidContract && contract?.sessionId !== key ? key : contract?.sessionId ?? key,
      ...(contract === undefined ? {} : { contract }),
      reframePending: invalidContract,
    }
    controls.set(key, control)
    updateRestriction(agent, control)
  }

  ctx.on('agent/created', ({ agent }) => installControl(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const control = controls.get(sessionKey(agent))
    control?.restriction?.()
    controls.delete(sessionKey(agent))
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    installControl(agent)
    const text = extractMessageText(message)
    if (text === '') return
    const control = controls.get(sessionKey(agent))!
    if (control.phase === 'probe') {
      transitionControl(agent, routeRequest(text, resolved))
      return
    }
    const override = routeRequest(text, resolved)
    if (override.reasons.includes('explicit bypass') || override.reasons.includes('explicit full-lattice override')) {
      transitionControl(agent, override)
      return
    }
    if ((control.phase === 'contract' || control.phase === 'lattice') && isMaterialChange(text)) {
      control.reframePending = true
      control.mutationBasis = undefined
      control.reasons = ['material user change requires contract revision', ...control.reasons]
    }
  })

  const registry = ctx.get('agents')
  if (registry !== undefined) for (const agent of registry.list()) installControl(agent)
}
