import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
})
