import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

const contexts: Context[] = []

function registerAgent(ctx: Context, session: { id: unknown; header: { cwd?: string } }): Agent {
  const agent = { id: session.id, session, ctx } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

function valueOf(result: Awaited<ReturnType<Context['tools']['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value as Record<string, unknown>
}

function appendSuccessfulCompaction(session: ReturnType<Context['sessions']['create']>): void {
  const original = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'old model-visible work context' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const compactionId = CompactionId('plan-lattice-proof-compaction')
  const start = session.append('compaction/start', { compactionId, turn: null })
  const summary = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'compacted context' }],
    shadowedRange: { start: original.seq, end: original.seq },
    shadowedSeqs: [original.seq],
    shadowedTokenCount: 1,
    provider: 'proof',
    model: 'proof',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'compacted context' }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
    sourceEventSeqs: [start.seq, summary.seq, original.seq],
  })
  session.append('compaction/end', { compactionId, turn: null })
}

describe('Harness tool-runtime integration', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  })

  it('gates real tool execution on a current leaf and forces a checkpoint after each guarded action', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-harness-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'LATTICE_SENTINEL\n', 'utf8')
      await writeFile(join(workspace, 'ARCHITECTURE.md'), 'State belongs in .dsh.\n', 'utf8')
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

      const agent = registerAgent(ctx, { id: 'lattice-agent', header: { cwd: workspace } })
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })

      const denied = await invoke('write', {})
      expect(denied.isError).toBe(true)
      expect(writes).toBe(0)

      const forwardParent = await invoke('lattice_open', {
        title: 'Invalid initial plan',
        objective: 'Must not persist.',
        contextPaths: ['PRODUCT.md'],
        initialPlan: [{
          key: 'child', parentKey: 'future-parent', title: 'Child', acceptanceCriteria: 'Child proof.',
        }],
      })
      expect(forwardParent.isError).toBe(true)
      expect(JSON.stringify(forwardParent.content)).toContain('must appear before child')

      const openResult = await invoke('lattice_open', {
        title: 'Proof project',
        objective: 'Preserve the product contract.',
        contextPaths: ['PRODUCT.md', 'ARCHITECTURE.md'],
        initialPlan: [
          {
            key: 'delivery',
            title: 'Deliver the verified artifact',
            acceptanceCriteria: 'Every implementation child is complete.',
          },
          {
            key: 'write',
            parentKey: 'delivery',
            title: 'Write one artifact',
            acceptanceCriteria: 'The guarded write has an evidence checkpoint.',
          },
        ],
        selectedLeafKey: 'delivery',
      })
      expect(JSON.stringify(openResult.content)).toContain('LATTICE_SENTINEL')
      expect(JSON.stringify(openResult.content)).toContain('State belongs in .dsh.')
      const open = valueOf(openResult)
      const openReceipt = open.receipt as { id: string; revision: number }
      expect(JSON.stringify(openResult.content)).toContain(`receiptId: ${openReceipt.id}`)
      expect(JSON.stringify(openResult.content)).toContain(`expectedRevision: ${openReceipt.revision}`)

      const initialPlan = open.initialPlan as {
        nodes: Array<{ key: string; node: { id: string } }>
        selectedLeaf: { key: string; node: { id: string } }
      }
      expect(initialPlan.nodes).toHaveLength(2)
      expect(initialPlan.selectedLeaf.key).toBe('write')
      expect(JSON.stringify(openResult.content)).toContain('INITIAL PLAN CREATED IN THIS CALL')
      expect(JSON.stringify(openResult.content)).toContain('Selected first leaf: write')

      const node = initialPlan.selectedLeaf.node
      const consumedReceipt = await invoke('lattice_checkout', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision + 1,
        nodeId: node.id,
      })
      expect(consumedReceipt.isError).toBe(true)
      expect(JSON.stringify(consumedReceipt.content)).toContain('stale lattice revision')
      const selectedLeafResult = await invoke('lattice_refresh_context', { planNodeId: node.id })
      const selectedLeafContext = valueOf(selectedLeafResult)
      const selectedLeafReceipt = selectedLeafContext.receipt as { id: string; revision: number }
      expect(JSON.stringify(selectedLeafResult.content)).toContain(`receiptId: ${selectedLeafReceipt.id}`)
      expect(JSON.stringify(selectedLeafResult.content)).toContain(`expectedRevision: ${selectedLeafReceipt.revision}`)

      const checkout = valueOf(await invoke('lattice_checkout', {
        receiptId: selectedLeafReceipt.id,
        expectedRevision: selectedLeafReceipt.revision,
        nodeId: node.id,
      }))
      expect(checkout.receipt).toBeUndefined()

      // The requirement contract can change after checkout but before the
      // first side effect. A lease alone must not authorize work against the
      // old model-visible document body.
      await invoke('lattice_refresh_context', {})
      await writeFile(join(workspace, 'PRODUCT.md'), 'LATTICE_SENTINEL changed before write\n', 'utf8')
      const deniedByChangedContract = await invoke('write', {})
      expect(deniedByChangedContract.isError).toBe(true)
      expect(JSON.stringify(deniedByChangedContract.content)).toContain('project context changed')
      expect(writes).toBe(0)

      const refreshedAfterContractChangeResult = await invoke('lattice_refresh_context', {})
      expect(JSON.stringify(refreshedAfterContractChangeResult.content)).toContain('changed before write')
      const refreshedAfterContractChange = valueOf(refreshedAfterContractChangeResult)
      expect(JSON.stringify(refreshedAfterContractChange)).toContain('changed before write')
      expect((await invoke('write', {})).isError).toBe(false)
      expect(writes).toBe(1)

      expect((await invoke('write', {})).isError).toBe(true)
      const refreshedWhileDirty = valueOf(await invoke('lattice_refresh_context', {}))
      expect((await invoke('write', {})).isError).toBe(true)
      expect(refreshedWhileDirty.receipt).toBeDefined()
      const checkpointContext = valueOf(await invoke('lattice_refresh_context', {}))
      const refreshedReceipt = checkpointContext.receipt as { id: string; revision: number }

      const checkpoint = valueOf(await invoke('lattice_checkpoint', {
        receiptId: refreshedReceipt.id,
        expectedRevision: refreshedReceipt.revision,
        summary: 'Performed the first guarded write.',
        references: ['write fixture'],
        complete: false,
      }))
      expect(checkpoint.receipt).toBeUndefined()

      await invoke('lattice_refresh_context', {})
      await writeFile(join(workspace, 'PRODUCT.md'), 'LATTICE_SENTINEL changed after checkpoint\n', 'utf8')
      const deniedAfterCheckpointContractChange = await invoke('write', {})
      expect(deniedAfterCheckpointContractChange.isError).toBe(true)
      expect(JSON.stringify(deniedAfterCheckpointContractChange.content)).toContain('project context changed')
      expect(writes).toBe(1)

      const refreshedAfterCheckpointContractChange = valueOf(await invoke('lattice_refresh_context', {}))
      expect(JSON.stringify(refreshedAfterCheckpointContractChange)).toContain('changed after checkpoint')
      expect((await invoke('write', {})).isError).toBe(false)
      expect(writes).toBe(2)

      const afterSecondWrite = valueOf(await invoke('lattice_refresh_context', {}))
      const afterSecondReceipt = afterSecondWrite.receipt as { id: string; revision: number }
      const completed = valueOf(await invoke('lattice_checkpoint', {
        receiptId: afterSecondReceipt.id,
        expectedRevision: afterSecondReceipt.revision,
        summary: 'Verified the final guarded write.',
        references: ['write fixture', 'vitest'],
        complete: true,
      }))
      expect(completed.receipt).toBeUndefined()

      const beforeProductChange = valueOf(await invoke('lattice_refresh_context', {}))
      const completeReceipt = beforeProductChange.receipt as { id: string; revision: number }
      await writeFile(join(workspace, 'PRODUCT.md'), 'LATTICE_SENTINEL changed\n', 'utf8')
      const staleMutation = await invoke('lattice_add', {
        receiptId: completeReceipt.id,
        expectedRevision: completeReceipt.revision,
        title: 'This must not be added',
        acceptanceCriteria: 'Never reaches storage.',
      })
      expect(staleMutation.isError).toBe(true)
      expect(JSON.stringify(staleMutation.content)).toContain('project context changed')
      expect(selectedLeafReceipt.revision).toBeLessThan(completeReceipt.revision)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('requires a fresh rendered contract after a real session compaction before another guarded write', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-compaction-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'COMPACTION_SENTINEL\n', 'utf8')
      await writeFile(join(workspace, 'TARGET.ts'), 'export const step = 0\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionStore)
      await ctx.plugin(InvariantRegistry)
      await ctx.plugin(CompactionInvariant)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      apply(ctx, { intakeMode: 'off' })

      let writes = 0
      ctx.tools.register(defineTool({
        name: 'write',
        description: 'A real guarded side-effect fixture.',
        parameters: {
          file_path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          await writeFile(args.file_path, args.content, 'utf8')
          writes += 1
          return `write-${writes}`
        },
      }))

      const session = ctx.sessions.create(SessionId('compaction-lattice-agent'), { meta: { cwd: workspace } })
      const agent = registerAgent(ctx, session)
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `compaction-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })

      const open = valueOf(await invoke('lattice_open', {
        title: 'Compaction proof',
        objective: 'Never write from compacted-away contract context.',
        contextPaths: ['PRODUCT.md'],
      }))
      const openReceipt = open.receipt as { id: string; revision: number }
      const added = valueOf(await invoke('lattice_add', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision,
        title: 'Guard one write',
        acceptanceCriteria: 'A write after compaction requires a new full contract read.',
      }))
      const node = added.node as { id: string }
      const refreshed = valueOf(await invoke('lattice_refresh_context', { planNodeId: node.id }))
      const receipt = refreshed.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_checkout', {
        receiptId: receipt.id,
        expectedRevision: receipt.revision,
        nodeId: node.id,
      }))
      const firstBasis = await invoke('lattice_refresh_context', { targetPaths: ['TARGET.ts'] })
      expect(JSON.stringify(firstBasis.content)).toContain('Guard one write')
      expect(JSON.stringify(firstBasis.content)).toContain('export const step = 0')
      expect((await invoke('write', {
        file_path: join(workspace, 'TARGET.ts'),
        content: 'export const step = 1\n',
      })).isError).toBe(false)
      expect(writes).toBe(1)

      const checkpointContext = valueOf(await invoke('lattice_refresh_context', {}))
      const checkpointReceipt = checkpointContext.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_checkpoint', {
        receiptId: checkpointReceipt.id,
        expectedRevision: checkpointReceipt.revision,
        summary: 'Recorded the first write.',
        references: ['write fixture'],
        complete: false,
      }))

      await invoke('lattice_refresh_context', { targetPaths: ['TARGET.ts'] })
      appendSuccessfulCompaction(session)
      const deniedAfterCompaction = await invoke('write', {
        file_path: join(workspace, 'TARGET.ts'),
        content: 'export const step = 2\n',
      })
      expect(deniedAfterCompaction.isError).toBe(true)
      expect(JSON.stringify(deniedAfterCompaction.content)).toContain('changed model-visible history')
      expect(writes).toBe(1)

      const afterCompactionResult = await invoke('lattice_refresh_context', { targetPaths: ['TARGET.ts'] })
      expect(JSON.stringify(afterCompactionResult.content)).toContain('COMPACTION_SENTINEL')
      expect(JSON.stringify(afterCompactionResult.content)).toContain('export const step = 1')
      expect(JSON.stringify(afterCompactionResult.content)).toContain('Guard one write')
      const afterCompaction = valueOf(afterCompactionResult)
      expect(JSON.stringify(afterCompaction)).toContain('COMPACTION_SENTINEL')
      expect((await invoke('write', {
        file_path: join(workspace, 'TARGET.ts'),
        content: 'export const step = 2\n',
      })).isError).toBe(false)
      expect(writes).toBe(2)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('binds each real filesystem mutation to the current node plan and exact target body', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-mutation-basis-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'The public behavior must remain stable.\n', 'utf8')
      await writeFile(join(workspace, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(workspace, 'b.ts'), 'export const b = 1\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      apply(ctx, { intakeMode: 'off' })

      let writes = 0
      ctx.tools.register(defineTool({
        name: 'write',
        description: 'A real-shaped guarded filesystem mutation fixture.',
        parameters: {
          file_path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          await writeFile(args.file_path, args.content, 'utf8')
          writes += 1
          return `write-${writes}`
        },
      }))

      const agent = registerAgent(ctx, { id: 'mutation-basis-agent', header: { cwd: workspace } })
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `mutation-basis-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })

      const open = valueOf(await invoke('lattice_open', {
        title: 'Mutation basis proof',
        objective: 'Every write starts from current intent and file state.',
        contextPaths: ['PRODUCT.md'],
      }))
      const openReceipt = open.receipt as { id: string; revision: number }
      const added = valueOf(await invoke('lattice_add', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision,
        title: 'Change only the selected implementation file',
        acceptanceCriteria: 'The selected target changes without violating public behavior.',
      }))
      const node = added.node as { id: string }
      const beforeCheckout = valueOf(await invoke('lattice_refresh_context', { planNodeId: node.id }))
      const checkoutReceipt = beforeCheckout.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_checkout', {
        receiptId: checkoutReceipt.id,
        expectedRevision: checkoutReceipt.revision,
        nodeId: node.id,
      }))

      const deniedWithoutTarget = await invoke('write', {
        file_path: join(workspace, 'a.ts'),
        content: 'export const a = 2\n',
      })
      expect(deniedWithoutTarget.isError).toBe(true)
      expect(JSON.stringify(deniedWithoutTarget.content)).toContain('targetPaths')

      const preparedB = await invoke('lattice_refresh_context', { targetPaths: ['b.ts'] })
      expect(JSON.stringify(preparedB.content)).toContain('Change only the selected implementation file')
      expect(JSON.stringify(preparedB.content)).toContain('The selected target changes')
      expect(JSON.stringify(preparedB.content)).toContain('export const b = 1')

      const deniedWrongTarget = await invoke('write', {
        file_path: join(workspace, 'a.ts'),
        content: 'export const a = 2\n',
      })
      expect(deniedWrongTarget.isError).toBe(true)
      expect(JSON.stringify(deniedWrongTarget.content)).toContain('was not included')

      await invoke('lattice_refresh_context', { targetPaths: ['b.ts'] })
      await writeFile(join(workspace, 'b.ts'), 'export const b = 9\n', 'utf8')
      const deniedStaleTarget = await invoke('write', {
        file_path: join(workspace, 'b.ts'),
        content: 'export const b = 2\n',
      })
      expect(deniedStaleTarget.isError).toBe(true)
      expect(JSON.stringify(deniedStaleTarget.content)).toContain('changed since the complete target set was read')

      await invoke('lattice_refresh_context', { targetPaths: ['b.ts'] })
      expect((await invoke('write', {
        file_path: join(workspace, 'b.ts'),
        content: 'export const b = 2\n',
      })).isError).toBe(false)
      expect(writes).toBe(1)

      const deniedReuse = await invoke('write', {
        file_path: join(workspace, 'b.ts'),
        content: 'export const b = 3\n',
      })
      expect(deniedReuse.isError).toBe(true)
      expect(JSON.stringify(deniedReuse.content)).toContain('checkpoint')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed for strict Bash when no host precondition adapter can prove its side effects', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-strict-bash-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'Shell mutations must preserve the plan.\n', 'utf8')
      await writeFile(join(workspace, 'target.txt'), 'before\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      apply(ctx, { intakeMode: 'off', strictBash: true })
      let calls = 0
      ctx.tools.register(defineTool({
        name: 'bash',
        description: 'Strict Bash mutation fixture.',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() {
          calls += 1
          await writeFile(join(workspace, 'target.txt'), 'after\n', 'utf8')
          return 'ok'
        },
      }))
      const agent = registerAgent(ctx, { id: 'strict-bash-agent', header: { cwd: workspace } })
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `strict-bash-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })
      const open = valueOf(await invoke('lattice_open', {
        title: 'Strict shell proof',
        objective: 'Do not run a mutating shell from stale context.',
        contextPaths: ['PRODUCT.md'],
      }))
      const initial = open.receipt as { id: string; revision: number }
      const added = valueOf(await invoke('lattice_add', {
        receiptId: initial.id,
        expectedRevision: initial.revision,
        title: 'Mutate one declared shell target',
        acceptanceCriteria: 'The shell target was read with the current node plan.',
      }))
      const node = added.node as { id: string }
      const beforeCheckout = valueOf(await invoke('lattice_refresh_context', { planNodeId: node.id }))
      const receipt = beforeCheckout.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_checkout', {
        receiptId: receipt.id,
        expectedRevision: receipt.revision,
        nodeId: node.id,
      }))

      await invoke('lattice_refresh_context', {})
      const denied = await invoke('bash', { command: 'replace target.txt' })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('precondition adapter')
      expect(calls).toBe(0)

      const prepared = await invoke('lattice_refresh_context', { targetPaths: ['target.txt'] })
      expect(JSON.stringify(prepared.content)).toContain('Mutate one declared shell target')
      expect(JSON.stringify(prepared.content)).toContain('before')
      const deniedWithoutAdapter = await invoke('bash', { command: 'replace target.txt' })
      expect(deniedWithoutAdapter.isError).toBe(true)
      expect(JSON.stringify(deniedWithoutAdapter.content)).toContain('precondition adapter')
      expect(calls).toBe(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('requires the exact plan neighborhood before changing a hidden structural node', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-plan-basis-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'Every plan mutation must follow current intent.\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      apply(ctx, { intakeMode: 'off' })

      const agent = registerAgent(ctx, { id: 'plan-basis-agent', header: { cwd: workspace } })
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `plan-basis-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent,
      })
      const add = async (parentId: string | undefined, title: string) => {
        const refreshed = valueOf(await invoke('lattice_refresh_context', {
          ...(parentId === undefined ? {} : { planNodeId: parentId }),
        }))
        const receipt = refreshed.receipt as { id: string; revision: number }
        return valueOf(await invoke('lattice_add', {
          receiptId: receipt.id,
          expectedRevision: receipt.revision,
          ...(parentId === undefined ? {} : { parentId }),
          title,
          acceptanceCriteria: `${title} has observable proof.`,
        })).node as { id: string }
      }

      const open = valueOf(await invoke('lattice_open', {
        title: 'Plan basis proof',
        objective: 'Do not mutate a plan node that was omitted from the current model-visible basis.',
        contextPaths: ['PRODUCT.md'],
      }))
      const openReceipt = open.receipt as { id: string; revision: number }
      const rootA = (valueOf(await invoke('lattice_add', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision,
        title: 'Root A',
        acceptanceCriteria: 'Root A reconciles its descendants.',
      })).node as { id: string })
      const rootB = await add(undefined, 'Root B')
      const middle = await add(rootA.id, 'Middle A')
      await add(middle.id, 'Leaf A')

      const unrelated = valueOf(await invoke('lattice_refresh_context', { planNodeId: rootB.id }))
      expect(JSON.stringify(unrelated)).not.toContain('Middle A')
      const unrelatedReceipt = unrelated.receipt as { id: string; revision: number }
      const denied = await invoke('lattice_update', {
        receiptId: unrelatedReceipt.id,
        expectedRevision: unrelatedReceipt.revision,
        nodeId: middle.id,
        acceptanceCriteria: 'This unobserved plan mutation must not land.',
      })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('was not the focused current neighborhood')

      const targeted = valueOf(await invoke('lattice_refresh_context', { planNodeId: middle.id }))
      expect(JSON.stringify(targeted)).toContain('Middle A')
      expect(JSON.stringify(targeted)).toContain('Leaf A')
      const targetedReceipt = targeted.receipt as { id: string; revision: number }
      expect((await invoke('lattice_update', {
        receiptId: targetedReceipt.id,
        expectedRevision: targetedReceipt.revision,
        nodeId: middle.id,
        acceptanceCriteria: 'The exact current plan neighborhood was read first.',
      })).isError).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
