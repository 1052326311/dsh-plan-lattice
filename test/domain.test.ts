import { describe, expect, it } from 'vitest'
import {
  assertBranchingCapacity,
  completeAndCollapse,
  createNode,
  LATTICE_SCHEMA_VERSION,
  type LatticeState,
} from '../src/domain.js'

function state(): LatticeState {
  return {
    schemaVersion: LATTICE_SCHEMA_VERSION,
    revision: 1,
    project: {
      title: 'Test',
      objective: 'Preserve the product contract.',
      contextPaths: ['PRODUCT.md'],
      createdAt: 1,
      updatedAt: 1,
    },
    nodes: {},
  }
}

describe('lattice domain', () => {
  it('collapses a parent only after every child has evidence-backed completion', () => {
    const graph = state()
    const parent = createNode({ title: 'Deliver feature', acceptanceCriteria: 'All child proofs pass.', now: 10 })
    const first = createNode({ parentId: parent.id, title: 'Implement', acceptanceCriteria: 'Code is complete.', now: 11 })
    const second = createNode({ parentId: parent.id, title: 'Verify', acceptanceCriteria: 'Tests pass.', now: 12 })
    parent.status = 'active'
    graph.nodes[parent.id] = parent
    graph.nodes[first.id] = first
    graph.nodes[second.id] = second

    expect(completeAndCollapse(graph, first.id, { summary: 'Implemented', references: ['src/a.ts'], recordedAt: 20 }))
      .toHaveLength(1)
    expect(parent.status).toBe('active')

    const touched = completeAndCollapse(graph, second.id, { summary: 'Verified', references: ['pnpm test'], recordedAt: 21 })
    expect(touched.map(node => node.id)).toEqual([second.id, parent.id])
    expect(parent.status).toBe('complete')
    expect(parent.evidence.at(-1)?.summary).toContain('Automatically reconciled')
  })

  it('enforces small recursive branches instead of silent unbounded fan-out', () => {
    const graph = state()
    expect(() => assertBranchingCapacity(graph, undefined, 3, 2, 5)).toThrow('top-level branching limit exceeded')
    expect(() => assertBranchingCapacity(graph, 'node-parent', 6, 2, 5)).toThrow('nested branching limit exceeded')
  })

  it('does not let an archived child masquerade as completion evidence', () => {
    const graph = state()
    const parent = createNode({ title: 'Parent', acceptanceCriteria: 'All paths reconciled.', now: 1 })
    const complete = createNode({ parentId: parent.id, title: 'Complete path', acceptanceCriteria: 'Proof', now: 2 })
    const archived = createNode({ parentId: parent.id, title: 'Discarded path', acceptanceCriteria: 'Proof', now: 3 })
    parent.status = 'active'
    archived.status = 'archived'
    graph.nodes[parent.id] = parent
    graph.nodes[complete.id] = complete
    graph.nodes[archived.id] = archived

    completeAndCollapse(graph, complete.id, { summary: 'Done', references: ['test'], recordedAt: 4 })
    expect(parent.status).toBe('active')
  })
})
