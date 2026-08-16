import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import {
  access,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { LatticeNode, LatticeState } from './domain.js'
import { findNode, nodeChildren, projectStatus } from './domain.js'

export interface MutationTargetSnapshot {
  path: string
  state: 'file' | 'missing'
  digest: string
  content?: string
}

export interface NodeExecutionPlan {
  nodeId: string
  revision: number
  digest: string
  lineage: Array<Pick<LatticeNode, 'id' | 'parentId' | 'title' | 'acceptanceCriteria' | 'status' | 'contractRevision' | 'contractDigest' | 'reconciliationRequired'>>
}

export interface ContractBasis {
  id: string
  sessionId: string
  revision: number
  documentDigest: string
}

export interface ExternalPreconditionSnapshot {
  toolName: string
  resource: string
  argumentsDigest: string
  stateDigest: string
  description: string
}

export interface MutationBasis {
  /** One runtime authorization epoch. Every protected attempt consumes it. */
  authorizationId: string
  epoch: number
  contract?: ContractBasis
  planRevision?: number
  nodePlan?: NodeExecutionPlan
  targets: MutationTargetSnapshot[]
  targetDigest: string
  externalPreconditions: ExternalPreconditionSnapshot[]
  externalPreconditionDigest: string
}

export interface StructuralPlanNode {
  id: string
  parentId?: string
  title: string
  acceptanceCriteria: string
  status: LatticeNode['status']
  blockedReason?: string
  contractRevision?: number
  reconciliationRequired?: boolean
}

export interface StructuralPlanView {
  revision: number
  digest: string
  roots: StructuralPlanNode[]
  frontier: StructuralPlanNode[]
  focus?: {
    nodeId: string
    lineage: StructuralPlanNode[]
    children: StructuralPlanNode[]
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertContained(root: string, target: string, label: string, allowRoot = false): void {
  const fromRoot = relative(root, target)
  if ((!allowRoot && fromRoot === '') || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`${label} resolves outside the workspace`)
  }
}

function normalizedInputPath(workspace: string, input: string): { root: string; candidate: string } {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('every mutation target must be a non-empty path')
  }
  const root = realpathSync(workspace)
  const candidate = resolve(root, input)
  return { root, candidate }
}

async function normalizedInputPathAsync(workspace: string, input: string): Promise<{ root: string; candidate: string }> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('every mutation target must be a non-empty path')
  }
  const root = await realpath(workspace)
  const candidate = resolve(root, input)
  return { root, candidate }
}

function missingSnapshot(path: string): MutationTargetSnapshot {
  return { path, state: 'missing', digest: sha256(`missing\0${path}`) }
}

async function snapshotOne(workspace: string, input: string): Promise<MutationTargetSnapshot> {
  const { root, candidate } = await normalizedInputPathAsync(workspace, input)
  try {
    await access(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const resolvedParent = await realpath(dirname(candidate))
    assertContained(root, resolvedParent, `parent of mutation target ${JSON.stringify(input)}`, true)
    const path = relative(root, resolve(resolvedParent, basename(candidate))).replaceAll('\\', '/')
    return missingSnapshot(path)
  }
  const resolved = await realpath(candidate)
  assertContained(root, resolved, `mutation target ${JSON.stringify(input)}`)
  if (!(await stat(resolved)).isFile()) throw new Error(`mutation target is not a regular file: ${JSON.stringify(input)}`)
  const content = await readFile(resolved, 'utf8')
  const path = relative(root, resolved).replaceAll('\\', '/')
  return { path, state: 'file', digest: sha256(content), content }
}

function snapshotOneSync(workspace: string, input: string): MutationTargetSnapshot {
  const { root, candidate } = normalizedInputPath(workspace, input)
  if (!existsSync(candidate)) {
    const resolvedParent = realpathSync(dirname(candidate))
    assertContained(root, resolvedParent, `parent of mutation target ${JSON.stringify(input)}`, true)
    const path = relative(root, resolve(resolvedParent, basename(candidate))).replaceAll('\\', '/')
    return missingSnapshot(path)
  }
  const resolved = realpathSync(candidate)
  assertContained(root, resolved, `mutation target ${JSON.stringify(input)}`)
  if (!statSync(resolved).isFile()) throw new Error(`mutation target is not a regular file: ${JSON.stringify(input)}`)
  const content = readFileSync(resolved, 'utf8')
  const path = relative(root, resolved).replaceAll('\\', '/')
  return { path, state: 'file', digest: sha256(content), content }
}

function summarizeTargets(targets: MutationTargetSnapshot[]): string {
  return sha256(JSON.stringify(targets.map(target => ({
    path: target.path,
    state: target.state,
    digest: target.digest,
  }))))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function digestArguments(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function summarizeExternalPreconditions(preconditions: ExternalPreconditionSnapshot[]): string {
  return sha256(JSON.stringify(preconditions.map(precondition => ({
    toolName: precondition.toolName,
    resource: precondition.resource,
    argumentsDigest: precondition.argumentsDigest,
    stateDigest: precondition.stateDigest,
  }))))
}

function uniqueTargets(paths: string[]): string[] {
  if (paths.length === 0) return []
  const normalized = paths.map(path => path.trim())
  if (new Set(normalized).size !== normalized.length) throw new Error('mutation target paths must not contain duplicates')
  return normalized.sort()
}

export async function readMutationTargets(
  workspace: string,
  paths: string[],
  maxBytes: number,
): Promise<{ targets: MutationTargetSnapshot[]; digest: string }> {
  const targets: MutationTargetSnapshot[] = []
  let bytes = 0
  for (const path of uniqueTargets(paths)) {
    const target = await snapshotOne(workspace, path)
    bytes += target.content === undefined ? 0 : Buffer.byteLength(target.content)
    if (bytes > maxBytes) {
      throw new Error(`mutation target context exceeds ${maxBytes} bytes; narrow the next change instead of truncating it`)
    }
    targets.push(target)
  }
  return { targets, digest: summarizeTargets(targets) }
}

export function verifyMutationTargetSync(
  workspace: string,
  expected: MutationTargetSnapshot,
): string | undefined {
  const current = snapshotOneSync(workspace, expected.path)
  if (current.state !== expected.state || current.digest !== expected.digest) {
    return `target ${JSON.stringify(expected.path)} changed since it was read in full`
  }
  return undefined
}

/** Recheck the complete declared target set, not only the path used by one editor call. */
export function verifyMutationTargetsSync(
  workspace: string,
  expected: MutationTargetSnapshot[],
  expectedDigest: string,
): string | undefined {
  const current = expected.map(target => snapshotOneSync(workspace, target.path))
  if (summarizeTargets(current) !== expectedDigest) {
    const changed = current.find((target, index) => {
      const prior = expected[index]
      return prior === undefined
        || target.path !== prior.path
        || target.state !== prior.state
        || target.digest !== prior.digest
    })
    return changed === undefined
      ? 'the declared mutation target set changed since it was read in full'
      : `target ${JSON.stringify(changed.path)} changed since the complete target set was read`
  }
  return undefined
}

export function normalizeMutationTarget(workspace: string, input: string): string {
  return snapshotOneSync(workspace, input).path
}

export function nodeExecutionPlan(state: LatticeState, nodeId: string): NodeExecutionPlan {
  const lineage: NodeExecutionPlan['lineage'] = []
  let current: LatticeNode | undefined = findNode(state, nodeId)
  while (current !== undefined) {
    lineage.unshift({
      id: current.id,
      ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
      title: current.title,
      acceptanceCriteria: current.acceptanceCriteria,
      status: current.status,
      ...(current.contractRevision === undefined ? {} : { contractRevision: current.contractRevision }),
      ...(current.contractDigest === undefined ? {} : { contractDigest: current.contractDigest }),
      ...(current.reconciliationRequired === undefined ? {} : { reconciliationRequired: current.reconciliationRequired }),
    })
    current = current.parentId === undefined ? undefined : findNode(state, current.parentId)
  }
  return { nodeId, revision: state.revision, digest: sha256(JSON.stringify(lineage)), lineage }
}

function structuralNode(node: LatticeNode): StructuralPlanNode {
  return {
    id: node.id,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    title: node.title,
    acceptanceCriteria: node.acceptanceCriteria,
    status: node.status,
    ...(node.blockedReason === undefined ? {} : { blockedReason: node.blockedReason }),
    ...(node.contractRevision === undefined ? {} : { contractRevision: node.contractRevision }),
    ...(node.reconciliationRequired === undefined ? {} : { reconciliationRequired: node.reconciliationRequired }),
  }
}

/**
 * Render the exact bounded graph neighborhood that may authorize the next
 * structural mutation. Roots are bounded by topLevelLimit, children by
 * nestedLimit, and the actionable frontier by the fixed status projection.
 */
export function structuralPlanView(state: LatticeState, focusNodeId?: string): StructuralPlanView {
  const frontierIds = projectStatus(state, { maxNodes: 16 }).frontier.nodes.map(node => node.id)
  const roots = nodeChildren(state, undefined).map(structuralNode)
  const frontier = frontierIds.map(id => structuralNode(findNode(state, id)))
  const focus = focusNodeId === undefined
    ? undefined
    : {
        nodeId: focusNodeId,
        lineage: nodeExecutionPlan(state, focusNodeId).lineage.map(node => ({ ...node })),
        children: nodeChildren(state, focusNodeId).map(structuralNode),
      }
  const body = {
    revision: state.revision,
    roots,
    frontier,
    ...(focus === undefined ? {} : { focus }),
  }
  return { ...body, digest: sha256(JSON.stringify(body)) }
}

export function mutationTargetFromTool(
  toolName: string,
  args: unknown,
): { kind: 'read' | 'mutation' | 'unknown'; path?: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { kind: 'unknown' }
  const record = args as Record<string, unknown>
  if (toolName === 'write' || toolName === 'edit') {
    return typeof record.file_path === 'string'
      ? { kind: 'mutation', path: record.file_path }
      : { kind: 'unknown' }
  }
  if (toolName === 'str_replace_editor') {
    if (record.command === 'view') return { kind: 'read' }
    return typeof record.path === 'string'
      ? { kind: 'mutation', path: record.path }
      : { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}
