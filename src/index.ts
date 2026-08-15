/**
 * Fractal Ledger: an evidence-gated recursive work graph for long-horizon agents.
 *
 * A lattice is deliberately not another todo list. Structural mutations and
 * execution leases are accepted only after the configured project contract has
 * been read in full and its current digest has been proven again.
 */

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
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
  INTAKE_DOCUMENT_PATH,
  type IntakeAnswer,
  type IntakeDecision,
  type IntakeFraming,
  type IntakeQuestion,
  persistIntake,
  renderIntakeContract,
  verifyIntake,
} from './intake.js'
import { LatticeStore } from './store.js'

export const name = 'plan-lattice'
export const inject = ['tools']

export interface Config {
  /** Pre-execution discovery policy. `off` preserves the original fully autonomous behavior. */
  intakeMode?: 'off' | 'adaptive' | 'guided'
  /** Estimated atomic-step count at which a non-off intake policy becomes mandatory. */
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
}

interface ResolvedConfig {
  intakeMode: 'off' | 'adaptive' | 'guided'
  longTaskThreshold: number
  guardedTools: Set<string>
  maxContextBytes: number
  topLevelLimit: number
  nestedLimit: number
  snapshotEvery: number
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
}

interface AgentLike {
  session: {
    id: unknown
    header: { cwd?: string }
  }
}

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
  const intakeMode = config.intakeMode ?? 'off'
  if (intakeMode !== 'off' && intakeMode !== 'adaptive' && intakeMode !== 'guided') {
    throw new Error('intakeMode must be off, adaptive, or guided')
  }
  const guardedTools = new Set(config.guardedTools ?? ['write', 'edit', 'str_replace_editor'])
  if (config.strictBash === true) guardedTools.add('bash')
  for (const tool of guardedTools) {
    if (tool.trim().length === 0) throw new Error('guardedTools must not contain an empty name')
  }
  return {
    intakeMode,
    longTaskThreshold: positiveInteger(config.longTaskThreshold, 8, 'longTaskThreshold'),
    guardedTools,
    maxContextBytes: positiveInteger(config.maxContextBytes, 256 * 1024, 'maxContextBytes'),
    topLevelLimit: positiveInteger(config.topLevelLimit, 2, 'topLevelLimit'),
    nestedLimit: positiveInteger(config.nestedLimit, 5, 'nestedLimit'),
    snapshotEvery: positiveInteger(config.snapshotEvery, 1024, 'snapshotEvery'),
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
    )).join('\n\n')}`,
  }]
}

function renderIntake(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as { message?: unknown; contract?: unknown }
  const message = typeof record.message === 'string' ? record.message : 'Execution intake confirmed.'
  const contract = typeof record.contract === 'string' ? record.contract : ''
  return [{ type: 'text', text: contract === '' ? message : `${message}\n\n${contract}` }]
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
  const leases = new Map<string, ExecutionLease>()
  const intakeInProgress = new Set<string>()

  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'plan:fractal-ledger',
    order: 55,
    text: `## Fractal Ledger long-task control

Before protected work, estimate the number of atomic execution steps honestly. For work likely to require ${resolved.longTaskThreshold} or more steps, establish the system boundary and desired outcome before decomposing it.

Use this reasoning cycle: define the boundary and time horizon; identify invariants; separate changeable forms; identify directional forces; reduce them to the few causal variables that decide success; then adapt the path while preserving the invariants. Re-run the cycle when material external facts change. Read repository evidence before questioning the user. Keep evidence-supported facts, user or product decisions, model assumptions, and unresolved unknowns distinct. Ask only about missing facts that can materially change scope, risk, or investment.

Intake policy is ${resolved.intakeMode}. ${resolved.intakeMode === 'off'
  ? 'Proceed autonomously and make assumptions explicit in the normal project context.'
  : resolved.intakeMode === 'adaptive'
    ? 'Call lattice_intake before lattice_open for long work. Let the user choose guided clarification or autonomous execution; autonomous mode still requires explicit assumptions.'
    : 'Call lattice_intake before lattice_open for long work. Ask only the highest-impact missing questions, obtain confirmation of the exact contract, and do not begin execution before it is persisted.'}

Only the live root agent may ask the human. A delegated agent must return unresolved boundary questions to its parent instead of guessing or blocking on user input. Mark readiness ready only when core outcome, boundary, and acceptance are known. Conditional readiness may preserve options around explicit non-core unknowns. Newly discovered facts that can change the boundary, acceptance criteria, or irreversible work require lattice_reframe before continuing; reconcile unfinished nodes against its newly rendered contract.`,
  }))

  function clearWorkspace(workspace: string): void {
    for (const [key, receipt] of receipts) if (receipt.workspace === workspace) receipts.delete(key)
    for (const [key, lease] of leases) if (lease.workspace === workspace) leases.delete(key)
  }

  function ensureNoActiveLease(workspace: string): void {
    for (const lease of leases.values()) {
      if (lease.workspace === workspace) {
        throw new Error(`node ${JSON.stringify(lease.nodeId)} is checked out; checkpoint it before changing the plan`)
      }
    }
  }

  async function issueCurrentReceipt(agent: AgentLike, workspace: string, state: LatticeState): Promise<{
    receipt: LatticeReceipt
    documents: Awaited<ReturnType<typeof readProjectContext>>['documents']
  }> {
    const context = await readProjectContext(workspace, state.project.contextPaths, resolved.maxContextBytes)
    const receipt = issueReceipt(workspace, state, context)
    receipts.set(sessionKey(agent), receipt)
    return { receipt, documents: context.documents }
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
    let decision: IntakeDecision = resolved.intakeMode === 'guided' ? 'guided' : 'autonomous'
    if (resolved.intakeMode === 'adaptive') {
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

  ctx.tools.guard(exec => {
    if (!resolved.guardedTools.has(exec.name)) return undefined
    if (exec.agent === undefined) return `plan-lattice blocks ${exec.name}: no owning agent can hold a lattice lease`
    const lease = leases.get(sessionKey(exec.agent))
    if (lease === undefined) return `plan-lattice blocks ${exec.name}: check out one current leaf first`
    if (lease.dirty) return `plan-lattice blocks ${exec.name}: checkpoint the previous guarded action first`
    if (lease.compactionSeq !== undefined) {
      return `plan-lattice blocks ${exec.name}: compaction at session event ${lease.compactionSeq} changed model-visible history; call lattice_refresh_context before another guarded action`
    }
    if (lease.revision < 1) return `plan-lattice blocks ${exec.name}: refresh the project context first`
    return changedContractGuard(exec.name, lease)
  })

  ctx.on('tools/result', (exec, result) => {
    if (result.isError || exec.agent === undefined || !resolved.guardedTools.has(exec.name)) return
    const lease = leases.get(sessionKey(exec.agent))
    if (lease !== undefined) lease.dirty = true
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
    const lease = leases.get(key)
    if (lease !== undefined) lease.compactionSeq = event.seq
  })

  if (resolved.intakeMode !== 'off') {
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
          const intake = await conductIntake(exec.agent, exec.signal, framing, normalizeQuestions(args.questions))
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
    name: 'lattice_open',
    description: `Create the workspace-local evidence-gated work graph. With intake policy ${resolved.intakeMode}, work estimated at ${resolved.longTaskThreshold} or more atomic steps also requires a confirmed intake receipt.`,
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
      if (resolved.intakeMode !== 'off') {
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
            ...(resolved.intakeMode === 'guided' ? { requiredDecision: 'guided' as const } : {}),
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
      return json({
        message: `Opened lattice revision ${state.revision}. Context is complete and current; create no more than ${resolved.topLevelLimit} root nodes before executing.`,
        project: state.project,
        receipt,
        documents: context.documents,
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
    description: 'Read every document in the current project context contract in full and issue one revision-bound freshness receipt. Use it before any structural change or after external project facts change.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(_args, exec) {
      const workspace = await workspaceFor(exec.agent)
      const state = await store.peek(workspace)
      if (state === undefined) throw new Error('no lattice exists for this workspace')
      const issued = await issueCurrentReceipt(exec.agent!, workspace, state)
      const lease = leases.get(sessionKey(exec.agent!))
      if (lease?.workspace === workspace) {
        lease.compactionSeq = undefined
        lease.contextDigest = issued.receipt.digest
        lease.contextPaths = state.project.contextPaths
      }
      return json({
        message: `Read ${issued.documents.length} complete context documents for lattice revision ${state.revision}.`,
        receipt: issued.receipt,
        documents: issued.documents,
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

  if (resolved.intakeMode !== 'off') {
    ctx.tools.register(defineTool({
      name: 'lattice_reframe',
      description: 'Re-establish the execution contract when material facts change. Requires a fresh current contract, no active lease, renewed human policy, and preserves the existing graph for explicit reconciliation.',
      parameters: {
        receiptId: { type: 'string', required: true, description: 'Fresh receipt for the current context contract.' },
        expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision observed with the current receipt.' },
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
      output: { schema: { type: 'json' }, render: renderContext },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('lattice_reframe requires an owning root agent session')
        const agent = exec.agent
        const workspace = await workspaceFor(agent)
        if (intakeInProgress.has(workspace)) throw new Error('another intake or reframe is already in progress')
        intakeInProgress.add(workspace)
        try {
          const current = await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
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
          await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
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
            assertExpectedRevision(state, args.expectedRevision)
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
      if (args.complete) leases.delete(sessionKey(agent))
      else leases.set(sessionKey(agent), { ...lease, revision: result.revision, dirty: false })
      return json({
        message: args.complete
          ? `Completed ${lease.nodeId} and reconciled ${result.touched.length - 1} parent nodes at revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`
          : `Checkpointed ${lease.nodeId} at revision ${result.revision}; its execution lease remains current. Refresh context before the next checkpoint.`,
        touched: result.touched,
      })
    },
  }))
}
