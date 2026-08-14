import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
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
      apply(ctx)

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

      const agent = { session: { id: 'lattice-agent', header: { cwd: workspace } } }
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent: agent as never,
      })

      const denied = await invoke('write', {})
      expect(denied.isError).toBe(true)
      expect(writes).toBe(0)

      const openResult = await invoke('lattice_open', {
        title: 'Proof project',
        objective: 'Preserve the product contract.',
        contextPaths: ['PRODUCT.md', 'ARCHITECTURE.md'],
      })
      expect(JSON.stringify(openResult.content)).toContain('LATTICE_SENTINEL')
      expect(JSON.stringify(openResult.content)).toContain('State belongs in .dsh.')
      const open = valueOf(openResult)
      const openReceipt = open.receipt as { id: string; revision: number }

      const added = valueOf(await invoke('lattice_add', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision,
        title: 'Write one artifact',
        acceptanceCriteria: 'The guarded write has an evidence checkpoint.',
      }))
      const node = added.node as { id: string }
      expect(added.receipt).toBeUndefined()
      const consumedReceipt = await invoke('lattice_checkout', {
        receiptId: openReceipt.id,
        expectedRevision: 2,
        nodeId: node.id,
      })
      expect(consumedReceipt.isError).toBe(true)
      expect(JSON.stringify(consumedReceipt.content)).toContain('context receipt is missing')
      const refreshedAfterAdd = valueOf(await invoke('lattice_refresh_context', {}))
      const addedReceipt = refreshedAfterAdd.receipt as { id: string; revision: number }

      const checkout = valueOf(await invoke('lattice_checkout', {
        receiptId: addedReceipt.id,
        expectedRevision: addedReceipt.revision,
        nodeId: node.id,
      }))
      expect(checkout.receipt).toBeUndefined()

      // The requirement contract can change after checkout but before the
      // first side effect. A lease alone must not authorize work against the
      // old model-visible document body.
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
      const refreshedReceipt = refreshedWhileDirty.receipt as { id: string; revision: number }

      const checkpoint = valueOf(await invoke('lattice_checkpoint', {
        receiptId: refreshedReceipt.id,
        expectedRevision: refreshedReceipt.revision,
        summary: 'Performed the first guarded write.',
        references: ['write fixture'],
        complete: false,
      }))
      expect(checkpoint.receipt).toBeUndefined()

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
      expect(addedReceipt.revision).toBeLessThan(completeReceipt.revision)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('requires a fresh rendered contract after a real session compaction before another guarded write', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-compaction-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'COMPACTION_SENTINEL\n', 'utf8')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionStore)
      await ctx.plugin(InvariantRegistry)
      await ctx.plugin(CompactionInvariant)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      apply(ctx)

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

      const session = ctx.sessions.create(SessionId('compaction-lattice-agent'), { meta: { cwd: workspace } })
      const agent = { session }
      let call = 0
      const invoke = async (name: string, argumentsValue: unknown) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `compaction-call-${++call}` as never,
        name,
        arguments: argumentsValue,
        agent: agent as never,
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
      const refreshed = valueOf(await invoke('lattice_refresh_context', {}))
      const receipt = refreshed.receipt as { id: string; revision: number }
      valueOf(await invoke('lattice_checkout', {
        receiptId: receipt.id,
        expectedRevision: receipt.revision,
        nodeId: node.id,
      }))
      expect((await invoke('write', {})).isError).toBe(false)
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

      appendSuccessfulCompaction(session)
      const deniedAfterCompaction = await invoke('write', {})
      expect(deniedAfterCompaction.isError).toBe(true)
      expect(JSON.stringify(deniedAfterCompaction.content)).toContain('compaction')
      expect(writes).toBe(1)

      const afterCompactionResult = await invoke('lattice_refresh_context', {})
      expect(JSON.stringify(afterCompactionResult.content)).toContain('COMPACTION_SENTINEL')
      const afterCompaction = valueOf(afterCompactionResult)
      expect(JSON.stringify(afterCompaction)).toContain('COMPACTION_SENTINEL')
      expect((await invoke('write', {})).isError).toBe(false)
      expect(writes).toBe(2)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
