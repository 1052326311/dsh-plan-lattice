/**
 * Fractal Ledger: an evidence-gated recursive work graph for long-horizon agents.
 *
 * A lattice is deliberately not another todo list. Every controlled mutation
 * must rejoin authoritative intent (the full contract and current node plan)
 * with authoritative fact (the exact target body) immediately before action.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-plan-mode'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  isAgentLoopRequest,
  type ContextSnapshotSection,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  joinContextSections,
  renderContextSections,
  renderPrompt,
  type PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt'
import {
  defineTool,
  TOOL_ABORTED_BEFORE_DISPATCH,
  type ToolDefinition,
  type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  assertBranchingCapacity,
  assertExpectedRevision,
  assertMechanicalExecutionReceipt,
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
  type MechanicalExecutionReceipt,
  type LatticeNode,
  type LatticeReceipt,
  type LatticeState,
} from './domain.js'
import { issueReceipt, readProjectContext, readProjectContextSync, validateContextPaths } from './context.js'
import {
  canonicalAnswerBindingStatement,
  CONTRACT_DOCUMENT_PATH,
  type AnswerBinding,
  type AnswerBindingTarget,
  type AuthoritySource,
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
import { LatticeStore, readLatticeStateSync } from './store.js'
import {
  type ContractBasis,
  digestArguments,
  type ExternalPreconditionSnapshot,
  type MutationBasis,
  mutationTargetFromTool,
  nodeExecutionPlan,
  normalizeMutationTarget,
  readMutationTargets,
  structuralPlanView,
  summarizeExternalPreconditions,
  type StructuralPlanView,
  verifyMutationTargetsSync,
} from './mutation-context.js'
import {
  allHumanUserInputs,
  humanInputBoundary,
  pendingUserInputDigest,
  pendingUserInputs,
  userInputDigest,
  type InputReviewMarker,
  type PendingUserInput,
} from './input-review.js'
import {
  findUncoveredRequiredCriticalGaps,
  type CriticalGapDimension,
} from './critical-gaps.js'
import { DurableDelegatedInputFenceStore } from './delegated-input-fence.js'
import {
  ExecutionStateError,
  executionLeaseClaim,
  PersistentExecutionState,
  PostRenameDurabilityError as ExecutionStatePostRenameDurabilityError,
  type ExecutionLease as DurableExecutionLease,
} from './execution-state.js'

export const name = 'plan-lattice'
export const inject = ['tools']

const REFRAME_FENCE_NODE_ID = '__plan_lattice_reframe_fence__'
const STRUCTURAL_FENCE_NODE_ID = '__plan_lattice_structural_fence__'

export type GuardedToolIdentityValue =
  | null
  | boolean
  | number
  | string
  | GuardedToolIdentityValue[]
  | { [key: string]: GuardedToolIdentityValue }

export interface GuardedToolPreconditionAdapter {
  /**
   * Reduce raw tool arguments to the fields that determine side-effect identity.
   * Snapshot and verify still receive the complete original arguments and must
   * reject every omitted field that can alter execution semantics.
   */
  normalizeArguments?(arguments_: unknown): GuardedToolIdentityValue
  /** Capture the exact host-observable state that must still hold at dispatch. */
  snapshot(input: {
    workspace: string
    resource: string
    arguments: unknown
  }): Promise<{ stateDigest: string; description: string }>
  /** Synchronous final equality check performed by the Harness tool guard. */
  verify(input: {
    workspace: string
    resource: string
    arguments: unknown
    expectedStateDigest: string
  }): string | undefined
  /**
   * Capture a tool-wide observable scope before the model chooses one exact
   * action. The guard still normalizes and locks the emitted arguments before
   * dispatch. Use this only when the host can synchronously recheck the scope.
   */
  snapshotScope?(input: {
    workspace: string
  }): Promise<{ resource: string; stateDigest: string; description: string }>
  /** Synchronous final equality check for a scope snapshot. */
  verifyScope?(input: {
    workspace: string
    resource: string
    expectedStateDigest: string
  }): string | undefined
}

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
  /**
   * Include all Bash and PowerShell calls in the guard; commands cannot be
   * reliably classified as read-only. Defaults to true for v0.4 control and
   * false for an explicit legacy v0.3 intakeMode configuration.
   */
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
  /** Programmatic host adapters for non-filesystem side effects. Unknown guarded tools fail closed. */
  preconditionAdapters?: Record<string, GuardedToolPreconditionAdapter>
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
  preconditionAdapters: Map<string, GuardedToolPreconditionAdapter>
}

interface ExecutionLease {
  workspace: string
  nodeId: string
  nodeTitle: string
  nodeAcceptanceCriteria: string
  revision: number
  dirty: boolean
  /** Cross-process ownership and checkpoint obligation persisted outside the agent-writable workspace. */
  durable: DurableExecutionLease
  /** Contract that was last rendered to the model before this lease may write. */
  contextDigest: string
  contextPaths: string[]
  /** The durable event that invalidated model-visible authority after the last explicit context read. */
  contextReplacement?: { seq: number; type: string }
  /** One mutation basis rendered after checkout: contract + node lineage + exact target bodies. */
  mutationBasis?: MutationBasis
  /** A release requested while durable execution was in flight; fulfilled only after the exact receipt settles it clean. */
  releaseWhenClean?: boolean
}

interface ReframeFence {
  authorityWorkspace: string
  durable: DurableExecutionLease
}

interface AgentLike {
  session: {
    id: unknown
    header: { cwd?: string; parentSession?: unknown; origin?: 'subagent'; delegationDepth?: number }
  }
}

/** Optional rc.7 service binding; the peer package may be installed without mounting this service. */
interface ContinuableSubagentSetupService {
  registerContinuableSetup(contribution: (childCtx: Context) => () => void): () => void
}

/** Optional rc.7 plan-mode service. Plan Lattice never owns this state. */
interface NativePlanModeService {
  get(agent: Agent): { active: boolean; pending?: boolean }
}

interface NativeSubagentRunBinding {
  runId: string
  provider: string
  child: Agent
}

interface AgentControl {
  phase: RoutePhase
  clarificationPolicy: ClarificationPolicy
  reasons: string[]
  productDefinitionGap: number
  outcomeCritical: boolean
  criticalGaps: CriticalGapDimension[]
  /** Original user authority retained only while repository evidence is being joined into a probe decision. */
  routeBasisText?: string
  rootSessionId: string
  contract?: ContractRecord
  /** True only before this root task has accepted its first contract or legacy graph. */
  initialContractPending: boolean
  reframePending: boolean
  authorizationEpoch: number
  contextReplacement?: { seq: number; type: string }
  /** Contract-tier equivalent of the mutation basis (there is no node lineage). */
  mutationBasis?: MutationBasis
  /** Documents already rendered in full since the latest context replacement. */
  visibleDocuments?: Map<string, string>
  delegatedNode?: {
    id: string
    title: string
    acceptanceCriteria: string
    graphRevision: number
  }
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
  authorizationEpoch: number
}

type ModelToolSchema = NonNullable<GenerateOptions['tools']>[number]

interface FinalAssemblyAttestation {
  sessionId: string
  authorizationEpoch: number
  systemPrompt: string
  controlRuntimeText: string
  runtimeText: string
  runtimeSections: ContextSnapshotSection[]
  runtimeSnapshotText: string
  assembly: PromptAssembly
  codeOnlyPresentation: boolean
  toolRegistryGeneration: number
  toolViewDigest: string
  wireToolsDigest: string
  toolProtocolDigest: string
  requiredTool?: string
  transport: 'native' | 'code'
  wireToolName?: string
  wireToolDigest?: string
}

interface PendingDelegatedInitialInput {
  message: Parameters<typeof userInputDigest>[0]
}

interface PreparedInputReview {
  id: string
  rootSessionId: string
  epoch: number
  contract: ContractBasis
  pendingDigest: string
  throughSeq: number
  messageIds: string[]
}

interface PreparedRouteProbe {
  id: string
  workspace: string
  epoch: number
  digest: string
  paths: string[]
  evidenceAssessment: RouteAssessment
}

interface PreparedAuthorization {
  workspace: string
  receipt: LatticeReceipt
  epoch: number
  contract?: ContractBasis
  view: StructuralPlanView
}

interface PreparedDispatch {
  callId: string
  sessionId: string
  toolName: string
  argumentsDigest: string
  workspace: string
  consumedEpoch: number
  phase: 'contract' | 'lattice'
  rootSessionId: string
  basis: MutationBasis
  definition: ToolDefinition
  execute: ToolDefinition['execute']
  nodeId?: string
  revocation: AbortController
}

interface PreparedReadDispatch {
  callId: string
  sessionId: string
  toolName: string
  argumentsDigest: string
  definition: ToolDefinition
  execute: ToolDefinition['execute']
  revocation: AbortController
}

interface GuardedDefinitionBinding {
  definition: ToolDefinition
  execute: ToolDefinition['execute']
}

interface ExternalActionRequest {
  toolName: string
  resource: string
  arguments: unknown
}

function assertIdentityValue(
  value: unknown,
  path = '$',
  ancestors = new Set<object>(),
): asserts value is GuardedToolIdentityValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${path} must be a JSON value`)
  if (ancestors.has(value)) throw new Error(`${path} must not contain a cycle`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      let indexCount = 0
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new Error(`${path} must not contain non-JSON array properties`)
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error(`${path}[${key}] must be an enumerable JSON data property`)
        }
        indexCount += 1
      }
      if (indexCount !== value.length) throw new Error(`${path} must not contain sparse arrays`)
      for (let index = 0; index < value.length; index += 1) {
        assertIdentityValue(value[index], `${path}[${index}]`, ancestors)
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`${path} must not contain symbol keys`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`${path}.${key} must be an enumerable JSON data property`)
      }
      assertIdentityValue(descriptor.value, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function externalActionIdentity(
  adapter: GuardedToolPreconditionAdapter,
  arguments_: unknown,
): GuardedToolIdentityValue | unknown {
  if (adapter.normalizeArguments === undefined) return arguments_
  const normalized = adapter.normalizeArguments(arguments_)
  assertIdentityValue(normalized)
  return normalized
}

const LATTICE_TOOL_NAMES = [
  'lattice_route',
  'lattice_intake',
  'lattice_commit_intake',
  'lattice_open',
  'lattice_status',
  'lattice_review_input',
  'lattice_commit_input_review',
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

const ROOT_ONLY_LATTICE_TOOLS = new Set<string>([
  'lattice_route',
  'lattice_intake',
  'lattice_commit_intake',
  'lattice_open',
  'lattice_review_input',
  'lattice_commit_input_review',
  'lattice_reframe',
])

interface InitialPlanNodeInput {
  key: string
  parentKey?: string
  title: string
  acceptanceCriteria: string
}

interface InitialPlanResult {
  nodes: Array<{ key: string; node: LatticeNode }>
  selectedLeaf?: { key: string; node: LatticeNode }
}

const CONTROLLER_BOOTSTRAP_ROOT_KEY = 'accepted-outcome'
const CONTROLLER_BOOTSTRAP_LEAF_KEY = 'next-verified-increment'

function controllerBootstrapPlan(): InitialPlanNodeInput[] {
  return [
    {
      key: CONTROLLER_BOOTSTRAP_ROOT_KEY,
      title: 'Complete the accepted human request',
      acceptanceCriteria: 'Every outcome, boundary, invariant, and acceptance criterion in immutable human authority is satisfied with verifiable evidence.',
    },
    {
      key: CONTROLLER_BOOTSTRAP_LEAF_KEY,
      parentKey: CONTROLLER_BOOTSTRAP_ROOT_KEY,
      title: 'Deliver the next verified increment',
      acceptanceCriteria: 'The next smallest end-to-end increment toward the accepted outcome is implemented and verified; split or update this leaf after repository evidence when more precise execution boundaries are needed.',
    },
  ]
}

interface ProjectedDocuments {
  documents: Array<{ path: string; digest: string; content: string }>
  documentReferences: Array<{ path: string; digest: string }>
}

const COMPACT_CONTRACT_SCALAR_LIMIT = 1_200
const COMPACT_CONTRACT_LIST_LIMIT = 12
const COMPACT_CONTRACT_ITEM_LIMIT = 600
const COMPACT_CONTRACT_TOTAL_LIMIT = 20_000
/** The Harness validates every tool value at runtime; this boundary keeps the domain types isolated. */
function json(value: unknown): never {
  return value as never
}

function buildInitialPlan(
  state: LatticeState,
  inputs: InitialPlanNodeInput[],
  selectedLeafKey: string | undefined,
  limits: Pick<ResolvedConfig, 'topLevelLimit' | 'nestedLimit'>,
): InitialPlanResult {
  if (inputs.length > 64) throw new Error('initialPlan accepts at most 64 nodes')
  if (inputs.length === 0 && selectedLeafKey !== undefined) {
    throw new Error('selectedLeafKey requires at least one initialPlan node')
  }
  const byKey = new Map<string, LatticeNode>()
  const nodes: InitialPlanResult['nodes'] = []
  for (const [index, input] of inputs.entries()) {
    const key = assertText(input.key, `initialPlan[${index}].key`)
    if (byKey.has(key)) throw new Error(`duplicate initialPlan key ${JSON.stringify(key)}`)
    const parentKey = input.parentKey === undefined
      ? undefined
      : assertText(input.parentKey, `initialPlan[${index}].parentKey`)
    const parent = parentKey === undefined ? undefined : byKey.get(parentKey)
    if (parentKey !== undefined && parent === undefined) {
      throw new Error(`initialPlan parent ${JSON.stringify(parentKey)} must appear before child ${JSON.stringify(key)}`)
    }
    assertBranchingCapacity(
      state,
      parent?.id,
      1,
      limits.topLevelLimit,
      limits.nestedLimit,
    )
    const node = createNode({
      ...(parent === undefined ? {} : { parentId: parent.id }),
      title: assertText(input.title, `initialPlan[${index}].title`),
      acceptanceCriteria: assertText(input.acceptanceCriteria, `initialPlan[${index}].acceptanceCriteria`),
      now: state.project.createdAt,
      contractRevision: state.project.contractRevision,
      contractDigest: state.project.contractDigest,
    })
    state.nodes[node.id] = node
    byKey.set(key, node)
    nodes.push({ key, node })
  }
  let selectedKey = selectedLeafKey === undefined
    ? nodes.find(({ node }) => isLeaf(state, node.id))?.key
    : assertText(selectedLeafKey, 'selectedLeafKey')
  let selected = selectedKey === undefined ? undefined : byKey.get(selectedKey)
  if (selectedKey !== undefined && selected === undefined) {
    throw new Error(`selectedLeafKey ${JSON.stringify(selectedKey)} is not present in initialPlan`)
  }
  if (selected !== undefined && !isLeaf(state, selected.id)) {
    const parentId = selected.id
    const descendant = nodes.find(({ node }) => {
      if (!isLeaf(state, node.id)) return false
      let current = node
      while (current.parentId !== undefined) {
        if (current.parentId === parentId) return true
        const parent = state.nodes[current.parentId]
        if (parent === undefined) break
        current = parent
      }
      return false
    })
    if (descendant === undefined) throw new Error(`selectedLeafKey ${JSON.stringify(selectedKey)} has no executable leaf`)
    selectedKey = descendant.key
    selected = descendant.node
  }
  return {
    nodes,
    ...(selected === undefined ? {} : { selectedLeaf: { key: selectedKey!, node: selected } }),
  }
}

function clarificationAnswerIsNonAnswer(answer: IntakeAnswer): boolean {
  if (answer.selected.length > 0) return false
  const text = (answer.custom ?? '').trim()
  if (text === '') return true
  return /(?:no additional (?:requirement|information)|no (?:preference|opinion)|not (?:specified|defined|provided|available|known)|unknown|cannot answer|can't answer|(?:you|agent) (?:can |may |should )?(?:choose|decide)|(?:choose|decide) (?:yourself|for me|what works best)|(?:up to you|whatever (?:you|the agent) (?:choose|decide)|use whatever works)|make (?:a |reasonable )?assumptions?|use your (?:judg(?:e)?ment|best judgment)|没有额外(?:需求|信息)|没有偏好|无所谓|未(?:指定|定义|提供|知)|不清楚|不知道|无法回答|自行决定|你来决定|你看着办|看着办即可|合理假设)/i.test(text)
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
  const strictShell = config.strictBash ?? config.intakeMode === undefined
  if (strictShell) {
    guardedTools.add('bash')
    guardedTools.add('pwsh')
  }
  for (const tool of guardedTools) {
    if (tool.trim().length === 0) throw new Error('guardedTools must not contain an empty name')
  }
  const preconditionAdapters = new Map(Object.entries(config.preconditionAdapters ?? {}))
  for (const [toolName, adapter] of preconditionAdapters) {
    if (toolName.trim().length === 0) throw new Error('preconditionAdapters must not contain an empty tool name')
    if (typeof adapter.snapshot !== 'function' || typeof adapter.verify !== 'function') {
      throw new Error(`precondition adapter for ${JSON.stringify(toolName)} must provide snapshot and verify`)
    }
    if ((adapter.snapshotScope === undefined) !== (adapter.verifyScope === undefined)) {
      throw new Error(`precondition adapter for ${JSON.stringify(toolName)} must provide both snapshotScope and verifyScope`)
    }
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
    preconditionAdapters,
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

function isDelegatedSession(agent: AgentLike): boolean {
  return agent.session.header.parentSession !== undefined
    || agent.session.header.origin === 'subagent'
    || (agent.session.header.delegationDepth ?? 0) > 0
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

function renderRoute(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as {
    message?: unknown
    probeReceipt?: { id?: unknown; digest?: unknown; paths?: unknown }
    documents?: Array<{ path?: unknown; digest?: unknown; content?: unknown }>
    route?: unknown
  }
  const heading = typeof record.message === 'string' ? record.message : 'Plan Lattice route updated.'
  const receipt = record.probeReceipt
  const receiptText = typeof receipt?.id === 'string'
    ? [
        'Route evidence receipt (copy this exact ID into lattice_route operation=resolve):',
        `- probeReceiptId: ${receipt.id}`,
        ...(typeof receipt.digest === 'string' ? [`- evidenceDigest: ${receipt.digest}`] : []),
        ...(Array.isArray(receipt.paths) ? [`- evidencePaths: ${receipt.paths.map(String).join(', ')}`] : []),
      ].join('\n')
    : ''
  const documentText = (record.documents ?? []).map(document => {
    const path = typeof document.path === 'string' ? document.path : '<unknown>'
    const digest = typeof document.digest === 'string' ? document.digest : '<unknown>'
    const content = typeof document.content === 'string' ? document.content : ''
    return `--- ROUTE EVIDENCE ${path} (sha256:${digest}) ---\n${content}`
  }).join('\n\n')
  const routeText = record.route === undefined
    ? ''
    : `--- RESOLVED PLAN LATTICE ROUTE ---\n${JSON.stringify(record.route, null, 2)}`
  return [{
    type: 'text',
    text: [heading, receiptText, documentText, routeText].filter(Boolean).join('\n\n'),
  }]
}

function renderContext(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as {
    message?: unknown
    receipt?: { id?: unknown; revision?: unknown; digest?: unknown }
    documents?: { path: string; digest: string; content: string }[]
    documentReferences?: Array<{ path: string; digest: string }>
    executionPlan?: {
      digest: string
      lineage: Array<{ id: string; title: string; acceptanceCriteria: string; status: string }>
    }
    planContext?: StructuralPlanView
    targets?: Array<{ path: string; state: 'file' | 'missing'; digest: string; content?: string }>
    externalPreconditions?: Array<{ toolName: string; description: string; stateDigest: string }>
    initialPlan?: InitialPlanResult
  }
  const heading = typeof record.message === 'string' ? record.message : 'Read the current project context.'
  const documents = record.documents ?? []
  const receipt = record.receipt
  const receiptText = typeof receipt?.id === 'string' && Number.isSafeInteger(receipt.revision)
    ? `Fresh context receipt (copy these exact values into the next structural lattice call):\n- receiptId: ${receipt.id}\n- expectedRevision: ${receipt.revision}${typeof receipt.digest === 'string' ? `\n- contextDigest: ${receipt.digest}` : ''}`
    : ''
  const documentText = documents.map(document => (
    `--- ${document.path} (sha256:${document.digest}) ---\n${document.content}`
  )).join('\n\n')
  const documentReferenceText = record.documentReferences === undefined || record.documentReferences.length === 0
    ? ''
    : `--- UNCHANGED AUTHORITATIVE DOCUMENTS ---\n${record.documentReferences.map(document => `- ${document.path} (sha256:${document.digest})`).join('\n')}\nThe controller reread these exact bytes. Their full contents remain model-visible from an earlier tool result after the latest context replacement; the digest is unchanged.`
  const planText = record.planContext === undefined
    ? ''
    : `--- CURRENT PLAN STRUCTURE (sha256:${record.planContext.digest}) ---\n${JSON.stringify(record.planContext, null, 2)}`
  const executionText = record.executionPlan === undefined
    ? ''
    : `--- CURRENT EXECUTION PLAN (sha256:${record.executionPlan.digest}) ---\n${record.executionPlan.lineage.map((node, index) => `${index + 1}. [${node.status}] ${node.title}\n   Node: ${node.id}\n   Acceptance: ${node.acceptanceCriteria}`).join('\n')}`
  const targetText = record.targets === undefined || record.targets.length === 0
    ? ''
    : record.targets.map(target => target.state === 'file'
      ? `--- MUTATION TARGET ${target.path} (sha256:${target.digest}) ---\n${target.content ?? ''}`
      : `--- MUTATION TARGET ${target.path} (missing; sha256:${target.digest}) ---\nThis path did not exist when the mutation basis was issued.`).join('\n\n')
  const externalText = record.externalPreconditions === undefined || record.externalPreconditions.length === 0
    ? ''
    : `--- HOST PRECONDITIONS ---\n${record.externalPreconditions.map(item => `- ${item.toolName}: ${item.description} (sha256:${item.stateDigest})`).join('\n')}`
  const initialPlanText = record.initialPlan === undefined || record.initialPlan.nodes.length === 0
    ? ''
    : `--- INITIAL PLAN CREATED IN THIS CALL ---\n${record.initialPlan.nodes.map(({ key, node }) => `- ${key}: ${node.id}${node.parentId === undefined ? '' : ` (parent ${node.parentId})`}\n  ${node.title}\n  Acceptance: ${node.acceptanceCriteria}`).join('\n')}${record.initialPlan.selectedLeaf === undefined ? '' : `\nSelected first leaf: ${record.initialPlan.selectedLeaf.key} -> ${record.initialPlan.selectedLeaf.node.id}`}`
  return [{
    type: 'text',
    text: [heading, receiptText, documentText, documentReferenceText, initialPlanText, planText, executionText, targetText, externalText].filter(Boolean).join('\n\n'),
  }]
}

function renderIntake(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as {
    message?: unknown
    contract?: unknown
    pendingIntakeId?: unknown
    answers?: unknown
    receipt?: { schemaVersion?: unknown; id?: unknown; revision?: unknown; documentPath?: unknown; documentDigest?: unknown; estimatedSteps?: unknown }
  }
  const message = typeof record.message === 'string' ? record.message : 'Execution intake confirmed.'
  const pending = typeof record.pendingIntakeId === 'string'
    ? `\n\nPending intake: ${record.pendingIntakeId}\nBind every answer with lattice_commit_intake before execution.\n${JSON.stringify(record.answers ?? [], null, 2)}`
    : ''
  if (record.receipt?.schemaVersion === 2 && typeof record.receipt.id === 'string') {
    const reference = [
      'Durable execution contract:',
      `- receiptId: ${record.receipt.id}`,
      ...(Number.isSafeInteger(record.receipt.revision) ? [`- revision: ${record.receipt.revision}`] : []),
      ...(typeof record.receipt.estimatedSteps === 'number' ? [`- estimatedSteps: ${record.receipt.estimatedSteps}`] : []),
      ...(typeof record.receipt.documentPath === 'string' ? [`- path: ${record.receipt.documentPath}`] : []),
      ...(typeof record.receipt.documentDigest === 'string' ? [`- sha256: ${record.receipt.documentDigest}`] : []),
      'The controller bound the complete human request from the durable Session log. Do not restate it. lattice_open can infer this receipt and step estimate; lattice_refresh_context re-renders immutable authority after context replacement.',
    ].join('\n')
    return [{ type: 'text', text: `${message}\n\n${reference}${pending}` }]
  }
  const contract = typeof record.contract === 'string' ? record.contract : ''
  return [{ type: 'text', text: contract === '' ? `${message}${pending}` : `${message}\n\n${contract}${pending}` }]
}

function renderReframe(args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = value as {
    pendingIntakeId?: unknown
    contract?: unknown
    documents?: Array<{ path?: unknown }>
  }
  if (typeof record.pendingIntakeId === 'string') return renderIntake(args, value)
  if (record.documents?.some(document => document.path === CONTRACT_DOCUMENT_PATH)) {
    return renderContext(args, value)
  }
  return typeof record.contract === 'string' ? renderIntake(args, value) : renderContext(args, value)
}

function textList(values: string[], field: string): string[] {
  return values.map((value, index) => assertText(value, `${field}[${index}]`))
}

function compactContractText(value: string | undefined, fallback: string, field: string): string {
  const text = assertText(value ?? fallback, field)
  if (Array.from(text).length > COMPACT_CONTRACT_SCALAR_LIMIT) {
    throw new Error(`${field} exceeds ${COMPACT_CONTRACT_SCALAR_LIMIT} characters; submit a semantic index and leave exact requirements in immutable Session authority`)
  }
  return text
}

function compactContractList(values: string[] | undefined, fallback: string[], field: string): string[] {
  const list = textList(values ?? fallback, field)
  if (list.length > COMPACT_CONTRACT_LIST_LIMIT) {
    throw new Error(`${field} accepts at most ${COMPACT_CONTRACT_LIST_LIMIT} semantic entries; group related details under their invariant`)
  }
  for (const [index, value] of list.entries()) {
    if (Array.from(value).length > COMPACT_CONTRACT_ITEM_LIMIT) {
      throw new Error(`${field}[${index}] exceeds ${COMPACT_CONTRACT_ITEM_LIMIT} characters; keep exact detail in immutable Session authority`)
    }
  }
  return list
}

function compactV2Framing(
  args: Partial<IntakeFraming>,
  clarificationPolicy: ClarificationPolicy,
): IntakeFraming {
  const requestSummary = compactContractText(
    args.requestSummary,
    'Execute the current human-authored request under its immutable Session authority.',
    'requestSummary',
  )
  const unknowns = compactContractList(args.unknowns, [], 'unknowns')
  const framing: IntakeFraming = {
    requestSummary,
    estimatedSteps: positiveInteger(args.estimatedSteps, 1, 'estimatedSteps'),
    systemBoundary: compactContractText(
      args.systemBoundary,
      'The current workspace; exact scope and exclusions remain in immutable Session authority.',
      'systemBoundary',
    ),
    timeHorizon: compactContractText(
      args.timeHorizon,
      'The current delivery stage; later stages remain governed by immutable Session authority.',
      'timeHorizon',
    ),
    desiredOutcome: compactContractText(args.desiredOutcome, requestSummary, 'desiredOutcome'),
    confirmedFacts: compactContractList(args.confirmedFacts, [], 'confirmedFacts'),
    decisions: compactContractList(args.decisions, [], 'decisions'),
    invariants: compactContractList(args.invariants, [], 'invariants'),
    changeables: compactContractList(args.changeables, [], 'changeables'),
    forces: compactContractList(args.forces, [], 'forces'),
    keyVariables: compactContractList(args.keyVariables, [], 'keyVariables'),
    assumptions: compactContractList(args.assumptions, clarificationPolicy === 'never'
      ? ['Implementation choices not fixed by human authority remain reversible until verified.']
      : [], 'assumptions'),
    unknowns,
    readiness: intakeReadiness(args.readiness, unknowns),
    readinessRationale: compactContractText(
      args.readinessRationale,
      unknowns.length === 0
        ? 'Immutable human authority is complete enough to begin the current stage.'
        : 'Execution preserves reversible choices around the listed non-critical unknowns.',
      'readinessRationale',
    ),
  }
  if (Buffer.byteLength(JSON.stringify(framing)) > COMPACT_CONTRACT_TOTAL_LIMIT) {
    throw new Error(`semantic contract exceeds ${COMPACT_CONTRACT_TOTAL_LIMIT} bytes; index the decisive invariants instead of copying the full request`)
  }
  return framing
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
  const questionById = new Map(questions.map(question => [question.id, question]))
  const expected = new Set(questions.map(question => question.id))
  const seen = new Set<string>()
  const normalized: IntakeAnswer[] = []
  for (const answer of answers) {
    if (!expected.has(answer.id) || seen.has(answer.id)) {
      throw new Error('the clarification provider returned unknown or duplicate answer ids')
    }
    const question = questionById.get(answer.id)!
    const selected = textList(answer.selected, `answer ${answer.id}.selected`)
    if (new Set(selected).size !== selected.length) {
      throw new Error(`clarification question ${JSON.stringify(answer.id)} returned duplicate options`)
    }
    const allowed = new Set(question.options?.map(option => option.label) ?? [])
    if (selected.some(value => !allowed.has(value))) {
      throw new Error(`clarification question ${JSON.stringify(answer.id)} returned an option that was not offered`)
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new Error(`clarification question ${JSON.stringify(answer.id)} does not allow multiple selections`)
    }
    if (selected.length === 0 && (answer.custom === undefined || answer.custom.trim() === '')) {
      throw new Error(`clarification question ${JSON.stringify(answer.id)} was not answered`)
    }
    seen.add(answer.id)
    normalized.push({
      id: answer.id,
      selected,
      ...(answer.custom === undefined ? {} : { custom: assertText(answer.custom, `answer ${answer.id}.custom`) }),
    })
  }
  if (seen.size !== expected.size) throw new Error('the clarification provider did not answer every question')
  return normalized
}

function selectedAnswer(answers: IntakeAnswer[], id: string): IntakeAnswer {
  const matches = answers.filter(answer => answer.id === id)
  if (matches.length !== 1) throw new Error(`the user-question provider did not return exactly one ${id} answer`)
  return matches[0]!
}

function intakeReadiness(value: 'ready' | 'conditional' | undefined, unknowns: string[]): 'ready' | 'conditional' {
  const inferred = value ?? (unknowns.length === 0 ? 'ready' : 'conditional')
  if (inferred === 'ready' && unknowns.length > 0) {
    throw new Error('ready execution cannot retain unresolved unknowns')
  }
  if (inferred === 'conditional' && unknowns.length === 0) {
    throw new Error('conditional readiness requires at least one explicit unresolved unknown')
  }
  return inferred
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
  const executionState = new PersistentExecutionState()
  const delegatedInputFences = new DurableDelegatedInputFenceStore(resolved.contractAnchorRoot)
  const preparedAuthorizations = new Map<string, PreparedAuthorization>()
  const authorizationEpochs = new Map<string, number>()
  const sessionWorkspaces = new Map<string, string>()
  const leases = new Map<string, ExecutionLease>()
  const intakeInProgress = new Set<string>()
  const controls = new Map<string, AgentControl>()
  const pendingIntakes = new Map<string, PendingIntake>()
  const preparedRouteProbes = new Map<string, PreparedRouteProbe>()
  const preparedInputReviews = new Map<string, PreparedInputReview>()
  const undurableUserInputs = new Map<string, Map<string, { messageId: string; digest: string; content: unknown }>>()
  const preparedDispatches = new WeakMap<object, PreparedDispatch>()
  const preparedReadDispatches = new WeakMap<object, PreparedReadDispatch>()
  const activeDispatches = new Map<string, Set<PreparedDispatch>>()
  const activeDefinitionDispatches = new Set<PreparedDispatch | PreparedReadDispatch>()
  const trustedGuardedDefinitions = new Map<string, GuardedDefinitionBinding>()
  const durableExecutionBegins = new Map<string, ExecutionLease>()
  const localExecutionOrigins = new WeakMap<ExecutionLease, { attemptId: string; token: symbol }>()
  const durableReleaseRequests = new WeakMap<ExecutionLease, Promise<void>>()
  const durableReleases = new Map<string, Promise<void>>()
  const durableFenceWrites = new Map<string, Set<Promise<void>>>()
  const ownedControlFences = new Set<string>()
  const continuableParents = new WeakMap<Agent, Agent>()
  const nativeSubagentStarts = new WeakMap<Agent, NativeSubagentRunBinding>()
  const nativeSubagentRuns = new Map<string, NativeSubagentRunBinding>()
  const pendingDelegatedInitialInputs = new WeakMap<Agent, PendingDelegatedInitialInput>()
  const delegatedOperationalMessages = new Map<string, Set<string>>()
  const validatedAssemblySignals = new WeakSet<AbortSignal>()
  const finalAssemblyAttestations = new WeakMap<AbortSignal, FinalAssemblyAttestation>()
  const nativePlanModeStates = new WeakMap<Agent, boolean>()
  const toolDefinitionIds = new WeakMap<object, number>()
  let nextToolDefinitionId = 1
  let toolRegistryGeneration = 0

  // Continuable children are owned structurally by DSH's private activation
  // scope, not by the parent Agent scope. Attest their durable parent edge in
  // the native unpublished setup transaction, before agent/created can publish.
  ctx.inject(['subagents'], (subagentCtx) => {
    const service = subagentCtx.get('subagents') as ContinuableSubagentSetupService | undefined
    if (typeof service?.registerContinuableSetup !== 'function') return
    subagentCtx.effect(() => service.registerContinuableSetup((childCtx) => {
      const child = childCtx.agent as Agent | undefined
      if (child === undefined) throw new Error('continuable Plan Lattice setup requires the unpublished child agent')
      const parentId = child.session.header.parentSession
      const registry = ctx.get('agents')
      const parent = parentId === undefined ? undefined : registry?.get(parentId as never)
      if (registry === undefined || parent === undefined) {
        throw new Error('continuable Plan Lattice setup requires the exact live durable parent')
      }
      continuableParents.set(child, parent)
      return () => {
        if (continuableParents.get(child) === parent) continuableParents.delete(child)
      }
    }), 'plan-lattice continuable child attestation')
  })

  // DSH publishes this edge for both one-shot runs and continuable
  // Activations. The edge deliberately carries no prompt message id, so it is
  // one part of the initial-delegation proof rather than sufficient provenance
  // by itself.
  ctx.on('subagent/start', (info) => {
    if (!info.local) return
    const child = ctx.get('agents')?.get(info.id)
    if (child === undefined) return
    const runId = String(info.runId)
    if (nativeSubagentRuns.has(runId) || nativeSubagentStarts.has(child)) return
    const binding = { runId, provider: info.provider, child }
    nativeSubagentStarts.set(child, binding)
    nativeSubagentRuns.set(runId, binding)
  })

  ctx.on('subagent/end', (info) => {
    const runId = String(info.runId)
    const binding = nativeSubagentRuns.get(runId)
    if (binding === undefined
      || !info.local
      || binding.provider !== info.provider
      || binding.child.id !== info.id) return
    nativeSubagentRuns.delete(runId)
    if (nativeSubagentStarts.get(binding.child) === binding) {
      nativeSubagentStarts.delete(binding.child)
      pendingDelegatedInitialInputs.delete(binding.child)
    }
  })

  ctx.effect(() => async () => {
    await Promise.allSettled([
      ...durableReleases.values(),
      ...[...durableFenceWrites.values()].flatMap(writes => [...writes]),
    ])
  }, 'plan-lattice durable execution releases')

  function executionAuthorityWorkspace(workspace: string): string {
    const workspaceDigest = createHash('sha256').update(workspace).digest('hex')
    return join(resolved.contractAnchorRoot, 'execution', workspaceDigest)
  }

  function durableStateFor(workspace: string) {
    return executionState.readSync(executionAuthorityWorkspace(workspace))
  }

  function scheduleLeaseRelease(key: string, lease: ExecutionLease): Promise<void> | undefined {
    if (leases.get(key) !== lease) return undefined
    lease.releaseWhenClean = true
    const existing = durableReleaseRequests.get(lease)
    if (existing !== undefined) return existing
    const authorityWorkspace = executionAuthorityWorkspace(lease.workspace)
    const pending = (async () => {
      if (leases.get(key) !== lease) return
      if (lease.durable.releaseWhenClean !== true) {
        lease.durable = await executionState.requestReleaseWhenClean(
          authorityWorkspace,
          executionLeaseClaim(lease.durable),
        )
      }
      if (lease.dirty) return
      await executionState.release(authorityWorkspace, executionLeaseClaim(lease.durable))
      if (leases.get(key) === lease) leases.delete(key)
    })()
    durableReleaseRequests.set(lease, pending)
    durableReleases.set(lease.workspace, pending)
    void pending.then(() => {
      if (durableReleaseRequests.get(lease) === pending) durableReleaseRequests.delete(lease)
      if (durableReleases.get(lease.workspace) === pending) durableReleases.delete(lease.workspace)
    }, (error) => {
      if (durableReleaseRequests.get(lease) === pending) durableReleaseRequests.delete(lease)
      if (durableReleases.get(lease.workspace) === pending) durableReleases.delete(lease.workspace)
      ctx.logger.warn('plan-lattice: durable execution lease release remains pending after failure: %o', error)
    })
    return pending
  }

  async function awaitReleaseMarkerForSettlement(lease: ExecutionLease): Promise<void> {
    const pending = durableReleaseRequests.get(lease)
    if (pending === undefined) return
    try {
      await pending
    } catch (error) {
      // The exact graph receipt below carries the same intent. Keep settling the
      // completed call so restart can reconcile it without replaying a side effect.
      if (lease.releaseWhenClean !== true) throw error
    }
  }

  function sameDurableLeaseLineage(left: DurableExecutionLease, right: DurableExecutionLease): boolean {
    return left.leaseId === right.leaseId
      && left.ownerSessionId === right.ownerSessionId
      && left.rootSessionId === right.rootSessionId
      && left.nodeId === right.nodeId
  }

  function samePendingExecution(
    left: DurableExecutionLease['pendingExecution'],
    right: DurableExecutionLease['pendingExecution'],
  ): boolean {
    if (left === undefined || right === undefined) return left === right
    return left.attemptId === right.attemptId
      && left.callId === right.callId
      && left.toolName === right.toolName
      && left.argumentsDigest === right.argumentsDigest
      && left.basisDigest === right.basisDigest
      && left.startedAt === right.startedAt
  }

  function sameDurableLeaseSnapshot(left: DurableExecutionLease, right: DurableExecutionLease): boolean {
    return sameDurableLeaseLineage(left, right)
      && left.generation === right.generation
      && left.graphRevision === right.graphRevision
      && left.contractRevision === right.contractRevision
      && left.contractDigest === right.contractDigest
      && left.dirty === right.dirty
      && left.checkpointRequired === right.checkpointRequired
      && left.releaseWhenClean === right.releaseWhenClean
      && left.legacyIndeterminate === right.legacyIndeterminate
      && samePendingExecution(left.pendingExecution, right.pendingExecution)
  }

  async function convergeRequestedLeaseRelease(key: string, lease: ExecutionLease): Promise<void> {
    for (let attempt = 0; attempt < 2 && leases.get(key) === lease && lease.releaseWhenClean === true; attempt += 1) {
      try {
        await scheduleLeaseRelease(key, lease)
      } catch {
        // A successful competing settlement can invalidate the first marker
        // claim. Retry once from the newly adopted durable generation below.
      }
    }
  }

  async function checkpointCommittedGraph(
    workspace: string,
    lease: ExecutionLease,
    graphRevision: number,
    release: boolean,
  ) {
    const authorityWorkspace = executionAuthorityWorkspace(workspace)
    let durable = lease.durable
    let releaseRequested = release || lease.releaseWhenClean === true || durable.releaseWhenClean === true
    let failure: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await executionState.checkpoint(
          authorityWorkspace,
          executionLeaseClaim(durable),
          { release: releaseRequested, graphRevision },
        )
      } catch (error) {
        if (error instanceof ExecutionStatePostRenameDurabilityError) throw error
        failure = error
        const current = await executionState.read(authorityWorkspace)
        if (current.lease === null) return current
        if (!sameDurableLeaseLineage(current.lease, durable)
          || current.lease.dirty
          || current.lease.graphRevision > graphRevision) {
          throw error
        }
        durable = current.lease
        releaseRequested = releaseRequested
          || lease.releaseWhenClean === true
          || durable.releaseWhenClean === true
        if (durable.graphRevision === graphRevision) {
          if (!releaseRequested) return current
          try {
            return await executionState.release(authorityWorkspace, executionLeaseClaim(durable))
          } catch (releaseError) {
            if (releaseError instanceof ExecutionStatePostRenameDurabilityError) throw releaseError
            failure = releaseError
          }
        }
      }
    }
    throw failure
  }

  function currentAuthorizationEpoch(key: string): number {
    return authorizationEpochs.get(key) ?? 0
  }

  function requireLiveOwnership(agent: Agent, expectedRootSessionId?: string): string {
    const registry = ctx.get('agents')
    if (registry === undefined) throw new Error('execution authority requires the live Harness agent registry')
    const visited = new Set<string>()
    let current = agent
    while (true) {
      const currentId = String(current.id)
      if (visited.has(currentId)) throw new Error('execution authority rejects a cyclic Harness ownership chain')
      visited.add(currentId)
      if (registry.get(current.id) !== current) {
        throw new Error('execution authority requires the exact live Harness agent instance')
      }
      const parentId = current.session.header.parentSession
      if (parentId === undefined) {
        if (isDelegatedSession(current)) {
          throw new Error('delegated execution authority requires a live parent ownership edge')
        }
        if (expectedRootSessionId !== undefined && currentId !== expectedRootSessionId) {
          throw new Error('the live Harness ownership root no longer matches the execution contract')
        }
        return currentId
      }
      const parent = registry.get(parentId as never)
      const continuableParent = continuableParents.get(current)
      if (parent === undefined
        || (continuableParent !== parent && !registry.isOwnedBy(current.id, parent))) {
        throw new Error('delegated execution authority requires an unbroken live Harness ownership chain')
      }
      current = parent
    }
  }

  function contractBasis(record: ContractRecord): ContractBasis {
    return {
      id: record.id,
      sessionId: record.sessionId,
      revision: record.revision,
      documentDigest: record.documentDigest,
    }
  }

  function delegatedInputContractBasis(record: ContractRecord) {
    return {
      rootSessionId: record.sessionId,
      contractId: record.id,
      contractRevision: record.revision,
      contractDigest: record.documentDigest,
    }
  }

  function ownSessionEvents(agent: Agent): readonly SessionEvent[] {
    return agent.session.events.slice(agent.session.header.seedLength ?? 0)
  }

  function hasMatchingNativeSubagentDescriptor(
    agent: Agent,
    binding: NativeSubagentRunBinding,
  ): boolean {
    if (agent.session.header.origin !== 'subagent') return false
    const descriptor = foldSubagentDescriptor(ownSessionEvents(agent))
    if (descriptor === undefined || descriptor.provider !== binding.provider) return false
    const expectedMode = continuableParents.has(agent) ? 'continuable' : 'one-shot'
    return descriptor.mode === expectedMode
  }

  function hasPriorDelegatedInput(agent: Agent): boolean {
    return ownSessionEvents(agent).some(event => event.type === 'user/message'
      && event.data.source.kind !== 'plugin')
  }

  function markDelegatedInitialInput(agent: Agent, control: AgentControl, messageId: string): void {
    const key = sessionKey(agent)
    const operational = delegatedOperationalMessages.get(key) ?? new Set<string>()
    operational.add(messageId)
    delegatedOperationalMessages.set(key, operational)
    nativeSubagentStarts.delete(agent)
    pendingDelegatedInitialInputs.delete(agent)
    invalidateRootAuthority(control.rootSessionId, true)
    control.reasons = ['native initial delegation preserved the inherited root contract', ...control.reasons]
  }

  function isNativeInitialDelegation(agent: Agent, control: AgentControl): boolean {
    const binding = nativeSubagentStarts.get(agent)
    if (binding === undefined
      || !hasMatchingNativeSubagentDescriptor(agent, binding)
      || hasPriorDelegatedInput(agent)) return false
    requireLiveOwnership(agent, control.rootSessionId)
    return true
  }

  function isPotentialNativeInitialDelegation(agent: Agent, control: AgentControl): boolean {
    if (sessionKey(agent) === control.rootSessionId
      || agent.session.header.origin !== 'subagent'
      || hasPriorDelegatedInput(agent)
      || pendingDelegatedInitialInputs.has(agent)) return false
    requireLiveOwnership(agent, control.rootSessionId)
    return true
  }

  function fenceUnprovenDelegatedInput(
    agent: Agent,
    control: AgentControl,
    message: Parameters<typeof userInputDigest>[0],
  ): void {
    const staged = undurableUserInputs.get(control.rootSessionId) ?? new Map()
    staged.set(String(message.id), {
      messageId: String(message.id),
      digest: userInputDigest(message),
      content: message.content,
    })
    undurableUserInputs.set(control.rootSessionId, staged)
    queueDelegatedInputFence(
      control,
      sessionKey(agent),
      message,
      'unproven user input delivered to a delegated session requires explicit root-contract revision',
    )
    invalidateRootAuthority(control.rootSessionId, true)
    requireRootReframe(
      control.rootSessionId,
      'a delegated user-role message lacked exact native initial-delegation provenance',
    )
  }

  function queueDelegatedInputFence(
    control: AgentControl,
    delegatedSessionId: string,
    message: Parameters<typeof userInputDigest>[0],
    reason: string,
  ): void {
    if (control.contract === undefined) return
    const rootSessionId = control.rootSessionId
    const writes = durableFenceWrites.get(rootSessionId) ?? new Set<Promise<void>>()
    const pending = delegatedInputFences.record({
      ...delegatedInputContractBasis(control.contract),
      delegatedSessionId,
      messageId: String(message.id),
      messageDigest: userInputDigest(message),
      reason,
    }).then(() => {}, error => {
      requireRootReframe(rootSessionId, `delegated input fence persistence failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      writes.delete(pending)
      if (writes.size === 0) durableFenceWrites.delete(rootSessionId)
    })
    writes.add(pending)
    durableFenceWrites.set(rootSessionId, writes)
  }

  async function awaitDelegatedInputFences(rootSessionId: string): Promise<void> {
    await Promise.all([...(durableFenceWrites.get(rootSessionId) ?? [])])
  }

  function invalidateSessionAuthority(
    key: string,
    options: {
      contextReplacement?: { seq: number; type: string }
      releaseLease?: boolean
    } = {},
  ): number {
    const next = currentAuthorizationEpoch(key) + 1
    authorizationEpochs.set(key, next)
    preparedAuthorizations.delete(key)
    preparedRouteProbes.delete(key)
    for (const dispatch of activeDispatches.get(key) ?? []) {
      dispatch.revocation.abort(new Error('plan-lattice execution authority was revoked before tool-body entry'))
    }
    const control = controls.get(key)
    if (control !== undefined) {
      control.authorizationEpoch = next
      control.mutationBasis = undefined
      if (options.contextReplacement !== undefined) {
        control.contextReplacement = options.contextReplacement
        control.visibleDocuments?.clear()
      }
    }
    const lease = leases.get(key)
    if (lease !== undefined) {
      lease.mutationBasis = undefined
      if (options.contextReplacement !== undefined) lease.contextReplacement = options.contextReplacement
      if (options.releaseLease === true) {
        lease.releaseWhenClean = true
        if (durableExecutionBegins.get(key) !== lease) void scheduleLeaseRelease(key, lease)
      }
    }
    return next
  }

  function invalidateRootAuthority(rootSessionId: string, releaseLeases: boolean): void {
    preparedInputReviews.delete(rootSessionId)
    for (const [key, control] of controls) {
      if (control.rootSessionId === rootSessionId) invalidateSessionAuthority(key, { releaseLease: releaseLeases })
    }
  }

  function requireRootReframe(
    rootSessionId: string,
    reason: string,
    criticalGaps: readonly CriticalGapDimension[] = [],
  ): void {
    for (const control of controls.values()) {
      if (control.rootSessionId !== rootSessionId) continue
      control.reframePending = true
      control.criticalGaps = [...new Set([...control.criticalGaps, ...criticalGaps])]
      control.reasons = [reason, ...control.reasons]
    }
  }

  function rootAgentFor(agent: Agent, control: AgentControl): Agent {
    const registry = ctx.get('agents')
    const root = registry?.get(control.rootSessionId as never)
    if (root === undefined) throw new Error('input review requires the live root Harness agent')
    requireLiveOwnership(agent, control.rootSessionId)
    return root
  }

  function durablePendingInputs(agent: Agent, control: AgentControl): PendingUserInput[] {
    if (control.contract === undefined) return []
    return pendingUserInputs(rootAgentFor(agent, control).session.events, control.contract)
  }

  function pendingInputGuard(agent: Agent, control: AgentControl): string | undefined {
    if (pendingDelegatedInitialInputs.has(agent)) {
      return 'the first delegated user-role message is waiting for native subagent lifecycle provenance'
    }
    const undurable = undurableUserInputs.get(control.rootSessionId)
    if ((undurable?.size ?? 0) > 0) {
      return control.reframePending
        ? 'a material change requires lattice_reframe after the new user input reaches the durable session log'
        : 'new user input has not reached the durable session log; wait for the current turn before rebuilding execution authority'
    }
    try {
      const pending = durablePendingInputs(agent, control)
      if (pending.length === 0) return undefined
      return control.reframePending
        ? `a material user change requires lattice_reframe; ${pending.length} durable input${pending.length === 1 ? '' : 's'} remain fenced from execution`
        : `${pending.length} durable user input${pending.length === 1 ? '' : 's'} must be compared with the accepted contract using lattice_review_input`
    } catch (error) {
      return error instanceof Error ? error.message : 'cannot verify durable user-input adoption'
    }
  }

  function appendInputReviewMarker(
    agent: Agent,
    contract: ContractRecord,
    disposition: InputReviewMarker['disposition'],
    rationale: string,
    reviewedInputs: readonly PendingUserInput[],
    throughSeq?: number,
  ): void {
    const boundary = humanInputBoundary(agent.session.events)
    agent.session.append('plan-lattice/input-review', {
      throughSeq: throughSeq ?? boundary.throughSeq,
      messageIds: reviewedInputs.map(input => input.messageId),
      pendingDigest: pendingUserInputDigest(reviewedInputs),
      disposition,
      rationale: assertText(rationale, 'input review rationale'),
      contractId: contract.id,
      contractRevision: contract.revision,
      contractDigest: contract.documentDigest,
    })
    undurableUserInputs.delete(contract.sessionId)
  }

  function substantiveRationale(value: string): string {
    const rationale = assertText(value, 'input review rationale')
    if (Array.from(rationale).length < 12) {
      throw new Error('input review rationale must explain how the new input does or does not alter the accepted contract')
    }
    return rationale
  }

  function acceptedNodeContract(agent: Agent): ContractRecord | undefined {
    if (resolved.legacyIntakeMode !== undefined) return undefined
    const control = controls.get(sessionKey(agent))
    if (control?.contract === undefined) throw new Error('node planning requires an accepted v2 execution contract')
    return requireContractAnchor(control.contract)
  }

  function assertNodeReconciled(node: LatticeNode, contract?: ContractRecord): void {
    const boundToOlderContract = contract !== undefined
      && node.contractRevision !== undefined
      && (node.contractRevision !== contract.revision || node.contractDigest !== contract.documentDigest)
    if (node.reconciliationRequired === true || boundToOlderContract) {
      throw new Error(`node ${JSON.stringify(node.id)} predates the accepted contract; inspect it with lattice_refresh_context and reconcile it using lattice_update`)
    }
  }

  function requireContractAnchor(record: ContractRecord): ContractRecord {
    const anchor = readContractAnchorSync(resolved.contractAnchorRoot, record.sessionId)
    if (anchor === undefined) throw new Error('execution contract has no durable session anchor; call lattice_reframe')
    if (!contractMatchesAnchor(record, anchor)) {
      throw new Error('execution contract differs from its durable session anchor; call lattice_reframe')
    }
    return anchor
  }

  async function persistConfirmedContract(
    input: Parameters<typeof persistContract>[0],
    expectedAuthority?: { sessionId: string; epoch: number },
  ) {
    const assertCurrent = () => {
      if (expectedAuthority !== undefined
        && currentAuthorizationEpoch(expectedAuthority.sessionId) !== expectedAuthority.epoch) {
        throw new Error('execution authority changed while the contract was being committed; start intake or reframe again')
      }
    }
    return persistContract(input, {
      beforeWrite: async record => {
        assertCurrent()
        await persistContractAnchor(resolved.contractAnchorRoot, record)
        assertCurrent()
      },
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
      productDefinitionGap: 0,
      outcomeCritical: false,
      criticalGaps: [],
      rootSessionId: key,
      initialContractPending: true,
      reframePending: false,
      authorizationEpoch: 0,
    }
  }

  function controlFor(agent: AgentLike | undefined): AgentControl {
    return agent === undefined ? fallbackControl(undefined) : controls.get(sessionKey(agent)) ?? fallbackControl(agent)
  }

  function nativePlanModeState(agent: AgentLike | undefined): { active: boolean; pending?: boolean } | undefined {
    if (agent === undefined) return undefined
    const service = ctx.get('planMode') as NativePlanModeService | undefined
    return service?.get(agent as Agent)
  }

  /** State DSH will apply to the next assembled model step. */
  function nativePlanModeActive(agent: AgentLike | undefined): boolean {
    const state = nativePlanModeState(agent)
    return state?.pending ?? state?.active ?? false
  }

  /** Logged state that still owns the currently executing model/tool batch. */
  function nativePlanModeOwnsCurrentBatch(agent: AgentLike | undefined): boolean {
    return nativePlanModeState(agent)?.active ?? false
  }

  /** Crossing a native planning boundary revokes execution authority. */
  function synchronizeNativePlanMode(agent: Agent): boolean {
    const active = nativePlanModeActive(agent)
    const previous = nativePlanModeStates.get(agent) ?? false
    nativePlanModeStates.set(agent, active)
    if (active !== previous) {
      invalidateSessionAuthority(sessionKey(agent), { releaseLease: true })
    }
    return active
  }

  function projectDocuments(
    agent: AgentLike,
    documents: Array<{ path: string; digest: string; content: string }>,
  ): ProjectedDocuments {
    const control = controls.get(sessionKey(agent))
    if (control === undefined) return { documents, documentReferences: [] }
    control.visibleDocuments ??= new Map()
    const projected: ProjectedDocuments = { documents: [], documentReferences: [] }
    for (const document of documents) {
      if (control.visibleDocuments.get(document.path) === document.digest) {
        projected.documentReferences.push({ path: document.path, digest: document.digest })
      } else {
        projected.documents.push(document)
        control.visibleDocuments.set(document.path, document.digest)
      }
    }
    return projected
  }

  function authoritySourcesFrom(inputs: readonly PendingUserInput[]): AuthoritySource[] {
    return inputs.map(input => ({ seq: input.seq, messageId: input.messageId, digest: input.digest }))
  }

  function mergeAuthoritySources(
    previous: readonly AuthoritySource[],
    additions: readonly AuthoritySource[],
  ): AuthoritySource[] {
    const merged = new Map(previous.map(source => [`${source.seq}\0${source.messageId}`, source]))
    for (const source of additions) merged.set(`${source.seq}\0${source.messageId}`, source)
    return [...merged.values()].sort((left, right) => left.seq - right.seq)
  }

  function authorityDocumentPath(source: AuthoritySource): string {
    return `session://human-authority/${source.seq}/${encodeURIComponent(source.messageId)}`
  }

  function authorityDocuments(agent: Agent, control: AgentControl, contract: ContractRecord) {
    const sources = contract.authoritySources ?? []
    if (sources.length === 0) return []
    const events = rootAgentFor(agent, control).session.events
    let totalBytes = 0
    return sources.map(source => {
      const event = events.find((candidate): candidate is SessionEvent<'user/message'> => candidate.type === 'user/message'
        && candidate.data.source.kind === 'user'
        && String(candidate.data.id) === source.messageId)
      if (event === undefined) {
        const content = `The immutable human message is unavailable in this restored process. Its external contract anchor still binds Session event ${source.seq}, message ${source.messageId}, sha256:${source.digest}. Use the semantic contract as the recovery fallback; do not invent missing source detail.`
        return {
          path: `${authorityDocumentPath(source)}/unavailable`,
          digest: createHash('sha256').update(content).digest('hex'),
          content,
        }
      }
      if (event.seq !== source.seq || userInputDigest(event.data) !== source.digest) {
        requireRootReframe(control.rootSessionId, 'an immutable human authority source is missing or changed')
        throw new Error(`immutable human authority source at Session event ${source.seq} failed verification`)
      }
      const content = event.data.content.map(block => block.type === 'text'
        ? block.text
        : `[non-text ${block.type}] ${JSON.stringify(block)}`).join('\n')
      totalBytes += Buffer.byteLength(content)
      if (totalBytes > resolved.maxContextBytes) {
        throw new Error(`immutable human authority exceeds ${resolved.maxContextBytes} bytes; split the task at a human-approved boundary instead of truncating it`)
      }
      return {
        path: authorityDocumentPath(source),
        digest: source.digest,
        content,
      }
    })
  }

  /** Stable control policy. Mutable execution facts live in the native runtime-context channel below. */
  function controlPolicyPrompt(agent: AgentLike | undefined): string {
    if (agent === undefined && resolved.legacyIntakeMode === undefined) return ''
    const control = controlFor(agent)
    if (control.phase === 'bypass') return ''
    const nativePlanMode = agent === undefined ? false : synchronizeNativePlanMode(agent as Agent)
    if (nativePlanMode) {
      return `## Plan Lattice authority during DSH plan mode

DSH native plan mode exclusively owns this planning turn. Explore and design under its plan policy, then present the complete plan through exit_plan_mode. Do not call any lattice_* tool and do not invoke a Plan Lattice guarded mutation tool while plan mode is active. Existing contract, invariant, decision, unknown, and current-leaf state below remain read-only authority for the plan; Plan Lattice will bind or refresh executable authority only after native plan mode exits.`
    }
    if (control.phase === 'probe') {
      return `## Plan Lattice route probe

Read the complete authoritative repository evidence without mutating it. Call lattice_route with operation=inspect for the workspace-relative evidence files, then call it once more with operation=resolve and a structured risk assessment. Guarded writes are blocked until both operations complete. Do not ask the user or invoke an external requirements channel during the probe; resolve the route first, then submit any outcome-critical questions through lattice_intake so their answers are bound to the contract.`
    }
    const child = agent === undefined ? false : isDelegatedSession(agent)
    const contract = control.contract
    const policy = control.clarificationPolicy === 'never'
      ? control.phase === 'lattice' && control.initialContractPending
        ? 'Do not ask the user and do not call lattice_intake. Before repository inspection or design narration, call lattice_open with an empty object. The controller binds the complete human request from the durable Session log and creates a minimal refinable graph; do not author or restate an initial tree.'
        : 'Do not ask the user. On a fresh contract-tier task, call lattice_intake exactly once with an honest step estimate, a one-sentence semantic summary, and only the few assumptions or invariants needed for execution. Omit questions and omitted framing fields; the controller supplies neutral defaults and binds the complete human request from the durable Session log. Never copy the full request into tool arguments.'
      : control.clarificationPolicy === 'always'
        ? 'Use lattice_intake for unresolved product-definition gaps before execution.'
        : 'Ask only about an outcome-critical gap that can change the P0 result, scope, authority, truth source, or acceptance. Submit those questions through lattice_intake; do not query a parallel user or requirements channel whose answers would remain outside the contract.'
    const tier = control.phase === 'contract'
      ? 'Persist the execution contract before guarded writes. Before each filesystem mutation, call lattice_refresh_context with the exact targetPaths so the contract and current file bodies are read together. After commitment, work directly without node-by-node checkout or checkpoints.'
      : `Persist the execution contract, open the lattice, and use leaf leases, receipts, semantic checkpoints, and evidence gates for protected work. After checkout and before each filesystem mutation, call lattice_refresh_context with the exact targetPaths; it must render the complete contract, current node lineage and acceptance criteria, and current target bodies together. The controller automatically persists a mechanical receipt for every settled guarded tool result; do not call lattice_checkpoint after each tool. Use lattice_checkpoint only when recording semantic verification or completing the leaf. Work estimated at ${resolved.longTaskThreshold} or more steps is only one signal; changing requirements, cross-module scope, irreversible effects, or multiple agents independently justify this tier.`
    const bootstrap = contract === undefined
      ? control.phase === 'lattice' && control.clarificationPolicy === 'never'
        ? '\n\nFresh-task bootstrap: lattice_open {} is the first control action. It creates a stable accepted-outcome root and one focused, executable leaf without a model-authored plan. After open, inspect repository evidence and refine only the next leaf with lattice_update or lattice_split when useful; do not exhaustively design the whole tree. The native todo list may show the immediate working set, but it is neither durable authority nor a required mirror of the lattice. Strict Bash remains guarded even when its command looks read-only.'
        : '\n\nFresh-task bootstrap: use dedicated read, glob, or grep tools to inspect the workspace before intake; strict Bash is guarded even when its command looks read-only. The first human request is authority for the new contract, not a reframe. After intake, lattice_open infers the accepted receipt and step estimate and may open with no extra background document. Build outcome-sized leaves that each deliver a testable increment; do not create scaffolding-only or one-file bookkeeping leaves.'
      : ''
    return `## Plan Lattice ${control.phase} control

DSH owns conversation history, compaction and pruning, native plan mode, todos, tool transport, and child prompt delivery. Plan Lattice does not replace them. It records the accepted contract and plan tree as durable addresses, then requires a fresh current basis before a protected mutation. Use the current runtime state and required next action below; do not restate the full request or create a parallel plan.${resolved.legacyIntakeMode === undefined ? '' : `\n\nIntake policy is ${resolved.legacyIntakeMode}.`}

${policy}

${tier}

${child ? 'This is a delegated agent. Never question the human directly; return missing boundary information to the parent agent.' : 'Only the root agent may ask the human.'} Material changes require lattice_reframe before further guarded work. DSH owns conversation compaction and tool-result pruning; after either replaces model-visible history, call lattice_refresh_context and reread the complete contract. Use the native todo list only as an optional current-work projection, never as contract or completion evidence.${bootstrap}`
  }

  function allowedControlTools(agent: AgentLike | undefined, control: AgentControl): Set<string> {
    const available = LATTICE_TOOL_NAMES.filter(name => !(
      resolved.legacyIntakeMode === 'off' && (name === 'lattice_intake' || name === 'lattice_reframe')
    ))
    let allowed: Set<string>
    if (resolved.legacyIntakeMode !== undefined) {
      allowed = new Set(available.filter(name => name !== 'lattice_route' && name !== 'lattice_commit_intake'))
    } else if (control.phase === 'probe') {
      allowed = new Set(['lattice_route'])
    } else if (control.phase === 'contract') {
      allowed = new Set([
        'lattice_intake',
        'lattice_commit_intake',
        'lattice_review_input',
        'lattice_commit_input_review',
        'lattice_reframe',
        'lattice_refresh_context',
      ])
    } else if (control.phase === 'lattice') {
      allowed = new Set(available.filter(name => name !== 'lattice_route'
        && !(control.initialContractPending && control.clarificationPolicy === 'never' && name === 'lattice_intake')))
    } else {
      allowed = new Set()
    }

    if (agent !== undefined && isDelegatedSession(agent)) {
      for (const name of ROOT_ONLY_LATTICE_TOOLS) allowed.delete(name)
    }
    return allowed
  }

  function latticeWorkState(agent: AgentLike | undefined): 'active' | 'complete' | 'empty' | 'unknown' {
    if (agent === undefined || controlFor(agent).phase !== 'lattice') return 'unknown'
    const workspace = agent.session.header.cwd
    if (workspace === undefined) return 'unknown'
    try {
      const state = readLatticeStateSync(workspace)
      if (state === undefined) return 'unknown'
      const live = Object.values(state.nodes).filter(node => node.status !== 'archived')
      if (live.some(node => node.status === 'pending' || node.status === 'active' || node.status === 'blocked')) {
        return 'active'
      }
      return live.length > 0 && live.every(node => node.status === 'complete') ? 'complete' : 'empty'
    } catch {
      return 'unknown'
    }
  }

  function nextControlStep(
    agent: AgentLike | undefined,
    control: AgentControl,
  ): { action: string; requiredTool?: string } {
    if (nativePlanModeActive(agent)) {
      return {
        action: 'Execution is suspended by DSH native plan mode. Continue planning and finish through exit_plan_mode; do not call lattice_* or guarded mutation tools.',
      }
    }
    const child = agent !== undefined && isDelegatedSession(agent)
    if (child && (control.phase === 'probe' || control.initialContractPending || control.reframePending)) {
      return { action: 'Stop protected work and return the unresolved route, contract, or requirement change to the parent agent.' }
    }
    if (control.phase === 'probe') {
      return {
        action: 'Inspect repository evidence and resolve the route with lattice_route before any guarded write.',
        requiredTool: 'lattice_route',
      }
    }
    const pendingIntake = [...pendingIntakes.values()].some(pending => pending.sessionId === control.rootSessionId)
    if (pendingIntake) {
      return {
        action: child
          ? 'Return the pending clarification boundary to the parent agent.'
          : 'Bind the recorded answers with lattice_commit_intake before continuing.',
        ...(child ? {} : { requiredTool: 'lattice_commit_intake' }),
      }
    }
    if (control.initialContractPending) {
      return control.phase === 'lattice' && control.clarificationPolicy === 'never'
        ? {
            action: 'Commit the durable human request and controller-owned initial leaf with lattice_open {}.',
            requiredTool: 'lattice_open',
          }
        : {
            action: 'Inspect authoritative repository evidence, then commit the execution contract with lattice_intake.',
            requiredTool: 'lattice_intake',
          }
    }
    if (control.reframePending) {
      return child
        ? { action: 'Stop protected work and return the material change to the parent agent for root-contract revision.' }
        : {
            action: 'Reconcile the material change with lattice_reframe before any guarded write.',
            requiredTool: 'lattice_reframe',
          }
    }
    if (control.contextReplacement !== undefined) {
      return {
        action: 'Restore the complete contract and current work basis with lattice_refresh_context.',
        requiredTool: 'lattice_refresh_context',
      }
    }
    if (control.phase === 'contract') {
      return {
        action: 'Call lattice_refresh_context with exact mutation targets before the next guarded write.',
        requiredTool: 'lattice_refresh_context',
      }
    }
    const key = agent === undefined ? control.rootSessionId : sessionKey(agent)
    if (leases.has(key)) {
      return {
        action: 'Call lattice_refresh_context with exact mutation targets before acting; use lattice_checkpoint for semantic verification or leaf completion.',
        requiredTool: 'lattice_refresh_context',
      }
    }
    const workState = latticeWorkState(agent)
    if (workState === 'complete') {
      return { action: child ? 'Return the completed delegated outcome to the parent agent.' : 'All lattice work is complete; report the verified outcome without checking out another leaf.' }
    }
    if (workState === 'empty') {
      return { action: child ? 'Return the missing executable-work boundary to the parent agent.' : 'No executable lattice leaf remains; report the blocked or archived outcome instead of attempting checkout.' }
    }
    return {
      action: 'Read the current plan with lattice_refresh_context and check out one current leaf before guarded work.',
      requiredTool: 'lattice_refresh_context',
    }
  }

  /** Mutable state projected through DSH's durable, superseding runtime-context snapshots. */
  function controlRuntimeContext(agent: AgentLike | undefined): string {
    if (agent === undefined && resolved.legacyIntakeMode === undefined) return ''
    const control = controlFor(agent)
    if (control.phase === 'bypass') return ''
    const nativePlanMode = agent === undefined ? false : synchronizeNativePlanMode(agent as Agent)
    if (control.phase === 'probe') {
      return [
        'Plan Lattice execution state:',
        '- Control: route probe',
        `- DSH native plan mode: ${nativePlanMode ? 'active; execution suspended' : 'inactive'}`,
        `- Reasons: ${control.reasons.join('; ') || 'route evidence is incomplete'}`,
        `- Outcome-critical gap: ${control.outcomeCritical ? 'yes' : 'no'}`,
        `- Critical dimensions: ${control.criticalGaps.join(', ') || 'none identified'}`,
        `- Required next action: ${nextControlStep(agent, control).action}`,
      ].join('\n')
    }
    const contract = control.contract
    if (contract === undefined) {
      return [
        'Plan Lattice execution state:',
        `- Control: ${control.phase}`,
        `- DSH native plan mode: ${nativePlanMode ? 'active; execution suspended' : 'inactive'}`,
        '- Contract: pending initial commitment',
        `- Root session: ${control.rootSessionId}`,
        `- Agent role: ${agent !== undefined && isDelegatedSession(agent) ? 'delegated; return unresolved authority or requirement changes to the parent, never ask the human directly' : 'root; only this role may clarify or revise the accepted contract'}`,
        `- Required next action: ${nextControlStep(agent, control).action}`,
      ].join('\n')
    }
    const activeLease = agent === undefined ? undefined : leases.get(sessionKey(agent))
    const currentNode = activeLease === undefined
      ? control.delegatedNode
      : {
          id: activeLease.nodeId,
          title: activeLease.nodeTitle,
          acceptanceCriteria: activeLease.nodeAcceptanceCriteria,
          graphRevision: activeLease.revision,
        }
    return [
      'Plan Lattice execution state:',
      `- Control: ${control.phase}`,
      `- DSH native plan mode: ${nativePlanMode ? 'active; execution suspended' : 'inactive'}`,
      `- Root session: ${control.rootSessionId}`,
      `- Outcome: ${contract.framing.desiredOutcome}`,
      `- Boundary: ${contract.framing.systemBoundary}`,
      `- Invariants: ${contract.framing.invariants.join('; ') || 'none recorded'}`,
      `- Decisions: ${contract.framing.decisions.join('; ') || 'none recorded'}`,
      `- Contract readiness: ${contract.framing.readinessRationale}`,
      `- Unknowns: ${contract.framing.unknowns.join('; ') || 'none'}`,
      `- Current node: ${currentNode === undefined ? 'none' : `${currentNode.id} - ${currentNode.title}`}`,
      `- Node acceptance: ${currentNode?.acceptanceCriteria ?? 'none'}`,
      `- Contract revision: ${contract.revision}`,
      `- Plan revision: ${currentNode?.graphRevision ?? 'none'}`,
      `- Reframe pending: ${control.reframePending ? 'yes' : 'no'}`,
      nativePlanMode
        ? '- Control protocol: DSH native plan mode owns this turn; contract and leaf state are read-only until exit_plan_mode completes.'
        : '- Control protocol: preserve the accepted contract; material changes require lattice_reframe; guarded writes require a fresh lattice_refresh_context basis, and lattice mode also requires a current leaf checkout.',
      `- Agent role: ${agent !== undefined && isDelegatedSession(agent) ? 'delegated; return unresolved authority or requirement changes to the parent, never ask the human directly' : 'root; only this role may clarify or revise the accepted contract'}`,
      `- Required next action: ${nextControlStep(agent, control).action}`,
      ...(control.contextReplacement === undefined
        ? []
        : [`- Latest history replacement: ${control.contextReplacement.type} at Session event ${control.contextReplacement.seq}`]),
    ].join('\n')
  }

  function toolSchemaDigest(schema: ModelToolSchema): string {
    return createHash('sha256').update(JSON.stringify(schema)).digest('hex')
  }

  function digestJson(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }

  function definitionId(definition: object): number {
    const existing = toolDefinitionIds.get(definition)
    if (existing !== undefined) return existing
    const id = nextToolDefinitionId++
    toolDefinitionIds.set(definition, id)
    return id
  }

  /** Bind schemas to the exact definitions visible to this one native Agent. */
  function toolViewDigest(agent: Agent): string {
    const view = ctx.tools.schemas(agent).map((schema) => {
      const definition = ctx.tools.get(schema.name, agent)
      return {
        name: schema.name,
        schema: toolSchemaDigest(schema),
        definition: definition === undefined ? null : definitionId(definition as object),
      }
    })
    return digestJson(view)
  }

  function wireToolsDigest(tools: readonly ModelToolSchema[]): string {
    return digestJson(tools.map(tool => toolSchemaDigest(tool)))
  }

  function toolProtocolDigest(assembly: PromptAssembly): string {
    return digestJson({
      tools: assembly.tools,
      sections: assembly.sections.filter(section => section.name === 'tools:code-only' || section.name === 'tools:sdk'),
    })
  }

  function assertExactWireTool(
    wire: ModelToolSchema,
    canonical: ModelToolSchema | undefined,
    name: string,
  ): string {
    if (canonical === undefined || toolSchemaDigest(wire) !== toolSchemaDigest(canonical)) {
      throw new Error(`Plan Lattice requires the exact callable DSH tool schema for ${name}`)
    }
    return toolSchemaDigest(wire)
  }

  function attestAssembly(
    agent: Agent,
    control: AgentControl,
    input: PromptAssembly,
    codeOnlyPresentation: boolean,
  ): { assembly: PromptAssembly; attestation: FinalAssemblyAttestation } {
    const controlRuntimeText = controlRuntimeContext(agent)
    const contexts = input.contexts.map(entry => entry.name === 'plan-lattice:execution-state'
      ? { ...entry, text: controlRuntimeText }
      : entry)
    const step = nextControlStep(agent, control)
    const requiredTool = step.requiredTool
    const wireTools = new Map(input.tools.map(schema => [schema.name, schema]))
    const canonicalTools = new Map(ctx.tools.schemas(agent).map(schema => [schema.name, schema]))
    let runtimeText = controlRuntimeText
    let transport: 'native' | 'code' = 'native'
    let wireToolName: string | undefined
    let wireToolDigest: string | undefined

    if (requiredTool !== undefined) {
      const requiredCapability = ctx.tools.get(requiredTool, agent)
      const canonicalRequired = canonicalTools.get(requiredTool)
      const direct = wireTools.get(requiredTool)
      const runCode = wireTools.get('run_code')
      const canonicalRunCode = canonicalTools.get('run_code')
      if (codeOnlyPresentation && runCode === undefined) {
        throw new Error(`Plan Lattice requires DSH Code Mode transport run_code for ${requiredTool}; a prompt transform removed the only model-direct executable bridge`)
      }
      // An exact run_code schema proves DSH selected a Code Mode-capable wire.
      // Prefer that executable bridge even if a later prompt transform injects
      // the native schema too: pure Code Mode rejects model-direct native calls.
      if (runCode !== undefined) {
        if (ctx.tools.get('run_code', agent) === undefined) {
          throw new Error(`Plan Lattice requires the current DSH control tool on the final wire: ${requiredTool}`)
        }
        if (requiredCapability === undefined || canonicalRequired === undefined) {
          throw new Error(`Plan Lattice requires callable DSH Code Mode tools: ${requiredTool}`)
        }
        wireToolName = 'run_code'
        wireToolDigest = assertExactWireTool(runCode, canonicalRunCode, 'run_code')
        transport = 'code'
        runtimeText += `\n- DSH Code Mode bridge: the model wire exposes run_code. Invoke the required control action inside run_code with return await tools.${requiredTool}({...}). ${requiredTool} parameters ${JSON.stringify(canonicalRequired.parameters ?? {})}`
      } else if (direct !== undefined) {
        if (requiredCapability === undefined || canonicalRequired === undefined) {
          throw new Error(`Plan Lattice requires the current DSH control tool on the final wire: ${requiredTool}`)
        }
        wireToolName = requiredTool
        wireToolDigest = assertExactWireTool(direct, canonicalRequired, requiredTool)
      } else {
        throw new Error(`Plan Lattice requires the current DSH control tool on the final wire: ${requiredTool}`)
      }
    }

    const assembly: PromptAssembly = {
      ...input,
      contexts: contexts.map(entry => entry.name === 'plan-lattice:execution-state'
        ? { ...entry, text: runtimeText }
        : entry),
    }
    const runtimeSections = renderContextSections(assembly)
    const runtimeSnapshotText = joinContextSections(runtimeSections)
    return {
      assembly,
      attestation: {
        sessionId: sessionKey(agent),
        authorizationEpoch: currentAuthorizationEpoch(sessionKey(agent)),
        systemPrompt: renderPrompt(assembly),
        controlRuntimeText,
        runtimeText,
        runtimeSections,
        runtimeSnapshotText,
        assembly,
        codeOnlyPresentation,
        toolRegistryGeneration,
        toolViewDigest: toolViewDigest(agent),
        wireToolsDigest: wireToolsDigest(assembly.tools),
        toolProtocolDigest: toolProtocolDigest(assembly),
        ...(requiredTool === undefined ? {} : { requiredTool }),
        transport,
        ...(wireToolName === undefined ? {} : { wireToolName }),
        ...(wireToolDigest === undefined ? {} : { wireToolDigest }),
      },
    }
  }

  function refreshedRuntimeMessage(attestation: FinalAssemblyAttestation) {
    return createUserMessage({
      content: [{ type: 'text', text: attestation.runtimeSnapshotText }],
      source: {
        kind: 'plugin',
        plugin: '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        sections: attestation.runtimeSections,
      },
    })
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'plan:fractal-ledger',
      order: 55,
      text: assemble => controlPolicyPrompt(assemble.agent),
    })
    promptCtx.systemPrompt.context({
      name: 'plan-lattice:execution-state',
      order: 130,
      text: assemble => controlRuntimeContext(assemble.agent),
    })

    // Run outermost around the authoritative DSH waterfall. Validation happens
    // after every downstream transform, against the exact contexts and wire
    // tools the agent loop receives. A later outer listener that short-circuits
    // this hook still fails closed at agent/pre-step through the signal latch.
    promptCtx.on('system-prompt/assemble', async (registryAssembly, assemble, next) => {
      const assemblyStartGeneration = toolRegistryGeneration
      const agent = assemble.agent
      const assemblyStartViewDigest = agent === undefined ? undefined : toolViewDigest(agent)
      const transformed = await next()
      if (agent === undefined) return transformed
      const control = controls.get(sessionKey(agent))
      if (control?.phase === 'bypass') return transformed
      if (control === undefined) {
        throw new Error('Plan Lattice has no installed control for this prompt assembly')
      }

      synchronizeNativePlanMode(agent)

      const expectedRuntime = controlRuntimeContext(agent)
      const runtimeEntries = transformed.contexts.filter(entry => entry.name === 'plan-lattice:execution-state')
      if (runtimeEntries.length !== 1 || runtimeEntries[0]?.text !== expectedRuntime) {
        throw new Error('Plan Lattice requires its exact final DSH runtime context; an active persona or prompt transform removed or replaced it')
      }

      const codeOnlyPresentation = registryAssembly.tools.length === 1
        && registryAssembly.tools[0]?.name === 'run_code'
      const final = attestAssembly(agent, control, transformed, codeOnlyPresentation)
      if (assemblyStartGeneration !== toolRegistryGeneration) {
        if (assemblyStartViewDigest !== final.attestation.toolViewDigest) {
          throw new Error('Plan Lattice DSH tool definitions changed for this Agent during prompt assembly')
        }
      }
      if (assemble.signal !== undefined) {
        validatedAssemblySignals.add(assemble.signal)
        finalAssemblyAttestations.set(assemble.signal, final.attestation)
      }
      return final.assembly
    }, { global: true, prepend: true })
  })

  // DSH assembles the system prompt before this hook with the same turn
  // signal. Active control must never survive while its runtime snapshot or
  // tool protocol is hidden by an incompatible persona/preset.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const control = controls.get(sessionKey(agent))
    if (control?.phase === 'bypass') return next()
    if (control === undefined) {
      throw new Error('Plan Lattice has no installed control for this agent; recreate the agent or disable Plan Lattice explicitly')
    }
    if (!validatedAssemblySignals.delete(signal)) {
      throw new Error('Plan Lattice requires a validated final DSH runtime context and tool protocol; enable runtime context, adjust the preset, or explicitly bypass Plan Lattice')
    }
    const decision = await next()
    if (decision.kind === 'reject') {
      nativeSubagentStarts.delete(agent)
      pendingDelegatedInitialInputs.delete(agent)
      return decision
    }

    const pendingDelegation = pendingDelegatedInitialInputs.get(agent)
    if (pendingDelegation !== undefined) {
      if (!isNativeInitialDelegation(agent, control)) {
        pendingDelegatedInitialInputs.delete(agent)
        fenceUnprovenDelegatedInput(agent, control, pendingDelegation.message)
        throw new Error('Plan Lattice rejected a delegated user-role message without native initial-delegation provenance')
      }
      markDelegatedInitialInput(agent, control, String(pendingDelegation.message.id))
    }

    const prior = finalAssemblyAttestations.get(signal)
    if (prior === undefined || prior.sessionId !== sessionKey(agent)) {
      throw new Error('Plan Lattice lost its DSH prompt-assembly attestation during pre-step')
    }
    const stale = prior.authorizationEpoch !== currentAuthorizationEpoch(sessionKey(agent))
      || prior.controlRuntimeText !== controlRuntimeContext(agent)
    if (!stale) return decision

    // Pressure compaction runs in DSH's native pre-step waterfall after prompt
    // assembly. Re-project only the dynamic native snapshot; the permanent
    // policy and tool registry remain owned by the original assembly.
    const refreshed = attestAssembly(agent, control, prior.assembly, prior.codeOnlyPresentation)
    finalAssemblyAttestations.set(signal, refreshed.attestation)
    return {
      ...decision,
      messages: [
        ...decision.messages.filter(message => !(message.source.kind === 'plugin'
          && message.source.plugin === '@deepseek-ai/dsh-system-prompt')),
        refreshedRuntimeMessage(refreshed.attestation),
      ],
    }
  }, { global: true, prepend: true })

  // Native overflow compaction retries the same step without another
  // agent/pre-step. Rejoin the changed Session surface to the same turn signal
  // only when DSH proved replacement progress and no human authority is
  // waiting for review.
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    const generation = agent.session.surface.replaceGeneration
    const action = await next()
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE
      || action?.kind !== 'retry'
      || agent.session.surface.replaceGeneration <= generation) return action

    const control = controls.get(sessionKey(agent))
    if (control?.phase === 'bypass') return action
    const prior = finalAssemblyAttestations.get(signal)
    if (control === undefined
      || prior === undefined
      || prior.sessionId !== sessionKey(agent)) {
      throw new Error('Plan Lattice cannot re-attest a native context-overflow retry without its live control and assembly')
    }
    requireLiveOwnership(agent, control.rootSessionId)
    const pendingReason = pendingInputGuard(agent, control)
    if (control.reframePending || pendingReason !== undefined) {
      throw new Error(`Plan Lattice blocks native context-overflow retry while human authority is pending${pendingReason === undefined ? '' : `: ${pendingReason}`}`)
    }

    const refreshed = attestAssembly(agent, control, prior.assembly, prior.codeOnlyPresentation)
    finalAssemblyAttestations.set(signal, refreshed.attestation)
    agent.session.append('user/message', refreshedRuntimeMessage(refreshed.attestation), { surfaceOp: 'append' })
    return action
  }, { global: true, prepend: true })

  async function assertFinalModelRequest(options: GenerateOptions): Promise<void> {
    if (!isAgentLoopRequest(options)) return
    const registry = ctx.get('agents')
    const agent = options.sessionId === undefined ? undefined : registry?.get(options.sessionId as never)
    if (agent === undefined) {
      throw new Error('Plan Lattice cannot attest an agent-loop request without its exact live DSH agent')
    }
    const control = controls.get(sessionKey(agent))
    if (control?.phase === 'bypass') return
    if (control === undefined) {
      throw new Error('Plan Lattice cannot attest an active agent-loop request without installed control')
    }
    const signal = options.signal
    if (signal === undefined) {
      throw new Error('Plan Lattice final model request has no AgentLoop turn signal')
    }
    let attestation = finalAssemblyAttestations.get(signal)
    if (attestation === undefined || attestation.sessionId !== sessionKey(agent)) {
      throw new Error('Plan Lattice final model request has no matching DSH prompt-assembly attestation')
    }
    if (attestation.toolRegistryGeneration !== toolRegistryGeneration) {
      if (toolViewDigest(agent) !== attestation.toolViewDigest) {
        throw new Error('Plan Lattice final model request uses a DSH tool presentation or registry state that changed after prompt assembly (this Agent\'s definition view changed)')
      }
      attestation = { ...attestation, toolRegistryGeneration }
      finalAssemblyAttestations.set(signal, attestation)
    }
    requireLiveOwnership(agent, control.rootSessionId)
    const liveEpoch = currentAuthorizationEpoch(sessionKey(agent))
    if (attestation.authorizationEpoch !== liveEpoch) {
      throw new Error(`Plan Lattice final model request carries a stale execution-authorization epoch (${attestation.authorizationEpoch} != ${liveEpoch})`)
    }
    if (attestation.controlRuntimeText !== controlRuntimeContext(agent)) {
      throw new Error('Plan Lattice final model request carries stale projected runtime state')
    }
    if ((options.system ?? '') !== attestation.systemPrompt) {
      throw new Error('Plan Lattice final model request system prompt differs from the attested DSH assembly')
    }
    if (wireToolsDigest(options.tools ?? []) !== attestation.wireToolsDigest) {
      throw new Error('Plan Lattice final model request tool wire differs from the attested DSH assembly')
    }

    const runtimeMessage = [...options.messages].reverse().find(message => message.source.kind === 'plugin'
      && message.source.plugin === '@deepseek-ai/dsh-system-prompt')
    const runtimeSource = runtimeMessage?.source
    const runtimeText = runtimeMessage?.content.length === 1
      && runtimeMessage.content[0]?.type === 'text'
      ? runtimeMessage.content[0].text
      : undefined
    if (runtimeSource?.kind !== 'plugin'
      || runtimeSource.plugin !== '@deepseek-ai/dsh-system-prompt'
      || runtimeSource.form !== 'snapshot'
      || JSON.stringify(runtimeSource.sections) !== JSON.stringify(attestation.runtimeSections)
      || runtimeText !== attestation.runtimeSnapshotText) {
      throw new Error('Plan Lattice final model request is missing the exact attested runtime-context snapshot')
    }

    if (attestation.requiredTool !== undefined) {
      const wire = (options.tools ?? []).find(schema => schema.name === attestation.wireToolName)
      const canonical = ctx.tools.schemas(agent).find(schema => schema.name === attestation.wireToolName)
      if (wire === undefined
        || canonical === undefined
        || attestation.wireToolDigest === undefined
        || toolSchemaDigest(wire) !== attestation.wireToolDigest
        || toolSchemaDigest(canonical) !== attestation.wireToolDigest
        || attestation.wireToolName === undefined
        || ctx.tools.get(attestation.wireToolName, agent) === undefined) {
        throw new Error(`Plan Lattice final model request is missing exact callable ${attestation.transport} control transport`)
      }
      if (ctx.tools.get(attestation.requiredTool, agent) === undefined) {
        throw new Error(`Plan Lattice final model request lost callable control capability ${attestation.requiredTool}`)
      }
    }
  }

  // The deep-frozen request is the only model wire DSH dispatches. Registry
  // changes after this check cannot rewrite it, and every resulting guarded
  // tool call is independently rebound at tools/execute before side effects.
  // Rechecking each delivered chunk closes asynchronous downstream windows up
  // to this middleware's yield boundary, such as native checkpoint flushes,
  // without depending on plugin registration order or invoking the public
  // prompt waterfall twice. rc.7 does not make this yield and AgentLoop's
  // subsequent Session append atomic; that remaining host seam is documented
  // and exercised by the native integration tests.
  ctx.inject(['llm'], (llmCtx) => {
    llmCtx.on('llm/stream', (options: GenerateOptions, next) => {
      return (async function* () {
        await assertFinalModelRequest(options)
        const iterator = next()[Symbol.asyncIterator]()
        let completed = false
        try {
          while (true) {
            const item = await iterator.next()
            if (item.done) {
              completed = true
              return
            }
            await assertFinalModelRequest(options)
            yield item.value
          }
        } finally {
          if (!completed) await iterator.return?.()
        }
      })()
    }, { global: true, prepend: true })
  })

  function clearWorkspace(workspace: string): void {
    const keys = new Set<string>()
    for (const [key, prepared] of preparedAuthorizations) if (prepared.workspace === workspace) keys.add(key)
    for (const [key, lease] of leases) if (lease.workspace === workspace) keys.add(key)
    for (const [key, boundWorkspace] of sessionWorkspaces) if (boundWorkspace === workspace) keys.add(key)
    for (const key of keys) invalidateSessionAuthority(key, { releaseLease: true })
  }

  async function ensureNoActiveLease(workspace: string): Promise<void> {
    await durableReleases.get(workspace)
    for (const lease of leases.values()) {
      if (lease.workspace === workspace) {
        throw new Error(`node ${JSON.stringify(lease.nodeId)} is checked out; checkpoint it before changing the plan`)
      }
    }
    const durable = await executionState.read(executionAuthorityWorkspace(workspace))
    if (durable.lease !== null) {
      throw new Error(`node ${JSON.stringify(durable.lease.nodeId)} is durably checked out by session ${JSON.stringify(durable.lease.ownerSessionId)}; checkpoint it before changing the plan`)
    }
  }

  async function acquireControlFence(
    workspace: string,
    sessionId: string,
    state: LatticeState,
    nodeId: typeof REFRAME_FENCE_NODE_ID | typeof STRUCTURAL_FENCE_NODE_ID,
    previousContract?: ContractRecord,
  ): Promise<ReframeFence> {
    await durableReleases.get(workspace)
    for (const lease of leases.values()) {
      if (lease.workspace === workspace) {
        throw new Error(`node ${JSON.stringify(lease.nodeId)} is checked out; checkpoint it before changing the contract`)
      }
    }
    const authorityWorkspace = executionAuthorityWorkspace(workspace)
    const snapshot = await executionState.read(authorityWorkspace)
    if (snapshot.lease !== null) {
      throw new Error(`node ${JSON.stringify(snapshot.lease.nodeId)} is durably checked out by session ${JSON.stringify(snapshot.lease.ownerSessionId)}; checkpoint it before changing the contract`)
    }
    const legacyDigest = createHash('sha256')
      .update(`${workspace}\0${sessionId}\0${state.revision}\0${nodeId}`)
      .digest('hex')
    const durable = await executionState.checkout(authorityWorkspace, {
      ownerSessionId: `${sessionId}:control:${randomUUID()}`,
      rootSessionId: sessionId,
      nodeId,
      graphRevision: state.revision,
      contractRevision: previousContract?.revision ?? 1,
      contractDigest: previousContract?.documentDigest ?? legacyDigest,
      expectedGeneration: snapshot.generation,
    })
    ownedControlFences.add(durable.leaseId)
    return { authorityWorkspace, durable }
  }

  function acquireReframeFence(
    workspace: string,
    sessionId: string,
    state: LatticeState,
    previousContract?: ContractRecord,
  ): Promise<ReframeFence> {
    return acquireControlFence(workspace, sessionId, state, REFRAME_FENCE_NODE_ID, previousContract)
  }

  async function releaseReframeFence(fence: ReframeFence): Promise<void> {
    await executionState.release(fence.authorityWorkspace, executionLeaseClaim(fence.durable))
    ownedControlFences.delete(fence.durable.leaseId)
  }

  async function mutateWithStructuralFence<T>(
    workspace: string,
    sessionId: string,
    state: LatticeState,
    contract: ContractRecord | undefined,
    action: string,
    mutate: (current: LatticeState) => { value: T; delta: LatticeDelta },
    beforeCommit: () => void,
  ): Promise<T> {
    const fence = await acquireControlFence(
      workspace,
      sessionId,
      state,
      STRUCTURAL_FENCE_NODE_ID,
      contract,
    )
    try {
      return await store.mutate(workspace, action, mutate, () => {
        beforeCommit()
        executionState.verifyOwnershipSync(fence.authorityWorkspace, executionLeaseClaim(fence.durable))
      })
    } finally {
      // The graph commit is authoritative even if cleanup encounters an I/O
      // error. Retaining a clean fence fails closed and restart can release it.
      await releaseReframeFence(fence).catch(() => {})
    }
  }

  async function restoreDurableLease(
    agent: Agent,
    workspace: string,
    state: LatticeState,
    acceptedContract?: ContractRecord,
  ): Promise<ExecutionLease | undefined> {
    const key = sessionKey(agent)
    const existing = leases.get(key)
    await durableReleases.get(workspace)

    const authorityWorkspace = executionAuthorityWorkspace(workspace)
    const snapshot = await executionState.read(authorityWorkspace)
    const persisted = snapshot.lease
    if (persisted === null) {
      if (existing?.workspace === workspace) leases.delete(key)
      return undefined
    }
    const recoveredProcess = persisted.ownerPid !== process.pid || persisted.ownerHost !== hostname()
    const isControlFence = persisted.nodeId === REFRAME_FENCE_NODE_ID
      || persisted.nodeId === STRUCTURAL_FENCE_NODE_ID
    if (isControlFence && ownedControlFences.has(persisted.leaseId)) {
      throw new Error('a durable contract or plan mutation is still in progress for this workspace')
    }
    const control = controls.get(key)
    const rootSessionId = control?.rootSessionId ?? key
    const sameRoot = persisted.rootSessionId === rootSessionId
    if (!sameRoot && persisted.dirty) {
      throw new Error('a pending execution belongs to another root task; resume that exact task and reconcile its mechanical receipt before continuing')
    }

    let durable = persisted
    if (persisted.ownerPid === process.pid && persisted.ownerSessionId === key) {
      durable = executionState.verifyOwnershipSync(authorityWorkspace, executionLeaseClaim(persisted))
    } else {
      try {
        durable = await executionState.checkout(authorityWorkspace, {
          ownerSessionId: key,
          rootSessionId: persisted.dirty || persisted.releaseWhenClean === true
            ? persisted.rootSessionId
            : rootSessionId,
          nodeId: persisted.nodeId,
          graphRevision: persisted.graphRevision,
          contractRevision: persisted.contractRevision,
          contractDigest: persisted.contractDigest,
          expectedGeneration: snapshot.generation,
        })
      } catch (error) {
        if (!sameRoot && !persisted.dirty
          && error instanceof ExecutionStateError && error.code === 'LEASE_CONFLICT') {
          return undefined
        }
        throw error
      }
    }

    if (durable.nodeId === REFRAME_FENCE_NODE_ID || durable.nodeId === STRUCTURAL_FENCE_NODE_ID) {
      if (durable.dirty) throw new Error('a durable control fence is unexpectedly dirty')
      if (durable.nodeId === REFRAME_FENCE_NODE_ID) {
        const contract = acceptedContract ?? control?.contract
        if (contract !== undefined && (
          state.project.contractRevision !== contract.revision
          || state.project.contractDigest !== contract.documentDigest
        ) && control !== undefined) {
          control.reframePending = true
        }
      }
      await executionState.release(authorityWorkspace, executionLeaseClaim(durable))
      ownedControlFences.delete(durable.leaseId)
      if (existing?.workspace === workspace) leases.delete(key)
      return undefined
    }

    const revisionDelta = state.revision - durable.graphRevision
    if (revisionDelta === -1) {
      if (durable.dirty) {
        throw new Error('a dirty execution lease cannot precede its durable graph revision')
      }
      await executionState.release(authorityWorkspace, executionLeaseClaim(durable))
      if (existing?.workspace === workspace) leases.delete(key)
      return undefined
    }
    if (revisionDelta < 0 || revisionDelta > 1) {
      throw new Error(`durable execution graph revision ${durable.graphRevision} cannot be reconciled with lattice revision ${state.revision}`)
    }

    const node = findNode(state, durable.nodeId)
    const contract = acceptedContract ?? control?.contract
    const contractChanged = contract !== undefined && (
      durable.contractRevision !== contract.revision
      || durable.contractDigest !== contract.documentDigest
    )
    const exactLocalSnapshot = existing?.workspace === workspace
      && existing.nodeId === persisted.nodeId
      && sameDurableLeaseSnapshot(existing.durable, persisted)
    const localExecutionOrigin = existing === undefined ? undefined : localExecutionOrigins.get(existing)
    const exactLocalLease = exactLocalSnapshot && (!persisted.dirty || (
      persisted.pendingExecution !== undefined
      && localExecutionOrigin?.token !== undefined
      && localExecutionOrigin?.attemptId === persisted.pendingExecution.attemptId
    ))

    // A crash can land after graph evidence commits but before the separate
    // ownership record advances. The old persisted timestamp remains the proof
    // boundary even when a dead owner is taken over and receives a new timestamp.
    if (revisionDelta === 1) {
      const localRelease = exactLocalLease && existing.releaseWhenClean === true
      let settled
      if (durable.dirty) {
        const pending = durable.pendingExecution
        if (pending === undefined) {
          throw new Error('a legacy indeterminate execution cannot be settled without an exact mechanical receipt')
        }
        const receipt = state.executionReceipts?.[pending.attemptId]
        if (receipt === undefined
          || receipt.nodeId !== durable.nodeId
          || receipt.callId !== pending.callId
          || receipt.toolName !== pending.toolName
          || receipt.argumentsDigest !== pending.argumentsDigest
          || receipt.basisDigest !== pending.basisDigest
          || receipt.recordedAt < pending.startedAt) {
          throw new Error('the lattice advanced beyond a pending execution without its exact mechanical receipt')
        }
        assertMechanicalExecutionReceipt(receipt)
        const release = node.status === 'complete'
          || !sameRoot
          || contractChanged
          || durable.releaseWhenClean === true
          || localRelease
          || receipt.releaseWhenClean === true
          || !exactLocalLease
        settled = await executionState.settleExecution(
          authorityWorkspace,
          executionLeaseClaim(durable),
          pending.attemptId,
          { release, graphRevision: state.revision },
        )
      } else {
        const checkpointEvidence = node.evidence.some(item => item.recordedAt >= persisted.updatedAt)
        if (!checkpointEvidence) {
          throw new Error('the lattice advanced beyond a clean execution lease without matching semantic checkpoint evidence')
        }
        const release = node.status === 'complete'
          || !sameRoot
          || contractChanged
          || durable.releaseWhenClean === true
          || localRelease
        settled = await executionState.checkpoint(
          authorityWorkspace,
          executionLeaseClaim(durable),
          { release, graphRevision: state.revision },
        )
      }
      if (settled.lease === null) {
        if (existing?.workspace === workspace) leases.delete(key)
        if (contractChanged && control !== undefined) control.reframePending = true
        return undefined
      }
      durable = settled.lease
    }

    if (contractChanged) {
      if (control !== undefined) control.reframePending = true
      if (durable.dirty) {
        throw new Error('durable execution ownership predates the accepted contract; settle its checkpoint before reframing')
      }
      await executionState.release(authorityWorkspace, executionLeaseClaim(durable))
      if (existing?.workspace === workspace) leases.delete(key)
      return undefined
    }
    if (durable.releaseWhenClean === true && !durable.dirty) {
      await executionState.release(authorityWorkspace, executionLeaseClaim(durable))
      if (leases.get(key) === existing) leases.delete(key)
      return undefined
    }
    if (recoveredProcess && !exactLocalLease && !durable.dirty) {
      await executionState.release(authorityWorkspace, executionLeaseClaim(durable))
      if (existing?.workspace === workspace) leases.delete(key)
      return undefined
    }
    if (!sameRoot) {
      await executionState.release(authorityWorkspace, executionLeaseClaim(durable))
      if (existing?.workspace === workspace) leases.delete(key)
      return undefined
    }

    const restored: ExecutionLease = {
      workspace,
      nodeId: node.id,
      nodeTitle: node.title,
      nodeAcceptanceCriteria: node.acceptanceCriteria,
      revision: state.revision,
      dirty: durable.dirty,
      durable,
      contextDigest: '',
      contextPaths: state.project.contextPaths,
      contextReplacement: {
        seq: Number.isSafeInteger(agent.session.firstLiveSeq)
          ? Math.max(0, agent.session.firstLiveSeq - 1)
          : 0,
        type: 'durable-execution-resume',
      },
      ...(durable.releaseWhenClean === true ? { releaseWhenClean: true } : {}),
    }
    leases.set(key, restored)
    return restored
  }

  async function snapshotExternalPreconditions(
    workspace: string,
    requests: ExternalActionRequest[],
    agent: Agent,
  ): Promise<ExternalPreconditionSnapshot[]> {
    const snapshots: ExternalPreconditionSnapshot[] = []
    const identities = new Set<string>()
    const actionTools = new Set<string>()
    for (const request of requests) {
      const toolName = assertText(request.toolName, 'externalActions.toolName')
      const resource = assertText(request.resource, 'externalActions.resource')
      if (!resolved.guardedTools.has(toolName)) {
        throw new Error(`external action ${JSON.stringify(toolName)} is not a configured guarded tool`)
      }
      const adapter = resolved.preconditionAdapters.get(toolName)
      if (adapter === undefined) {
        throw new Error(`no host precondition adapter is configured for ${JSON.stringify(toolName)}`)
      }
      const normalizedArguments = externalActionIdentity(adapter, request.arguments)
      const argumentsDigest = digestArguments(normalizedArguments)
      const identity = `${toolName}\0${argumentsDigest}`
      if (identities.has(identity)) throw new Error('externalActions must not duplicate the same tool arguments')
      identities.add(identity)
      actionTools.add(toolName)
      const captured = await adapter.snapshot({ workspace, resource, arguments: request.arguments })
      const stateDigest = assertText(captured.stateDigest, `precondition state digest for ${toolName}`)
      const description = assertText(captured.description, `precondition description for ${toolName}`)
      snapshots.push({ toolName, resource, argumentsDigest, stateDigest, description })
    }
    for (const [toolName, adapter] of resolved.preconditionAdapters) {
      if (actionTools.has(toolName)
        || adapter.snapshotScope === undefined
        || adapter.verifyScope === undefined
        || ctx.tools.get(toolName, agent) === undefined) continue
      const captured = await adapter.snapshotScope({ workspace })
      snapshots.push({
        toolName,
        resource: assertText(captured.resource, `scope resource for ${toolName}`),
        argumentsDigest: '',
        scope: true,
        stateDigest: assertText(captured.stateDigest, `scope state digest for ${toolName}`),
        description: assertText(captured.description, `scope description for ${toolName}`),
      })
    }
    return snapshots.sort((left, right) => (
      `${left.toolName}\0${left.scope === true ? 'scope' : 'action'}\0${left.argumentsDigest}`
        .localeCompare(`${right.toolName}\0${right.scope === true ? 'scope' : 'action'}\0${right.argumentsDigest}`)
    ))
  }

  async function issueCurrentReceipt(
    agent: Agent,
    workspace: string,
    state: LatticeState,
    targetPaths: string[] = [],
    planNodeId?: string,
    externalActions: ExternalActionRequest[] = [],
    expectedStartEpoch?: number,
  ): Promise<{
    receipt: LatticeReceipt
    documents: Awaited<ReturnType<typeof readProjectContext>>['documents']
    mutationBasis: MutationBasis
    planContext: StructuralPlanView
  }> {
    const key = sessionKey(agent)
    const control = controls.get(key)
    requireLiveOwnership(agent, control?.rootSessionId)
    const startEpoch = expectedStartEpoch ?? currentAuthorizationEpoch(key)
    if (currentAuthorizationEpoch(key) !== startEpoch) {
      throw new Error('execution authority changed before the authoritative context read began; retry lattice_refresh_context')
    }
    sessionWorkspaces.set(key, workspace)
    let acceptedContract: ContractRecord | undefined
    if (resolved.legacyIntakeMode === undefined) {
      if (control === undefined || control.phase !== 'lattice') {
        throw new Error('a tracked lattice task is required to rebuild execution authority')
      }
      if (control.contract === undefined) {
        // Existing v1 graphs get a plan-only migration receipt. It can authorize
        // lattice_reframe, never artifact or structural mutation.
        control.reframePending = true
      } else {
        acceptedContract = control.reframePending
          ? requireContractAnchor(control.contract)
          : await verifyAnchoredContract({ workspace, sessionId: control.rootSessionId })
        if (acceptedContract.controlLevel !== 'lattice') throw new Error('the accepted contract does not authorize lattice execution')
      }
    }
    const context = await readProjectContext(workspace, state.project.contextPaths, resolved.maxContextBytes)
    const targetContext = await readMutationTargets(workspace, targetPaths, resolved.maxContextBytes)
    const externalPreconditions = await snapshotExternalPreconditions(workspace, externalActions, agent)
    await restoreDurableLease(agent, workspace, state, acceptedContract)
    const lease = leases.get(sessionKey(agent))
    const priorFocus = preparedAuthorizations.get(key)?.view.focus?.nodeId
    const planContext = structuralPlanView(state, planNodeId ?? lease?.nodeId ?? priorFocus)
    const receipt = issueReceipt(workspace, state, context)
    if (currentAuthorizationEpoch(key) !== startEpoch) {
      throw new Error('execution authority changed during the authoritative context read; retry lattice_refresh_context')
    }
    if (control !== undefined && acceptedContract !== undefined) control.contract = acceptedContract
    const epoch = startEpoch
    const mutationBasis: MutationBasis = {
      authorizationId: receipt.id,
      epoch,
      ...(acceptedContract === undefined ? {} : { contract: contractBasis(acceptedContract) }),
      planRevision: state.revision,
      ...(lease?.workspace === workspace ? { nodePlan: nodeExecutionPlan(state, lease.nodeId) } : {}),
      targets: targetContext.targets,
      targetDigest: targetContext.digest,
      externalPreconditions,
      externalPreconditionDigest: summarizeExternalPreconditions(externalPreconditions),
    }
    preparedAuthorizations.set(key, {
      workspace,
      receipt,
      epoch,
      ...(acceptedContract === undefined ? {} : { contract: contractBasis(acceptedContract) }),
      view: planContext,
    })
    const documents = acceptedContract === undefined || control === undefined
      ? context.documents
      : [...context.documents, ...authorityDocuments(agent, control, acceptedContract)]
    return { receipt, documents, mutationBasis, planContext }
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

  async function consumeFreshAuthorization(
    agent: Agent,
    workspace: string,
    receiptId: string,
    expectedRevision: number,
    observedNodeId?: string,
    allowReframePending = false,
  ): Promise<{ state: LatticeState; consumedEpoch: number }> {
    const key = sessionKey(agent)
    const control = controls.get(key)
    requireLiveOwnership(agent, control?.rootSessionId)
    if (resolved.legacyIntakeMode === undefined && control !== undefined) {
      const pendingReason = pendingInputGuard(agent, control)
      if (pendingReason !== undefined && !(allowReframePending && control.reframePending)) {
        throw new Error(`${pendingReason}; guarded work remains blocked`)
      }
    }
    if (control?.reframePending === true && !allowReframePending) {
      throw new Error('a material change requires lattice_reframe before another lattice operation')
    }
    const prepared = preparedAuthorizations.get(key)
    if (prepared === undefined || prepared.receipt.id !== receiptId) {
      throw new Error('context receipt is missing, expired, or belongs to another session; call lattice_refresh_context')
    }
    const previousEpoch = currentAuthorizationEpoch(key)
    // Consume before any semantic or downstream validation. A failed attempt
    // must never leave reusable authority behind.
    const consumedEpoch = invalidateSessionAuthority(key)
    if (prepared.epoch !== previousEpoch || prepared.workspace !== workspace) {
      throw new Error('context receipt is stale; call lattice_refresh_context')
    }
    if (resolved.legacyIntakeMode === undefined) {
      if (control === undefined || control.phase !== 'lattice') throw new Error('the session is not an active lattice task')
      if (control.reframePending && !allowReframePending) {
        throw new Error('a material change requires lattice_reframe before another lattice operation')
      }
      if (!(allowReframePending && control.contract === undefined && prepared.contract === undefined)) {
        const currentContract = allowReframePending && control.reframePending && control.contract !== undefined
          ? requireContractAnchor(control.contract)
          : await verifyAnchoredContract({ workspace, sessionId: control.rootSessionId })
        if (prepared.contract === undefined
          || currentContract.id !== prepared.contract.id
          || currentContract.revision !== prepared.contract.revision
          || currentContract.documentDigest !== prepared.contract.documentDigest) {
          throw new Error('the accepted execution contract changed after authorization; call lattice_reframe')
        }
      }
    }
    const state = readLatticeStateSync(workspace)
    if (state === undefined) throw new Error('no lattice exists for this workspace')
    assertExpectedRevision(state, expectedRevision)
    if (prepared.receipt.revision !== state.revision) throw new Error('context receipt is stale; call lattice_refresh_context')
    // Every structural action reads the full contract again. A matching token
    // alone is intentionally insufficient after a document changes on disk.
    const context = await readProjectContext(workspace, state.project.contextPaths, resolved.maxContextBytes)
    if (context.digest !== prepared.receipt.digest && !(allowReframePending && control?.reframePending === true)) {
      throw new Error('project context changed after the receipt; call lattice_refresh_context and reconsider the mutation')
    }
    const currentView = structuralPlanView(state, prepared.view.focus?.nodeId)
    if (currentView.revision !== prepared.view.revision || currentView.digest !== prepared.view.digest) {
      throw new Error('the plan changed after it was rendered; call lattice_refresh_context')
    }
    if (observedNodeId !== undefined && prepared.view.focus?.nodeId !== observedNodeId) {
      throw new Error(`plan node ${JSON.stringify(observedNodeId)} was not the focused current neighborhood; call lattice_refresh_context with planNodeId`)
    }
    if (currentAuthorizationEpoch(key) !== consumedEpoch) {
      throw new Error('execution authority changed during validation; call lattice_refresh_context')
    }
    store.invalidate(workspace)
    return { state, consumedEpoch }
  }

  function assertConsumedEpochCurrent(agent: Agent, consumedEpoch: number): void {
    assertAuthorizationEpochCurrent(
      sessionKey(agent),
      consumedEpoch,
      'execution authority changed before the protected plan mutation committed; refresh context and retry',
    )
  }

  function assertAuthorizationEpochCurrent(key: string, expectedEpoch: number, message: string): void {
    if (currentAuthorizationEpoch(key) !== expectedEpoch) throw new Error(message)
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
    if (basis.externalPreconditionDigest !== summarizeExternalPreconditions(basis.externalPreconditions)) {
      return `plan-lattice blocks ${toolName}: the external precondition set is internally inconsistent; rebuild the authorization basis`
    }
    if (requireNodePlan) {
      try {
        const current = readLatticeStateSync(workspace)
        if (current === undefined || basis.planRevision !== current.revision) {
          return `plan-lattice blocks ${toolName}: the current plan revision changed; call lattice_refresh_context`
        }
        const currentPlan = nodeExecutionPlan(current, basis.nodePlan!.nodeId)
        if (currentPlan.digest !== basis.nodePlan!.digest || currentPlan.revision !== basis.nodePlan!.revision) {
          return `plan-lattice blocks ${toolName}: the root-to-leaf execution plan changed; call lattice_refresh_context`
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown plan verification failure'
        return `plan-lattice blocks ${toolName}: cannot verify the current plan (${reason}); call lattice_refresh_context`
      }
    }
    try {
      const changed = verifyMutationTargetsSync(workspace, basis.targets, basis.targetDigest)
      if (changed !== undefined) {
        return `plan-lattice blocks ${toolName}: ${changed}; rebuild the complete mutation basis with lattice_refresh_context`
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown target verification failure'
      return `plan-lattice blocks ${toolName}: cannot verify the complete target set (${reason}); call lattice_refresh_context again`
    }
    // A generic guarded tool is an external side effect. It is authorized only
    // through a host adapter that can compare the exact action arguments and
    // current external state. File target declarations cannot prove this.
    if (target.kind === 'unknown') {
      if (resolved.legacyIntakeMode !== undefined && toolName !== 'bash') return undefined
      const adapter = resolved.preconditionAdapters.get(toolName)
      if (adapter === undefined) {
        return `plan-lattice blocks ${toolName}: no host precondition adapter can prove the external side effect; use a dedicated observable tool or configure an adapter`
      }
      try {
        const normalizedArguments = externalActionIdentity(adapter, args)
        const argumentsDigest = digestArguments(normalizedArguments)
        const actionCandidates = basis.externalPreconditions.filter(precondition => (
          precondition.scope !== true
          && precondition.toolName === toolName
          && precondition.argumentsDigest === argumentsDigest
        ))
        if (actionCandidates.length > 1) {
          return `plan-lattice blocks ${toolName}: the exact protected action has ambiguous host preconditions`
        }
        const expectedAction = actionCandidates[0]
        if (expectedAction !== undefined) {
          const changed = adapter.verify({
            workspace,
            resource: expectedAction.resource,
            arguments: args,
            expectedStateDigest: expectedAction.stateDigest,
          })
          return changed === undefined
            ? undefined
            : `plan-lattice blocks ${toolName}: ${changed}; rebuild the host precondition basis`
        }
        const scopeCandidates = basis.externalPreconditions.filter(precondition => (
          precondition.scope === true && precondition.toolName === toolName
        ))
        if (scopeCandidates.length !== 1 || adapter.verifyScope === undefined) {
          return `plan-lattice blocks ${toolName}: lattice_refresh_context did not bind exactly this protected action or one current host scope`
        }
        const expectedScope = scopeCandidates[0]!
        const changed = adapter.verifyScope({
          workspace,
          resource: expectedScope.resource,
          expectedStateDigest: expectedScope.stateDigest,
        })
        return changed === undefined
          ? undefined
          : `plan-lattice blocks ${toolName}: ${changed}; rebuild the host precondition basis`
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown host precondition verification failure'
        return `plan-lattice blocks ${toolName}: cannot verify host preconditions (${reason})`
      }
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
    return undefined
  }

  function prepareProtectedDispatch(
    exec: { callId: unknown; name: string; arguments: unknown; agent?: Agent },
    prepared: Omit<PreparedDispatch, 'callId' | 'sessionId' | 'toolName' | 'argumentsDigest' | 'revocation'>,
  ): string | undefined {
    if (exec.agent === undefined) return `plan-lattice blocks ${exec.name}: no owning agent can hold execution authority`
    const call = exec as object
    if (preparedDispatches.has(call)) return `plan-lattice blocks ${exec.name}: this protected call already has a prepared dispatch`
    const dispatch: PreparedDispatch = {
      ...prepared,
      callId: String(exec.callId),
      sessionId: sessionKey(exec.agent),
      toolName: exec.name,
      argumentsDigest: digestArguments(exec.arguments),
      revocation: new AbortController(),
    }
    preparedDispatches.set(call, dispatch)
    const active = activeDispatches.get(dispatch.sessionId) ?? new Set<PreparedDispatch>()
    active.add(dispatch)
    activeDispatches.set(dispatch.sessionId, active)
    activeDefinitionDispatches.add(dispatch)
    return undefined
  }

  function prepareReadDispatch(
    exec: { callId: unknown; name: string; arguments: unknown; agent?: Agent },
    binding: GuardedDefinitionBinding,
  ): string | undefined {
    if (exec.agent === undefined) return `plan-lattice blocks ${exec.name}: no owning agent can bind the guarded read call`
    const call = exec as object
    const prepared: PreparedReadDispatch = {
      callId: String(exec.callId),
      sessionId: sessionKey(exec.agent),
      toolName: exec.name,
      argumentsDigest: digestArguments(exec.arguments),
      definition: binding.definition,
      execute: binding.execute,
      revocation: new AbortController(),
    }
    preparedReadDispatches.set(call, prepared)
    activeDefinitionDispatches.add(prepared)
    return undefined
  }

  function trustedGuardedDefinition(
    exec: { name: string; agent?: Agent },
  ): GuardedDefinitionBinding | string {
    if (exec.agent === undefined) return `plan-lattice blocks ${exec.name}: no owning agent can bind a guarded tool definition`
    const visible = ctx.tools.get(exec.name, exec.agent)
    const global = ctx.tools.get(exec.name)
    if (visible === undefined) return `plan-lattice blocks ${exec.name}: the guarded tool definition is no longer visible`
    if (global === undefined || visible !== global) {
      return `plan-lattice blocks ${exec.name}: a scoped or replaced tool definition cannot inherit the trusted global guarded-tool identity`
    }
    const trusted = trustedGuardedDefinitions.get(exec.name)
    if (trusted !== undefined) {
      if (trusted.definition !== global || trusted.execute !== global.execute) {
        return `plan-lattice blocks ${exec.name}: a replacement guarded tool definition cannot inherit the process-lifetime trust anchor`
      }
      return trusted
    }
    const descriptor = Object.getOwnPropertyDescriptor(global, 'execute')
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.value !== global.execute) {
      return `plan-lattice blocks ${exec.name}: the guarded tool execute implementation cannot be identity-locked`
    }
    try {
      Object.defineProperty(global, 'execute', {
        ...descriptor,
        configurable: false,
        writable: false,
      })
    } catch {
      return `plan-lattice blocks ${exec.name}: the guarded tool execute implementation cannot be identity-locked`
    }
    const binding = { definition: global, execute: global.execute }
    trustedGuardedDefinitions.set(exec.name, binding)
    return binding
  }

  function revalidatePreparedDispatch(
    exec: { callId: unknown; name: string; arguments: unknown; agent?: Agent },
    prepared: PreparedDispatch,
  ): string | undefined {
    if (exec.agent === undefined
      || sessionKey(exec.agent) !== prepared.sessionId
      || String(exec.callId) !== prepared.callId
      || exec.name !== prepared.toolName
      || digestArguments(exec.arguments) !== prepared.argumentsDigest) {
      return `plan-lattice blocks ${prepared.toolName}: the protected call identity or arguments changed after authorization`
    }
    if (ctx.tools.get(prepared.toolName, exec.agent) !== prepared.definition
      || ctx.tools.get(prepared.toolName) !== prepared.definition
      || prepared.definition.execute !== prepared.execute) {
      return `plan-lattice blocks ${prepared.toolName}: the guarded tool implementation changed after authorization`
    }
    if (currentAuthorizationEpoch(prepared.sessionId) !== prepared.consumedEpoch) {
      return `plan-lattice blocks ${prepared.toolName}: execution authority changed between guard validation and dispatch`
    }
    const tracked = controls.get(prepared.sessionId)
    if (resolved.legacyIntakeMode === undefined && (tracked === undefined
      || tracked.phase !== prepared.phase
      || tracked.rootSessionId !== prepared.rootSessionId
      || tracked.reframePending)) {
      return `plan-lattice blocks ${prepared.toolName}: the execution contract changed between guard validation and dispatch`
    }
    if (resolved.legacyIntakeMode === undefined && tracked !== undefined) {
      const pendingReason = pendingInputGuard(exec.agent, tracked)
      if (pendingReason !== undefined) return `plan-lattice blocks ${prepared.toolName}: ${pendingReason}`
    }
    try {
      requireLiveOwnership(exec.agent, prepared.rootSessionId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown Harness ownership failure'
      return `plan-lattice blocks ${prepared.toolName}: ${reason}`
    }
    if (prepared.phase === 'contract') {
      if (tracked === undefined) return `plan-lattice blocks ${prepared.toolName}: the contract control disappeared before dispatch`
      if (tracked.contextReplacement !== undefined) {
        return `plan-lattice blocks ${prepared.toolName}: model-visible context changed between guard validation and dispatch`
      }
      try {
        const contract = readContractSync(prepared.workspace)
        const persistedAnchor = readContractAnchorSync(resolved.contractAnchorRoot, prepared.rootSessionId)
        if (contract === undefined
          || persistedAnchor === undefined
          || !contractMatchesAnchor(contract, persistedAnchor)
          || (tracked.contract !== undefined && !contractMatchesAnchor(persistedAnchor, tracked.contract))
          || prepared.basis.contract === undefined
          || persistedAnchor.id !== prepared.basis.contract.id
          || persistedAnchor.revision !== prepared.basis.contract.revision
          || persistedAnchor.documentDigest !== prepared.basis.contract.documentDigest) {
          return `plan-lattice blocks ${prepared.toolName}: the accepted contract changed between guard validation and dispatch`
        }
        return mutationBasisGuard(prepared.toolName, exec.arguments, prepared.workspace, prepared.basis, false)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown contract verification failure'
        return `plan-lattice blocks ${prepared.toolName}: cannot revalidate the accepted contract (${reason})`
      }
    }
    const lease = leases.get(prepared.sessionId)
    if (lease === undefined
      || lease.workspace !== prepared.workspace
      || lease.nodeId !== prepared.nodeId
      || lease.dirty
      || lease.contextReplacement !== undefined) {
      return `plan-lattice blocks ${prepared.toolName}: the execution lease changed between guard validation and dispatch`
    }
    try {
      const durable = executionState.verifyOwnershipSync(
        executionAuthorityWorkspace(lease.workspace),
        executionLeaseClaim(lease.durable),
      )
      if (durable.dirty
        || durable.graphRevision !== lease.revision
        || durable.rootSessionId !== prepared.rootSessionId) {
        return `plan-lattice blocks ${prepared.toolName}: durable execution ownership changed between guard validation and dispatch`
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown durable ownership failure'
      return `plan-lattice blocks ${prepared.toolName}: cannot verify durable execution ownership (${reason})`
    }
    return changedContractGuard(prepared.toolName, lease)
      ?? mutationBasisGuard(prepared.toolName, exec.arguments, prepared.workspace, prepared.basis, true)
  }

  function freezeJsonTree(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) freezeJsonTree(child)
    return Object.freeze(value)
  }

  function snapshotDispatchArguments(value: unknown, expectedDigest: string): unknown {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('tool dispatch arguments must be JSON-serializable')
    const detached: unknown = JSON.parse(serialized)
    if (digestArguments(detached) !== expectedDigest) {
      throw new Error('tool dispatch arguments changed while their immutable snapshot was created')
    }
    return freezeJsonTree(detached)
  }

  function lockDispatchIdentity(exec: object, argumentsDigest: string): Record<string, unknown> {
    const record = exec as Record<string, unknown>
    const argumentsSnapshot = snapshotDispatchArguments(record.arguments, argumentsDigest)
    for (const key of ['callId', 'rootCallId', 'token', 'name', 'arguments', 'agent', 'parent'] as const) {
      if (!(key in record)) continue
      Object.defineProperty(record, key, {
        configurable: false,
        enumerable: true,
        value: key === 'arguments' ? argumentsSnapshot : record[key],
        writable: false,
      })
    }
    return record
  }

  function lockPreparedDispatch(
    exec: object,
    prepared: Pick<PreparedDispatch | PreparedReadDispatch, 'argumentsDigest' | 'revocation'>,
  ): void {
    const record = lockDispatchIdentity(exec, prepared.argumentsDigest)
    let downstreamSignal = record.signal as AbortSignal
    let combinedSignal = AbortSignal.any([downstreamSignal, prepared.revocation.signal])
    Object.defineProperty(record, 'signal', {
      configurable: false,
      enumerable: true,
      get() {
        return combinedSignal
      },
      set(value) {
        if (!(value instanceof AbortSignal)) throw new TypeError('tool dispatch signal must be an AbortSignal')
        downstreamSignal = value
        combinedSignal = AbortSignal.any([downstreamSignal, prepared.revocation.signal])
      },
    })
  }

  async function recordMechanicalExecution(
    exec: { callId: unknown; name: string; arguments: unknown; agent?: Agent },
    prepared: PreparedDispatch,
    result: Readonly<ToolExecutionResult>,
  ): Promise<void> {
    if (prepared.phase !== 'lattice' || exec.agent === undefined) return
    const key = sessionKey(exec.agent)
    const lease = leases.get(key)
    if (lease === undefined
      || lease.workspace !== prepared.workspace
      || lease.nodeId !== prepared.nodeId
      || !lease.dirty) {
      throw new Error(`plan-lattice cannot settle ${exec.name}: the dirty execution lease changed before its result`)
    }
    await awaitReleaseMarkerForSettlement(lease)
    const pending = lease.durable.pendingExecution
    const basisDigest = digestArguments(prepared.basis)
    if (pending === undefined
      || pending.callId !== String(exec.callId)
      || pending.toolName !== exec.name
      || pending.argumentsDigest !== prepared.argumentsDigest
      || pending.basisDigest !== basisDigest) {
      throw new Error(`plan-lattice cannot settle ${exec.name}: the persistent pending execution identity changed`)
    }
    const recordedAt = Date.now()
    const dispatchResultDigest = digestArguments({
      isError: result.isError,
      content: result.content,
      ...(result.isError ? { error: result.error } : {}),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })
    const receipt: MechanicalExecutionReceipt = {
      attemptId: pending.attemptId,
      nodeId: lease.nodeId,
      callId: String(exec.callId),
      toolName: exec.name,
      argumentsDigest: prepared.argumentsDigest,
      basisDigest,
      outcome: result.isError ? 'error' : 'success',
      resultDigest: dispatchResultDigest,
      ...(lease.releaseWhenClean || lease.durable.releaseWhenClean === true
        ? { releaseWhenClean: true as const }
        : {}),
      recordedAt,
    }
    const committed = await store.mutate(lease.workspace, 'mechanical-execution-receipt', state => {
      if (state.revision !== lease.revision) {
        throw new Error(`cannot settle execution against stale lattice revision ${lease.revision}; current ${state.revision}`)
      }
      const node = findNode(state, lease.nodeId)
      assertMutable(node)
      if (!isLeaf(state, node.id)) throw new Error('a mechanical execution receipt requires the checked-out node to remain a leaf')
      state.executionReceipts ??= {}
      if (state.executionReceipts[receipt.attemptId] !== undefined) {
        throw new Error(`duplicate mechanical execution receipt ${JSON.stringify(receipt.attemptId)}`)
      }
      state.executionReceipts[receipt.attemptId] = receipt
      state.revision += 1
      return {
        value: { revision: state.revision },
        delta: { revision: state.revision, upserts: [], executionReceipts: [receipt] },
      }
    }, () => {
      executionState.verifyOwnershipSync(
        executionAuthorityWorkspace(lease.workspace),
        executionLeaseClaim(lease.durable),
      )
    })
    await awaitReleaseMarkerForSettlement(lease)
    const durable = await executionState.settleExecution(
      executionAuthorityWorkspace(lease.workspace),
      executionLeaseClaim(lease.durable),
      receipt.attemptId,
      {
        graphRevision: committed.revision,
        release: lease.releaseWhenClean || lease.durable.releaseWhenClean === true,
      },
    )
    lease.revision = committed.revision
    if (durable.lease === null) {
      localExecutionOrigins.delete(lease)
      lease.dirty = false
      lease.mutationBasis = undefined
      if (leases.get(key) === lease) leases.delete(key)
      return
    }
    lease.durable = durable.lease
    localExecutionOrigins.delete(lease)
    lease.dirty = false
    lease.mutationBasis = undefined
    if (lease.releaseWhenClean === true) await convergeRequestedLeaseRelease(key, lease)
  }

  function dispatchPipelineErrorResult(error: unknown): ToolExecutionResult {
    let message = '<unprintable thrown value>'
    try {
      message = error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : String(error)
    } catch {
      // Keep normalization total at the same boundary as the Harness registry.
    }
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
      error: { message },
    }
  }

  ctx.tools.guard(exec => {
    const control = exec.agent === undefined ? undefined : controls.get(sessionKey(exec.agent))
    if (exec.agent !== undefined
      && control?.phase !== 'bypass'
      && nativePlanModeOwnsCurrentBatch(exec.agent)
      && (LATTICE_TOOL_NAMES.includes(exec.name as typeof LATTICE_TOOL_NAMES[number])
        || resolved.guardedTools.has(exec.name))) {
      return `plan-lattice blocks ${exec.name}: DSH native plan mode owns this turn; finish planning through exit_plan_mode before requesting executable authority`
    }
    if (!resolved.guardedTools.has(exec.name)) return undefined
    const tracked = control
    if (tracked?.phase === 'bypass') return undefined
    if (exec.agent === undefined) return `plan-lattice blocks ${exec.name}: no owning agent can hold a lattice lease`
    const definition = trustedGuardedDefinition(exec)
    if (typeof definition === 'string') return definition
    const toolTarget = mutationTargetFromTool(exec.name, exec.arguments)
    if (toolTarget.kind === 'read') return prepareReadDispatch(exec, definition)
    try {
      requireLiveOwnership(exec.agent, tracked?.rootSessionId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown Harness ownership failure'
      return `plan-lattice blocks ${exec.name}: ${reason}`
    }
    if (tracked?.phase === 'probe') {
      return `plan-lattice blocks ${exec.name}: routing is unresolved; read repository evidence and call lattice_route before writing`
    }
    if (resolved.legacyIntakeMode === undefined && tracked?.initialContractPending) {
      return tracked.phase === 'lattice' && tracked.clarificationPolicy === 'never'
        ? `plan-lattice blocks ${exec.name}: call lattice_open with an empty object to bind the first human request and controller-owned minimal graph before inspection or planning`
        : `plan-lattice blocks ${exec.name}: call lattice_intake once to bind the first human request; dedicated read, glob, and grep tools remain available before intake`
    }
    if (resolved.legacyIntakeMode === undefined && tracked !== undefined) {
      const pendingReason = pendingInputGuard(exec.agent, tracked)
      if (pendingReason !== undefined) return `plan-lattice blocks ${exec.name}: ${pendingReason}`
    }
    if (tracked?.phase === 'contract') {
      const key = sessionKey(exec.agent)
      const basis = tracked.mutationBasis
      const basisEpoch = currentAuthorizationEpoch(key)
      const consumedEpoch = invalidateSessionAuthority(key)
      if (tracked.reframePending) return `plan-lattice blocks ${exec.name}: a material change requires lattice_reframe`
      if (tracked.contextReplacement !== undefined) {
        return `plan-lattice blocks ${exec.name}: ${tracked.contextReplacement.type} at session event ${tracked.contextReplacement.seq} requires lattice_refresh_context before writing`
      }
      if (basis === undefined || basis.epoch !== basisEpoch) return `plan-lattice blocks ${exec.name}: call lattice_refresh_context${toolTarget.kind === 'mutation' ? ' with targetPaths' : ''} before this protected action`
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
        if (basis.contract === undefined
          || persistedAnchor.id !== basis.contract.id
          || persistedAnchor.revision !== basis.contract.revision
          || persistedAnchor.documentDigest !== basis.contract.documentDigest) {
          return `plan-lattice blocks ${exec.name}: the accepted contract no longer matches the prepared authorization`
        }
        const reason = mutationBasisGuard(exec.name, exec.arguments, cwd, basis, false)
        return reason ?? prepareProtectedDispatch(exec, {
          workspace: cwd,
          consumedEpoch,
          phase: 'contract',
          rootSessionId: tracked.rootSessionId,
          basis,
          definition: definition.definition,
          execute: definition.execute,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown contract verification failure'
        return `plan-lattice blocks ${exec.name}: ${reason}; call lattice_reframe`
      }
    }
    if (tracked?.reframePending) return `plan-lattice blocks ${exec.name}: a material change requires lattice_reframe`
    const key = sessionKey(exec.agent)
    const lease = leases.get(key)
    if (lease === undefined) return `plan-lattice blocks ${exec.name}: check out one current leaf first`
    const basis = lease.mutationBasis
    const basisEpoch = currentAuthorizationEpoch(key)
    const consumedEpoch = invalidateSessionAuthority(key)
    if (lease.contextReplacement !== undefined) {
      return `plan-lattice blocks ${exec.name}: ${lease.contextReplacement.type} at session event ${lease.contextReplacement.seq} changed model-visible history; call lattice_refresh_context before another guarded action`
    }
    if (lease.dirty) return `plan-lattice blocks ${exec.name}: a prior execution is pending or indeterminate; recover its exact mechanical receipt before continuing`
    if (basis === undefined || basis.epoch !== basisEpoch) return `plan-lattice blocks ${exec.name}: call lattice_refresh_context${toolTarget.kind === 'mutation' ? ' with targetPaths' : ''} before this protected action`
    const mutationReason = changedContractGuard(exec.name, lease)
      ?? mutationBasisGuard(exec.name, exec.arguments, lease.workspace, basis, true)
    return mutationReason ?? prepareProtectedDispatch(exec, {
      workspace: lease.workspace,
      consumedEpoch,
      phase: 'lattice',
      rootSessionId: tracked?.rootSessionId ?? key,
      basis,
      definition: definition.definition,
      execute: definition.execute,
      nodeId: lease.nodeId,
    })
  })

  ctx.on('tools/execute', async (exec, next) => {
    const control = exec.agent === undefined ? undefined : controls.get(sessionKey(exec.agent))
    if (control?.phase === 'bypass') return next()
    if (!resolved.guardedTools.has(exec.name)) {
      lockDispatchIdentity(exec as object, digestArguments(exec.arguments))
      return next()
    }
    if (exec.agent === undefined) throw new Error(`plan-lattice blocks ${exec.name}: guarded dispatch has no owning agent`)
    const preparedRead = preparedReadDispatches.get(exec as object)
    if (preparedRead !== undefined) {
      if (String(exec.callId) !== preparedRead.callId
        || sessionKey(exec.agent) !== preparedRead.sessionId
        || exec.name !== preparedRead.toolName
        || digestArguments(exec.arguments) !== preparedRead.argumentsDigest
        || ctx.tools.get(exec.name, exec.agent) !== preparedRead.definition
        || ctx.tools.get(exec.name) !== preparedRead.definition
        || preparedRead.definition.execute !== preparedRead.execute) {
        throw new Error(`plan-lattice blocks ${preparedRead.toolName}: guarded read identity, arguments, or read-only classification changed after the guard`)
      }
      if (mutationTargetFromTool(exec.name, exec.arguments).kind !== 'read') {
        requireLiveOwnership(exec.agent, controls.get(preparedRead.sessionId)?.rootSessionId)
      }
      lockPreparedDispatch(exec as object, preparedRead)
      return next()
    }
    const prepared = preparedDispatches.get(exec as object)
    if (prepared === undefined) {
      throw new Error(`plan-lattice blocks ${exec.name}: protected dispatch has no consumed authorization`)
    }
    const reason = revalidatePreparedDispatch(exec, prepared)
    if (reason !== undefined) throw new Error(reason)
    lockPreparedDispatch(exec as object, prepared)
    if (prepared.phase === 'lattice') {
      const key = sessionKey(exec.agent)
      const lease = leases.get(key)
      if (lease === undefined || lease.nodeId !== prepared.nodeId || lease.workspace !== prepared.workspace) {
        throw new Error(`plan-lattice blocks ${exec.name}: the execution lease disappeared before durable dispatch`)
      }
      durableExecutionBegins.set(key, lease)
      try {
        const durable = await executionState.beginExecution(
          executionAuthorityWorkspace(lease.workspace),
          executionLeaseClaim(lease.durable),
          {
            callId: String(exec.callId),
            toolName: exec.name,
            argumentsDigest: prepared.argumentsDigest,
            basisDigest: digestArguments(prepared.basis),
          },
        )
        lease.durable = durable
        const pending = durable.pendingExecution
        if (!durable.dirty || pending === undefined) {
          throw new Error(`plan-lattice cannot enter ${exec.name}: durable execution did not return an exact pending attempt`)
        }
        localExecutionOrigins.set(lease, { attemptId: pending.attemptId, token: Symbol(pending.attemptId) })
        lease.dirty = true
        lease.mutationBasis = undefined
        if (lease.releaseWhenClean) await scheduleLeaseRelease(key, lease)
      } catch (error) {
        if (lease.dirty) {
          const message = error instanceof Error ? error.message : String(error)
          const result: ToolExecutionResult = {
            content: [{ type: 'text', text: `Error: plan-lattice durable admission failed before tool-body entry: ${message}` }],
            isError: true,
            error: {
              message,
              info: {
                name: error instanceof Error ? error.name : 'Error',
                code: TOOL_ABORTED_BEFORE_DISPATCH,
              },
            },
          }
          await recordMechanicalExecution(exec, prepared, result)
          return result
        } else if (lease.releaseWhenClean && leases.get(key) === lease) {
          await scheduleLeaseRelease(key, lease)
        }
        throw error
      } finally {
        if (durableExecutionBegins.get(key) === lease) durableExecutionBegins.delete(key)
      }
      if (prepared.revocation.signal.aborted) {
        const result: ToolExecutionResult = {
          content: [{ type: 'text', text: 'Error: plan-lattice execution authority was revoked before tool-body entry' }],
          isError: true,
          error: {
            message: 'plan-lattice execution authority was revoked before tool-body entry',
            info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
          },
        }
        await recordMechanicalExecution(exec, prepared, result)
        return result
      }
    }
    let result: Readonly<ToolExecutionResult>
    try {
      result = await next()
    } catch (error) {
      await recordMechanicalExecution(exec, prepared, dispatchPipelineErrorResult(error))
      throw error
    }
    await recordMechanicalExecution(exec, prepared, result)
    return result
  })

  ctx.on('tools/result', (exec, _result) => {
    const preparedRead = preparedReadDispatches.get(exec as object)
    if (preparedRead !== undefined) activeDefinitionDispatches.delete(preparedRead)
    preparedReadDispatches.delete(exec as object)
    const prepared = preparedDispatches.get(exec as object)
    if (prepared !== undefined) {
      activeDefinitionDispatches.delete(prepared)
      const active = activeDispatches.get(prepared.sessionId)
      active?.delete(prepared)
      if (active?.size === 0) activeDispatches.delete(prepared.sessionId)
    }
    preparedDispatches.delete(exec as object)
    if (exec.agent === undefined || !resolved.guardedTools.has(exec.name)) return
    const tracked = controls.get(sessionKey(exec.agent))
    if (tracked !== undefined && tracked.phase !== 'lattice') tracked.mutationBasis = undefined
  })

  ctx.on('tools/change', () => {
    toolRegistryGeneration += 1
    const registry = ctx.get('agents')
    for (const dispatch of activeDefinitionDispatches) {
      const agent = registry?.get(dispatch.sessionId as never)
      const definitionChanged = agent === undefined
        || ctx.tools.get(dispatch.toolName, agent) !== dispatch.definition
        || ctx.tools.get(dispatch.toolName) !== dispatch.definition
        || dispatch.definition.execute !== dispatch.execute
      if (definitionChanged) {
        dispatch.revocation.abort(new Error('plan-lattice guarded tool identity changed before tool-body entry'))
      }
    }
  })

  // Any announced compaction/prune or actual surface replacement invalidates
  // the same authorization epoch. This covers summary compaction, model-free
  // tool-result pruning, and future replacement producers without naming each
  // backend.
  ctx.on('session/event', (session, event) => {
    const surfaceOp = 'surfaceOp' in event ? event.surfaceOp : undefined
    const replacement = event.type === 'compaction/summary'
      || event.type === 'compaction/prune'
      || (typeof surfaceOp === 'object' && surfaceOp !== null && surfaceOp.op === 'replace')
    const key = String(session.id)
    if (replacement) {
      invalidateSessionAuthority(key, {
        contextReplacement: { seq: event.seq, type: event.type },
      })
      return
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    const control = controls.get(key)
    if (control === undefined || (control.phase !== 'contract' && control.phase !== 'lattice')) return
    const messageId = String(event.data.id)
    const delegatedOperational = delegatedOperationalMessages.get(key)
    if (delegatedOperational?.delete(messageId) === true) {
      if (delegatedOperational.size === 0) delegatedOperationalMessages.delete(key)
      return
    }
    if (control.initialContractPending) return
    const undurable = undurableUserInputs.get(control.rootSessionId)
    const staged = undurable?.get(messageId)
    if (staged !== undefined) {
      if (staged.digest !== userInputDigest(event.data)) {
        requireRootReframe(control.rootSessionId, 'the durable human input differs from its inbox payload')
      } else {
        undurable!.delete(messageId)
        if (undurable!.size === 0) undurableUserInputs.delete(control.rootSessionId)
      }
    }
    invalidateRootAuthority(control.rootSessionId, true)
    const text = extractMessageText(event.data)
    const hasNonText = event.data.content.some(block => block.type !== 'text')
    if (key !== control.rootSessionId) {
      queueDelegatedInputFence(
        control,
        key,
        event.data,
        'human input delivered to a delegated session requires explicit root-contract revision',
      )
    }
    if (key !== control.rootSessionId || hasNonText || text === '' || isMaterialChange(text)) {
      const criticalGaps = text === '' ? [] : routeRequest(text, resolved).criticalGaps
      requireRootReframe(
        control.rootSessionId,
        key !== control.rootSessionId
          ? 'human input delivered to a delegated session requires explicit root-contract revision'
          : hasNonText || text === ''
          ? 'non-text user context requires explicit contract revision'
          : 'material user change requires contract revision',
        criticalGaps,
      )
    }
  })

  function updateRestriction(agent: Agent, control: AgentControl): void {
    control.restriction?.()
    const available = LATTICE_TOOL_NAMES.filter(name => !(
      resolved.legacyIntakeMode === 'off' && (name === 'lattice_intake' || name === 'lattice_reframe')
    ))
    const allowed = allowedControlTools(agent, control)
    const deny = available.filter(name => !allowed.has(name))
    control.restriction = agent.ctx.tools.restrict({ deny })
  }

  function updateRootRestrictions(rootSessionId: string): void {
    const registry = ctx.get('agents')
    if (registry === undefined) return
    for (const [key, control] of controls) {
      if (control.rootSessionId !== rootSessionId) continue
      const agent = registry.get(key as never)
      if (agent !== undefined) updateRestriction(agent, control)
    }
  }

  function transitionControl(agent: Agent, assessment: RouteAssessment): AgentControl {
    const current = controls.get(sessionKey(agent)) ?? fallbackControl(agent)
    current.phase = assessment.phase
    current.clarificationPolicy = assessment.clarificationPolicy
    current.reasons = [...assessment.reasons]
    current.productDefinitionGap = assessment.productDefinitionGap
    current.outcomeCritical = assessment.outcomeCritical
    current.criticalGaps = [...assessment.criticalGaps]
    if (assessment.phase !== 'probe') current.routeBasisText = undefined
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
    if (sessionKey(agent) !== pending.sessionId) {
      throw new Error('only the root agent session that started intake may commit its pending contract; delegated agents must return answers to the parent')
    }
    if (currentAuthorizationEpoch(pending.sessionId) !== pending.authorizationEpoch) {
      throw new Error('pending intake crossed an authorization invalidation; start intake or reframe again')
    }
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
    if ((undurableUserInputs.get(pending.sessionId)?.size ?? 0) > 0) {
      throw new Error('new user input has not reached the durable session log; restart intake or reframe after it is recorded')
    }
    const reviewedInputs = pending.kind === 'reframe' && pending.previousContract !== undefined
      ? pendingUserInputs(agent.session.events, pending.previousContract)
      : allHumanUserInputs(agent.session.events)
    const authoritySources = mergeAuthoritySources(
      pending.previousContract?.authoritySources ?? [],
      authoritySourcesFrom(reviewedInputs),
    )
    const reviewBoundary = humanInputBoundary(agent.session.events).throughSeq
    let reframeCurrent: LatticeState | undefined
    let reframeFence: ReframeFence | undefined
    if (pending.kind === 'reframe' && pending.controlLevel === 'lattice') {
      if (pending.latticeRevision === undefined) throw new Error('lattice reframe is missing its source revision')
      reframeCurrent = await store.peek(pending.workspace)
      if (reframeCurrent === undefined) throw new Error('the lattice disappeared while reframe was pending')
      assertExpectedRevision(reframeCurrent, pending.latticeRevision)
      reframeFence = await acquireReframeFence(
        pending.workspace,
        pending.sessionId,
        reframeCurrent,
        pending.previousContract,
      )
    }

    let persisted: Awaited<ReturnType<typeof persistConfirmedContract>>
    let latticeReceipt: LatticeReceipt | undefined
    let documents: Awaited<ReturnType<typeof readProjectContext>>['documents'] | undefined
    let project: LatticeState['project'] | undefined
    let updatedLattice: LatticeState | undefined
    try {
      persisted = await persistConfirmedContract({
        workspace: pending.workspace,
        sessionId: pending.sessionId,
        controlLevel: pending.controlLevel,
        clarificationPolicy: pending.clarificationPolicy,
        framing: pending.framing,
        authoritySources,
        questions: pending.questions,
        answers: pending.answers,
        answerBindings: bindings,
        ...(pending.previousContract === undefined ? {} : {
          revision: pending.previousContract.revision + 1,
          createdAt: pending.previousContract.createdAt,
        }),
      }, {
        sessionId: pending.sessionId,
        epoch: pending.authorizationEpoch,
      })
      assertAuthorizationEpochCurrent(
        pending.sessionId,
        pending.authorizationEpoch,
        'execution authority changed while the pending contract was being committed; start intake or reframe again',
      )

      if (pending.kind === 'reframe' && pending.controlLevel === 'lattice') {
        const current = reframeCurrent!
        const contextPaths = validateContextPaths([
          CONTRACT_DOCUMENT_PATH,
          ...current.project.contextPaths.filter(path => path !== CONTRACT_DOCUMENT_PATH && path !== INTAKE_DOCUMENT_PATH),
        ])
        const context = await readProjectContext(pending.workspace, contextPaths, resolved.maxContextBytes)
        const result = await store.mutate(pending.workspace, 'reframe-v2', state => {
          assertAuthorizationEpochCurrent(
            pending.sessionId,
            pending.authorizationEpoch,
            'execution authority changed before the reframed graph committed; start lattice_reframe again',
          )
          assertExpectedRevision(state, pending.latticeRevision!)
          const now = Date.now()
          state.project = {
            ...state.project,
            objective: persisted.record.framing.desiredOutcome,
            contextPaths,
            contractRevision: persisted.record.revision,
            contractDigest: persisted.record.documentDigest,
            updatedAt: now,
          }
          const touched = Object.values(state.nodes).filter(node => node.status !== 'archived')
          for (const node of touched) {
            if (node.status === 'complete') node.status = 'pending'
            node.reconciliationRequired = true
            node.updatedAt = now
          }
          state.revision += 1
          return { value: { revision: state.revision, project: { ...state.project } }, delta: delta(state, touched, true) }
        }, () => {
          assertAuthorizationEpochCurrent(
            pending.sessionId,
            pending.authorizationEpoch,
            'execution authority changed at the reframed graph commit point; start lattice_reframe again',
          )
          executionState.verifyOwnershipSync(
            reframeFence!.authorityWorkspace,
            executionLeaseClaim(reframeFence!.durable),
          )
        })
        assertAuthorizationEpochCurrent(
          pending.sessionId,
          pending.authorizationEpoch,
          'execution authority changed while the reframed graph was being committed; start lattice_reframe again',
        )
        await releaseReframeFence(reframeFence!)
        reframeFence = undefined
        clearWorkspace(pending.workspace)
        updatedLattice = await store.peek(pending.workspace)
        if (updatedLattice === undefined) throw new Error('the lattice disappeared after reframe')
        project = result.project
      }
    } catch (error) {
      if (reframeFence !== undefined) await releaseReframeFence(reframeFence).catch(() => {})
      throw error
    }

    await awaitDelegatedInputFences(pending.sessionId)
    await delegatedInputFences.clearAfterContractAdoption(delegatedInputContractBasis(persisted.record))

    for (const control of controls.values()) {
      if (control.rootSessionId !== pending.sessionId) continue
      control.contract = persisted.record
      control.initialContractPending = false
      control.reframePending = false
      control.criticalGaps = []
      control.contextReplacement = undefined
      control.mutationBasis = undefined
    }
    appendInputReviewMarker(
      agent,
      persisted.record,
      'contract-reframed',
      pending.kind === 'reframe'
        ? `The accepted contract was revised from reviewed execution-stage input: ${pending.framing.requestSummary}`
        : `The initial accepted contract incorporates the root request: ${pending.framing.requestSummary}`,
      reviewedInputs,
      reviewBoundary,
    )
    invalidateRootAuthority(pending.sessionId, true)
    for (const control of controls.values()) {
      if (control.rootSessionId !== pending.sessionId) continue
      control.contract = persisted.record
      control.initialContractPending = false
      control.reframePending = false
      control.criticalGaps = []
      control.contextReplacement = undefined
    }
    updateRootRestrictions(pending.sessionId)
    if (updatedLattice !== undefined) {
      const issued = await issueCurrentReceipt(
        agent,
        pending.workspace,
        updatedLattice,
        [],
        undefined,
        [],
        currentAuthorizationEpoch(pending.sessionId),
      )
      latticeReceipt = issued.receipt
      documents = issued.documents
    }
    const callerControl = controls.get(sessionKey(agent))
    if (callerControl?.rootSessionId === pending.sessionId) {
      callerControl.visibleDocuments ??= new Map()
      callerControl.visibleDocuments.set(CONTRACT_DOCUMENT_PATH, persisted.record.documentDigest)
      for (const source of persisted.record.authoritySources ?? []) {
        callerControl.visibleDocuments.set(authorityDocumentPath(source), source.digest)
      }
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
    description: 'Inspect exact repository files, then resolve an uncertain Plan Lattice route from the one-use evidence receipt. This is the only Lattice tool exposed during probe mode.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['inspect', 'resolve'] },
      evidencePaths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files whose complete current contents can change the route. Required for inspect.' },
      probeReceiptId: { type: 'string', description: 'One-use receipt returned by inspect. Required for resolve.' },
      recommendedLevel: { type: 'string', enum: ['bypass', 'contract', 'lattice'] },
      estimatedSteps: { type: 'integer', description: 'Evidence-based estimate of atomic execution steps.' },
      executionSpan: { type: 'integer', description: 'Risk score from 0 to 10 for execution horizon and cross-boundary work.' },
      productDefinitionGap: { type: 'integer', description: 'Risk score from 0 to 10 for missing user, outcome, scope, truth-source, authority, or acceptance facts.' },
      outcomeCritical: { type: 'boolean', description: 'Whether a missing fact can alter P0 outcome, authority, data truth, or acceptance.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Concrete observations grounded in the inspected file contents.' },
      rationale: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderRoute },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('lattice_route requires an owning agent')
      const key = sessionKey(exec.agent)
      const control = controls.get(key)
      if (control === undefined || control.phase !== 'probe') throw new Error('lattice_route is available only while the task route is unresolved')
      if (args.operation === 'inspect') {
        const workspace = await workspaceFor(exec.agent)
        const paths = validateContextPaths(args.evidencePaths ?? [])
        const context = await readProjectContext(workspace, paths, resolved.maxContextBytes)
        const evidenceAssessment = routeRequest([
          control.routeBasisText,
          context.documents.map(document => `${document.path}\n${document.content}`).join('\n\n'),
        ].filter((value): value is string => typeof value === 'string' && value.trim() !== '').join('\n\n'), resolved)
        const prepared: PreparedRouteProbe = {
          id: `route-probe-${randomUUID()}`,
          workspace,
          epoch: currentAuthorizationEpoch(key),
          digest: context.digest,
          paths,
          evidenceAssessment,
        }
        preparedRouteProbes.set(key, prepared)
        return json({
          message: 'Read the complete route-sensitive repository evidence. Resolve the route with this one-use receipt; any input or file change requires another inspect.',
          probeReceipt: { id: prepared.id, digest: prepared.digest, paths: prepared.paths },
          documents: context.documents,
        })
      }
      if (args.operation !== 'resolve') throw new Error('lattice_route operation must be inspect or resolve')
      const prepared = preparedRouteProbes.get(key)
      preparedRouteProbes.delete(key)
      if (prepared === undefined || args.probeReceiptId !== prepared.id) {
        throw new Error('route evidence receipt is missing, consumed, or belongs to another session; inspect repository evidence again')
      }
      if (prepared.epoch !== currentAuthorizationEpoch(key)) {
        throw new Error('route evidence became stale after an authority change; inspect repository evidence again')
      }
      const currentEvidence = await readProjectContext(prepared.workspace, prepared.paths, resolved.maxContextBytes)
      if (currentEvidence.digest !== prepared.digest) {
        throw new Error('route-sensitive repository evidence changed; inspect it again before resolving the route')
      }
      const estimatedSteps = positiveInteger(args.estimatedSteps, 1, 'estimatedSteps')
      const executionSpan = Number(args.executionSpan)
      const productDefinitionGap = Number(args.productDefinitionGap)
      if (!Number.isSafeInteger(executionSpan) || executionSpan < 0 || executionSpan > 10) throw new Error('executionSpan must be an integer from 0 to 10')
      if (!Number.isSafeInteger(productDefinitionGap) || productDefinitionGap < 0 || productDefinitionGap > 10) throw new Error('productDefinitionGap must be an integer from 0 to 10')
      const evidence = textList(args.evidence ?? [], 'evidence')
      if (evidence.length === 0) throw new Error('lattice_route requires repository evidence')
      if (typeof args.outcomeCritical !== 'boolean') throw new Error('outcomeCritical must be a boolean')
      if (args.recommendedLevel !== 'bypass' && args.recommendedLevel !== 'contract' && args.recommendedLevel !== 'lattice') {
        throw new Error('recommendedLevel must be bypass, contract, or lattice')
      }
      let phase = args.recommendedLevel as RoutePhase
      const phaseRank = { bypass: 0, probe: 0, contract: 1, lattice: 2 } as const
      const evidenceMinimum = prepared.evidenceAssessment.phase === 'contract'
        || prepared.evidenceAssessment.phase === 'lattice'
        ? prepared.evidenceAssessment.phase
        : 'bypass'
      if (phaseRank[phase] < phaseRank[evidenceMinimum]) phase = evidenceMinimum
      if (estimatedSteps >= resolved.longTaskThreshold && resolved.controlCeiling === 'lattice') phase = 'lattice'
      const effectiveExecutionSpan = Math.max(executionSpan, prepared.evidenceAssessment.executionSpan)
      const effectiveProductDefinitionGap = Math.max(productDefinitionGap, prepared.evidenceAssessment.productDefinitionGap)
      const effectiveOutcomeCritical = args.outcomeCritical || prepared.evidenceAssessment.outcomeCritical
      if (phase === 'bypass' && (effectiveOutcomeCritical || effectiveExecutionSpan > 2 || effectiveProductDefinitionGap > 1 || estimatedSteps >= resolved.longTaskThreshold)) {
        throw new Error('outcome-critical, ambiguous, or long work cannot be bypassed')
      }
      if (phase === 'lattice' && resolved.controlCeiling === 'contract') phase = 'contract'
      const assessment: RouteAssessment = {
        phase,
        confidence: 'high',
        executionSpan: effectiveExecutionSpan,
        productDefinitionGap: effectiveProductDefinitionGap,
        outcomeCritical: effectiveOutcomeCritical,
        criticalGaps: [...prepared.evidenceAssessment.criticalGaps],
        clarificationPolicy: control.clarificationPolicy,
        reasons: [
          assertText(args.rationale ?? '', 'rationale'),
          ...evidence,
          ...prepared.evidenceAssessment.reasons,
          `repository evidence ${prepared.digest}`,
        ],
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
      description: 'Bind immutable human Session authority to a compact semantic execution contract. Under clarificationPolicy=never, submit one concise call with no questions; omitted semantic fields receive neutral, reversible defaults.',
      parameters: {
        requestSummary: { type: 'string', required: true, description: `One-sentence semantic index, at most ${COMPACT_CONTRACT_SCALAR_LIMIT} characters. Never copy the full request; the controller binds it from Session authority.` },
        estimatedSteps: { type: 'integer', required: true, description: 'Honest estimate of atomic execution steps.' },
        systemBoundary: { type: 'string', description: 'Concise system scope and exclusions. Omit when immutable human authority is already exact.' },
        timeHorizon: { type: 'string', description: 'Concise decision and execution horizon. Omit when the human request defines stages.' },
        desiredOutcome: { type: 'string', description: 'Observable result, independent of implementation form. Defaults to requestSummary.' },
        confirmedFacts: { type: 'array', description: `At most ${COMPACT_CONTRACT_LIST_LIMIT} decisive facts; omit details already present in human authority.`, items: { type: 'string' } },
        decisions: { type: 'array', description: 'Only explicit user or product decisions; never inferred preferences.', items: { type: 'string' } },
        invariants: { type: 'array', description: 'The few stable goals and constraints that control decomposition.', items: { type: 'string' } },
        changeables: { type: 'array', description: 'Implementation forms that may adapt. Optional.', items: { type: 'string' } },
        forces: { type: 'array', description: 'Directional changes that affect execution. Optional.', items: { type: 'string' } },
        keyVariables: { type: 'array', description: 'Smallest causal variable set that determines success. Optional.', items: { type: 'string' } },
        assumptions: { type: 'array', description: 'Only model assumptions that must stay explicit and reversible. A neutral default is supplied for never policy.', items: { type: 'string' } },
        unknowns: { type: 'array', description: 'Known non-critical missing facts. Omit when none remain.', items: { type: 'string' } },
        readiness: { type: 'string', enum: ['ready', 'conditional'], description: 'Inferred from unknowns when omitted.' },
        readinessRationale: { type: 'string', description: 'Concise readiness reason. A neutral authority-based reason is supplied when omitted.' },
        questions: {
          type: 'array',
          description: 'Zero to five outcome-critical questions. Omit under clarificationPolicy=never.',
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
          const questions = normalizeQuestions(args.questions ?? [])
          let framing: IntakeFraming
          if (resolved.legacyIntakeMode === undefined) {
            const control = controlFor(exec.agent)
            framing = compactV2Framing(args, control.clarificationPolicy)
            if (control.phase !== 'contract' && control.phase !== 'lattice') {
              throw new Error(`lattice_intake is unavailable while the task route is ${control.phase}`)
            }
            if (isDelegatedSession(exec.agent)) {
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
            if (control.clarificationPolicy === 'critical') {
              const uncovered = findUncoveredRequiredCriticalGaps(control.criticalGaps, questions)
              if (uncovered.length > 0) {
                throw new Error(`outcome-critical gaps require focused clarification for: ${uncovered.join(', ')}`)
              }
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
                authorizationEpoch: currentAuthorizationEpoch(control.rootSessionId),
              })
              return json({
                message: 'Clarification answers were collected but no execution contract has been persisted. Bind each answer into the final contract with lattice_commit_intake.',
                pendingIntakeId,
                answers,
              })
            }
            const pending: PendingIntake = {
              id: randomUUID(),
              workspace,
              sessionId: control.rootSessionId,
              kind: 'intake',
              controlLevel: control.phase,
              clarificationPolicy: control.clarificationPolicy,
              framing,
              questions: [],
              answers: [],
              authorizationEpoch: currentAuthorizationEpoch(control.rootSessionId),
            }
            const persisted = await finalizePendingContract(pending, [], exec.agent)
            return json({
              message: `Committed a v2 ${control.phase} execution contract without a clarification round.`,
              receipt: persisted.contractReceipt,
              contract: persisted.contract,
            })
          }
          const unknowns = textList(args.unknowns ?? [], 'unknowns')
          framing = {
            requestSummary: assertText(args.requestSummary, 'requestSummary'),
            estimatedSteps: positiveInteger(args.estimatedSteps, 1, 'estimatedSteps'),
            systemBoundary: assertText(args.systemBoundary ?? '', 'systemBoundary'),
            timeHorizon: assertText(args.timeHorizon ?? '', 'timeHorizon'),
            desiredOutcome: assertText(args.desiredOutcome ?? '', 'desiredOutcome'),
            confirmedFacts: textList(args.confirmedFacts ?? [], 'confirmedFacts'),
            decisions: textList(args.decisions ?? [], 'decisions'),
            invariants: textList(args.invariants ?? [], 'invariants'),
            changeables: textList(args.changeables ?? [], 'changeables'),
            forces: textList(args.forces ?? [], 'forces'),
            keyVariables: textList(args.keyVariables ?? [], 'keyVariables'),
            assumptions: textList(args.assumptions ?? [], 'assumptions'),
            unknowns,
            readiness: intakeReadiness(args.readiness, unknowns),
            readinessRationale: assertText(args.readinessRationale ?? '', 'readinessRationale'),
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
      const questionById = new Map(pending.questions.map(question => [question.id, question]))
      const answerById = new Map(pending.answers.map(answer => [answer.id, answer]))
      const bindings = args.answerBindings.map((binding, index): AnswerBinding => {
        const questionId = assertText(binding.questionId, `answerBindings[${index}].questionId`)
        const question = questionById.get(questionId)
        const answer = answerById.get(questionId)
        if (question === undefined || answer === undefined) {
          throw new Error('answer binding refers to an unknown clarification question')
        }
        return {
          questionId,
          target: binding.target as AnswerBindingTarget,
          statement: canonicalAnswerBindingStatement(question, answer),
        }
      })
      if (pending.clarificationPolicy === 'critical') {
        const unanswered = pending.answers.filter(clarificationAnswerIsNonAnswer)
        if (unanswered.length > 0) {
          throw new Error(`outcome-critical clarification ${unanswered.map(answer => JSON.stringify(answer.id)).join(', ')} was not answered; it cannot be relabeled as a fact or decision`)
        }
      }
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
      if (pending.clarificationPolicy === 'critical' && bindings.some(binding => binding.target === 'unknown')) {
        throw new Error('an outcome-critical clarification cannot be rebound as an unresolved unknown; clarify it before execution')
      }
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
    description: `Create the workspace-local evidence-gated work graph. Under question-free lattice control, call with no arguments before planning: the controller binds durable human Session authority and creates a minimal refinable root and leaf. The ${resolved.longTaskThreshold}-step threshold is one routing signal, not a substitute for risk assessment.`,
    parameters: {
      title: { type: 'string', description: 'Optional short project title. Omit with objective and initialPlan for controller-owned bootstrap.' },
      objective: { type: 'string', description: 'Optional durable outcome. Omit with title and initialPlan to bind immutable human authority directly.' },
      estimatedSteps: { type: 'integer', description: 'Honest estimate of atomic execution steps. In v2 this defaults to the anchored contract value; legacy intake still requires it.' },
      intakeReceiptId: { type: 'string', description: 'Optional exact v2 receipt assertion. The current anchored root receipt is inferred when omitted.' },
      contextPaths: {
        type: 'array',
        description: 'Existing workspace-relative background, product, or architecture documents required for future plan changes. Omit when immutable Session authority is sufficient; the durable contract is included automatically.',
        items: { type: 'string' },
      },
      initialPlan: {
        type: 'array',
        description: 'Optional topologically ordered initial work tree. Each parentKey must name an earlier item. The complete tree is committed with the project in this one call.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true, description: 'Short call-local key used by parentKey and selectedLeafKey.' },
            parentKey: { type: 'string', description: 'Key of an earlier initialPlan item. Omit for a root.' },
            title: { type: 'string', required: true, description: 'Concrete node outcome.' },
            acceptanceCriteria: { type: 'string', required: true, description: 'Observable proof required before this node completes.' },
          },
        },
      },
      selectedLeafKey: {
        type: 'string',
        description: 'Optional key of the first outcome or leaf to execute. A parent resolves to its first deterministic descendant leaf. The returned mapping gives the durable leaf ID for checkout.',
      },
    },
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('lattice_open requires an owning agent')
      const workspace = await workspaceFor(exec.agent)
      const key = sessionKey(exec.agent)
      const control = controls.get(key)
      const controllerBootstrap = resolved.legacyIntakeMode === undefined
        && args.title === undefined
        && args.objective === undefined
        && args.initialPlan === undefined
        && args.selectedLeafKey === undefined
      if (resolved.legacyIntakeMode !== undefined && (args.title === undefined || args.objective === undefined)) {
        throw new Error('legacy lattice_open requires title and objective; migrate to the v0.4 contract protocol for parameterless bootstrap')
      }
      requireLiveOwnership(exec.agent, control?.rootSessionId)
      if (resolved.legacyIntakeMode === undefined && control !== undefined) {
        const pendingReason = pendingInputGuard(exec.agent, control)
        if (pendingReason !== undefined && !control.reframePending) {
          throw new Error(`${pendingReason}; classify it with lattice_review_input before rebuilding execution authority`)
        }
      }
      let startEpoch = currentAuthorizationEpoch(key)
      if (intakeInProgress.has(workspace)) {
        throw new Error('lattice_open waits until the active intake or reframe finishes')
      }
      let contextPaths = args.contextPaths ?? []
      let acceptedContract: ContractRecord | undefined
      if (resolved.legacyIntakeMode === undefined) {
        if (!controls.has(key)) throw new Error('lattice_open requires a Harness-managed agent session')
        const control = controlFor(exec.agent)
        if (control.phase !== 'lattice') throw new Error(`lattice_open is available only at lattice control, not ${control.phase}`)
        if (control.reframePending) throw new Error('a material change requires lattice_reframe before lattice_open')
        if (control.initialContractPending && control.clarificationPolicy === 'never') {
          if (isDelegatedSession(exec.agent)) {
            throw new Error('a delegated agent cannot establish the root execution contract; return the plan to the parent agent')
          }
          intakeInProgress.add(workspace)
          try {
            const inferredSteps = positiveInteger(
              args.estimatedSteps,
              Math.max(resolved.longTaskThreshold, (args.initialPlan ?? []).length),
              'estimatedSteps',
            )
            const pending: PendingIntake = {
              id: randomUUID(),
              workspace,
              sessionId: control.rootSessionId,
              kind: 'intake',
              controlLevel: 'lattice',
              clarificationPolicy: 'never',
              framing: compactV2Framing({
                requestSummary: args.title,
                estimatedSteps: inferredSteps,
                desiredOutcome: args.objective,
              }, 'never'),
              questions: [],
              answers: [],
              authorizationEpoch: startEpoch,
            }
            const persisted = await finalizePendingContract(pending, [], exec.agent)
            acceptedContract = persisted.contractRecord
            startEpoch = currentAuthorizationEpoch(key)
          } finally {
            intakeInProgress.delete(workspace)
          }
        }
        const contract = await verifyAnchoredContract({
          workspace,
          sessionId: control.rootSessionId,
          ...(args.intakeReceiptId === undefined ? {} : { receiptId: assertText(args.intakeReceiptId, 'intakeReceiptId') }),
        })
        const estimatedSteps = positiveInteger(args.estimatedSteps, contract.estimatedSteps, 'estimatedSteps')
        if (contract.controlLevel !== 'lattice') throw new Error('the execution contract does not authorize full lattice control')
        if (contract.estimatedSteps !== estimatedSteps) throw new Error('estimatedSteps changed after contract commitment; call lattice_reframe')
        control.contract = contract
        acceptedContract = contract
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
      contextPaths = validateContextPaths(contextPaths)
      const context = await readProjectContext(workspace, contextPaths, resolved.maxContextBytes)
      const now = Date.now()
      const projectTitle = args.title === undefined
        ? controllerBootstrap
          ? 'Current human request'
          : acceptedContract?.framing.requestSummary ?? 'Current human request'
        : assertText(args.title, 'title')
      const projectObjective = args.objective === undefined
        ? acceptedContract?.framing.desiredOutcome ?? 'Complete the current human-authored request under its immutable Session authority.'
        : assertText(args.objective, 'objective')
      const state: LatticeState = {
        schemaVersion: LATTICE_SCHEMA_VERSION,
        revision: 1,
        project: {
          title: projectTitle,
          objective: projectObjective,
          contextPaths,
          ...(acceptedContract === undefined ? {} : {
            contractRevision: acceptedContract.revision,
            contractDigest: acceptedContract.documentDigest,
          }),
          createdAt: now,
          updatedAt: now,
        },
        nodes: {},
      }
      const initialPlanInputs = controllerBootstrap
        ? controllerBootstrapPlan()
        : (args.initialPlan ?? []) as InitialPlanNodeInput[]
      const initialPlan = buildInitialPlan(
        state,
        initialPlanInputs,
        controllerBootstrap ? CONTROLLER_BOOTSTRAP_LEAF_KEY : args.selectedLeafKey,
        resolved,
      )
      await store.create(workspace, state, undefined, () => {
        assertAuthorizationEpochCurrent(
          key,
          startEpoch,
          'execution authority changed before the lattice graph committed; restart lattice_open from the current contract',
        )
        const currentContext = readProjectContextSync(workspace, contextPaths, resolved.maxContextBytes)
        if (currentContext.digest !== context.digest) {
          throw new Error('authoritative project context changed while the initial plan was being built; reread it and restart lattice_open')
        }
        if (acceptedContract !== undefined) {
          const currentContract = readContractSync(workspace)
          const anchor = readContractAnchorSync(resolved.contractAnchorRoot, acceptedContract.sessionId)
          if (currentContract === undefined
            || anchor === undefined
            || !contractMatchesAnchor(currentContract, acceptedContract)
            || !contractMatchesAnchor(anchor, acceptedContract)) {
            throw new Error('the anchored execution contract changed while the initial plan was being built; restart lattice_open')
          }
        }
      })
      assertAuthorizationEpochCurrent(
        key,
        startEpoch,
        'execution authority changed while the lattice graph was being committed; reread the current contract before planning',
      )
      const receipt = issueReceipt(workspace, state, context)
      const planContext = structuralPlanView(state, initialPlan.selectedLeaf?.node.id)
      sessionWorkspaces.set(key, workspace)
      preparedAuthorizations.set(key, {
        workspace,
        receipt,
        epoch: startEpoch,
        ...(acceptedContract === undefined ? {} : { contract: contractBasis(acceptedContract) }),
        view: planContext,
      })
      const projected = projectDocuments(exec.agent, context.documents)
      return json({
        message: controllerBootstrap
          ? `Opened lattice revision ${state.revision} from immutable human authority with a controller-owned outcome root and focused executable leaf. Inspect repository evidence now; refine only the next leaf when needed instead of designing the complete tree up front.`
          : initialPlan.nodes.length === 0
          ? `Opened lattice revision ${state.revision}. Context is complete and current; create no more than ${resolved.topLevelLimit} root nodes before executing.`
          : `Opened lattice revision ${state.revision} with ${initialPlan.nodes.length} initial plan nodes in one atomic graph creation. The selected leaf is focused in this receipt and may be checked out directly; refresh exact mutation targets after checkout. Do not recreate these nodes.`,
        ...(controllerBootstrap ? { controllerBootstrap: true } : {}),
        project: state.project,
        receipt,
        documents: projected.documents,
        documentReferences: projected.documentReferences,
        initialPlan,
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
      const receiptNodeId = args.nodeId ?? active?.nodeId
      const recentExecutions = Object.values(state.executionReceipts ?? {})
        .filter(receipt => receiptNodeId === undefined || receipt.nodeId === receiptNodeId)
        .sort((left, right) => right.recordedAt - left.recordedAt)
        .slice(0, 3)
      const liveNodes = status.counts.pending + status.counts.active + status.counts.blocked + status.counts.complete
      return json({
        message: `Lattice revision ${state.revision}: ${liveNodes} live nodes; returning ${status.frontier.nodes.length} of ${status.frontier.total} actionable frontier nodes.`,
        status,
        recentExecutions,
        ...(active === undefined ? {} : {
          lease: {
            nodeId: active.nodeId,
            dirty: active.dirty,
            contextRefreshRequired: active.contextReplacement !== undefined,
          },
        }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_review_input',
    description: 'Read the complete accepted contract together with every unadopted human message. Returns a one-use review receipt; it never restores execution authority by itself.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('lattice_review_input requires the owning root agent')
      const agent = exec.agent
      const key = sessionKey(agent)
      const control = controls.get(key)
      if (control === undefined || (control.phase !== 'contract' && control.phase !== 'lattice')) {
        throw new Error('lattice_review_input requires an active v2 execution contract')
      }
      if (control.rootSessionId !== key || isDelegatedSession(agent)) {
        throw new Error('only the root agent may adopt new human input; delegated agents must return the gap to their parent')
      }
      if (resolved.legacyIntakeMode !== undefined) throw new Error('durable input review is a v0.4 control feature')
      const undurable = undurableUserInputs.get(key)
      if ((undurable?.size ?? 0) > 0) {
        throw new Error('new user input has not reached the durable session log; wait for the current turn before reviewing it')
      }

      invalidateRootAuthority(key, true)
      const startEpoch = currentAuthorizationEpoch(key)
      const workspace = await workspaceFor(agent)
      const contract = await verifyAnchoredContract({ workspace, sessionId: key })
      const context = await readProjectContext(workspace, [CONTRACT_DOCUMENT_PATH], resolved.maxContextBytes)
      const pending = pendingUserInputs(agent.session.events, contract)
      if (pending.length === 0) throw new Error('there is no unreviewed durable human input')
      const digest = pendingUserInputDigest(pending)
      if (currentAuthorizationEpoch(key) !== startEpoch
        || pendingUserInputDigest(pendingUserInputs(agent.session.events, contract)) !== digest) {
        throw new Error('human input changed during contract review; call lattice_review_input again')
      }
      const review: PreparedInputReview = {
        id: `input-review-${randomUUID()}`,
        rootSessionId: key,
        epoch: startEpoch,
        contract: contractBasis(contract),
        pendingDigest: digest,
        throughSeq: pending.at(-1)!.seq,
        messageIds: pending.map(input => input.messageId),
      }
      preparedInputReviews.set(key, review)
      control.contract = contract
      return json({
        message: `Read the complete accepted contract and ${pending.length} exact unadopted human input${pending.length === 1 ? '' : 's'}. Compare outcome, boundary, invariants, truth sources, authority, and acceptance before committing this review.`,
        reviewReceipt: {
          id: review.id,
          contractRevision: review.contract.revision,
          contractDigest: review.contract.documentDigest,
          pendingDigest: review.pendingDigest,
          throughSeq: review.throughSeq,
        },
        documents: context.documents,
        pendingInputs: pending,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_commit_input_review',
    description: 'Durably bind the exact reviewed human-message sequence to either the unchanged accepted contract or a required reframe. The review receipt is one-use and fails closed if another message arrived.',
    parameters: {
      reviewReceiptId: { type: 'string', required: true },
      disposition: { type: 'string', required: true, enum: ['contract-unchanged', 'contract-changed'] },
      rationale: { type: 'string', required: true, description: 'Substantive comparison against outcome, boundary, invariants, truth sources, authority, and acceptance.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('lattice_commit_input_review requires the owning root agent')
      const agent = exec.agent
      const key = sessionKey(agent)
      const prepared = preparedInputReviews.get(key)
      preparedInputReviews.delete(key)
      if (prepared === undefined || prepared.id !== args.reviewReceiptId) {
        throw new Error('input-review receipt is missing, consumed, or belongs to another session; call lattice_review_input again')
      }
      const control = controls.get(key)
      if (control === undefined || control.rootSessionId !== key || isDelegatedSession(agent)) {
        throw new Error('only the owning root agent may commit human-input adoption')
      }
      if (currentAuthorizationEpoch(key) !== prepared.epoch) {
        throw new Error('execution authority or human input changed after review; call lattice_review_input again')
      }
      if ((undurableUserInputs.get(key)?.size ?? 0) > 0) {
        throw new Error('another user input is awaiting durable append; call lattice_review_input again after it is recorded')
      }
      const workspace = await workspaceFor(agent)
      const contract = await verifyAnchoredContract({ workspace, sessionId: key })
      if (contract.id !== prepared.contract.id
        || contract.revision !== prepared.contract.revision
        || contract.documentDigest !== prepared.contract.documentDigest) {
        throw new Error('the accepted contract changed after input review; call lattice_review_input again')
      }
      const pending = pendingUserInputs(agent.session.events, contract)
      const currentDigest = pendingUserInputDigest(pending)
      if (currentDigest !== prepared.pendingDigest
        || pending.at(-1)?.seq !== prepared.throughSeq
        || JSON.stringify(pending.map(input => input.messageId)) !== JSON.stringify(prepared.messageIds)) {
        throw new Error('the durable human-message sequence changed after review; call lattice_review_input again')
      }
      const rationale = substantiveRationale(args.rationale)
      if (args.disposition === 'contract-unchanged' && control.reframePending) {
        throw new Error('the current task is already fenced for a material change; revise the contract with lattice_reframe')
      }
      appendInputReviewMarker(agent, contract, args.disposition, rationale, pending, prepared.throughSeq)
      invalidateRootAuthority(key, true)
      if (args.disposition === 'contract-changed') {
        requireRootReframe(key, `reviewed human input changes the accepted contract: ${rationale}`)
        return json({
          message: 'Durably classified the reviewed input as contract-changing. Guarded work remains blocked until lattice_reframe commits the revised contract.',
          disposition: args.disposition,
          reviewedMessageIds: prepared.messageIds,
        })
      }
      for (const tracked of controls.values()) {
        if (tracked.rootSessionId !== key) continue
        tracked.contract = contract
        tracked.reasons = ['latest durable human input was reviewed against the unchanged contract', ...tracked.reasons]
      }
      return json({
        message: 'Durably adopted the reviewed input without changing the contract. Execution authority remains consumed; call lattice_refresh_context before protected work.',
        disposition: args.disposition,
        reviewedMessageIds: prepared.messageIds,
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
      externalActions: {
        type: 'array',
        description: 'Exact non-filesystem guarded actions whose current host state must be captured through a configured precondition adapter.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            toolName: { type: 'string', required: true },
            resource: { type: 'string', required: true },
            arguments: { type: 'json', required: true },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(args, exec) {
      const workspace = await workspaceFor(exec.agent)
      if (exec.agent === undefined) throw new Error('lattice_refresh_context requires an owning agent')
      const key = sessionKey(exec.agent)
      const control = controls.get(key)
      requireLiveOwnership(exec.agent, control?.rootSessionId)
      if (resolved.legacyIntakeMode === undefined && control !== undefined) {
        const pendingReason = pendingInputGuard(exec.agent, control)
        if (pendingReason !== undefined && !control.reframePending) {
          throw new Error(`${pendingReason}; classify it with lattice_review_input before rebuilding execution authority`)
        }
      }
      const startEpoch = currentAuthorizationEpoch(key)
      const targetPaths = args.targetPaths ?? []
      const externalActions = (args.externalActions ?? []) as ExternalActionRequest[]
      store.invalidate(workspace)
      const state = await store.peek(workspace)
      if (state === undefined) {
        if (control === undefined || control.phase !== 'contract') throw new Error('no lattice exists for this workspace')
        const contract = await verifyAnchoredContract({ workspace, sessionId: control.rootSessionId })
        const context = await readProjectContext(workspace, [CONTRACT_DOCUMENT_PATH], resolved.maxContextBytes)
        const targetContext = await readMutationTargets(workspace, targetPaths, resolved.maxContextBytes)
        const externalPreconditions = await snapshotExternalPreconditions(workspace, externalActions, exec.agent)
        if (currentAuthorizationEpoch(key) !== startEpoch) {
          throw new Error('execution authority changed during the authoritative context read; retry lattice_refresh_context')
        }
        sessionWorkspaces.set(key, workspace)
        control.contract = contract
        control.contextReplacement = undefined
        control.mutationBasis = {
          authorizationId: `authorization-${randomUUID()}`,
          epoch: currentAuthorizationEpoch(key),
          contract: contractBasis(contract),
          targets: targetContext.targets,
          targetDigest: targetContext.digest,
          externalPreconditions,
          externalPreconditionDigest: summarizeExternalPreconditions(externalPreconditions),
        }
        const projected = projectDocuments(exec.agent, [
          ...context.documents,
          ...authorityDocuments(exec.agent, control, contract),
        ])
        return json({
          message: `Verified the complete v2 execution contract at revision ${contract.revision}${projected.documents.length === 0 ? ' from its unchanged rendered digest' : ' by rendering its current full text'}${targetContext.targets.length === 0 ? '' : ` and read ${targetContext.targets.length} exact mutation target${targetContext.targets.length === 1 ? '' : 's'}`}.`,
          receipt: { id: contract.id, revision: contract.revision, digest: contract.documentDigest },
          documents: projected.documents,
          documentReferences: projected.documentReferences,
          targets: targetContext.targets,
          externalPreconditions,
        })
      }
      const issued = await issueCurrentReceipt(exec.agent, workspace, state, targetPaths, args.planNodeId, externalActions, startEpoch)
      const lease = leases.get(key)
      if (lease?.workspace === workspace) {
        lease.contextReplacement = undefined
        lease.contextDigest = issued.receipt.digest
        lease.contextPaths = state.project.contextPaths
        lease.mutationBasis = issued.mutationBasis
      }
      if (control !== undefined) control.contextReplacement = undefined
      const projected = projectDocuments(exec.agent, issued.documents)
      return json({
        message: `Verified ${issued.documents.length} complete contract document${issued.documents.length === 1 ? '' : 's'} for lattice revision ${state.revision}; rendered ${projected.documents.length} changed or context-replaced document${projected.documents.length === 1 ? '' : 's'} and referenced ${projected.documentReferences.length} unchanged document${projected.documentReferences.length === 1 ? '' : 's'}${issued.mutationBasis.nodePlan === undefined ? '' : ', together with the current execution lineage'}${issued.mutationBasis.targets.length === 0 ? '' : ` and ${issued.mutationBasis.targets.length} exact mutation target${issued.mutationBasis.targets.length === 1 ? '' : 's'}`}.`,
        receipt: issued.receipt,
        documents: projected.documents,
        documentReferences: projected.documentReferences,
        planContext: issued.planContext,
        ...(issued.mutationBasis.nodePlan === undefined ? {} : { executionPlan: issued.mutationBasis.nodePlan }),
        targets: issued.mutationBasis.targets,
        externalPreconditions: issued.mutationBasis.externalPreconditions,
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
      const consumed = await consumeFreshAuthorization(agent, workspace, args.receiptId, args.expectedRevision)
      const current = consumed.state
      await ensureNoActiveLease(workspace)
      const contract = acceptedNodeContract(agent)
      const additions = validateContextPaths(args.addPaths)
      if (additions.some(path => current.project.contextPaths.includes(path))) {
        throw new Error('addPaths may contain only documents that are not already in the context contract')
      }
      const contextPaths = validateContextPaths([...current.project.contextPaths, ...additions])
      // Read every added document before changing the durable contract. A
      // missing, unsafe, or oversized addition therefore cannot leave a
      // partial state that the model has never seen.
      const context = await readProjectContext(workspace, contextPaths, resolved.maxContextBytes)
      const result = await mutateWithStructuralFence(workspace, sessionKey(agent), current, contract, 'adopt-context', state => {
        assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
        assertExpectedRevision(state, args.expectedRevision)
        const now = Date.now()
        state.project = { ...state.project, contextPaths, updatedAt: now }
        state.revision += 1
        return {
          value: { revision: state.revision, project: { ...state.project } },
          delta: delta(state, [], true),
        }
      }, () => assertConsumedEpochCurrent(agent, consumed.consumedEpoch))
      clearWorkspace(workspace)
      const updated = await store.peek(workspace)
      if (updated === undefined) throw new Error('the lattice disappeared after context adoption')
      const issued = await issueCurrentReceipt(agent, workspace, updated)
      return json({
        message: `Adopted ${additions.length} newly required context document${additions.length === 1 ? '' : 's'} at lattice revision ${result.revision}. Read the complete returned contract before the next plan change.`,
        project: result.project,
        receipt: issued.receipt,
        documents: issued.documents,
        planContext: issued.planContext,
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
        systemBoundary: { type: 'string', description: 'Updated scope only when changed; otherwise a neutral authority reference is used.' },
        timeHorizon: { type: 'string', description: 'Updated horizon only when changed.' },
        desiredOutcome: { type: 'string', description: 'Updated observable outcome. Defaults to requestSummary.' },
        confirmedFacts: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        invariants: { type: 'array', items: { type: 'string' } },
        changeables: { type: 'array', items: { type: 'string' } },
        forces: { type: 'array', items: { type: 'string' } },
        keyVariables: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        unknowns: { type: 'array', items: { type: 'string' } },
        readiness: { type: 'string', enum: ['ready', 'conditional'] },
        readinessRationale: { type: 'string' },
        questions: {
          type: 'array',
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
            if (isDelegatedSession(agent)) {
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
              const current = await consumeFreshAuthorization(
                agent,
                workspace,
                assertText(args.receiptId, 'receiptId'),
                args.expectedRevision,
                undefined,
                true,
              )
              latticeRevision = current.state.revision
              await ensureNoActiveLease(workspace)
            }
            const framing = compactV2Framing(args, control.clarificationPolicy)
            const questions = normalizeQuestions(args.questions ?? [])
            if (control.clarificationPolicy === 'never' && questions.length > 0) {
              throw new Error('clarificationPolicy never forbids reframe questions; record reversible assumptions')
            }
            if (control.clarificationPolicy === 'always' && questions.length === 0) {
              throw new Error('clarificationPolicy always requires at least one reframe question')
            }
            if (control.clarificationPolicy === 'critical') {
              const uncovered = findUncoveredRequiredCriticalGaps(control.criticalGaps, questions)
              if (uncovered.length > 0) {
                throw new Error(`outcome-critical reframe gaps require focused clarification for: ${uncovered.join(', ')}`)
              }
            }
            if (control.clarificationPolicy === 'never' && framing.assumptions.length === 0) {
              throw new Error('question-free reframe requires at least one explicit, reversible assumption')
            }
            invalidateRootAuthority(control.rootSessionId, true)
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
              authorizationEpoch: currentAuthorizationEpoch(control.rootSessionId),
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
          const consumed = await consumeFreshAuthorization(agent, workspace, legacyReceiptId, legacyExpectedRevision, undefined, true)
          const current = consumed.state
          const legacyEpoch = consumed.consumedEpoch
          await ensureNoActiveLease(workspace)
          const unknowns = textList(args.unknowns ?? [], 'unknowns')
          const framing: IntakeFraming = {
            requestSummary: assertText(args.requestSummary, 'requestSummary'),
            estimatedSteps: positiveInteger(args.estimatedSteps, 1, 'estimatedSteps'),
            systemBoundary: assertText(args.systemBoundary ?? '', 'systemBoundary'),
            timeHorizon: assertText(args.timeHorizon ?? '', 'timeHorizon'),
            desiredOutcome: assertText(args.desiredOutcome ?? '', 'desiredOutcome'),
            confirmedFacts: textList(args.confirmedFacts ?? [], 'confirmedFacts'),
            decisions: textList(args.decisions ?? [], 'decisions'),
            invariants: textList(args.invariants ?? [], 'invariants'),
            changeables: textList(args.changeables ?? [], 'changeables'),
            forces: textList(args.forces ?? [], 'forces'),
            keyVariables: textList(args.keyVariables ?? [], 'keyVariables'),
            assumptions: textList(args.assumptions ?? [], 'assumptions'),
            unknowns,
            readiness: intakeReadiness(args.readiness, unknowns),
            readinessRationale: assertText(args.readinessRationale ?? '', 'readinessRationale'),
          }
          const intake = await conductIntake(agent, exec.signal, framing, normalizeQuestions(args.questions ?? []))
          // A human answer can take minutes. Any lifecycle or context event in
          // that interval invalidates the consumed authorization epoch.
          if (currentAuthorizationEpoch(sessionKey(agent)) !== legacyEpoch) {
            throw new Error('execution authority changed while legacy reframe was awaiting input; refresh and start again')
          }
          const latest = await store.peek(workspace)
          if (latest === undefined) throw new Error('the lattice disappeared while legacy reframe was awaiting input')
          assertExpectedRevision(latest, legacyExpectedRevision)
          await readProjectContext(workspace, current.project.contextPaths, resolved.maxContextBytes)
          await ensureNoActiveLease(workspace)
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
          await readProjectContext(workspace, contextPaths, resolved.maxContextBytes)
          const result = await mutateWithStructuralFence(workspace, sessionKey(agent), latest, undefined, 'reframe', state => {
            assertExpectedRevision(state, legacyExpectedRevision)
            const now = Date.now()
            state.project = {
              ...state.project,
              objective: framing.desiredOutcome,
              contextPaths,
              updatedAt: now,
            }
            const touched = Object.values(state.nodes).filter(node => node.status !== 'archived')
            for (const node of touched) {
              if (node.status === 'complete') node.status = 'pending'
              node.reconciliationRequired = true
              node.updatedAt = now
            }
            state.revision += 1
            return {
              value: { revision: state.revision, project: { ...state.project } },
              delta: delta(state, touched, true),
            }
          }, () => assertConsumedEpochCurrent(agent, legacyEpoch))
          clearWorkspace(workspace)
          const updated = await store.peek(workspace)
          if (updated === undefined) throw new Error('the lattice disappeared after legacy reframe')
          const issued = await issueCurrentReceipt(agent, workspace, updated)
          return json({
            message: `Reframed the execution contract at lattice revision ${result.revision}. Reconcile every unfinished node against the returned contract before checkout.`,
            project: result.project,
            intakeReceipt: persisted.receipt,
            receipt: issued.receipt,
            documents: issued.documents,
            planContext: issued.planContext,
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
      const consumed = await consumeFreshAuthorization(agent, workspace, args.receiptId, args.expectedRevision, args.parentId)
      await ensureNoActiveLease(workspace)
      const contract = acceptedNodeContract(agent)
      const result = await mutateWithStructuralFence(workspace, sessionKey(agent), consumed.state, contract, 'add', state => {
        assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
        assertExpectedRevision(state, args.expectedRevision)
        if (args.parentId !== undefined) {
          const parent = findNode(state, args.parentId)
          assertMutable(parent)
          assertNodeReconciled(parent, contract)
        }
        assertBranchingCapacity(state, args.parentId, 1, resolved.topLevelLimit, resolved.nestedLimit)
        const node = createNode({
          parentId: args.parentId,
          title: args.title,
          acceptanceCriteria: args.acceptanceCriteria,
          now: Date.now(),
          contractRevision: contract?.revision,
          contractDigest: contract?.documentDigest,
        })
        state.nodes[node.id] = node
        state.revision += 1
        state.project.updatedAt = Date.now()
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      }, () => assertConsumedEpochCurrent(agent, consumed.consumedEpoch))
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
      const consumed = await consumeFreshAuthorization(agent, workspace, args.receiptId, args.expectedRevision, args.nodeId)
      await ensureNoActiveLease(workspace)
      const contract = acceptedNodeContract(agent)
      if (args.children.length < 2) throw new Error('lattice_split requires at least two children')
      const result = await mutateWithStructuralFence(workspace, sessionKey(agent), consumed.state, contract, 'split', state => {
        assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
        assertExpectedRevision(state, args.expectedRevision)
        const parent = findNode(state, args.nodeId)
        assertMutable(parent)
        assertNodeReconciled(parent, contract)
        if (!isLeaf(state, parent.id)) throw new Error('only a leaf can be split')
        assertBranchingCapacity(state, parent.id, args.children.length, resolved.topLevelLimit, resolved.nestedLimit)
        const now = Date.now()
        parent.status = 'active'
        parent.updatedAt = now
        const children = args.children.map(child => createNode({
          parentId: parent.id,
          title: child.title,
          acceptanceCriteria: child.acceptanceCriteria,
          now,
          contractRevision: contract?.revision,
          contractDigest: contract?.documentDigest,
        }))
        for (const child of children) state.nodes[child.id] = child
        state.revision += 1
        state.project.updatedAt = now
        return { value: { children, revision: state.revision }, delta: delta(state, [parent, ...children], true) }
      }, () => assertConsumedEpochCurrent(agent, consumed.consumedEpoch))
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
      const consumed = await consumeFreshAuthorization(agent, workspace, args.receiptId, args.expectedRevision, args.nodeId)
      await ensureNoActiveLease(workspace)
      const contract = acceptedNodeContract(agent)
      if (args.title === undefined && args.acceptanceCriteria === undefined && args.blockedReason === undefined) {
        throw new Error('lattice_update requires title, acceptanceCriteria, or blockedReason')
      }
      const result = await mutateWithStructuralFence(workspace, sessionKey(agent), consumed.state, contract, 'update', state => {
        assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, args.nodeId)
        assertMutable(node)
        if (args.title !== undefined) node.title = assertText(args.title, 'title')
        if (args.acceptanceCriteria !== undefined) node.acceptanceCriteria = assertText(args.acceptanceCriteria, 'acceptanceCriteria')
        if (args.blockedReason !== undefined) {
          node.blockedReason = assertText(args.blockedReason, 'blockedReason')
          node.status = 'blocked'
        }
        if (contract !== undefined) {
          node.contractRevision = contract.revision
          node.contractDigest = contract.documentDigest
        }
        delete node.reconciliationRequired
        node.updatedAt = Date.now()
        state.revision += 1
        state.project.updatedAt = node.updatedAt
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      }, () => assertConsumedEpochCurrent(agent, consumed.consumedEpoch))
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
      const consumed = await consumeFreshAuthorization(agent, workspace, args.receiptId, args.expectedRevision, args.nodeId)
      await ensureNoActiveLease(workspace)
      const result = await mutateWithStructuralFence(workspace, sessionKey(agent), consumed.state, acceptedNodeContract(agent), 'archive', state => {
        assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
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
      }, () => assertConsumedEpochCurrent(agent, consumed.consumedEpoch))
      clearWorkspace(workspace)
      return json({
        message: `Archived node ${args.nodeId} at lattice revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_checkout',
    description: 'Acquire the sole execution lease for one current leaf. Each guarded result receives an automatic mechanical receipt; semantic verification and leaf completion remain explicit checkpoints.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Pending or active leaf to execute.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      const prepared = preparedAuthorizations.get(sessionKey(agent))
      const consumed = await consumeFreshAuthorization(agent, workspace, args.receiptId, args.expectedRevision, args.nodeId)
      const state = consumed.state
      const contract = acceptedNodeContract(agent)
      if (prepared === undefined) throw new Error('context receipt is missing; call lattice_refresh_context')
      await ensureNoActiveLease(workspace)
      const authorityWorkspace = executionAuthorityWorkspace(workspace)
      const executionSnapshot = await executionState.read(authorityWorkspace)
      const durable = await executionState.checkout(authorityWorkspace, {
        ownerSessionId: sessionKey(agent),
        rootSessionId: controls.get(sessionKey(agent))?.rootSessionId ?? sessionKey(agent),
        nodeId: args.nodeId,
        graphRevision: args.expectedRevision + 1,
        contractRevision: contract?.revision ?? 1,
        contractDigest: contract?.documentDigest ?? prepared.receipt.digest,
        expectedGeneration: executionSnapshot.generation,
      })
      let result: { node: LatticeNode; revision: number }
      try {
        result = await store.mutate(workspace, 'checkout', state => {
          assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
          assertExpectedRevision(state, args.expectedRevision)
          const node = findNode(state, args.nodeId)
          if (node.status !== 'pending' && node.status !== 'active') throw new Error('only a pending or active node can be checked out')
          if (!isLeaf(state, node.id)) throw new Error('only a leaf can be checked out for execution')
          const now = Date.now()
          const touched: LatticeNode[] = []
          let current: LatticeNode | undefined = node
          while (current !== undefined) {
            assertNodeReconciled(current, contract)
            if (current.status === 'pending') current.status = 'active'
            current.updatedAt = now
            touched.push(current)
            current = current.parentId === undefined ? undefined : findNode(state, current.parentId)
          }
          state.revision += 1
          state.project.updatedAt = now
          return { value: { node, revision: state.revision }, delta: delta(state, touched, true) }
        }, () => {
          assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
          executionState.verifyOwnershipSync(authorityWorkspace, executionLeaseClaim(durable))
        })
      } catch (error) {
        await executionState.release(authorityWorkspace, executionLeaseClaim(durable)).catch(() => {})
        throw error
      }
      clearWorkspace(workspace)
      leases.set(sessionKey(agent), {
        workspace,
        nodeId: args.nodeId,
        nodeTitle: result.node.title,
        nodeAcceptanceCriteria: result.node.acceptanceCriteria,
        revision: result.revision,
        dirty: false,
        durable,
        contextDigest: prepared.receipt.digest,
        contextPaths: state.project.contextPaths,
      })
      return json({
        message: `Checked out leaf ${args.nodeId} at lattice revision ${result.revision}. Refresh context before each guarded action; use checkpoints only for semantic verification or leaf completion.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_checkpoint',
    description: 'Record semantic verification for the current execution unit. Mechanical tool outcomes are already automatic; this evidence either keeps the leaf active or completes it and reconciles completed parents.',
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
      if (lease.dirty) {
        throw new Error('lattice_checkpoint cannot settle an indeterminate tool execution; resume recovery until its exact mechanical receipt is reconciled')
      }
      const consumed = await consumeFreshAuthorization(agent, workspace, args.receiptId, args.expectedRevision, lease.nodeId)
      const result = await store.mutate(workspace, 'checkpoint', state => {
        assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
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
      }, () => {
        assertConsumedEpochCurrent(agent, consumed.consumedEpoch)
        executionState.verifyOwnershipSync(
          executionAuthorityWorkspace(workspace),
          executionLeaseClaim(lease.durable),
        )
      })
      const key = sessionKey(agent)
      const durable = await checkpointCommittedGraph(workspace, lease, result.revision, args.complete)
      let released = false
      if (durable.lease === null) {
        released = true
        leases.delete(key)
      } else {
        leases.set(key, {
          ...lease,
          revision: result.revision,
          dirty: false,
          durable: durable.lease,
          mutationBasis: undefined,
        })
        const current = leases.get(key)
        if (current !== undefined && current.releaseWhenClean === true) {
          await convergeRequestedLeaseRelease(key, current)
          released = leases.get(key) === undefined
        }
      }
      return json({
        message: args.complete
          ? `Completed ${lease.nodeId} and reconciled ${result.touched.length - 1} parent nodes at revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`
          : released
            ? `Checkpointed ${lease.nodeId} at revision ${result.revision}; concurrent invalidation released its execution lease. Refresh context and check out a current leaf before more protected work.`
          : `Checkpointed ${lease.nodeId} at revision ${result.revision}; its execution lease remains current. Refresh context before the next checkpoint.`,
        touched: result.touched,
      })
    },
  }))

  function installControl(agent: Agent): void {
    const key = sessionKey(agent)
    if (controls.has(key)) return
    if (resolved.activationMode === 'off') {
      const control = fallbackControl(agent)
      controls.set(key, control)
      updateRestriction(agent, control)
      return
    }
    const parentId = agent.session.header.parentSession
    if (parentId !== undefined) {
      const registry = ctx.get('agents')
      const parentAgent = registry?.get(parentId as never)
      const continuableParent = continuableParents.get(agent)
      if (registry === undefined
        || parentAgent === undefined
        || (continuableParent !== parentAgent && !registry.isOwnedBy(agent.id, parentAgent))) {
        throw new Error('delegated control inheritance requires live Harness ownership or native continuable setup attestation, not parentSession metadata alone')
      }
      if (!controls.has(String(parentId))) installControl(parentAgent)
      const parent = controls.get(String(parentId))
      if (parent === undefined) throw new Error('delegated control inheritance requires an installed parent control')
      const parentLease = leases.get(String(parentId))
      const delegatedNode = parentLease === undefined
        ? parent.delegatedNode
        : {
            id: parentLease.nodeId,
            title: parentLease.nodeTitle,
            acceptanceCriteria: parentLease.nodeAcceptanceCriteria,
            graphRevision: parentLease.revision,
          }
      // Creating a delegated execution surface is a handoff boundary. Neither
      // side inherits the parent's pre-handoff mutation authority.
      invalidateRootAuthority(parent.rootSessionId, true)
      authorizationEpochs.set(key, 0)
      const inherited: AgentControl = {
        phase: parent.phase,
        clarificationPolicy: parent.clarificationPolicy,
        reasons: ['inherited from parent task', ...parent.reasons],
        productDefinitionGap: parent.productDefinitionGap,
        outcomeCritical: parent.outcomeCritical,
        criticalGaps: [...parent.criticalGaps],
        rootSessionId: parent.rootSessionId,
        ...(parent.contract === undefined ? {} : { contract: parent.contract }),
        initialContractPending: parent.initialContractPending,
        reframePending: parent.reframePending,
        authorizationEpoch: 0,
        ...(delegatedNode === undefined ? {} : { delegatedNode }),
        ...(parent.contextReplacement === undefined ? {} : { contextReplacement: parent.contextReplacement }),
      }
      controls.set(key, inherited)
      updateRestriction(agent, inherited)
      return
    }

    if (isDelegatedSession(agent)) {
      throw new Error('delegated control inheritance requires a live parentSession ownership edge')
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
      if (contract !== undefined && contract.sessionId !== key) invalidContract = true
    }
    const hasV1Graph = cwd !== undefined && existsSync(join(cwd, '.dsh', 'plan-lattice', 'v1', 'snapshot.json'))
    let delegatedInputPending = false
    if (contract !== undefined && contract.sessionId === key) {
      try {
        delegatedInputPending = delegatedInputFences.verifySync(delegatedInputContractBasis(contract)).length > 0
      } catch {
        invalidContract = true
        delegatedInputPending = true
      }
    }
    let interruptedReframe = false
    if (cwd !== undefined && contract?.controlLevel === 'lattice') {
      try {
        const state = readLatticeStateSync(cwd)
        if (state !== undefined) {
          // A v2 contract with no project-level binding is ambiguous for an
          // empty or all-archived pre-RC.5 graph. Fail closed: after a
          // successful reframe both fields are always committed with the graph.
          const projectContractMismatch = state.project.contractRevision !== contract.revision
            || state.project.contractDigest !== contract.documentDigest
          interruptedReframe = !state.project.contextPaths.includes(CONTRACT_DOCUMENT_PATH)
            || projectContractMismatch
            || Object.values(state.nodes).some(node => node.status !== 'archived'
              && node.contractRevision !== contract!.revision
              && node.reconciliationRequired !== true)
        }
      } catch {
        interruptedReframe = true
      }
    }
    if (interruptedReframe) invalidContract = true
    const phase: RoutePhase = hasV1Graph
      ? 'lattice'
      : contract?.controlLevel
        ?? (resolved.legacyIntakeMode !== undefined
          ? 'lattice'
          : resolved.activationMode === 'always'
            ? resolved.controlCeiling
            : 'probe')
    const control: AgentControl = {
      phase,
      clarificationPolicy: contract?.clarificationPolicy ?? resolved.clarificationPolicy,
      productDefinitionGap: 0,
      outcomeCritical: false,
      criticalGaps: [],
      reasons: hasV1Graph
        ? interruptedReframe
          ? ['an interrupted contract reframe left the durable graph unreconciled']
          : ['resumed an existing v1 lattice']
        : delegatedInputPending
          ? ['durable delegated human input requires root-contract revision']
        : contract !== undefined
          ? ['restored v2 execution contract']
          : invalidContract
            ? ['v2 contract exists but failed integrity validation']
            : ['awaiting first user request'],
      rootSessionId: invalidContract && contract?.sessionId !== key ? key : contract?.sessionId ?? key,
      ...(contract === undefined ? {} : { contract }),
      initialContractPending: contract === undefined && !hasV1Graph,
      reframePending: invalidContract || delegatedInputPending,
      authorizationEpoch: currentAuthorizationEpoch(key),
    }
    if (agent.session.surface.replaceGeneration > 0) {
      control.contextReplacement = {
        seq: Math.max(0, agent.session.firstLiveSeq - 1),
        type: `seeded-surface-replacement/${agent.session.surface.replaceGeneration}`,
      }
    }
    controls.set(key, control)
    updateRestriction(agent, control)
  }

  ctx.on('agent/created', ({ agent }) => installControl(agent))
  ctx.on('agent/session-start', ({ agent, source }) => {
    if (source === 'startup') return
    installControl(agent)
    invalidateSessionAuthority(sessionKey(agent), {
      contextReplacement: {
        seq: Math.max(0, agent.session.firstLiveSeq - 1),
        type: `agent/session-start:${source}`,
      },
      releaseLease: true,
    })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const key = sessionKey(agent)
    const control = controls.get(key)
    if (control !== undefined) invalidateRootAuthority(control.rootSessionId, true)
    invalidateSessionAuthority(key, { releaseLease: true })
    control?.restriction?.()
    nativePlanModeStates.delete(agent)
    controls.delete(key)
    sessionWorkspaces.delete(key)
    delegatedOperationalMessages.delete(key)
  })
  ctx.on('session/disposed', session => {
    invalidateSessionAuthority(String(session.id), { releaseLease: true })
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // This event observes an inbox splice that already committed. It must not
    // throw and make the sender believe an accepted message was rejected.
    let key: string | undefined
    let control: AgentControl | undefined
    try {
      key = sessionKey(agent)
      control = controls.get(key)
      if (control === undefined) {
        invalidateSessionAuthority(key, { releaseLease: true })
        ctx.logger.warn(`plan-lattice: accepted inbox message ${String(message.id)} reached uninstalled agent ${key}; guarded writes remain fail-closed`)
        return
      }
      if (resolved.activationMode === 'off') return
      const text = extractMessageText(message)
      const hasNonText = message.content.some(block => block.type !== 'text')
      const active = control.phase === 'contract' || control.phase === 'lattice'
      const established = active && !control.initialContractPending
      let initialDelegation = false
      if (message.source.kind === 'user' && isPotentialNativeInitialDelegation(agent, control)) {
        if (isNativeInitialDelegation(agent, control)) {
          markDelegatedInitialInput(agent, control, String(message.id))
          initialDelegation = true
        } else {
          // One-shot rc.7 appends its descriptor in the first pre-step after
          // accepting the prompt. Hold this one message unclassified until the
          // downstream native lifecycle has published both facts.
          pendingDelegatedInitialInputs.set(agent, { message })
          return
        }
      }
      if (established && message.source.kind === 'user' && !initialDelegation) {
        const staged = undurableUserInputs.get(control.rootSessionId) ?? new Map()
        staged.set(String(message.id), {
          messageId: String(message.id),
          digest: userInputDigest(message),
          content: message.content,
        })
        undurableUserInputs.set(control.rootSessionId, staged)
        if (key !== control.rootSessionId) {
          queueDelegatedInputFence(
            control,
            key,
            message,
            'human input delivered to a delegated session requires explicit root-contract revision',
          )
        }
      }
      if (established) invalidateRootAuthority(control.rootSessionId, true)
      if (message.source.kind !== 'user') {
        if (established) {
          control.reasons = ['plugin-authored operational input invalidated prior action authority', ...control.reasons]
        }
        return
      }
      if (initialDelegation) {
        return
      }
      if (hasNonText || text === '') {
        if (established) requireRootReframe(control.rootSessionId, 'non-text input requires explicit contract revision')
        return
      }
      if (control.phase === 'probe') {
        control.routeBasisText = [control.routeBasisText, text]
          .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
          .join('\n\n')
        transitionControl(agent, routeRequest(control.routeBasisText, resolved))
        return
      }
      const override = routeRequest(text, resolved)
      if (override.reasons.includes('explicit bypass') || override.reasons.includes('explicit full-lattice override')) {
        transitionControl(agent, override)
        return
      }
      if (established) {
        if (isMaterialChange(text)) {
          requireRootReframe(control.rootSessionId, 'material user change requires contract revision', override.criticalGaps)
        } else {
          control.reasons = ['new user input invalidated prior authority', ...control.reasons]
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      try {
        if (control === undefined) {
          if (key !== undefined) invalidateSessionAuthority(key, { releaseLease: true })
        } else {
          invalidateRootAuthority(control.rootSessionId, true)
          requireRootReframe(
            control.rootSessionId,
            `accepted inbox input could not be reconciled safely: ${reason}`,
          )
        }
      } catch {
        // The observer is post-commit. Cleanup failure cannot reject the splice;
        // untracked sessions remain fail-closed in the guarded-tool fallback.
      }
      try {
        ctx.logger.warn(`plan-lattice: accepted inbox message entered fail-closed handling for ${key ?? '<unknown-agent>'}: ${reason}`)
      } catch {
        // Logging is diagnostic and cannot alter native inbox acceptance.
      }
    }
  })

  const registry = ctx.get('agents')
  if (registry !== undefined) for (const agent of registry.list()) installControl(agent)
}
