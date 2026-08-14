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
})
