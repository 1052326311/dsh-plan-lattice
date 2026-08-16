import { randomUUID } from 'node:crypto'

export const LATTICE_SCHEMA_VERSION = 1

export type NodeStatus = 'pending' | 'active' | 'blocked' | 'complete' | 'archived'

export interface NodeEvidence {
  summary: string
  references: string[]
  recordedAt: number
}

export interface LatticeNode {
  id: string
  parentId?: string
  title: string
  acceptanceCriteria: string
  status: NodeStatus
  evidence: NodeEvidence[]
  blockedReason?: string
  /** The accepted contract revision against which this node was last reconciled. */
  contractRevision?: number
  contractDigest?: string
  /** Reframe fence: a node cannot execute until explicitly rebound to the new contract. */
  reconciliationRequired?: boolean
  createdAt: number
  updatedAt: number
}

export interface LatticeProject {
  title: string
  objective: string
  contextPaths: string[]
  createdAt: number
  updatedAt: number
}

export interface LatticeState {
  schemaVersion: typeof LATTICE_SCHEMA_VERSION
  revision: number
  project: LatticeProject
  nodes: Record<string, LatticeNode>
}

export interface LatticeDelta {
  revision: number
  project?: LatticeProject
  upserts: LatticeNode[]
}

export interface LatticeReceipt {
  id: string
  workspace: string
  revision: number
  digest: string
  issuedAt: number
}

export interface LatticeNodeSummary {
  id: string
  parentId?: string
  title: string
  acceptanceCriteria: string
  status: NodeStatus
  evidenceCount: number
  blockedReason?: string
  contractRevision?: number
  reconciliationRequired?: boolean
  latestEvidence?: NodeEvidence
}

export interface LatticeStatusProjection {
  revision: number
  project: {
    title: string
    objective: string
    contextPaths: string[]
    contextPathCount: number
    contextPathsTruncated: boolean
    updatedAt: number
  }
  counts: Record<NodeStatus, number>
  frontier: {
    nodes: LatticeNodeSummary[]
    total: number
    truncated: boolean
  }
  focus?: {
    node: LatticeNodeSummary
    children: LatticeNodeSummary[]
    childrenTotal: number
    childrenTruncated: boolean
  }
}

export function assertText(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${field} must be a non-empty string`)
  return normalized
}

export function assertExpectedRevision(state: LatticeState, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
    throw new Error(`stale lattice revision: expected ${expectedRevision}, current ${state.revision}`)
  }
}

export function nodeChildren(state: LatticeState, parentId: string | undefined): LatticeNode[] {
  return Object.values(state.nodes).filter(node => node.parentId === parentId && node.status !== 'archived')
}

/** Historical children remain relevant when deciding whether a parent may complete. */
function allChildren(state: LatticeState, parentId: string): LatticeNode[] {
  return Object.values(state.nodes).filter(node => node.parentId === parentId)
}

export function isLeaf(state: LatticeState, nodeId: string): boolean {
  return nodeChildren(state, nodeId).length === 0
}

export function findNode(state: LatticeState, nodeId: string): LatticeNode {
  const node = state.nodes[nodeId]
  if (node === undefined) throw new Error(`unknown lattice node ${JSON.stringify(nodeId)}`)
  return node
}

export function assertMutable(node: LatticeNode): void {
  if (node.status === 'complete' || node.status === 'archived') {
    throw new Error(`node ${JSON.stringify(node.id)} is ${node.status} and cannot be changed`)
  }
}

export function createNode(input: {
  parentId?: string
  title: string
  acceptanceCriteria: string
  now: number
  contractRevision?: number
  contractDigest?: string
}): LatticeNode {
  return {
    id: `node-${randomUUID()}`,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    title: assertText(input.title, 'title'),
    acceptanceCriteria: assertText(input.acceptanceCriteria, 'acceptanceCriteria'),
    status: 'pending',
    evidence: [],
    ...(input.contractRevision === undefined ? {} : { contractRevision: input.contractRevision }),
    ...(input.contractDigest === undefined ? {} : { contractDigest: input.contractDigest }),
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export function assertBranchingCapacity(
  state: LatticeState,
  parentId: string | undefined,
  requestedChildren: number,
  topLevelLimit: number,
  nestedLimit: number,
): void {
  if (!Number.isSafeInteger(requestedChildren) || requestedChildren < 1) {
    throw new Error('requestedChildren must be a positive safe integer')
  }
  const limit = parentId === undefined ? topLevelLimit : nestedLimit
  const existing = nodeChildren(state, parentId).length
  if (existing + requestedChildren > limit) {
    throw new Error(
      `${parentId === undefined ? 'top-level' : 'nested'} branching limit exceeded: `
      + `${existing} existing + ${requestedChildren} requested > ${limit}`,
    )
  }
}

/** Mark a completed leaf and collapse every parent whose non-archived children all completed. */
export function completeAndCollapse(state: LatticeState, nodeId: string, evidence: NodeEvidence): LatticeNode[] {
  const node = findNode(state, nodeId)
  if (!isLeaf(state, nodeId)) throw new Error('only a leaf node can be completed directly')
  assertMutable(node)
  const touched: LatticeNode[] = []
  const now = evidence.recordedAt
  node.status = 'complete'
  delete node.blockedReason
  node.evidence.push(evidence)
  node.updatedAt = now
  touched.push(node)

  let parentId = node.parentId
  while (parentId !== undefined) {
    const parent = findNode(state, parentId)
    const children = allChildren(state, parentId)
    if (children.length === 0 || children.some(child => child.status !== 'complete')) break
    if (parent.status !== 'complete') {
      parent.status = 'complete'
      delete parent.blockedReason
      parent.evidence.push({
        summary: 'Automatically reconciled: every child node is complete.',
        references: children.flatMap(child => child.evidence.flatMap(item => item.references)),
        recordedAt: now,
      })
      parent.updatedAt = now
      touched.push(parent)
    }
    parentId = parent.parentId
  }
  return touched
}

export function publicState(state: LatticeState): LatticeState {
  return JSON.parse(JSON.stringify(state)) as LatticeState
}

function compactText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`
}

function summarizeNode(node: LatticeNode): LatticeNodeSummary {
  const latest = node.evidence.at(-1)
  return {
    id: node.id,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    title: compactText(node.title, 160),
    acceptanceCriteria: compactText(node.acceptanceCriteria, 240),
    status: node.status,
    evidenceCount: node.evidence.length,
    ...(node.blockedReason === undefined ? {} : { blockedReason: compactText(node.blockedReason, 240) }),
    ...(node.contractRevision === undefined ? {} : { contractRevision: node.contractRevision }),
    ...(node.reconciliationRequired === undefined ? {} : { reconciliationRequired: node.reconciliationRequired }),
    ...(latest === undefined ? {} : {
      latestEvidence: {
        summary: compactText(latest.summary, 240),
        references: latest.references.slice(0, 3).map(reference => compactText(reference, 160)),
        recordedAt: latest.recordedAt,
      },
    }),
  }
}

function compareActionableNodes(left: LatticeNode, right: LatticeNode): number {
  const priority: Record<NodeStatus, number> = {
    active: 0,
    blocked: 1,
    pending: 2,
    complete: 3,
    archived: 4,
  }
  return priority[left.status] - priority[right.status]
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id)
}

function boundedSelection(nodes: Iterable<LatticeNode>, maxNodes: number): { nodes: LatticeNode[]; total: number } {
  const selected: LatticeNode[] = []
  let total = 0
  for (const node of nodes) {
    total += 1
    if (selected.length < maxNodes) {
      selected.push(node)
      selected.sort(compareActionableNodes)
      continue
    }
    const last = selected.at(-1)
    if (last !== undefined && compareActionableNodes(node, last) < 0) {
      selected[selected.length - 1] = node
      selected.sort(compareActionableNodes)
    }
  }
  return { nodes: selected, total }
}

/**
 * Return a model-safe view of the graph. The durable ledger can grow large,
 * but reading its status must not reinject the entire graph into the prompt.
 */
export function projectStatus(
  state: LatticeState,
  options: { nodeId?: string; maxNodes: number },
): LatticeStatusProjection {
  const counts: Record<NodeStatus, number> = {
    pending: 0,
    active: 0,
    blocked: 0,
    complete: 0,
    archived: 0,
  }
  const liveChildCounts = new Map<string, number>()
  const values = Object.values(state.nodes)
  for (const node of values) {
    counts[node.status] += 1
    if (node.parentId !== undefined && node.status !== 'archived') {
      liveChildCounts.set(node.parentId, (liveChildCounts.get(node.parentId) ?? 0) + 1)
    }
  }

  const frontier = boundedSelection(values.filter(node => (
    node.status === 'blocked'
    || ((node.status === 'pending' || node.status === 'active') && !liveChildCounts.has(node.id))
  )), options.maxNodes)
  const contextPaths = state.project.contextPaths.slice(0, 16).map(path => compactText(path, 240))
  const result: LatticeStatusProjection = {
    revision: state.revision,
    project: {
      title: compactText(state.project.title, 160),
      objective: compactText(state.project.objective, 480),
      contextPaths,
      contextPathCount: state.project.contextPaths.length,
      contextPathsTruncated: contextPaths.length < state.project.contextPaths.length,
      updatedAt: state.project.updatedAt,
    },
    counts,
    frontier: {
      nodes: frontier.nodes.map(summarizeNode),
      total: frontier.total,
      truncated: frontier.total > frontier.nodes.length,
    },
  }

  if (options.nodeId !== undefined) {
    const node = findNode(state, options.nodeId)
    const children = boundedSelection(values.filter(candidate => candidate.parentId === node.id), options.maxNodes)
    result.focus = {
      node: summarizeNode(node),
      children: children.nodes.map(summarizeNode),
      childrenTotal: children.total,
      childrenTruncated: children.total > children.nodes.length,
    }
  }
  return result
}
