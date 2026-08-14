import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LatticeDelta, LatticeState } from './domain.js'
import { LATTICE_SCHEMA_VERSION, publicState } from './domain.js'

const DIRECTORY = join('.dsh', 'plan-lattice', 'v1')
const SNAPSHOT_FILE = 'snapshot.json'
const LEDGER_FILE = 'ledger.jsonl'
const HISTORY_FILE = 'history.jsonl'
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

function paths(workspace: string): Record<'directory' | 'snapshot' | 'ledger' | 'history' | 'lock', string> {
  const directory = join(workspace, DIRECTORY)
  return {
    directory,
    snapshot: join(directory, SNAPSHOT_FILE),
    ledger: join(directory, LEDGER_FILE),
    history: join(directory, HISTORY_FILE),
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
  constructor(private readonly options: StoreOptions = { snapshotEvery: 128 }) {
    if (!Number.isSafeInteger(options.snapshotEvery) || options.snapshotEvery < 1) {
      throw new Error('snapshotEvery must be a positive safe integer')
    }
  }

  async read(workspace: string): Promise<LatticeState | undefined> {
    const location = paths(workspace)
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
    return publicState(state)
  }

  async create<T>(workspace: string, initial: LatticeState, value: T): Promise<T> {
    const location = paths(workspace)
    const release = await acquire(location.lock)
    try {
      if (await readOptional(location.snapshot) !== undefined) throw new Error('a lattice already exists for this workspace')
      await atomicWrite(location.snapshot, `${JSON.stringify(initial, null, 2)}\n`)
      await atomicWrite(location.ledger, '')
      await appendFile(location.history, `${JSON.stringify({ at: Date.now(), action: 'create', revision: initial.revision })}\n`, 'utf8')
      return value
    } finally {
      await release()
    }
  }

  async mutate<T>(workspace: string, action: string, mutate: (state: LatticeState) => Mutation<T>): Promise<T> {
    const location = paths(workspace)
    const release = await acquire(location.lock)
    try {
      const state = await this.read(workspace)
      if (state === undefined) throw new Error('no lattice exists for this workspace')
      const result = mutate(state)
      if (result.delta.revision !== state.revision) {
        throw new Error(`mutation ${action} must advance the lattice revision`)
      }
      const entry: LoggedDelta = { ...result.delta, action, at: Date.now() }
      await appendFile(location.ledger, `${JSON.stringify(entry)}\n`, 'utf8')
      await appendFile(location.history, `${JSON.stringify(entry)}\n`, 'utf8')
      const ledger = await readOptional(location.ledger)
      const entryCount = ledger === undefined ? 0 : ledger.split('\n').filter(Boolean).length
      if (entryCount >= this.options.snapshotEvery) {
        await atomicWrite(location.snapshot, `${JSON.stringify(state, null, 2)}\n`)
        await atomicWrite(location.ledger, '')
      }
      return result.value
    } finally {
      await release()
    }
  }
}
