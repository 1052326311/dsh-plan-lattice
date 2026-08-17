import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { readContractAnchorSync } from './contract-anchor.js'

export const DELEGATED_INPUT_FENCE_SCHEMA_VERSION = 1

const FENCE_DIRECTORY = join('delegated-input-fences', 'v1')
const RECORD_DIRECTORY = 'records'
const REFERENCE_DIRECTORY = 'refs'

export interface DelegatedInputContractBasis {
  rootSessionId: string
  contractId: string
  contractRevision: number
  contractDigest: string
}

export interface DelegatedInputFenceInput extends DelegatedInputContractBasis {
  delegatedSessionId: string
  messageId: string
  messageDigest: string
  reason: string
  createdAt?: string
}

export interface DelegatedInputFence extends DelegatedInputContractBasis {
  delegatedSessionId: string
  messageId: string
  messageDigest: string
  reason: string
  createdAt: string
}

export interface PersistedDelegatedInputFence {
  created: boolean
  fence: DelegatedInputFence
}

export interface DelegatedInputFenceStoreOptions {
  now?: () => number
}

export class DelegatedInputFenceError extends Error {
  constructor(
    message: string,
    readonly code: 'CORRUPT_FENCE' | 'FENCE_CONFLICT' | 'CONTRACT_MISMATCH' | 'ADOPTION_MISMATCH',
  ) {
    super(message)
    this.name = 'DelegatedInputFenceError'
  }
}

interface FenceEnvelope {
  schemaVersion: typeof DELEGATED_INPUT_FENCE_SCHEMA_VERSION
  record: DelegatedInputFence
  recordDigest: string
}

interface FenceReference {
  schemaVersion: typeof DELEGATED_INPUT_FENCE_SCHEMA_VERSION
  rootSessionId: string
  delegatedSessionId: string
  messageId: string
  recordDigest: string
}

interface LoadedFence {
  fence: DelegatedInputFence
  recordDigest: string
  recordPath: string
  referencePath: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.trim()
  if (normalized === '') throw new TypeError(`${field} must be a non-empty string`)
  return normalized
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value
}

function digest(value: string, field: string): string {
  const normalized = nonEmpty(value, field).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError(`${field} must be a SHA-256 digest`)
  return normalized
}

function timestamp(value: string, field: string): string {
  const normalized = nonEmpty(value, field)
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${field} must be a valid timestamp`)
  return normalized
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new DelegatedInputFenceError(`${label} has an unsupported or malformed schema`, 'CORRUPT_FENCE')
  }
}

function normalizeBasis(input: DelegatedInputContractBasis): DelegatedInputContractBasis {
  return {
    rootSessionId: nonEmpty(input.rootSessionId, 'rootSessionId'),
    contractId: nonEmpty(input.contractId, 'contractId'),
    contractRevision: positiveInteger(input.contractRevision, 'contractRevision'),
    contractDigest: digest(input.contractDigest, 'contractDigest'),
  }
}

function normalizeInput(input: DelegatedInputFenceInput, now: () => number): DelegatedInputFence {
  return {
    ...normalizeBasis(input),
    delegatedSessionId: nonEmpty(input.delegatedSessionId, 'delegatedSessionId'),
    messageId: nonEmpty(input.messageId, 'messageId'),
    messageDigest: digest(input.messageDigest, 'messageDigest'),
    reason: nonEmpty(input.reason, 'reason'),
    createdAt: timestamp(input.createdAt ?? new Date(now()).toISOString(), 'createdAt'),
  }
}

function assertStoredFence(value: unknown): asserts value is DelegatedInputFence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DelegatedInputFenceError('delegated-input fence record is not an object', 'CORRUPT_FENCE')
  }
  const record = value as Record<string, unknown>
  exactKeys(record, [
    'rootSessionId',
    'contractId',
    'contractRevision',
    'contractDigest',
    'delegatedSessionId',
    'messageId',
    'messageDigest',
    'reason',
    'createdAt',
  ], 'delegated-input fence record')
  try {
    const normalized = normalizeInput(record as unknown as DelegatedInputFenceInput, Date.now)
    if (canonicalJson(normalized) !== canonicalJson(record)) throw new Error('record values are not canonical')
  } catch (error) {
    if (error instanceof DelegatedInputFenceError) throw error
    throw new DelegatedInputFenceError(
      `delegated-input fence record is malformed: ${error instanceof Error ? error.message : String(error)}`,
      'CORRUPT_FENCE',
    )
  }
}

function assertEnvelope(value: unknown): asserts value is FenceEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DelegatedInputFenceError('delegated-input fence envelope is not an object', 'CORRUPT_FENCE')
  }
  const envelope = value as Record<string, unknown>
  exactKeys(envelope, ['schemaVersion', 'record', 'recordDigest'], 'delegated-input fence envelope')
  if (envelope.schemaVersion !== DELEGATED_INPUT_FENCE_SCHEMA_VERSION) {
    throw new DelegatedInputFenceError('delegated-input fence envelope has an unsupported schema', 'CORRUPT_FENCE')
  }
  assertStoredFence(envelope.record)
  if (typeof envelope.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.recordDigest)) {
    throw new DelegatedInputFenceError('delegated-input fence record digest is malformed', 'CORRUPT_FENCE')
  }
  if (sha256(canonicalJson(envelope.record)) !== envelope.recordDigest) {
    throw new DelegatedInputFenceError('delegated-input fence record digest mismatch', 'CORRUPT_FENCE')
  }
}

function assertReference(value: unknown): asserts value is FenceReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DelegatedInputFenceError('delegated-input fence reference is not an object', 'CORRUPT_FENCE')
  }
  const reference = value as Record<string, unknown>
  exactKeys(reference, [
    'schemaVersion',
    'rootSessionId',
    'delegatedSessionId',
    'messageId',
    'recordDigest',
  ], 'delegated-input fence reference')
  if (reference.schemaVersion !== DELEGATED_INPUT_FENCE_SCHEMA_VERSION
    || typeof reference.rootSessionId !== 'string'
    || typeof reference.delegatedSessionId !== 'string'
    || typeof reference.messageId !== 'string'
    || typeof reference.recordDigest !== 'string') {
    throw new DelegatedInputFenceError('delegated-input fence reference is malformed', 'CORRUPT_FENCE')
  }
  try {
    if (nonEmpty(reference.rootSessionId, 'rootSessionId') !== reference.rootSessionId
      || nonEmpty(reference.delegatedSessionId, 'delegatedSessionId') !== reference.delegatedSessionId
      || nonEmpty(reference.messageId, 'messageId') !== reference.messageId
      || digest(reference.recordDigest, 'recordDigest') !== reference.recordDigest) {
      throw new Error('reference values are not canonical')
    }
  } catch (error) {
    throw new DelegatedInputFenceError(
      `delegated-input fence reference is malformed: ${error instanceof Error ? error.message : String(error)}`,
      'CORRUPT_FENCE',
    )
  }
}

function identityDigest(delegatedSessionId: string, messageId: string): string {
  return sha256(`${delegatedSessionId}\0${messageId}`)
}

function sessionDirectory(contractAnchorRoot: string, rootSessionId: string): string {
  return resolve(contractAnchorRoot, FENCE_DIRECTORY, sha256(rootSessionId))
}

function statePaths(contractAnchorRoot: string, rootSessionId: string): { records: string; references: string } {
  const directory = sessionDirectory(contractAnchorRoot, rootSessionId)
  return {
    records: join(directory, RECORD_DIRECTORY),
    references: join(directory, REFERENCE_DIRECTORY),
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function createImmutableFile(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const candidate = `${path}.${process.pid}.${randomUUID()}.candidate`
  const handle = await open(candidate, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(candidate, path)
    await syncDirectory(dirname(path))
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await rm(candidate, { force: true })
    await syncDirectory(dirname(path))
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new DelegatedInputFenceError(
      `cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'CORRUPT_FENCE',
    )
  }
}

function readJsonSync(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new DelegatedInputFenceError(
      `cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'CORRUPT_FENCE',
    )
  }
}

function referenceFor(fence: DelegatedInputFence, recordDigest: string): FenceReference {
  return {
    schemaVersion: DELEGATED_INPUT_FENCE_SCHEMA_VERSION,
    rootSessionId: fence.rootSessionId,
    delegatedSessionId: fence.delegatedSessionId,
    messageId: fence.messageId,
    recordDigest,
  }
}

function sameIdentity(left: DelegatedInputFence, right: Pick<DelegatedInputFence, 'delegatedSessionId' | 'messageId'>): boolean {
  return left.delegatedSessionId === right.delegatedSessionId && left.messageId === right.messageId
}

function inputMatchesFence(input: DelegatedInputFenceInput, fence: DelegatedInputFence): boolean {
  const normalized = normalizeInput({ ...input, createdAt: input.createdAt ?? fence.createdAt }, Date.now)
  return canonicalJson(normalized) === canonicalJson(fence)
}

async function readLoadedFences(contractAnchorRoot: string, rootSessionIdInput: string): Promise<LoadedFence[]> {
  const rootSessionId = nonEmpty(rootSessionIdInput, 'rootSessionId')
  const paths = statePaths(contractAnchorRoot, rootSessionId)
  let entries
  try {
    entries = await readdir(paths.references, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const loaded: LoadedFence[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith('.json')) continue
    if (!entry.isFile()) {
      throw new DelegatedInputFenceError(`delegated-input fence reference ${entry.name} is not a regular file`, 'CORRUPT_FENCE')
    }
    const referencePath = join(paths.references, entry.name)
    const referenceValue = await readJson(referencePath, 'delegated-input fence reference')
    assertReference(referenceValue)
    const expectedReferenceName = `${identityDigest(referenceValue.delegatedSessionId, referenceValue.messageId)}.json`
    if (entry.name !== expectedReferenceName || referenceValue.rootSessionId !== rootSessionId) {
      throw new DelegatedInputFenceError('delegated-input fence reference identity mismatch', 'CORRUPT_FENCE')
    }
    const recordPath = join(paths.records, `${referenceValue.recordDigest}.json`)
    const envelopeValue = await readJson(recordPath, 'delegated-input fence record')
    assertEnvelope(envelopeValue)
    if (envelopeValue.recordDigest !== referenceValue.recordDigest
      || envelopeValue.record.rootSessionId !== rootSessionId
      || envelopeValue.record.delegatedSessionId !== referenceValue.delegatedSessionId
      || envelopeValue.record.messageId !== referenceValue.messageId) {
      throw new DelegatedInputFenceError('delegated-input fence record does not match its durable reference', 'CORRUPT_FENCE')
    }
    loaded.push({
      fence: envelopeValue.record,
      recordDigest: envelopeValue.recordDigest,
      recordPath,
      referencePath,
    })
  }
  return loaded.sort((left, right) => (
    left.fence.createdAt.localeCompare(right.fence.createdAt)
      || left.fence.delegatedSessionId.localeCompare(right.fence.delegatedSessionId)
      || left.fence.messageId.localeCompare(right.fence.messageId)
  ))
}

function readLoadedFencesSync(contractAnchorRoot: string, rootSessionIdInput: string): LoadedFence[] {
  const rootSessionId = nonEmpty(rootSessionIdInput, 'rootSessionId')
  const paths = statePaths(contractAnchorRoot, rootSessionId)
  let entries
  try {
    entries = readdirSync(paths.references, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const loaded: LoadedFence[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith('.json')) continue
    if (!entry.isFile()) {
      throw new DelegatedInputFenceError(`delegated-input fence reference ${entry.name} is not a regular file`, 'CORRUPT_FENCE')
    }
    const referencePath = join(paths.references, entry.name)
    const referenceValue = readJsonSync(referencePath, 'delegated-input fence reference')
    assertReference(referenceValue)
    const expectedReferenceName = `${identityDigest(referenceValue.delegatedSessionId, referenceValue.messageId)}.json`
    if (entry.name !== expectedReferenceName || referenceValue.rootSessionId !== rootSessionId) {
      throw new DelegatedInputFenceError('delegated-input fence reference identity mismatch', 'CORRUPT_FENCE')
    }
    const recordPath = join(paths.records, `${referenceValue.recordDigest}.json`)
    const envelopeValue = readJsonSync(recordPath, 'delegated-input fence record')
    assertEnvelope(envelopeValue)
    if (envelopeValue.recordDigest !== referenceValue.recordDigest
      || envelopeValue.record.rootSessionId !== rootSessionId
      || envelopeValue.record.delegatedSessionId !== referenceValue.delegatedSessionId
      || envelopeValue.record.messageId !== referenceValue.messageId) {
      throw new DelegatedInputFenceError('delegated-input fence record does not match its durable reference', 'CORRUPT_FENCE')
    }
    loaded.push({
      fence: envelopeValue.record,
      recordDigest: envelopeValue.recordDigest,
      recordPath,
      referencePath,
    })
  }
  return loaded.sort((left, right) => (
    left.fence.createdAt.localeCompare(right.fence.createdAt)
      || left.fence.delegatedSessionId.localeCompare(right.fence.delegatedSessionId)
      || left.fence.messageId.localeCompare(right.fence.messageId)
  ))
}

export class DurableDelegatedInputFenceStore {
  private readonly contractAnchorRoot: string
  private readonly now: () => number

  constructor(contractAnchorRoot: string, options: DelegatedInputFenceStoreOptions = {}) {
    this.contractAnchorRoot = resolve(nonEmpty(contractAnchorRoot, 'contractAnchorRoot'))
    this.now = options.now ?? Date.now
  }

  async read(rootSessionId: string): Promise<DelegatedInputFence[]> {
    return (await readLoadedFences(this.contractAnchorRoot, rootSessionId)).map(item => structuredClone(item.fence))
  }

  readSync(rootSessionId: string): DelegatedInputFence[] {
    return readLoadedFencesSync(this.contractAnchorRoot, rootSessionId).map(item => structuredClone(item.fence))
  }

  async verify(basisInput: DelegatedInputContractBasis): Promise<DelegatedInputFence[]> {
    const basis = normalizeBasis(basisInput)
    const fences = await this.read(basis.rootSessionId)
    const mismatch = fences.find(fence => (
      fence.contractId !== basis.contractId
      || fence.contractRevision !== basis.contractRevision
      || fence.contractDigest !== basis.contractDigest
    ))
    if (mismatch !== undefined) {
      throw new DelegatedInputFenceError(
        `delegated input ${JSON.stringify(mismatch.messageId)} belongs to a different accepted contract`,
        'CONTRACT_MISMATCH',
      )
    }
    return fences
  }

  verifySync(basisInput: DelegatedInputContractBasis): DelegatedInputFence[] {
    const basis = normalizeBasis(basisInput)
    const fences = this.readSync(basis.rootSessionId)
    const mismatch = fences.find(fence => (
      fence.contractId !== basis.contractId
      || fence.contractRevision !== basis.contractRevision
      || fence.contractDigest !== basis.contractDigest
    ))
    if (mismatch !== undefined) {
      throw new DelegatedInputFenceError(
        `delegated input ${JSON.stringify(mismatch.messageId)} belongs to a different accepted contract`,
        'CONTRACT_MISMATCH',
      )
    }
    return fences
  }

  async record(input: DelegatedInputFenceInput): Promise<PersistedDelegatedInputFence> {
    const basis = normalizeBasis(input)
    const existing = (await readLoadedFences(this.contractAnchorRoot, basis.rootSessionId))
      .find(item => sameIdentity(item.fence, input))
    if (existing !== undefined) {
      if (!inputMatchesFence(input, existing.fence)) {
        throw new DelegatedInputFenceError(
          `delegated input ${JSON.stringify(existing.fence.messageId)} is already fenced with different content`,
          'FENCE_CONFLICT',
        )
      }
      return { created: false, fence: structuredClone(existing.fence) }
    }

    const fence = normalizeInput(input, this.now)
    const recordDigest = sha256(canonicalJson(fence))
    const envelope: FenceEnvelope = {
      schemaVersion: DELEGATED_INPUT_FENCE_SCHEMA_VERSION,
      record: fence,
      recordDigest,
    }
    const paths = statePaths(this.contractAnchorRoot, fence.rootSessionId)
    const recordPath = join(paths.records, `${recordDigest}.json`)
    const referencePath = join(paths.references, `${identityDigest(fence.delegatedSessionId, fence.messageId)}.json`)
    const recordCreated = await createImmutableFile(recordPath, `${JSON.stringify(envelope, null, 2)}\n`)
    try {
      const referenceCreated = await createImmutableFile(
        referencePath,
        `${JSON.stringify(referenceFor(fence, recordDigest), null, 2)}\n`,
      )
      if (referenceCreated) return { created: true, fence: structuredClone(fence) }

      const raced = (await readLoadedFences(this.contractAnchorRoot, fence.rootSessionId))
        .find(item => sameIdentity(item.fence, fence))
      if (raced === undefined || !inputMatchesFence(input, raced.fence)) {
        throw new DelegatedInputFenceError(
          `delegated input ${JSON.stringify(fence.messageId)} was concurrently fenced with different content`,
          'FENCE_CONFLICT',
        )
      }
      if (recordCreated && raced.recordDigest !== recordDigest) {
        await rm(recordPath, { force: true })
        await syncDirectory(paths.records)
      }
      return { created: false, fence: structuredClone(raced.fence) }
    } catch (error) {
      if (recordCreated) {
        await rm(recordPath, { force: true })
        await syncDirectory(paths.records)
      }
      throw error
    }
  }

  async clearAfterContractAdoption(adoptedInput: DelegatedInputContractBasis): Promise<number> {
    const adopted = normalizeBasis(adoptedInput)
    const anchor = readContractAnchorSync(this.contractAnchorRoot, adopted.rootSessionId)
    if (anchor === undefined
      || anchor.id !== adopted.contractId
      || anchor.revision !== adopted.contractRevision
      || anchor.documentDigest !== adopted.contractDigest) {
      throw new DelegatedInputFenceError(
        'the proposed clearing contract is not the durable contract anchor currently adopted by the root task',
        'ADOPTION_MISMATCH',
      )
    }

    const loaded = await readLoadedFences(this.contractAnchorRoot, adopted.rootSessionId)
    const unsuperseded = loaded.find(item => (
      adopted.contractRevision <= item.fence.contractRevision
      || adopted.contractDigest === item.fence.contractDigest
    ))
    if (unsuperseded !== undefined) {
      throw new DelegatedInputFenceError(
        `adopted contract revision ${adopted.contractRevision} does not supersede delegated input ${JSON.stringify(unsuperseded.fence.messageId)}`,
        'ADOPTION_MISMATCH',
      )
    }
    if (loaded.length === 0) return 0

    const paths = statePaths(this.contractAnchorRoot, adopted.rootSessionId)
    for (const item of loaded) {
      const referenceValue = await readJson(item.referencePath, 'delegated-input fence reference')
      assertReference(referenceValue)
      if (referenceValue.recordDigest !== item.recordDigest) {
        throw new DelegatedInputFenceError('delegated-input fence changed while it was being cleared', 'CORRUPT_FENCE')
      }
      await rm(item.referencePath, { force: true })
    }
    await syncDirectory(paths.references)
    for (const item of loaded) await rm(item.recordPath, { force: true })
    await syncDirectory(paths.records)
    return loaded.length
  }
}
