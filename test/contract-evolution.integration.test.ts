import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

const contexts: Context[] = []

function registerAgent(ctx: Context, id: string, workspace: string): Agent {
  const agent = {
    id,
    session: { id, header: { cwd: workspace } },
    ctx,
  } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

function valueOf(result: Awaited<ReturnType<Context['tools']['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value as Record<string, unknown>
}

function renderedLatticeReceipt(result: Awaited<ReturnType<Context['tools']['execute']>>): { id: string; revision: number } {
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  const match = text.match(/Fresh context receipt \(copy these exact values into the next structural lattice call\):\n- receiptId: ([^\n]+)\n- expectedRevision: (\d+)/)
  if (match?.[1] === undefined || match[2] === undefined) throw new Error('final tool content omitted the lattice receipt')
  return { id: match[1], revision: Number(match[2]) }
}

describe('contract-set evolution', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  })

  it('adopts a newly required document without losing the graph, then makes it part of execution authorization', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-contract-baseline-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'PRODUCT_SENTINEL\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      apply(ctx, { intakeMode: 'off' })

      let writes = 0
      ctx.tools.register(defineTool({
        name: 'write',
        description: 'A real guarded side-effect fixture.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() {
          writes += 1
          return `write-${writes}`
        },
      }))

      const agent = registerAgent(ctx, 'contract-evolution-agent', workspace)
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `contract-evolution-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })

      const open = valueOf(await invoke('lattice_open', {
        title: 'Contract evolution proof',
        objective: 'Keep every required decision visible before plan changes.',
        contextPaths: ['PRODUCT.md'],
      }))
      const receipt = open.receipt as { id: string; revision: number }
      const added = valueOf(await invoke('lattice_add', {
        receiptId: receipt.id,
        expectedRevision: receipt.revision,
        title: 'Keep the graph durable',
        acceptanceCriteria: 'Existing nodes must survive a newly discovered project contract.',
      }))
      const originalNode = added.node as { id: string }

      await writeFile(join(workspace, 'DECISIONS.md'), 'DECISION_SENTINEL: runtime authorization must read this.\n', 'utf8')
      const refreshed = valueOf(await invoke('lattice_refresh_context', { planNodeId: originalNode.id }))
      expect(JSON.stringify(refreshed)).not.toContain('DECISION_SENTINEL')

      const refreshedReceipt = refreshed.receipt as { id: string; revision: number }
      const adoptedResult = await invoke('lattice_adopt_context', {
        receiptId: refreshedReceipt.id,
        expectedRevision: refreshedReceipt.revision,
        addPaths: ['DECISIONS.md'],
      })
      expect(JSON.stringify(adoptedResult.content)).toContain('PRODUCT_SENTINEL')
      expect(JSON.stringify(adoptedResult.content)).toContain('DECISION_SENTINEL')
      const adopted = valueOf(adoptedResult)
      expect(JSON.stringify(adopted)).toContain('PRODUCT_SENTINEL')
      expect(JSON.stringify(adopted)).toContain('DECISION_SENTINEL')
      const adoptedReceipt = adopted.receipt as { id: string; revision: number }
      expect(adoptedReceipt.revision).toBe(refreshedReceipt.revision + 1)

      const visibleReceipt = renderedLatticeReceipt(adoptedResult)
      expect(visibleReceipt).toEqual({ id: adoptedReceipt.id, revision: adoptedReceipt.revision })
      valueOf(await invoke('lattice_update', {
        receiptId: visibleReceipt.id,
        expectedRevision: visibleReceipt.revision,
        nodeId: originalNode.id,
        acceptanceCriteria: 'Existing nodes remain immediately reconcilable after adopting a new project contract.',
      }))

      const status = valueOf(await invoke('lattice_status', {}))
      expect(JSON.stringify(status)).toContain('Keep the graph durable')
      expect(JSON.stringify(status)).toContain('Existing nodes remain immediately reconcilable after adopting a new project contract.')
      expect(JSON.stringify(status)).toContain('DECISIONS.md')

      const afterAdoption = valueOf(await invoke('lattice_refresh_context', {}))
      const afterAdoptionReceipt = afterAdoption.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_add', {
        receiptId: afterAdoptionReceipt.id,
        expectedRevision: afterAdoptionReceipt.revision,
        title: 'Use the adopted contract',
        acceptanceCriteria: 'The new decision document gates future structural changes.',
      }))
      const afterAdd = valueOf(await invoke('lattice_refresh_context', { planNodeId: originalNode.id }))
      const afterAddReceipt = afterAdd.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_checkout', {
        receiptId: afterAddReceipt.id,
        expectedRevision: afterAddReceipt.revision,
        nodeId: originalNode.id,
      }))
      await invoke('lattice_refresh_context', {})
      await writeFile(join(workspace, 'DECISIONS.md'), 'DECISION_SENTINEL changed after adoption.\n', 'utf8')
      const denied = await invoke('write', {})
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('project context changed')
      expect(writes).toBe(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 15_000)

  it('does not partially change the contract when a newly required document cannot be read', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-contract-atomicity-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'PRODUCT_SENTINEL\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      apply(ctx, { intakeMode: 'off' })

      const agent = registerAgent(ctx, 'contract-atomicity-agent', workspace)
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `contract-atomicity-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })

      const open = valueOf(await invoke('lattice_open', {
        title: 'Atomic adoption proof',
        objective: 'Never store an unread contract.',
        contextPaths: ['PRODUCT.md'],
      }))
      const receipt = open.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_add', {
        receiptId: receipt.id,
        expectedRevision: receipt.revision,
        title: 'Keep existing work',
        acceptanceCriteria: 'The graph survives a failed contract adoption.',
      }))
      const refreshed = valueOf(await invoke('lattice_refresh_context', {}))
      const refreshedReceipt = refreshed.receipt as { id: string; revision: number }
      const rejected = await invoke('lattice_adopt_context', {
        receiptId: refreshedReceipt.id,
        expectedRevision: refreshedReceipt.revision,
        addPaths: ['MISSING-DECISIONS.md'],
      })
      expect(rejected.isError).toBe(true)

      const status = valueOf(await invoke('lattice_status', {}))
      expect((status.status as { revision: number }).revision).toBe(refreshedReceipt.revision)
      expect(JSON.stringify(status)).toContain('Keep existing work')
      expect(JSON.stringify(status)).not.toContain('MISSING-DECISIONS.md')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refuses to change the contract while another session holds the execution lease', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-contract-lease-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'PRODUCT_SENTINEL\n', 'utf8')
      await writeFile(join(workspace, 'DECISIONS.md'), 'DECISION_SENTINEL\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      apply(ctx, { intakeMode: 'off' })

      const owner = registerAgent(ctx, 'contract-owner', workspace)
      const observer = registerAgent(ctx, 'contract-observer', workspace)
      let call = 0
      const invoke = async (agent: Agent, name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `contract-lease-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })

      const open = valueOf(await invoke(owner, 'lattice_open', {
        title: 'Lease adoption proof',
        objective: 'Do not switch contracts during execution.',
        contextPaths: ['PRODUCT.md'],
      }))
      const openReceipt = open.receipt as { id: string; revision: number }
      const added = valueOf(await invoke(owner, 'lattice_add', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision,
        title: 'Execute one protected unit',
        acceptanceCriteria: 'No contract change occurs while this lease is active.',
      }))
      const node = added.node as { id: string }
      const ownerRefresh = valueOf(await invoke(owner, 'lattice_refresh_context', { planNodeId: node.id }))
      const ownerReceipt = ownerRefresh.receipt as { id: string; revision: number }
      valueOf(await invoke(owner, 'lattice_checkout', {
        receiptId: ownerReceipt.id,
        expectedRevision: ownerReceipt.revision,
        nodeId: node.id,
      }))

      const observerRefresh = valueOf(await invoke(observer, 'lattice_refresh_context', {}))
      const observerReceipt = observerRefresh.receipt as { id: string; revision: number }
      const rejected = await invoke(observer, 'lattice_adopt_context', {
        receiptId: observerReceipt.id,
        expectedRevision: observerReceipt.revision,
        addPaths: ['DECISIONS.md'],
      })
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toContain('checked out')

      const status = valueOf(await invoke(observer, 'lattice_status', {}))
      expect(JSON.stringify(status)).not.toContain('DECISIONS.md')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
