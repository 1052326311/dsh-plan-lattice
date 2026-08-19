import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LatticeDelta, LatticeState, MechanicalExecutionReceipt } from './domain.js'
import { assertMechanicalExecutionReceipt, LATTICE_SCHEMA_VERSION, publicState } from './domain.js'

const DIRECTORY = join('.dsh', 'plan-lattice', 'v1')
const SNAPSHOT_FILE = 'snapshot.json'
const LEDGER_FILE = 'ledger.jsonl'
const HISTORY_FILE = 'history.jsonl'
const VERSION_FILE = 'version'
const LOCK_FILE = '.lock'
const PENDING_CREATE_VERSION = '0'
const RECOVERY_LOCK_SUFFIX = '.recovery'
const SYNC_READ_ATTEMPTS = 8
const SYNC_RETRY_DELAY_MS = 10
const DEFAULT_DIRECTORY_SYNC_ATTEMPTS = 3
const syncRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

interface LoggedDelta extends LatticeDelta {
  at: number
  action: string
}

export interface Mutation<T> {
  value: T
  delta: LatticeDelta
}

export interface StoreOptions {
  snapshotEvery: number
  /** Test seam for failures after rename has made a new generation visible. */
  directorySync?: (path: string) => Promise<void>
  directorySyncAttempts?: number
}

interface CachedState {
  state: LatticeState
  generation: string
  ledgerEntries: number
  normalizedLedger: string
  ledgerNeedsNormalization: boolean
}

interface LockMetadata {
  pid: number
  ownerToken: string
  acquiredAt: number
}

type BeforeCommit = () => void | Promise<void>

class PostRenameDurabilityError extends Error {
  constructor(readonly target: string, cause: unknown) {
    super(`renamed lattice target ${target} is visible but directory durability could not be confirmed`, { cause })
    this.name = 'PostRenameDurabilityError'
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function syncDirectorySync(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
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
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, SYNC_RETRY_DELAY_MS))
    }
  }
  throw new PostRenameDurabilityError(target, failure)
}

function paths(workspace: string): Record<'directory' | 'snapshot' | 'ledger' | 'history' | 'version' | 'lock', string> {
  const directory = join(workspace, DIRECTORY)
  return {
    directory,
    snapshot: join(directory, SNAPSHOT_FILE),
    ledger: join(directory, LEDGER_FILE),
    history: join(directory, HISTORY_FILE),
    version: join(directory, VERSION_FILE),
    lock: join(directory, LOCK_FILE),
  }
}

function isState(value: unknown): value is LatticeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === LATTICE_SCHEMA_VERSION
    && Number.isSafeInteger(record.revision)
    && record.revision as number >= 1
    && typeof record.project === 'object'
    && record.project !== null
    && typeof record.nodes === 'object'
    && record.nodes !== null
}

function assertReceiptMap(value: unknown, field: string): asserts value is Record<string, MechanicalExecutionReceipt> | undefined {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  for (const [attemptId, receipt] of Object.entries(value)) {
    assertMechanicalExecutionReceipt(receipt)
    if (receipt.attemptId !== attemptId) {
      throw new Error(`${field} key does not match mechanical execution attemptId`)
    }
  }
}

function assertReceiptDelta(value: unknown): asserts value is MechanicalExecutionReceipt[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('lattice executionReceipts delta must be an array')
  for (const receipt of value) assertMechanicalExecutionReceipt(receipt)
}

function applyDelta(state: LatticeState, delta: LatticeDelta): void {
  if (delta.revision !== state.revision + 1) {
    throw new Error(`invalid lattice ledger revision ${delta.revision}; expected ${state.revision + 1}`)
  }
  if (delta.project !== undefined) state.project = delta.project
  for (const node of delta.upserts) state.nodes[node.id] = node
  if (delta.executionReceipts !== undefined) {
    assertReceiptDelta(delta.executionReceipts)
    state.executionReceipts ??= {}
    for (const receipt of delta.executionReceipts) {
      if (state.executionReceipts[receipt.attemptId] !== undefined) {
        throw new Error(`duplicate mechanical execution receipt ${JSON.stringify(receipt.attemptId)}`)
      }
      state.executionReceipts[receipt.attemptId] = receipt
    }
  }
  state.revision = delta.revision
}

function readOptionalSync(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function versionRevision(value: string | undefined, path: string): number | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!/^[1-9]\d*$/.test(normalized)) throw new Error(`invalid lattice version ${path}`)
  const revision = Number(normalized)
  if (!Number.isSafeInteger(revision)) throw new Error(`invalid lattice version ${path}`)
  return revision
}

function lockMetadata(value: string | undefined): LockMetadata | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) return undefined
    if (typeof record.ownerToken !== 'string' || !/^[a-zA-Z0-9._-]{16,128}$/.test(record.ownerToken)) return undefined
    if (!Number.isSafeInteger(record.acquiredAt) || (record.acquiredAt as number) < 1) return undefined
    return {
      pid: record.pid as number,
      ownerToken: record.ownerToken,
      acquiredAt: record.acquiredAt as number,
    }
  } catch {
    return undefined
  }
}

/** PID reuse is intentionally treated as a live owner; only ESRCH proves death. */
function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function acquireRecoverySync(lockPath: string): (() => void) | undefined {
  const recoveryPath = `${lockPath}${RECOVERY_LOCK_SUFFIX}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const metadata: LockMetadata = {
      pid: process.pid,
      ownerToken: randomUUID(),
      acquiredAt: Date.now(),
    }
    const candidate = `${recoveryPath}.${metadata.ownerToken}.candidate`
    writeFileSync(candidate, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', flag: 'wx' })
    try {
      linkSync(candidate, recoveryPath)
      return () => {
        const current = lockMetadata(readOptionalSync(recoveryPath))
        if (current?.ownerToken === metadata.ownerToken) rmSync(recoveryPath, { force: true })
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = lockMetadata(readOptionalSync(recoveryPath))
      if (holder === undefined || !processIsDefinitelyDead(holder.pid)) return undefined
      const observed = readOptionalSync(recoveryPath)
      if (observed === readOptionalSync(recoveryPath)) rmSync(recoveryPath, { force: true })
    } finally {
      rmSync(candidate, { force: true })
    }
  }
  return undefined
}

function recoverDeadLockSync(lockPath: string): boolean {
  const observed = readOptionalSync(lockPath)
  const metadata = lockMetadata(observed)
  if (metadata === undefined || !processIsDefinitelyDead(metadata.pid)) return false
  const releaseRecovery = acquireRecoverySync(lockPath)
  if (releaseRecovery === undefined) return false
  try {
    const current = readOptionalSync(lockPath)
    const currentMetadata = lockMetadata(current)
    if (current !== observed
      || currentMetadata?.ownerToken !== metadata.ownerToken
      || !processIsDefinitelyDead(metadata.pid)) return false
    // The retained lock means a prior rename may be visible but not yet
    // directory-durable. Confirm that directory before making the lock reusable.
    syncDirectorySync(dirname(lockPath))
    rmSync(lockPath)
    rmSync(`${lockPath}.${metadata.ownerToken}.candidate`, { force: true })
    syncDirectorySync(dirname(lockPath))
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  } finally {
    releaseRecovery()
  }
}

interface MaterializedLedger {
  state: LatticeState
  ledgerEntries: number
  normalizedLedger: string
  ledgerNeedsNormalization: boolean
}

function materializeLedger(
  snapshot: string,
  ledger: string | undefined,
  committedRevision: number | undefined,
  location: ReturnType<typeof paths>,
): MaterializedLedger {
  const parsed: unknown = JSON.parse(snapshot)
  if (!isState(parsed)) throw new Error(`invalid lattice snapshot ${location.snapshot}`)
  const state = parsed as LatticeState
  assertReceiptMap(state.executionReceipts, 'lattice snapshot executionReceipts')
  const snapshotRevision = state.revision
  const rawLedger = ledger ?? ''
  const lines = rawLedger.split('\n').filter(Boolean)

  if (committedRevision === undefined) {
    for (const line of lines) applyDelta(state, JSON.parse(line) as LoggedDelta)
    return {
      state,
      ledgerEntries: lines.length,
      normalizedLedger: rawLedger,
      ledgerNeedsNormalization: false,
    }
  }
  if (snapshotRevision > committedRevision) {
    throw new Error(`snapshot revision ${snapshotRevision} exceeds committed version ${committedRevision}`)
  }

  const committedLines: string[] = []
  let sawUncommittedTail = false
  for (const line of lines) {
    // Once the commit marker has been fully materialized, no later bytes can
    // affect visible state. This also tolerates a process dying mid-append and
    // leaving a truncated JSON fragment in the uncommitted tail.
    if (state.revision === committedRevision) {
      sawUncommittedTail = true
      continue
    }
    const entry = JSON.parse(line) as LoggedDelta
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
      throw new Error(`invalid lattice ledger revision in ${location.ledger}`)
    }
    // A committed snapshot may briefly coexist with the ledger it supersedes.
    if (entry.revision <= snapshotRevision) continue
    if (entry.revision > committedRevision) {
      sawUncommittedTail = true
      continue
    }
    if (sawUncommittedTail) {
      throw new Error(`committed lattice revision ${entry.revision} appears after an uncommitted ledger tail`)
    }
    applyDelta(state, entry)
    committedLines.push(line)
  }
  if (state.revision !== committedRevision) {
    throw new Error(`materialized revision ${state.revision} does not match committed version ${committedRevision}`)
  }
  const normalizedLedger = committedLines.length === 0 ? '' : `${committedLines.join('\n')}\n`
  return {
    state,
    ledgerEntries: committedLines.length,
    normalizedLedger,
    ledgerNeedsNormalization: normalizedLedger !== rawLedger,
  }
}

function retrySyncRead(): void {
  Atomics.wait(syncRetrySignal, 0, 0, SYNC_RETRY_DELAY_MS)
}

/**
 * Rebuild the durable graph for the synchronous tool guard. This deliberately
 * bypasses the process cache so another runtime cannot leave an old plan basis
 * looking current.
 */
export function readLatticeStateSync(workspace: string): LatticeState | undefined {
  const location = paths(workspace)
  let lastFailure = 'the durable generation did not stabilize'
  for (let attempt = 1; attempt <= SYNC_READ_ATTEMPTS; attempt += 1) {
    if (existsSync(location.lock) && !recoverDeadLockSync(location.lock)) {
      lastFailure = `writer lock is present at ${location.lock}`
    } else {
      const versionBefore = readOptionalSync(location.version)
      let state: LatticeState | undefined
      let materializationFailure: string | undefined
      try {
        const ledger = readOptionalSync(location.ledger)
        const snapshot = readOptionalSync(location.snapshot)
        if (snapshot === undefined) {
          if (ledger !== undefined || versionBefore !== undefined) {
            materializationFailure = 'snapshot is missing while ledger or version state exists'
          }
        } else {
          state = materializeLedger(
            snapshot,
            ledger,
            versionRevision(versionBefore, location.version),
            location,
          ).state
        }
      } catch (error) {
        materializationFailure = error instanceof Error ? error.message : 'unknown snapshot or ledger failure'
      }

      const versionAfter = readOptionalSync(location.version)
      if (existsSync(location.lock)) {
        lastFailure = `writer lock appeared during the read at ${location.lock}`
      } else if (versionBefore !== versionAfter) {
        lastFailure = `version changed during the read (${JSON.stringify(versionBefore?.trim())} -> ${JSON.stringify(versionAfter?.trim())})`
      } else if (materializationFailure !== undefined) {
        lastFailure = materializationFailure
      } else if (state === undefined) {
        return undefined
      } else {
        return state
      }
    }
    if (attempt < SYNC_READ_ATTEMPTS) retrySyncRead()
  }
  throw new Error(`failed to read a consistent lattice state from ${location.directory} after ${SYNC_READ_ATTEMPTS} attempts: ${lastFailure}`)
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function atomicWrite(
  path: string,
  content: string,
  beforeCommit: BeforeCommit = () => {},
  directorySync: (path: string) => Promise<void> = syncDirectory,
  directorySyncAttempts = DEFAULT_DIRECTORY_SYNC_ATTEMPTS,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  let renamed = false
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    // The rename is the first durable visibility point. Recheck authority here,
    // after asynchronous staging, so an invalidation cannot land in between the
    // final check and the commit syscall.
    await beforeCommit()
    await rename(temporary, path)
    renamed = true
    await confirmDirectoryDurability(path, directorySync, directorySyncAttempts)
  } finally {
    try {
      await handle.close()
    } catch {
      // The successful path closes before rename for cross-platform atomic replacement.
    }
    if (!renamed) await rm(temporary, { force: true })
  }
}

async function durableAppend(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function acquire(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true })
  const metadata: LockMetadata = {
    pid: process.pid,
    ownerToken: randomUUID(),
    acquiredAt: Date.now(),
  }
  const candidate = `${lockPath}.${metadata.ownerToken}.candidate`
  const candidateHandle = await open(candidate, 'wx', 0o600)
  try {
    await candidateHandle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8')
    await candidateHandle.sync()
  } finally {
    await candidateHandle.close()
  }
  const deadline = Date.now() + 5_000
  try {
    while (true) {
      try {
        // Linking a fully written candidate means .lock is never observed with
        // partial owner metadata, even if the process dies during acquisition.
        await link(candidate, lockPath)
        return async () => {
          const current = lockMetadata(await readOptional(lockPath))
          if (current?.ownerToken === metadata.ownerToken) await rm(lockPath, { force: true })
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        recoverDeadLockSync(lockPath)
        if (Date.now() >= deadline) throw new Error(`timed out waiting for lattice lock ${lockPath}`)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  } finally {
    await rm(candidate, { force: true })
  }
}

export class LatticeStore {
  private readonly cache = new Map<string, CachedState>()
  private readonly directorySync: (path: string) => Promise<void>
  private readonly directorySyncAttempts: number

  constructor(private readonly options: StoreOptions = { snapshotEvery: 1024 }) {
    if (!Number.isSafeInteger(options.snapshotEvery) || options.snapshotEvery < 1) {
      throw new Error('snapshotEvery must be a positive safe integer')
    }
    this.directorySyncAttempts = options.directorySyncAttempts ?? DEFAULT_DIRECTORY_SYNC_ATTEMPTS
    if (!Number.isSafeInteger(this.directorySyncAttempts) || this.directorySyncAttempts < 1) {
      throw new Error('directorySyncAttempts must be a positive safe integer')
    }
    this.directorySync = options.directorySync ?? syncDirectory
  }

  /** Forget process-local materialization before an authorization read. */
  invalidate(workspace: string): void {
    this.cache.delete(workspace)
  }

  private async load(workspace: string, fresh = false): Promise<CachedState | undefined> {
    const location = paths(workspace)
    let lastFailure = 'the durable generation did not stabilize'
    for (let attempt = 1; attempt <= SYNC_READ_ATTEMPTS; attempt += 1) {
      const versionBefore = await readOptional(location.version)
      const generation = versionBefore?.trim()
      const cached = this.cache.get(workspace)
      if (!fresh && generation !== undefined && cached?.generation === generation) return cached

      try {
        // Ledger-first ordering makes both sides of post-commit compaction safe:
        // old ledger + new snapshot and new ledger + new snapshot materialize
        // the same committed revision.
        const ledger = await readOptional(location.ledger)
        const snapshot = await readOptional(location.snapshot)
        const versionAfter = await readOptional(location.version)
        if (versionBefore !== versionAfter) {
          lastFailure = 'version changed during lattice materialization'
        } else if (snapshot === undefined) {
          if (ledger !== undefined || versionBefore !== undefined) {
            throw new Error('snapshot is missing while ledger or version state exists')
          }
          return undefined
        } else {
          const materialized = materializeLedger(
            snapshot,
            ledger,
            versionRevision(versionAfter, location.version),
            location,
          )
          const loaded: CachedState = {
            ...materialized,
            // Pre-generation v1 graphs remain readable, but are reloaded until
            // their next successful mutation creates a commit marker.
            generation: generation ?? `legacy:${materialized.state.revision}:${materialized.ledgerEntries}`,
          }
          this.cache.set(workspace, loaded)
          return loaded
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : 'unknown lattice materialization failure'
      }
      if (attempt < SYNC_READ_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, SYNC_RETRY_DELAY_MS))
    }
    throw new Error(`failed to read a consistent lattice state from ${location.directory}: ${lastFailure}`)
  }

  /** Return an isolated JSON copy for callers that need to expose state. */
  async read(workspace: string): Promise<LatticeState | undefined> {
    const loaded = await this.load(workspace)
    return loaded === undefined ? undefined : publicState(loaded.state)
  }

  /** Return the process-local materialized state for bounded internal projections. Never mutate it. */
  async peek(workspace: string): Promise<LatticeState | undefined> {
    return (await this.load(workspace))?.state
  }

  async create<T>(workspace: string, initial: LatticeState, value: T, beforeCommit: () => void = () => {}): Promise<T> {
    if (!isState(initial)) throw new TypeError('initial lattice state is invalid')
    assertReceiptMap(initial.executionReceipts, 'initial lattice executionReceipts')
    const location = paths(workspace)
    const release = await acquire(location.lock)
    let ownsPendingBundle = false
    let retainLock = false
    try {
      const existingVersion = await readOptional(location.version)
      if (existingVersion?.trim() === PENDING_CREATE_VERSION) {
        // A dead creator may leave a staged graph behind. The pending marker is
        // never a readable generation, so recovery can discard the whole bundle.
        await rm(location.snapshot, { force: true })
        await rm(location.ledger, { force: true })
        await rm(location.history, { force: true })
        await rm(location.version, { force: true })
      } else if (existingVersion !== undefined || await readOptional(location.snapshot) !== undefined) {
        throw new Error('a lattice already exists for this workspace')
      }
      // Publish an explicitly unreadable generation before any graph bytes.
      // The final version rename below is the only creation commit point.
      await atomicWrite(location.version, `${PENDING_CREATE_VERSION}\n`, undefined, this.directorySync, this.directorySyncAttempts)
      ownsPendingBundle = true
      await atomicWrite(location.snapshot, `${JSON.stringify(initial, null, 2)}\n`, beforeCommit, this.directorySync, this.directorySyncAttempts)
      await atomicWrite(location.ledger, '', undefined, this.directorySync, this.directorySyncAttempts)
      await durableAppend(location.history, `${JSON.stringify({ at: Date.now(), action: 'create', revision: initial.revision })}\n`)
      await atomicWrite(location.version, `${initial.revision}\n`, beforeCommit, this.directorySync, this.directorySyncAttempts)
      this.cache.set(workspace, {
        state: publicState(initial),
        generation: String(initial.revision),
        ledgerEntries: 0,
        normalizedLedger: '',
        ledgerNeedsNormalization: false,
      })
      return value
    } catch (error) {
      this.cache.delete(workspace)
      const marker = await readOptional(location.version)
      if (ownsPendingBundle && marker?.trim() === String(initial.revision)) {
        // The final rename is the commit point. A later directory-fsync error
        // may be retried, but success is reported only after durability is
        // confirmed. Failure leaves the visible commit intact for recovery.
        try {
          await confirmDirectoryDurability(
            location.version,
            this.directorySync,
            this.directorySyncAttempts,
          )
        } catch (confirmationError) {
          retainLock = confirmationError instanceof PostRenameDurabilityError
          throw confirmationError
        }
        this.cache.set(workspace, {
          state: publicState(initial),
          generation: String(initial.revision),
          ledgerEntries: 0,
          normalizedLedger: '',
          ledgerNeedsNormalization: false,
        })
        return value
      }
      if (error instanceof PostRenameDurabilityError) {
        // Any target rename may already be visible. Keep both the pending
        // bundle and its writer boundary intact until dead-owner recovery can
        // confirm the directory before deciding whether to resume or replace it.
        retainLock = true
        throw error
      }
      if (ownsPendingBundle && marker?.trim() === PENDING_CREATE_VERSION) {
        await rm(location.snapshot, { force: true })
        await rm(location.ledger, { force: true })
        await rm(location.history, { force: true })
        await rm(location.version, { force: true })
      }
      throw error
    } finally {
      if (!retainLock) await release()
    }
  }

  async mutate<T>(
    workspace: string,
    action: string,
    mutate: (state: LatticeState) => Mutation<T>,
    beforeCommit: BeforeCommit = () => {},
  ): Promise<T> {
    const location = paths(workspace)
    const release = await acquire(location.lock)
    let retainLock = false
    try {
      try {
        const loaded = await this.load(workspace, true)
        if (loaded === undefined) throw new Error('no lattice exists for this workspace')
        if (loaded.ledgerNeedsNormalization) {
          await atomicWrite(
            location.ledger,
            loaded.normalizedLedger,
            undefined,
            this.directorySync,
            this.directorySyncAttempts,
          )
        }
        const previousRevision = loaded.state.revision
        const result = mutate(loaded.state)
        if (loaded.state.revision !== previousRevision + 1 || result.delta.revision !== loaded.state.revision) {
          throw new Error(`mutation ${action} must advance the lattice revision`)
        }
        assertReceiptDelta(result.delta.executionReceipts)
        const entry: LoggedDelta = { ...result.delta, action, at: Date.now() }
        await durableAppend(location.ledger, `${JSON.stringify(entry)}\n`)
        await durableAppend(location.history, `${JSON.stringify(entry)}\n`)
        const entryCount = loaded.ledgerEntries + 1
        const generation = String(loaded.state.revision)
        // The version rename is the transaction commit point. Ledger data may
        // exist before it, but readers never expose revisions beyond this marker.
        await atomicWrite(
          location.version,
          `${generation}\n`,
          beforeCommit,
          this.directorySync,
          this.directorySyncAttempts,
        )
        this.cache.set(workspace, {
          state: loaded.state,
          generation,
          ledgerEntries: entryCount,
          normalizedLedger: `${loaded.normalizedLedger}${JSON.stringify(entry)}\n`,
          ledgerNeedsNormalization: false,
        })
        if (entryCount >= this.options.snapshotEvery) {
          try {
            // Compaction is post-commit maintenance. Every intermediate state is
            // readable at the committed version, so a crash cannot roll forward
            // an uncommitted snapshot or make a committed mutation disappear.
            await atomicWrite(
              location.snapshot,
              `${JSON.stringify(loaded.state, null, 2)}\n`,
              undefined,
              this.directorySync,
              this.directorySyncAttempts,
            )
            await atomicWrite(location.ledger, '', undefined, this.directorySync, this.directorySyncAttempts)
            this.cache.set(workspace, {
              state: loaded.state,
              generation,
              ledgerEntries: 0,
              normalizedLedger: '',
              ledgerNeedsNormalization: false,
            })
          } catch {
            // The mutation is already committed. Force a fresh reconstruction,
            // but do not report failure and invite a duplicate retry.
            this.cache.delete(workspace)
          }
        }
        return result.value
      } catch (error) {
        // Mutation callbacks update the materialized object in place. If any
        // persistence step fails, force the next caller to rebuild from disk
        // rather than exposing a half-committed in-memory graph.
        this.cache.delete(workspace)
        if (error instanceof PostRenameDurabilityError) retainLock = true
        throw error
      }
    } finally {
      if (!retainLock) await release()
    }
  }
}
