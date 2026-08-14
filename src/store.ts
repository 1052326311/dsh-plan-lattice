import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LatticeDelta, LatticeState } from './domain.js'
import { LATTICE_SCHEMA_VERSION, publicState } from './domain.js'

const DIRECTORY = join('.dsh', 'plan-lattice', 'v1')
const SNAPSHOT_FILE = 'snapshot.json'
const LEDGER_FILE = 'ledger.jsonl'
const HISTORY_FILE = 'history.jsonl'
const VERSION_FILE = 'version'
const LOCK_FILE = '.lock'

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
}

interface CachedState {
  state: LatticeState
  generation: string
  ledgerEntries: number
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

function applyDelta(state: LatticeState, delta: LatticeDelta): void {
  if (delta.revision !== state.revision + 1) {
    throw new Error(`invalid lattice ledger revision ${delta.revision}; expected ${state.revision + 1}`)
  }
  if (delta.project !== undefined) state.project = delta.project
  for (const node of delta.upserts) state.nodes[node.id] = node
  state.revision = delta.revision
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

async function acquire(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${process.pid}:${Date.now()}`)
      return async () => {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error(`timed out waiting for lattice lock ${lockPath}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

export class LatticeStore {
  private readonly cache = new Map<string, CachedState>()

  constructor(private readonly options: StoreOptions = { snapshotEvery: 1024 }) {
    if (!Number.isSafeInteger(options.snapshotEvery) || options.snapshotEvery < 1) {
      throw new Error('snapshotEvery must be a positive safe integer')
    }
  }

  private async load(workspace: string): Promise<CachedState | undefined> {
    const location = paths(workspace)
    const generation = (await readOptional(location.version))?.trim()
    const cached = this.cache.get(workspace)
    if (generation !== undefined && cached?.generation === generation) return cached

    const snapshot = await readOptional(location.snapshot)
    if (snapshot === undefined) return undefined
    const parsed: unknown = JSON.parse(snapshot)
    if (!isState(parsed)) throw new Error(`invalid lattice snapshot ${location.snapshot}`)
    const state = parsed as LatticeState
    const ledger = await readOptional(location.ledger)
    const entries = ledger === undefined ? [] : ledger.split('\n').filter(Boolean)
    for (const line of entries) {
      const entry = JSON.parse(line) as LoggedDelta
      applyDelta(state, entry)
    }
    const loaded: CachedState = {
      state,
      // v0.1 snapshots predate the tiny generation marker. They stay readable,
      // but are reloaded until their next successful mutation creates one.
      generation: generation ?? `legacy:${state.revision}:${entries.length}`,
      ledgerEntries: entries.length,
    }
    this.cache.set(workspace, loaded)
    return loaded
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

  async create<T>(workspace: string, initial: LatticeState, value: T): Promise<T> {
    const location = paths(workspace)
    const release = await acquire(location.lock)
    try {
      if (await readOptional(location.snapshot) !== undefined) throw new Error('a lattice already exists for this workspace')
      await atomicWrite(location.snapshot, `${JSON.stringify(initial, null, 2)}\n`)
      await atomicWrite(location.ledger, '')
      await atomicWrite(location.version, `${initial.revision}\n`)
      await appendFile(location.history, `${JSON.stringify({ at: Date.now(), action: 'create', revision: initial.revision })}\n`, 'utf8')
      this.cache.set(workspace, {
        state: publicState(initial),
        generation: String(initial.revision),
        ledgerEntries: 0,
      })
      return value
    } finally {
      await release()
    }
  }

  async mutate<T>(workspace: string, action: string, mutate: (state: LatticeState) => Mutation<T>): Promise<T> {
    const location = paths(workspace)
    const release = await acquire(location.lock)
    try {
      try {
        const loaded = await this.load(workspace)
        if (loaded === undefined) throw new Error('no lattice exists for this workspace')
        const previousRevision = loaded.state.revision
        const result = mutate(loaded.state)
        if (loaded.state.revision !== previousRevision + 1 || result.delta.revision !== loaded.state.revision) {
          throw new Error(`mutation ${action} must advance the lattice revision`)
        }
        const entry: LoggedDelta = { ...result.delta, action, at: Date.now() }
        await appendFile(location.ledger, `${JSON.stringify(entry)}\n`, 'utf8')
        await appendFile(location.history, `${JSON.stringify(entry)}\n`, 'utf8')
        const entryCount = loaded.ledgerEntries + 1
        if (entryCount >= this.options.snapshotEvery) {
          await atomicWrite(location.snapshot, `${JSON.stringify(loaded.state, null, 2)}\n`)
          await atomicWrite(location.ledger, '')
        }
        const generation = String(loaded.state.revision)
        await atomicWrite(location.version, `${generation}\n`)
        this.cache.set(workspace, {
          state: loaded.state,
          generation,
          ledgerEntries: entryCount >= this.options.snapshotEvery ? 0 : entryCount,
        })
        return result.value
      } catch (error) {
        // Mutation callbacks update the materialized object in place. If any
        // persistence step fails, force the next caller to rebuild from disk
        // rather than exposing a half-committed in-memory graph.
        this.cache.delete(workspace)
        throw error
      }
    } finally {
      await release()
    }
  }
}
