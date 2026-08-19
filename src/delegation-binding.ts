import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ContractBasis, NodeExecutionPlan } from './mutation-context.js'

const SCHEMA_VERSION = 1
const DIRECTORY = 'delegated-execution/v1'

export interface DelegatedNodeBinding {
  id: string
  title: string
  acceptanceCriteria: string
  graphRevision: number
  lineage: NodeExecutionPlan['lineage']
}

export interface DelegationBinding {
  schemaVersion: typeof SCHEMA_VERSION
  childSessionId: string
  parentSessionId: string
  rootSessionId: string
  contract: ContractBasis
  delegatedNode: DelegatedNodeBinding
  initialMessage: {
    id: string
    digest: string
  }
}

export type DelegationBindingInput = Omit<DelegationBinding, 'schemaVersion'>

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
}

function positiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive safe integer`)
}

function digest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be a SHA-256 digest`)
}

function pathFor(root: string, childSessionId: string): string {
  const file = `${createHash('sha256').update(childSessionId).digest('hex')}.json`
  return join(resolve(root), DIRECTORY, file)
}

function assertLineage(value: unknown): asserts value is NodeExecutionPlan['lineage'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('delegatedNode.lineage must be non-empty')
  const ids = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const node = value[index]
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new Error(`delegatedNode.lineage[${index}] must be an object`)
    }
    const record = node as Record<string, unknown>
    const allowed = new Set([
      'id',
      'parentId',
      'title',
      'acceptanceCriteria',
      'status',
      'contractRevision',
      'contractDigest',
      'reconciliationRequired',
    ])
    if (Object.keys(record).some(key => !allowed.has(key))) {
      throw new Error(`delegatedNode.lineage[${index}] contains unsupported fields`)
    }
    nonEmpty(record.id, `delegatedNode.lineage[${index}].id`)
    nonEmpty(record.title, `delegatedNode.lineage[${index}].title`)
    nonEmpty(record.acceptanceCriteria, `delegatedNode.lineage[${index}].acceptanceCriteria`)
    if (record.parentId !== undefined) nonEmpty(record.parentId, `delegatedNode.lineage[${index}].parentId`)
    if (record.status !== 'pending' && record.status !== 'active' && record.status !== 'blocked'
      && record.status !== 'complete' && record.status !== 'archived') {
      throw new Error(`delegatedNode.lineage[${index}].status is invalid`)
    }
    if (record.contractRevision !== undefined) positiveInteger(record.contractRevision, `delegatedNode.lineage[${index}].contractRevision`)
    if (record.contractDigest !== undefined) digest(record.contractDigest, `delegatedNode.lineage[${index}].contractDigest`)
    if (record.reconciliationRequired !== undefined && record.reconciliationRequired !== true) {
      throw new Error(`delegatedNode.lineage[${index}].reconciliationRequired must be true when present`)
    }
    if (ids.has(record.id)) throw new Error('delegatedNode.lineage contains duplicate ids')
    ids.add(record.id)
    const expectedParent = index === 0 ? undefined : (value[index - 1] as { id: string }).id
    if (record.parentId !== expectedParent) throw new Error('delegatedNode.lineage is not a contiguous root-to-leaf path')
  }
}

function assertBinding(value: unknown, childSessionId?: string): asserts value is DelegationBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('delegation binding is not an object')
  const binding = value as Partial<DelegationBinding>
  if (binding.schemaVersion !== SCHEMA_VERSION) throw new Error('delegation binding has an unsupported schema')
  nonEmpty(binding.childSessionId, 'childSessionId')
  if (childSessionId !== undefined && binding.childSessionId !== childSessionId) {
    throw new Error('delegation binding child session identity does not match its anchor')
  }
  nonEmpty(binding.parentSessionId, 'parentSessionId')
  nonEmpty(binding.rootSessionId, 'rootSessionId')
  if (typeof binding.contract !== 'object' || binding.contract === null || Array.isArray(binding.contract)) {
    throw new Error('delegation binding contract is not an object')
  }
  nonEmpty(binding.contract.id, 'contract.id')
  nonEmpty(binding.contract.sessionId, 'contract.sessionId')
  positiveInteger(binding.contract.revision, 'contract.revision')
  digest(binding.contract.documentDigest, 'contract.documentDigest')
  if (binding.contract.sessionId !== binding.rootSessionId) throw new Error('delegation binding contract root mismatch')
  if (typeof binding.delegatedNode !== 'object' || binding.delegatedNode === null || Array.isArray(binding.delegatedNode)) {
    throw new Error('delegation binding node is not an object')
  }
  nonEmpty(binding.delegatedNode.id, 'delegatedNode.id')
  nonEmpty(binding.delegatedNode.title, 'delegatedNode.title')
  nonEmpty(binding.delegatedNode.acceptanceCriteria, 'delegatedNode.acceptanceCriteria')
  positiveInteger(binding.delegatedNode.graphRevision, 'delegatedNode.graphRevision')
  assertLineage(binding.delegatedNode.lineage)
  if (binding.delegatedNode.lineage.at(-1)?.id !== binding.delegatedNode.id) {
    throw new Error('delegated node must be the terminal lineage entry')
  }
  if (typeof binding.initialMessage !== 'object' || binding.initialMessage === null || Array.isArray(binding.initialMessage)) {
    throw new Error('delegation binding initialMessage is not an object')
  }
  nonEmpty(binding.initialMessage.id, 'initialMessage.id')
  digest(binding.initialMessage.digest, 'initialMessage.digest')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function readDelegationBindingSync(root: string, childSessionId: string): DelegationBinding | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(pathFor(root, childSessionId), 'utf8'))
    assertBinding(value, childSessionId)
    return clone(value)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Persist only native Session identities and accepted Lattice identities. The
 * delegated prompt remains exclusively in the child's DSH Session log.
 */
export function persistDelegationBindingSync(root: string, input: DelegationBindingInput): DelegationBinding {
  const binding: DelegationBinding = { schemaVersion: SCHEMA_VERSION, ...clone(input) }
  assertBinding(binding, input.childSessionId)
  const existing = readDelegationBindingSync(root, binding.childSessionId)
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(binding)) {
      throw new Error('delegation binding already exists with a different native or Lattice identity')
    }
    return existing
  }

  const path = pathFor(root, binding.childSessionId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return clone(binding)
}
