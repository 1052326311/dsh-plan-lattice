#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'

const [phase, arm, caseId, root] = process.argv.slice(2)
if (!['prepare', 'resume'].includes(phase)
  || !['native', 'plan-lattice'].includes(arm)
  || typeof caseId !== 'string'
  || typeof root !== 'string') {
  throw new Error('usage: crash-continuity-worker.mjs <prepare|resume> <native|plan-lattice> <case> <root>')
}

const controlled = arm === 'plan-lattice'
const workspace = join(root, 'workspace')
const target = join(workspace, 'TARGET.txt')
const metadataPath = join(root, 'case-state.json')
const SECOND_MUTATION = 'SECOND_MUTATION_EXECUTED\n'
const hazardCase = caseId === 'successful-side-effect-no-checkpoint'
  || caseId === 'partial-failure-no-checkpoint'

async function pauseBeforeToolResult(toolBodyEntries) {
  process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid, toolBodyEntries })}\n`)
  await new Promise(() => setInterval(() => {}, 60_000))
}

function textOf(result) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function valueOf(result) {
  if (result.isError) throw new Error(textOf(result))
  return result.value
}

async function createRuntime() {
  await mkdir(workspace, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (controlled) {
    apply(ctx, {
      intakeMode: 'off',
      guardedTools: ['edit', 'partial_edit'],
      contractAnchorRoot: join(root, 'trusted-authority'),
    })
  }

  let toolBodyEntries = 0
  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Write one crash-continuity fixture artifact.',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      toolBodyEntries += 1
      await writeFile(args.file_path, args.content, 'utf8')
      if (phase === 'prepare' && caseId === 'successful-side-effect-no-checkpoint') {
        await pauseBeforeToolResult(toolBodyEntries)
      }
      return `edit-${toolBodyEntries}`
    },
  }))
  ctx.tools.register(defineTool({
    name: 'partial_edit',
    description: 'Write one fixture artifact, then report failure.',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      toolBodyEntries += 1
      await writeFile(args.file_path, args.content, 'utf8')
      if (phase === 'prepare' && caseId === 'partial-failure-no-checkpoint') {
        await pauseBeforeToolResult(toolBodyEntries)
      }
      throw new Error('fixture failed after its observable side effect')
    },
  }))

  const session = {
    id: 'crash-continuity-root',
    header: { cwd: workspace },
    surface: { replaceGeneration: 0 },
    firstLiveSeq: 0,
  }
  const agent = { id: session.id, session, ctx }
  const detach = ctx.agents.enter(agent, undefined)
  let call = 0
  return {
    ctx,
    agent,
    toolBodyEntries: () => toolBodyEntries,
    invoke(name, args) {
      return ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `crash-continuity-${phase}-${++call}`,
        name,
        arguments: args,
        agent,
      })
    },
    async dispose() {
      detach()
      await ctx.fiber.dispose()
    },
  }
}

async function prepare() {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'PRODUCT.md'), 'A protected side effect requires durable evidence before later work.\n', 'utf8')
  await writeFile(target, 'SAFE_BASELINE\n', 'utf8')
  const runtime = await createRuntime()
  let nodeId = null
  if (controlled) {
    const opened = valueOf(await runtime.invoke('lattice_open', {
      title: 'Crash continuity fixture',
      objective: 'Do not forget an uncheckpointed side effect across process death.',
      contextPaths: ['PRODUCT.md'],
    }))
    const added = valueOf(await runtime.invoke('lattice_add', {
      receiptId: opened.receipt.id,
      expectedRevision: opened.receipt.revision,
      title: 'Execute and prove one protected unit',
      acceptanceCriteria: 'Every side effect is followed by durable checkpoint evidence.',
    }))
    nodeId = added.node.id
    const beforeCheckout = valueOf(await runtime.invoke('lattice_refresh_context', { planNodeId: nodeId }))
    valueOf(await runtime.invoke('lattice_checkout', {
      receiptId: beforeCheckout.receipt.id,
      expectedRevision: beforeCheckout.receipt.revision,
      nodeId,
    }))
    valueOf(await runtime.invoke('lattice_refresh_context', { targetPaths: ['TARGET.txt'] }))
  }

  await writeFile(metadataPath, `${JSON.stringify({ nodeId, caseId, arm }, null, 2)}\n`, 'utf8')

  if (caseId === 'successful-side-effect-no-checkpoint') {
    valueOf(await runtime.invoke('edit', { file_path: target, content: 'FIRST_SIDE_EFFECT\n' }))
  } else if (caseId === 'partial-failure-no-checkpoint') {
    const result = await runtime.invoke('partial_edit', { file_path: target, content: 'PARTIAL_SIDE_EFFECT\n' })
    if (!result.isError) throw new Error('partial failure fixture unexpectedly succeeded')
  } else if (!['clean-restart-current-basis', 'checkpoint-after-restart'].includes(caseId)) {
    throw new Error(`unknown crash continuity case ${caseId}`)
  } else if (caseId === 'checkpoint-after-restart') {
    valueOf(await runtime.invoke('edit', { file_path: target, content: 'FIRST_SIDE_EFFECT\n' }))
  }

  if (hazardCase) throw new Error('hazard tool unexpectedly returned before SIGKILL')
  process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid, toolBodyEntries: runtime.toolBodyEntries() })}\n`)
  setInterval(() => {}, 60_000)
}

async function resume() {
  const runtime = await createRuntime()
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    let firstRefresh
    if (controlled) {
      firstRefresh = valueOf(await runtime.invoke('lattice_refresh_context', {
        planNodeId: metadata.nodeId,
        targetPaths: ['TARGET.txt'],
      }))
      if (['clean-restart-current-basis', 'checkpoint-after-restart'].includes(caseId)) {
        valueOf(await runtime.invoke('lattice_checkout', {
          receiptId: firstRefresh.receipt.id,
          expectedRevision: firstRefresh.receipt.revision,
          nodeId: metadata.nodeId,
        }))
        firstRefresh = valueOf(await runtime.invoke('lattice_refresh_context', {
          planNodeId: metadata.nodeId,
          targetPaths: ['TARGET.txt'],
        }))
      }
      if (caseId === 'checkpoint-after-restart') {
        valueOf(await runtime.invoke('lattice_checkpoint', {
          receiptId: firstRefresh.receipt.id,
          expectedRevision: firstRefresh.receipt.revision,
          summary: 'Recovered the prior side effect and recorded its evidence after restart.',
          references: ['SIGKILL crash-continuity fixture'],
          complete: false,
        }))
        firstRefresh = valueOf(await runtime.invoke('lattice_refresh_context', {
          planNodeId: metadata.nodeId,
          targetPaths: ['TARGET.txt'],
        }))
      }
    }

    const result = await runtime.invoke('edit', { file_path: target, content: SECOND_MUTATION })
    const finalArtifact = await readFile(target, 'utf8')
    process.stdout.write(`${JSON.stringify({
      event: 'result',
      arm,
      caseId,
      isError: result.isError,
      message: textOf(result).replaceAll(root, '<isolated-root>').replace(/\s+/g, ' ').trim(),
      toolBodyEntries: runtime.toolBodyEntries(),
      secondMutationExecuted: finalArtifact === SECOND_MUTATION,
      finalArtifact,
    })}\n`)
  } finally {
    await runtime.dispose()
  }
}

await (phase === 'prepare' ? prepare() : resume())
