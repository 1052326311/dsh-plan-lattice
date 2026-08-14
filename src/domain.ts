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
}): LatticeNode {
  return {
    id: `node-${randomUUID()}`,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    title: assertText(input.title, 'title'),
    acceptanceCriteria: assertText(input.acceptanceCriteria, 'acceptanceCriteria'),
    status: 'pending',
    evidence: [],
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
