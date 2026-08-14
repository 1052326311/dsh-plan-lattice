import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

const contexts: Context[] = []

function valueOf(result: Awaited<ReturnType<Context['tools']['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value as Record<string, unknown>
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

      const open = valueOf(await invoke('lattice_open', {
        title: 'Proof project',
        objective: 'Preserve the product contract.',
        contextPaths: ['PRODUCT.md', 'ARCHITECTURE.md'],
      }))
      expect(JSON.stringify(open)).toContain('LATTICE_SENTINEL')
      const openReceipt = open.receipt as { id: string; revision: number }

      const added = valueOf(await invoke('lattice_add', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision,
        title: 'Write one artifact',
        acceptanceCriteria: 'The guarded write has an evidence checkpoint.',
      }))
      const node = added.node as { id: string }
      const addedReceipt = added.receipt as { id: string; revision: number }

      const checkout = valueOf(await invoke('lattice_checkout', {
        receiptId: addedReceipt.id,
        expectedRevision: addedReceipt.revision,
        nodeId: node.id,
      }))
      const checkoutReceipt = checkout.receipt as { id: string; revision: number }
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
      const checkpointReceipt = checkpoint.receipt as { id: string; revision: number }
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
      const completeReceipt = completed.receipt as { id: string; revision: number }

      await writeFile(join(workspace, 'PRODUCT.md'), 'LATTICE_SENTINEL changed\n', 'utf8')
      const staleMutation = await invoke('lattice_add', {
        receiptId: completeReceipt.id,
        expectedRevision: completeReceipt.revision,
        title: 'This must not be added',
        acceptanceCriteria: 'Never reaches storage.',
      })
      expect(staleMutation.isError).toBe(true)
      expect(JSON.stringify(staleMutation.content)).toContain('project context changed')
      expect(checkoutReceipt.revision).toBeLessThan(completeReceipt.revision)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
