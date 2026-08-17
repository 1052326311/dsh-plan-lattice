import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNode, LATTICE_SCHEMA_VERSION, type LatticeState } from '../src/domain.js'
import { LatticeStore } from '../src/store.js'

function initial(): LatticeState {
  return {
    schemaVersion: LATTICE_SCHEMA_VERSION,
    revision: 1,
    project: { title: 'Test', objective: 'Objective', contextPaths: ['PRODUCT.md'], createdAt: 1, updatedAt: 1 },
    nodes: {},
  }
}

describe('lattice storage', () => {
  it('replays deltas and compacts a materialized snapshot without losing audit history', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-'))
    try {
      const store = new LatticeStore({ snapshotEvery: 1 })
      await store.create(workspace, initial(), undefined)
      await store.mutate(workspace, 'add', state => {
        const node = createNode({ title: 'First', acceptanceCriteria: 'Observed', now: 2 })
        state.nodes[node.id] = node
        state.revision += 1
        return { value: node.id, delta: { revision: state.revision, upserts: [node] } }
      })

      const restored = await new LatticeStore({ snapshotEvery: 1 }).read(workspace)
      expect(restored?.revision).toBe(2)
      expect(Object.values(restored?.nodes ?? {})).toHaveLength(1)
      const history = await readFile(join(workspace, '.dsh', 'plan-lattice', 'v1', 'history.jsonl'), 'utf8')
      expect(history).toContain('"action":"add"')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('invalidates a materialized cache after another store commits a newer revision', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-cache-'))
    try {
      const writer = new LatticeStore({ snapshotEvery: 64 })
      const observer = new LatticeStore({ snapshotEvery: 64 })
      await writer.create(workspace, initial(), undefined)
      expect((await observer.peek(workspace))?.revision).toBe(1)

      await writer.mutate(workspace, 'add', state => {
        const node = createNode({ title: 'Shared update', acceptanceCriteria: 'Observer sees revision two.', now: 2 })
        state.nodes[node.id] = node
        state.revision += 1
        return { value: undefined, delta: { revision: state.revision, upserts: [node] } }
      })

      const refreshed = await observer.peek(workspace)
      expect(refreshed?.revision).toBe(2)
      expect(Object.values(refreshed?.nodes ?? {})).toHaveLength(1)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects duplicate and invalid creation without deleting a committed graph', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-duplicate-'))
    try {
      const store = new LatticeStore({ snapshotEvery: 64 })
      await store.create(workspace, initial(), undefined)
      await expect(store.create(workspace, initial(), undefined)).rejects.toThrow('already exists')
      expect((await new LatticeStore({ snapshotEvery: 64 }).read(workspace))?.revision).toBe(1)

      const invalid = { ...initial(), revision: 0 }
      await expect(new LatticeStore({ snapshotEvery: 64 }).create(
        join(workspace, 'invalid'),
        invalid,
        undefined,
      )).rejects.toThrow('initial lattice state is invalid')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('drops a failed in-memory mutation and reloads the durable graph', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-rollback-'))
    try {
      const store = new LatticeStore({ snapshotEvery: 64 })
      await store.create(workspace, initial(), undefined)
      await expect(store.mutate(workspace, 'invalid', state => {
        state.project.title = 'Must not leak from memory'
        return { value: undefined, delta: { revision: state.revision, upserts: [] } }
      })).rejects.toThrow('must advance the lattice revision')

      const durable = await store.read(workspace)
      expect(durable?.revision).toBe(1)
      expect(durable?.project.title).toBe('Test')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('recovers a valid lock owned by a process that has exited', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-dead-lock-'))
    try {
      const store = new LatticeStore({ snapshotEvery: 64 })
      await store.create(workspace, initial(), undefined)
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
      const deadPid = child.pid!
      await once(child, 'exit')
      const lock = join(workspace, '.dsh', 'plan-lattice', 'v1', '.lock')
      await writeFile(lock, `${JSON.stringify({
        pid: deadPid,
        ownerToken: 'dead-owner-token-0001',
        acquiredAt: Date.now(),
      })}\n`, 'utf8')

      await store.mutate(workspace, 'recovered', state => {
        state.revision += 1
        return { value: undefined, delta: { revision: state.revision, upserts: [] } }
      })

      expect((await store.read(workspace))?.revision).toBe(2)
      await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not recover a lock whose owner process is still alive', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-live-lock-'))
    let releaseTimer: NodeJS.Timeout | undefined
    try {
      const store = new LatticeStore({ snapshotEvery: 64 })
      await store.create(workspace, initial(), undefined)
      const lock = join(workspace, '.dsh', 'plan-lattice', 'v1', '.lock')
      await writeFile(lock, `${JSON.stringify({
        pid: process.pid,
        ownerToken: 'live-owner-token-0001',
        acquiredAt: Date.now(),
      })}\n`, 'utf8')
      let externallyReleased = false
      releaseTimer = setTimeout(() => {
        externallyReleased = true
        void rm(lock, { force: true })
      }, 50)

      await store.mutate(workspace, 'waited-for-live-owner', state => {
        expect(externallyReleased).toBe(true)
        state.revision += 1
        return { value: undefined, delta: { revision: state.revision, upserts: [] } }
      })
      expect((await store.read(workspace))?.revision).toBe(2)
    } finally {
      if (releaseTimer !== undefined) clearTimeout(releaseTimer)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not advance the committed revision when beforeCommit fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-before-commit-'))
    try {
      const store = new LatticeStore({ snapshotEvery: 64 })
      await store.create(workspace, initial(), undefined)
      let observedLock: Record<string, unknown> | undefined
      await expect(store.mutate(workspace, 'rejected', state => {
        state.project.title = 'Uncommitted title'
        state.revision += 1
        return { value: undefined, delta: { revision: state.revision, project: state.project, upserts: [] } }
      }, async () => {
        observedLock = JSON.parse(await readFile(
          join(workspace, '.dsh', 'plan-lattice', 'v1', '.lock'),
          'utf8',
        )) as Record<string, unknown>
        throw new Error('authorization changed before commit')
      })).rejects.toThrow('authorization changed before commit')

      expect(observedLock).toMatchObject({ pid: process.pid })
      expect(observedLock?.ownerToken).toMatch(/^[a-zA-Z0-9._-]{16,128}$/)
      expect(observedLock?.acquiredAt).toEqual(expect.any(Number))
      expect((await store.read(workspace))?.revision).toBe(1)
      expect((await new LatticeStore({ snapshotEvery: 64 }).read(workspace))?.revision).toBe(1)
      expect(await readFile(join(workspace, '.dsh', 'plan-lattice', 'v1', 'version'), 'utf8')).toBe('1\n')

      await store.mutate(workspace, 'retry', state => {
        state.project.title = 'Committed retry'
        state.revision += 1
        return { value: undefined, delta: { revision: state.revision, project: state.project, upserts: [] } }
      })
      const committed = await new LatticeStore({ snapshotEvery: 64 }).read(workspace)
      expect(committed?.revision).toBe(2)
      expect(committed?.project.title).toBe('Committed retry')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('confirms a visible mutate commit after the first directory fsync fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-fsync-retry-'))
    try {
      await new LatticeStore({ snapshotEvery: 64 }).create(workspace, initial(), undefined)
      let syncAttempts = 0
      const store = new LatticeStore({
        snapshotEvery: 64,
        directorySync: async () => {
          syncAttempts += 1
          if (syncAttempts === 1) throw new Error('injected first directory fsync failure')
        },
      })

      const revision = await store.mutate(workspace, 'fsync-retry', state => {
        state.project.title = 'Confirmed after retry'
        state.revision += 1
        return {
          value: state.revision,
          delta: { revision: state.revision, project: state.project, upserts: [] },
        }
      })

      expect(revision).toBe(2)
      expect(syncAttempts).toBe(2)
      expect((await new LatticeStore({ snapshotEvery: 64 }).read(workspace))?.project.title)
        .toBe('Confirmed after retry')
      await expect(readFile(join(workspace, '.dsh', 'plan-lattice', 'v1', '.lock'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('retains the writer lock when a visible mutate commit cannot be made directory-durable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-store-fsync-fail-closed-'))
    try {
      await new LatticeStore({ snapshotEvery: 64 }).create(workspace, initial(), undefined)
      const store = new LatticeStore({
        snapshotEvery: 64,
        directorySyncAttempts: 2,
        directorySync: async () => {
          throw new Error('injected persistent directory fsync failure')
        },
      })

      await expect(store.mutate(workspace, 'fsync-unconfirmed', state => {
        state.revision += 1
        return { value: undefined, delta: { revision: state.revision, upserts: [] } }
      })).rejects.toThrow(/visible but directory durability could not be confirmed/i)

      const directory = join(workspace, '.dsh', 'plan-lattice', 'v1')
      expect(await readFile(join(directory, 'version'), 'utf8')).toBe('2\n')
      expect(JSON.parse(await readFile(join(directory, '.lock'), 'utf8'))).toMatchObject({ pid: process.pid })
      expect((await store.read(workspace))?.revision).toBe(2)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('preserves a pending create bundle when an intermediate rename cannot be made directory-durable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-create-fsync-fail-closed-'))
    try {
      let syncAttempts = 0
      const store = new LatticeStore({
        snapshotEvery: 64,
        directorySyncAttempts: 1,
        directorySync: async () => {
          syncAttempts += 1
          if (syncAttempts >= 2) throw new Error('injected persistent snapshot directory fsync failure')
        },
      })

      await expect(store.create(workspace, initial(), undefined))
        .rejects.toThrow(/visible but directory durability could not be confirmed/i)

      const directory = join(workspace, '.dsh', 'plan-lattice', 'v1')
      expect(await readFile(join(directory, 'version'), 'utf8')).toBe('0\n')
      expect(JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'))).toMatchObject({ revision: 1 })
      expect(JSON.parse(await readFile(join(directory, '.lock'), 'utf8'))).toMatchObject({ pid: process.pid })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
