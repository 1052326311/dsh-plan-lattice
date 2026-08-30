import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { LATTICE_SCHEMA_VERSION, type LatticeState } from '../src/domain.js'
import { apply } from '../src/index.js'
import { LatticeStore } from '../src/store.js'

const NODE_COUNT = 100_000
const ROOT_LIMIT = 2
const NESTED_LIMIT = 5
const LEAF_COUNT = NODE_COUNT - Math.ceil((NODE_COUNT - ROOT_LIMIT) / NESTED_LIMIT)

function largeState(): LatticeState {
  const nodes: LatticeState['nodes'] = {}
  const parents: { id: string; remaining: number }[] = []
  let parentIndex = 0
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const id = `node-${index}`
    const parent = index < ROOT_LIMIT ? undefined : parents[parentIndex]
    if (index >= ROOT_LIMIT && parent === undefined) throw new Error('large-state generator exhausted its parent frontier')
    nodes[id] = {
      id,
      ...(parent === undefined ? {} : { parentId: parent.id }),
      title: `Work item ${index}`,
      acceptanceCriteria: 'A concrete command proves this work item.',
      status: index === 0 ? 'active' : index === 50_000 ? 'blocked' : 'pending',
      evidence: [],
      ...(index === 50_000 ? { blockedReason: 'Waiting for a local proof.' } : {}),
      createdAt: index,
      updatedAt: index,
    }
    if (parent !== undefined && --parent.remaining === 0) parentIndex += 1
    parents.push({ id, remaining: NESTED_LIMIT })
  }
  return {
    schemaVersion: LATTICE_SCHEMA_VERSION,
    revision: 1,
    project: {
      title: '100k recovery proof',
      objective: 'Keep the durable work graph out of the model context.',
      contextPaths: ['PRODUCT.md'],
      createdAt: 1,
      updatedAt: 1,
    },
    nodes,
  }
}

function valueOf(result: Awaited<ReturnType<Context['tools']['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value as Record<string, unknown>
}

describe('large lattice recovery and bounded runtime status', () => {
  it('restores a default-branch-valid 100,000-node graph, replays an incremental ledger, and keeps the ToolRuntime response bounded', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-scale-'))
    const contexts: Context[] = []
    try {
      const store = new LatticeStore({ snapshotEvery: 64 })
      await store.create(workspace, largeState(), undefined)

      const writer = new LatticeStore({ snapshotEvery: 64 })
      expect((await writer.peek(workspace))?.nodes['node-99999']).toBeDefined()
      for (let iteration = 1; iteration <= 65; iteration += 1) {
        await writer.mutate(workspace, 'scale-update', state => {
          const node = state.nodes['node-99999']
          node.title = `Recovered update ${iteration}`
          node.updatedAt = iteration
          state.revision += 1
          state.project.updatedAt = iteration
          return {
            value: state.revision,
            delta: { revision: state.revision, project: state.project, upserts: [node] },
          }
        })
      }

      const restarted = await new LatticeStore({ snapshotEvery: 64 }).peek(workspace)
      expect(restarted?.revision).toBe(66)
      expect(Object.keys(restarted?.nodes ?? {})).toHaveLength(NODE_COUNT)
      expect(restarted?.nodes['node-99999']?.title).toBe('Recovered update 65')
      const childCounts = new Map<string, number>()
      for (const node of Object.values(restarted?.nodes ?? {})) {
        if (node.parentId !== undefined) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1)
      }
      expect(Object.values(restarted?.nodes ?? {}).filter(node => node.parentId === undefined)).toHaveLength(ROOT_LIMIT)
      expect([...childCounts.values()].every(count => count <= NESTED_LIMIT)).toBe(true)

      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      apply(ctx, { intakeMode: 'off' })
      const agent = { session: { id: 'scale-agent', header: { cwd: workspace } } }
      const statusResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'scale-status' as never,
        name: 'lattice_status',
        arguments: { maxNodes: 3 },
        agent: agent as never,
      })
      const status = valueOf(statusResult)
      const projection = status.status as {
        counts: { pending: number; blocked: number }
        frontier: { nodes: { id: string }[]; total: number; truncated: boolean }
      }
      expect(projection.counts.pending).toBe(99_998)
      expect(projection.counts.blocked).toBe(1)
      expect(projection.frontier.nodes).toHaveLength(3)
      expect(projection.frontier.total).toBe(LEAF_COUNT)
      expect(projection.frontier.truncated).toBe(true)
      expect(JSON.stringify(statusResult.content)).toContain(
        'Node counts: pending=99998, active=1, blocked=1, complete=0, archived=0',
      )
      expect(JSON.stringify(status).length).toBeLessThan(5_000)
      expect(JSON.stringify(status)).not.toContain('node-99999')
    } finally {
      await Promise.all(contexts.map(context => context.fiber.dispose()))
      await rm(workspace, { recursive: true, force: true })
    }
  }, 30_000)
})
