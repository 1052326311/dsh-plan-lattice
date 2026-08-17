import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'

export const EXECUTION_STATE_SCHEMA_VERSION = 1

const STATE_DIRECTORY = join('.dsh', 'plan-lattice', 'execution-state', 'v1')
const STATE_FILE = 'state.json'
const LOCK_FILE = '.lock'

export type ProcessLiveness = 'alive' | 'dead' | 'unknown'

export interface ExecutionLease {
  leaseId: string
  ownerSessionId: string
  rootSessionId: string
  nodeId: string
  graphRevision: number
  contractRevision: number
  contractDigest: string
  generation: number
  dirty: boolean
  checkpointRequired: boolean
  ownerPid: number
  ownerHost: string
  checkedOutAt: number
  updatedAt: number
}

export interface ExecutionStateSnapshot {
  schemaVersion: typeof EXECUTION_STATE_SCHEMA_VERSION
  generation: number
  lease: ExecutionLease | null
}

export interface ExecutionCheckoutRequest {
  ownerSessionId: string
  rootSessionId: string
  nodeId: string
  graphRevision: number
  contractRevision: number
  contractDigest: string
  /** Optional compare-and-swap guard over the complete persistent state. */
  expectedGeneration?: number
}

export interface ExecutionLeaseClaim {
  leaseId: string
  ownerSessionId: string
  rootSessionId: string
  nodeId: string
  generation: number
}

export interface CheckpointOptions {
  /** Atomically clear the checkpoint requirement and release ownership. */
  release?: boolean
  /** Graph revision containing the durable checkpoint evidence. */
  graphRevision?: number
}

export interface PersistentExecutionStateOptions {
  lockTimeoutMs?: number
  lockRetryMs?: number
  /** A definitely-dead process must remain unchanged for this long before takeover. */
  deadOwnerGraceMs?: number
  processId?: number
  host?: string
  processLiveness?: (pid: number) => ProcessLiveness
  now?: () => number
  /** Test seam for failures after state.json rename has become visible. */
  directorySync?: (path: string) => Promise<void>
  directorySyncAttempts?: number
}

interface LockRecord {
  schemaVersion: 1
  token: string
  ownerPid: number
  ownerHost: string
  createdAt: number
}

const DEFAULT_DIRECTORY_SYNC_ATTEMPTS = 3

class PostRenameDurabilityError extends Error {
  constructor(readonly target: string, cause: unknown) {
    super(`renamed execution-state target ${target} is visible but directory durability could not be confirmed`, { cause })
    this.name = 'PostRenameDurabilityError'
  }
}

export class ExecutionStateError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'CORRUPT_STATE'
      | 'GENERATION_MISMATCH'
      | 'LEASE_CONFLICT'
      | 'LEASE_OWNERSHIP'
      | 'CHECKPOINT_REQUIRED'
      | 'LOCK_TIMEOUT',
  ) {
    super(message)
    this.name = 'ExecutionStateError'
  }
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new TypeError(`${field} must be a non-empty string`)
  return normalized
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value
}

function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('generation must be a non-negative safe integer')
  return value
}

function contractDigest(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError('contractDigest must be a SHA-256 digest')
  return normalized
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function statePaths(workspace: string): { directory: string; state: string; lock: string } {
  const directory = resolve(workspace, STATE_DIRECTORY)
  return { directory, state: join(directory, STATE_FILE), lock: join(directory, LOCK_FILE) }
}

function defaultSnapshot(): ExecutionStateSnapshot {
  return { schemaVersion: EXECUTION_STATE_SCHEMA_VERSION, generation: 0, lease: null }
}

function assertLease(value: unknown, stateGeneration: number): asserts value is ExecutionLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('lease must be an object')
  }
  const lease = value as Partial<ExecutionLease>
  if (typeof lease.leaseId !== 'string'
    || typeof lease.ownerSessionId !== 'string'
    || typeof lease.rootSessionId !== 'string'
    || typeof lease.nodeId !== 'string'
    || !Number.isSafeInteger(lease.graphRevision) || lease.graphRevision! < 1
    || !Number.isSafeInteger(lease.contractRevision) || lease.contractRevision! < 1
    || typeof lease.contractDigest !== 'string' || !/^[0-9a-f]{64}$/.test(lease.contractDigest)
    || lease.generation !== stateGeneration
    || typeof lease.dirty !== 'boolean'
    || typeof lease.checkpointRequired !== 'boolean'
    || lease.dirty !== lease.checkpointRequired
    || !Number.isSafeInteger(lease.ownerPid) || lease.ownerPid! < 1
    || typeof lease.ownerHost !== 'string' || lease.ownerHost.length === 0
    || !Number.isSafeInteger(lease.checkedOutAt) || lease.checkedOutAt! < 0
    || !Number.isSafeInteger(lease.updatedAt) || lease.updatedAt! < lease.checkedOutAt!) {
    throw new Error('lease has an unsupported or malformed schema')
  }
}

function assertSnapshot(value: unknown): asserts value is ExecutionStateSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('execution state must be an object')
  }
  const state = value as Partial<ExecutionStateSnapshot>
  if (state.schemaVersion !== EXECUTION_STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(state.generation) || state.generation! < 0
    || (state.lease !== null && typeof state.lease !== 'object')) {
    throw new Error('execution state has an unsupported or malformed schema')
  }
  if (state.lease !== null) assertLease(state.lease, state.generation!)
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function confirmDirectoryDurability(
  target: string,
  directorySync: (path: string) => Promise<void>,
  attempts: number,
): Promise<void> {
  let failure: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await directorySync(dirname(target))
      return
    } catch (error) {
      failure = error
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new PostRenameDurabilityError(target, failure)
}

async function durableRemove(path: string): Promise<void> {
  await rm(path, { force: true })
  await syncDirectory(dirname(path))
}

async function atomicWrite(
  path: string,
  content: string,
  directorySync: (path: string) => Promise<void> = syncDirectory,
  directorySyncAttempts = DEFAULT_DIRECTORY_SYNC_ATTEMPTS,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  let renamed = false
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
    renamed = true
    await confirmDirectoryDurability(path, directorySync, directorySyncAttempts)
  } finally {
    try {
      await handle.close()
    } catch {
      // The successful path closes before rename so Windows can replace the target.
    }
    if (!renamed) await rm(temporary, { force: true })
  }
}

async function readSnapshot(path: string): Promise<ExecutionStateSnapshot> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    assertSnapshot(parsed)
    return parsed
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSnapshot()
    if (error instanceof ExecutionStateError) throw error
    throw new ExecutionStateError(
      `cannot read persistent execution state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'CORRUPT_STATE',
    )
  }
}

function readSnapshotSync(path: string): ExecutionStateSnapshot {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    assertSnapshot(parsed)
    return parsed
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSnapshot()
    if (error instanceof ExecutionStateError) throw error
    throw new ExecutionStateError(
      `cannot read persistent execution state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'CORRUPT_STATE',
    )
  }
}

function defaultProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'dead'
    return 'unknown'
  }
}

function assertLockRecord(value: unknown): asserts value is LockRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('lock is not an object')
  const record = value as Partial<LockRecord>
  if (record.schemaVersion !== 1
    || typeof record.token !== 'string' || record.token === ''
    || !Number.isSafeInteger(record.ownerPid) || record.ownerPid! < 1
    || typeof record.ownerHost !== 'string' || record.ownerHost === ''
    || !Number.isSafeInteger(record.createdAt) || record.createdAt! < 0) {
    throw new Error('lock has an unsupported or malformed schema')
  }
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    assertLockRecord(parsed)
    return parsed
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

function recoveryName(token: string): string {
  return `.recover-${createHash('sha256').update(token).digest('hex')}.lock`
}

async function createExclusiveDurableFile(path: string, content: string): Promise<boolean> {
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

export function executionLeaseClaim(lease: ExecutionLease): ExecutionLeaseClaim {
  return {
    leaseId: lease.leaseId,
    ownerSessionId: lease.ownerSessionId,
    rootSessionId: lease.rootSessionId,
    nodeId: lease.nodeId,
    generation: lease.generation,
  }
}

/**
 * Durable, workspace-scoped execution ownership. Every transition is serialized
 * by a cross-process file lock and committed as one fsync + atomic rename.
 */
export class PersistentExecutionState {
  private readonly lockTimeoutMs: number
  private readonly lockRetryMs: number
  private readonly deadOwnerGraceMs: number
  private readonly processId: number
  private readonly host: string
  private readonly processLiveness: (pid: number) => ProcessLiveness
  private readonly now: () => number
  private readonly directorySync: (path: string) => Promise<void>
  private readonly directorySyncAttempts: number

  constructor(options: PersistentExecutionStateOptions = {}) {
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 5_000, 'lockTimeoutMs')
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? 20, 'lockRetryMs')
    this.deadOwnerGraceMs = generation(options.deadOwnerGraceMs ?? 1_000)
    this.processId = positiveInteger(options.processId ?? process.pid, 'processId')
    this.host = nonEmpty(options.host ?? hostname(), 'host')
    this.processLiveness = options.processLiveness ?? defaultProcessLiveness
    this.now = options.now ?? Date.now
    this.directorySyncAttempts = positiveInteger(
      options.directorySyncAttempts ?? DEFAULT_DIRECTORY_SYNC_ATTEMPTS,
      'directorySyncAttempts',
    )
    this.directorySync = options.directorySync ?? syncDirectory
  }

  async read(workspace: string): Promise<ExecutionStateSnapshot> {
    return clone(await readSnapshot(statePaths(workspace).state))
  }

  /**
   * Read one atomic state-file snapshot without acquiring ownership. This is
   * suitable for resume/disposal discovery, never as authority for a later write.
   */
  readSync(workspace: string): ExecutionStateSnapshot {
    return clone(readSnapshotSync(statePaths(workspace).state))
  }

  /**
   * Verify that a claim names the current lease owned by this process. The
   * result is observational: callers must still await markDirty before entering
   * a protected tool body because another transition can follow this read.
   */
  verifyOwnershipSync(workspace: string, claim: ExecutionLeaseClaim): ExecutionLease {
    const state = readSnapshotSync(statePaths(workspace).state)
    return clone(this.assertClaim(state, claim))
  }

  async checkout(workspace: string, request: ExecutionCheckoutRequest): Promise<ExecutionLease> {
    const normalized = this.normalizeCheckout(request)
    return this.withLock(workspace, async paths => {
      const current = await readSnapshot(paths.state)
      this.assertExpectedGeneration(current, normalized.expectedGeneration)
      if (current.lease !== null) this.assertTakeoverAllowed(current.lease, normalized)

      const nextGeneration = current.generation + 1
      const now = this.now()
      const inheritedDirty = current.lease?.dirty === true
      const lease: ExecutionLease = {
        leaseId: randomUUID(),
        ownerSessionId: normalized.ownerSessionId,
        rootSessionId: normalized.rootSessionId,
        nodeId: normalized.nodeId,
        graphRevision: normalized.graphRevision,
        contractRevision: normalized.contractRevision,
        contractDigest: normalized.contractDigest,
        generation: nextGeneration,
        dirty: inheritedDirty,
        checkpointRequired: inheritedDirty,
        ownerPid: this.processId,
        ownerHost: this.host,
        checkedOutAt: now,
        updatedAt: now,
      }
      await this.write(paths.state, { schemaVersion: EXECUTION_STATE_SCHEMA_VERSION, generation: nextGeneration, lease })
      return clone(lease)
    })
  }

  async markDirty(workspace: string, claim: ExecutionLeaseClaim): Promise<ExecutionLease> {
    return this.updateOwned(workspace, claim, async (state, lease, path) => {
      if (lease.dirty) return clone(lease)
      const updated = this.advanceLease(state, lease, { dirty: true, checkpointRequired: true })
      await this.write(path, { ...state, generation: updated.generation, lease: updated })
      return clone(updated)
    })
  }

  async checkpoint(
    workspace: string,
    claim: ExecutionLeaseClaim,
    options: CheckpointOptions = {},
  ): Promise<ExecutionStateSnapshot> {
    return this.updateOwned(workspace, claim, async (state, lease, path) => {
      const graphRevision = options.graphRevision === undefined
        ? lease.graphRevision
        : positiveInteger(options.graphRevision, 'graphRevision')
      if (graphRevision < lease.graphRevision) {
        throw new ExecutionStateError('checkpoint graph revision cannot move backwards', 'GENERATION_MISMATCH')
      }
      const nextGeneration = state.generation + 1
      const next: ExecutionStateSnapshot = options.release === true
        ? { schemaVersion: EXECUTION_STATE_SCHEMA_VERSION, generation: nextGeneration, lease: null }
        : {
            schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
            generation: nextGeneration,
            lease: {
              ...lease,
              graphRevision,
              generation: nextGeneration,
              dirty: false,
              checkpointRequired: false,
              updatedAt: this.now(),
            },
          }
      await this.write(path, next)
      return clone(next)
    })
  }

  async release(workspace: string, claim: ExecutionLeaseClaim): Promise<ExecutionStateSnapshot> {
    return this.updateOwned(workspace, claim, async (state, lease, path) => {
      if (lease.dirty || lease.checkpointRequired) {
        throw new ExecutionStateError('dirty execution ownership requires checkpoint before release', 'CHECKPOINT_REQUIRED')
      }
      const next: ExecutionStateSnapshot = {
        schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
        generation: state.generation + 1,
        lease: null,
      }
      await this.write(path, next)
      return clone(next)
    })
  }

  private normalizeCheckout(request: ExecutionCheckoutRequest): ExecutionCheckoutRequest {
    return {
      ownerSessionId: nonEmpty(request.ownerSessionId, 'ownerSessionId'),
      rootSessionId: nonEmpty(request.rootSessionId, 'rootSessionId'),
      nodeId: nonEmpty(request.nodeId, 'nodeId'),
      graphRevision: positiveInteger(request.graphRevision, 'graphRevision'),
      contractRevision: positiveInteger(request.contractRevision, 'contractRevision'),
      contractDigest: contractDigest(request.contractDigest),
      ...(request.expectedGeneration === undefined ? {} : { expectedGeneration: generation(request.expectedGeneration) }),
    }
  }

  private assertExpectedGeneration(state: ExecutionStateSnapshot, expected: number | undefined): void {
    if (expected !== undefined && expected !== state.generation) {
      throw new ExecutionStateError(
        `stale execution generation: expected ${expected}, current ${state.generation}`,
        'GENERATION_MISMATCH',
      )
    }
  }

  private ownerLiveness(ownerPid: number, ownerHost: string): ProcessLiveness {
    if (ownerHost !== this.host) return 'unknown'
    if (ownerPid === this.processId) return 'alive'
    return this.processLiveness(ownerPid)
  }

  private assertTakeoverAllowed(lease: ExecutionLease, request: ExecutionCheckoutRequest): void {
    if (this.ownerLiveness(lease.ownerPid, lease.ownerHost) !== 'dead'
      || this.now() - lease.updatedAt < this.deadOwnerGraceMs) {
      throw new ExecutionStateError(
        `execution node ${JSON.stringify(lease.nodeId)} is owned by live or unverifiable process ${lease.ownerHost}:${lease.ownerPid}`,
        'LEASE_CONFLICT',
      )
    }
    if (lease.dirty && (
      request.rootSessionId !== lease.rootSessionId
      || request.nodeId !== lease.nodeId
      || request.graphRevision !== lease.graphRevision
      || request.contractRevision !== lease.contractRevision
      || request.contractDigest !== lease.contractDigest
    )) {
      throw new ExecutionStateError(
        'dirty dead-owner takeover must preserve the exact root, node, graph, and contract basis until checkpoint',
        'CHECKPOINT_REQUIRED',
      )
    }
  }

  private assertClaim(state: ExecutionStateSnapshot, claim: ExecutionLeaseClaim): ExecutionLease {
    const lease = state.lease
    if (lease === null
      || claim.generation !== state.generation
      || claim.generation !== lease.generation
      || claim.leaseId !== lease.leaseId
      || claim.ownerSessionId !== lease.ownerSessionId
      || claim.rootSessionId !== lease.rootSessionId
      || claim.nodeId !== lease.nodeId) {
      throw new ExecutionStateError('execution ownership claim is stale or belongs to another lease', 'LEASE_OWNERSHIP')
    }
    if (lease.ownerPid !== this.processId || lease.ownerHost !== this.host) {
      throw new ExecutionStateError('execution ownership belongs to another process', 'LEASE_OWNERSHIP')
    }
    return lease
  }

  private advanceLease(
    state: ExecutionStateSnapshot,
    lease: ExecutionLease,
    changes: Pick<ExecutionLease, 'dirty' | 'checkpointRequired'>,
  ): ExecutionLease {
    return {
      ...lease,
      ...changes,
      generation: state.generation + 1,
      updatedAt: this.now(),
    }
  }

  private async updateOwned<T>(
    workspace: string,
    claim: ExecutionLeaseClaim,
    update: (state: ExecutionStateSnapshot, lease: ExecutionLease, path: string) => Promise<T>,
  ): Promise<T> {
    return this.withLock(workspace, async paths => {
      const state = await readSnapshot(paths.state)
      return update(state, this.assertClaim(state, claim), paths.state)
    })
  }

  private async write(path: string, state: ExecutionStateSnapshot): Promise<void> {
    assertSnapshot(state)
    await atomicWrite(
      path,
      `${JSON.stringify(state, null, 2)}\n`,
      this.directorySync,
      this.directorySyncAttempts,
    )
  }

  private async withLock<T>(workspace: string, operation: (paths: ReturnType<typeof statePaths>) => Promise<T>): Promise<T> {
    const paths = statePaths(workspace)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const release = await this.acquireLock(paths)
    let retainLock = false
    try {
      return await operation(paths)
    } catch (error) {
      if (error instanceof PostRenameDurabilityError) retainLock = true
      throw error
    } finally {
      if (!retainLock) await release()
    }
  }

  private async acquireLock(paths: ReturnType<typeof statePaths>): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.lockTimeoutMs
    while (true) {
      const record: LockRecord = {
        schemaVersion: 1,
        token: randomUUID(),
        ownerPid: this.processId,
        ownerHost: this.host,
        createdAt: this.now(),
      }
      if (await createExclusiveDurableFile(paths.lock, `${JSON.stringify(record)}\n`)) {
        return async () => {
          const current = await readLock(paths.lock)
          if (current?.token !== record.token) {
            throw new ExecutionStateError('execution-state lock ownership changed before release', 'LEASE_OWNERSHIP')
          }
          await durableRemove(paths.lock)
        }
      }

      const existing = await readLock(paths.lock)
      if (existing !== undefined
        && this.ownerLiveness(existing.ownerPid, existing.ownerHost) === 'dead'
        && this.now() - existing.createdAt >= this.deadOwnerGraceMs) {
        await this.tryReclaimDeadLock(paths, existing)
      }
      if (Date.now() >= deadline) {
        throw new ExecutionStateError(`timed out waiting for execution-state lock ${paths.lock}`, 'LOCK_TIMEOUT')
      }
      await new Promise(resolve => setTimeout(resolve, this.lockRetryMs))
    }
  }

  private async tryReclaimDeadLock(paths: ReturnType<typeof statePaths>, observed: LockRecord): Promise<void> {
    const recoveryPath = join(paths.directory, recoveryName(observed.token))
    const recovery: LockRecord = {
      schemaVersion: 1,
      token: randomUUID(),
      ownerPid: this.processId,
      ownerHost: this.host,
      createdAt: this.now(),
    }
    if (!await createExclusiveDurableFile(recoveryPath, `${JSON.stringify(recovery)}\n`)) return
    try {
      const current = await readLock(paths.lock)
      if (current?.token === observed.token
        && this.ownerLiveness(current.ownerPid, current.ownerHost) === 'dead'
        && this.now() - current.createdAt >= this.deadOwnerGraceMs) {
        // A retained lock can mean the prior owner renamed state.json but
        // could not confirm the parent directory. Confirm that visibility
        // before removing the only fence protecting the recoverable claim.
        await confirmDirectoryDurability(
          paths.state,
          this.directorySync,
          this.directorySyncAttempts,
        )
        await durableRemove(paths.lock)
      }
    } finally {
      await durableRemove(recoveryPath)
    }
  }
}
