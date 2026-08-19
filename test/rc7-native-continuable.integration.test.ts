import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { assembleContextFor, emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createMessage,
  createUserMessage,
  isAgentLoopRequest,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import SubagentRuntime, {
  snapshotSubagentDescriptor,
  type SubagentProvider,
  type SubagentResult,
} from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

const contexts: Context[] = []
const workspaces: string[] = []
const adapters: GatedTextAdapter[] = []

class FakeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'

  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

class GatedTextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly gate = Promise.withResolvers<void>()

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  release(): void {
    this.gate.resolve()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate.promise
    options.signal?.throwIfAborted()
    const text = 'continuable work complete'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class PlanExitBatchAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const calls = [
        {
          id: 'plan-exit',
          name: 'exit_plan_mode',
          arguments: {
            plan: '# Approved implementation\n\nImplement the accepted system without changing its boundaries.',
          },
        },
        { id: 'same-batch-open', name: 'lattice_open', arguments: {} },
        { id: 'same-batch-edit', name: 'edit', arguments: { content: 'must remain blocked until the next step' } },
      ]
      for (const [index, call] of calls.entries()) {
        const argumentsJson = JSON.stringify(call.arguments)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: call.id as never,
            name: call.name,
            arguments: argumentsJson,
          },
        }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const text = 'approved implementation complete'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class OverflowThenTextAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 128 } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const trailing = options.messages.at(-1)?.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests.push(options)
      const summary = 'RECOVERY CHECKPOINT'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: summary }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    this.conversationRequests.push(options)
    if (this.conversationRequests.length === 1) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'request exceeds the model context window',
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        },
      }
      return
    }
    const text = 'recovered after native compaction'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type ToolResult = Awaited<ReturnType<Context['tools']['execute']>>

function valueOf(result: ToolResult): Record<string, unknown> {
  if (result.isError) {
    throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  }
  return result.value as Record<string, unknown>
}

function sendUser(ctx: Context, agent: Agent, text: string): void {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for native continuable state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function overflowHistorySeed(): SessionEvent[] {
  const session = Session.create(SessionId('plan-lattice-overflow-seed'))
  for (let turn = 1; turn <= 2; turn += 1) {
    const sentinel = turn === 1 ? 'OLD HISTORY SENTINEL' : 'RECENT HISTORY'
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${sentinel} ${'old context '.repeat(200)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `historical response ${turn} ${'detail '.repeat(200)}` }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [...session.events]
}

async function mountPlanLattice(ctx: Context, config: Parameters<typeof apply>[1]): Promise<void> {
  await ctx.plugin({
    name: 'plan-lattice-under-test',
    inject: ['tools'],
    apply(inner) {
      apply(inner, config)
    },
  })
}

describe('official rc.7 continuable integration', () => {
  afterEach(async () => {
    for (const adapter of adapters.splice(0)) adapter.release()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('inherits through native unpublished setup rather than AgentRegistry parent ownership', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-continuable-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'a.ts'), 'export const value = 1\n', 'utf8')

    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionPersistence, { root: join(workspace, '.sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    let edits = 0
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Native continuable filesystem mutation fixture.',
      parameters: {
        file_path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        await writeFile(args.file_path, args.content, 'utf8')
        edits += 1
        return `edit-${edits}`
      },
    }))

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-continuable-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === parent) return { kind: 'reject' as const }
      return next()
    })

    sendUser(ctx, parent, 'Use the full Plan Lattice to build the accepted system without asking questions.')
    let call = 0
    const invoke = (agent: Agent, name: string, args: unknown) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `native-continuable-${++call}` as never,
      name,
      arguments: args,
      agent,
    })
    const opened = valueOf(await invoke(parent, 'lattice_open', {}))
    const selected = (opened.initialPlan as { selectedLeaf: { node: { id: string } } }).selectedLeaf.node

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'native Plan Lattice child',
      request: {
        prompt: [{ type: 'text', text: 'Implement the current accepted leaf.' }],
        parent,
      },
      signal: new AbortController().signal,
    })
    const child = ctx.agents.get(started.childId)
    expect(child).toBeDefined()
    if (child === undefined) throw new Error('native continuable child was not live after inbox acceptance')
    const childErrors: unknown[] = []
    child.ctx.on('agent/error', ({ error }) => { childErrors.push(error) })
    expect(ctx.agents.isOwnedBy(child.id, parent)).toBe(false)
    expect(child.session.events.slice(child.session.header.seedLength ?? 0)
      .some(event => event.type === 'subagent/descriptor')).toBe(true)
    const childTools = ctx.tools.schemas(child).map(tool => tool.name)
    expect(childTools).not.toContain('lattice_open')
    expect(childTools).not.toContain('lattice_reframe')
    expect(childTools).toContain('lattice_refresh_context')

    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(child))
    const state = prompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(state).toContain(`Root session: ${parent.id}`)
    expect(state).toContain('Execute the current human-authored request')
    expect(state).toContain('Reframe pending: no')
    expect(state).toContain('Agent role: delegated')

    // startContinuable resolves at native inbox acceptance. Wait for the loop
    // to commit that exact initial delegation before deriving mutation authority.
    await waitUntil(() => childErrors.length > 0 || child.session.events.slice(child.session.header.seedLength ?? 0)
      .some(event => event.type === 'user/message' && event.data.source.kind === 'user'))
    expect(childErrors).toEqual([])

    const refreshed = valueOf(await invoke(child, 'lattice_refresh_context', { planNodeId: selected.id }))
    const receipt = refreshed.receipt as { id: string; revision: number }
    valueOf(await invoke(child, 'lattice_checkout', {
      receiptId: receipt.id,
      expectedRevision: receipt.revision,
      nodeId: selected.id,
    }))
    valueOf(await invoke(child, 'lattice_refresh_context', { targetPaths: ['a.ts'] }))
    const edited = await invoke(child, 'edit', {
      file_path: join(workspace, 'a.ts'),
      content: 'export const value = 2\n',
    })
    expect(edited.isError).toBe(false)
    expect(edits).toBe(1)
    expect(await readFile(join(workspace, 'a.ts'), 'utf8')).toBe('export const value = 2\n')

    adapter.release()
    await waitUntil(() => ctx.agents.get(started.childId) === undefined)
    expect(adapter.requests).toHaveLength(1)
  })

  it('augments the native tool-subagent prompt path without replacing it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-tool-subagent-'))
    workspaces.push(workspace)

    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionPersistence, { root: join(workspace, '.sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })
    await ctx.plugin(ToolSubagent, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-tool-subagent-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent
      ? { kind: 'reject' as const }
      : next())

    sendUser(ctx, parent, 'Build the accepted system through the native DSH delegation path.')
    let call = 0
    const invoke = (agent: Agent, name: string, args: unknown) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `native-tool-subagent-${++call}` as never,
      name,
      arguments: args,
      agent,
    })
    const opened = valueOf(await invoke(parent, 'lattice_open', {}))
    const initialPlan = opened.initialPlan as {
      nodes: Array<{ node: { id: string; title: string; acceptanceCriteria: string } }>
      selectedLeaf: { node: { id: string; title: string; acceptanceCriteria: string } }
    }
    const selected = initialPlan.selectedLeaf.node
    const root = initialPlan.nodes.find(entry => entry.node.id !== selected.id)?.node
    if (root === undefined) throw new Error('controller bootstrap must create a root for delegation scope coverage')
    const rootContext = valueOf(await invoke(parent, 'lattice_refresh_context', { planNodeId: root.id }))
    const rootReceipt = rootContext.receipt as { id: string; revision: number }
    const sibling = valueOf(await invoke(parent, 'lattice_add', {
      receiptId: rootReceipt.id,
      expectedRevision: rootReceipt.revision,
      parentId: root.id,
      title: 'A neighboring branch',
      acceptanceCriteria: 'This branch remains outside the delegated child scope.',
    })).node as { id: string }
    const parentContext = valueOf(await invoke(parent, 'lattice_refresh_context', { planNodeId: selected.id }))
    const parentReceipt = parentContext.receipt as { id: string; revision: number }
    valueOf(await invoke(parent, 'lattice_checkout', {
      receiptId: parentReceipt.id,
      expectedRevision: parentReceipt.revision,
      nodeId: selected.id,
    }))

    const delegatedTask = 'Implement only the assigned accepted leaf; report concrete verification.'
    const start = valueOf(await invoke(parent, 'subagent', {
      description: 'implement accepted leaf',
      prompt: delegatedTask,
      run_in_background: true,
    }))
    expect(start.kind).toBe('continuable')
    const childId = String(start.subagentId)
    const child = ctx.agents.get(childId as never)
    expect(child).toBeDefined()
    if (child === undefined) throw new Error('native tool-subagent did not publish its continuable child')

    const childTools = ctx.tools.schemas(child).map(tool => tool.name)
    expect(childTools).toContain('lattice_refresh_context')
    expect(childTools).toContain('lattice_checkout')
    expect(childTools).not.toContain('lattice_add')
    expect(childTools).not.toContain('lattice_split')
    expect(childTools).not.toContain('lattice_update')
    expect(childTools).not.toContain('lattice_archive')

    await waitUntil(() => adapter.requests.length === 1)
    const ownUserMessages = child.session.events
      .slice(child.session.header.seedLength ?? 0)
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(ownUserMessages).toHaveLength(1)
    expect(ownUserMessages[0]?.data.content).toEqual([{ type: 'text', text: delegatedTask }])

    const request = adapter.requests[0]!
    expect(request.system).toContain('DSH owns conversation history, compaction and pruning, native plan mode, todos, tool transport, and child prompt delivery')
    expect(request.system).not.toContain('define the boundary and time horizon')
    const nativeUserMessages = request.messages.filter(message => message.source.kind === 'user')
    expect(nativeUserMessages).toHaveLength(1)
    expect(nativeUserMessages[0]?.content).toEqual([{ type: 'text', text: delegatedTask }])
    const runtimeSnapshot = [...request.messages].reverse().find(message => message.source.kind === 'plugin'
      && message.source.plugin === '@deepseek-ai/dsh-system-prompt')
    const runtimeText = runtimeSnapshot?.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('') ?? ''
    expect(runtimeText).toContain(`Root session: ${parent.id}`)
    expect(runtimeText).toContain(`Current node: ${selected.id} - ${selected.title}`)
    expect(runtimeText).toContain(`Node acceptance: ${selected.acceptanceCriteria}`)
    expect(runtimeText).toContain('Execution path:')
    expect(runtimeText).toContain(`${root.id} - ${root.title}`)
    expect(runtimeText).toContain(`${selected.id} - ${selected.title}`)
    expect(runtimeText).toContain('Agent role: delegated')

    const wrongBranch = await invoke(child, 'lattice_refresh_context', { planNodeId: sibling.id })
    expect(wrongBranch.isError).toBe(true)
    expect(wrongBranch.content.map(block => block.type === 'text' ? block.text : '').join('\n')).toMatch(/assigned only to leaf|changed branch/i)

    const ownContext = valueOf(await invoke(child, 'lattice_refresh_context', {}))
    expect(JSON.stringify(ownContext.planContext)).toContain(selected.id)

    adapter.release()
    await waitUntil(() => ctx.agents.get(child.id) === undefined)
  })

  it.each([
    ['removes', (messages: GenerateOptions['messages']) => []],
    ['duplicates', (messages: GenerateOptions['messages']) => [messages[0]!, ...messages]],
    ['rewrites', (messages: GenerateOptions['messages']) => [
      { ...messages[0]!, content: [{ type: 'text' as const, text: 'DOWNSTREAM REWRITE' }] },
      ...messages.slice(1),
    ]],
  ])('fails closed when downstream pre-step middleware %s the native child prompt', async (_case, transform) => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-child-prompt-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionPersistence, { root: join(workspace, '.sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId(`native-child-prompt-parent-${_case}`), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, parent, 'Build the accepted system with exact native delegation identity.')
    valueOf(await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `native-child-prompt-open-${_case}` as never,
      name: 'lattice_open',
      arguments: {},
      agent: parent,
    }))

    const childErrors: unknown[] = []
    ctx.on('agent/error', ({ agent, error }) => {
      if (agent !== parent) childErrors.push(error)
    })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (agent === parent || decision.kind === 'reject') return decision
      return { ...decision, messages: transform(decision.messages) }
    })

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: `downstream ${_case} fixture`,
      request: {
        prompt: [{ type: 'text', text: 'PRESERVE THIS EXACT NATIVE CHILD PROMPT' }],
        parent,
      },
      signal: new AbortController().signal,
    })
    const child = ctx.agents.get(started.childId)
    expect(child).toBeDefined()
    if (child === undefined) throw new Error('downstream prompt fixture did not publish its child')
    await waitUntil(() => childErrors.length > 0 || child.status === 'idle')

    expect(String(childErrors[0])).toMatch(/downstream rewrite, removal, or duplication/i)
    expect(adapter.requests).toHaveLength(0)
    expect(child.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toBe(false)
  })

  it('restores the original delegated leaf on cold resume even after the parent moves, then blocks when the binding is absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-child-resume-'))
    workspaces.push(workspace)
    const anchors = join(workspace, '.authorization-anchors')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionPersistence, { root: join(workspace, '.sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: anchors,
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-child-resume-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, parent, 'Build the accepted system and preserve each delegated leaf across cold resume.')
    let call = 0
    const invoke = (agent: Agent, name: string, args: unknown) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `native-child-resume-${++call}` as never,
      name,
      arguments: args,
      agent,
    })
    const opened = valueOf(await invoke(parent, 'lattice_open', {}))
    const initialPlan = opened.initialPlan as {
      nodes: Array<{ node: { id: string } }>
      selectedLeaf: { node: { id: string; title: string; acceptanceCriteria: string } }
    }
    const selected = initialPlan.selectedLeaf.node
    const root = initialPlan.nodes.find(entry => entry.node.id !== selected.id)?.node
    if (root === undefined) throw new Error('cold-resume fixture requires the controller root')
    const rootContext = valueOf(await invoke(parent, 'lattice_refresh_context', { planNodeId: root.id }))
    const rootReceipt = rootContext.receipt as { id: string; revision: number }
    const sibling = valueOf(await invoke(parent, 'lattice_add', {
      receiptId: rootReceipt.id,
      expectedRevision: rootReceipt.revision,
      parentId: root.id,
      title: 'Newer parent branch',
      acceptanceCriteria: 'This branch must not replace the child original assignment.',
    })).node as { id: string; title: string; acceptanceCriteria: string }
    const selectedContext = valueOf(await invoke(parent, 'lattice_refresh_context', { planNodeId: selected.id }))
    const selectedReceipt = selectedContext.receipt as { id: string; revision: number }
    valueOf(await invoke(parent, 'lattice_checkout', {
      receiptId: selectedReceipt.id,
      expectedRevision: selectedReceipt.revision,
      nodeId: selected.id,
    }))

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'cold-resume bound leaf',
      request: {
        prompt: [{ type: 'text', text: 'Execute only the originally delegated leaf.' }],
        parent,
      },
      signal: new AbortController().signal,
    })
    await waitUntil(() => adapter.requests.length === 1)
    expect(JSON.stringify(adapter.requests[0])).toContain(`Current node: ${selected.id}`)
    adapter.release()
    await waitUntil(() => ctx.agents.get(started.childId) === undefined)
    const bindingName = `${createHash('sha256').update(String(started.childId)).digest('hex')}.json`
    const bindingPath = join(anchors, 'delegated-execution', 'v1', bindingName)
    const bindingText = await readFile(bindingPath, 'utf8')
    expect(bindingText).not.toContain('Execute only the originally delegated leaf.')
    const persistedChild = await ctx.sessionPersistence.inspect(started.childId)
    expect(persistedChild.events.some(event => event.type.startsWith('plan-lattice/'))).toBe(false)

    const siblingContext = valueOf(await invoke(parent, 'lattice_refresh_context', { planNodeId: sibling.id }))
    const siblingReceipt = siblingContext.receipt as { id: string; revision: number }
    valueOf(await invoke(parent, 'lattice_checkout', {
      receiptId: siblingReceipt.id,
      expectedRevision: siblingReceipt.revision,
      nodeId: sibling.id,
    }))

    await ctx.subagents.followup(
      parent,
      started.childId,
      [{ type: 'text', text: 'Continue from your native durable child session.' }],
      { source: { kind: 'plugin', plugin: 'cold-resume-fixture' }, signal: new AbortController().signal },
    )
    await waitUntil(() => adapter.requests.length === 2)
    const resumed = adapter.requests[1]!
    expect(JSON.stringify(resumed)).toContain(`Current node: ${selected.id}`)
    expect(JSON.stringify(resumed)).not.toContain(`Current node: ${sibling.id}`)
    await waitUntil(() => ctx.agents.get(started.childId) === undefined)

    await rm(bindingPath, { force: true })
    await expect(ctx.subagents.followup(
      parent,
      started.childId,
      [{ type: 'text', text: 'This resume must fail without the immutable binding.' }],
      { source: { kind: 'plugin', plugin: 'missing-binding-fixture' }, signal: new AbortController().signal },
    )).rejects.toThrow(/no durable delegation binding|new native delegation/i)
  })

  it('recognizes a native one-shot spawn only after its start edge and own descriptor agree', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-one-shot-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-one-shot-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, parent, 'Build the accepted system with the full Plan Lattice.')
    valueOf(await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-one-shot-open' as never,
      name: 'lattice_open',
      arguments: {},
      agent: parent,
    }))

    const run = await ctx.subagents.start('spawn', {
      parent,
      prompt: [{ type: 'text', text: 'Implement the current accepted leaf.' }],
      signal: new AbortController().signal,
    })
    const child = run.localAgent
    expect(child).toBeDefined()
    if (child === undefined) throw new Error('native one-shot child did not expose its local Agent')
    await waitUntil(() => adapter.requests.length === 1)
    const own = child.session.events.slice(child.session.header.seedLength ?? 0)
    expect(own.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(own.some(event => event.type === 'user/message' && event.data.source.kind === 'user')).toBe(true)
    const requestText = JSON.stringify(adapter.requests[0])
    expect(requestText).toContain(`Root session: ${parent.id}`)
    expect(requestText).toContain('Reframe pending: no')

    adapter.release()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
  })

  it('preserves an auto probe request when rc.7 publishes the one-shot descriptor after assembly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-probe-one-shot-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'auto',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    let edits = 0
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Probe child mutation fixture.',
      parameters: { content: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute() {
        edits += 1
        return Promise.resolve(`edit-${edits}`)
      },
    }))

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-probe-one-shot-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    const delegatedTask = 'Inspect the repository and determine the current implementation boundary.'
    const run = await ctx.subagents.start('spawn', {
      parent,
      prompt: [{ type: 'text', text: delegatedTask }],
      signal: new AbortController().signal,
    })
    const child = run.localAgent
    expect(child).toBeDefined()
    if (child === undefined) throw new Error('native probe one-shot child did not expose its local Agent')
    const childErrors: unknown[] = []
    child.ctx.on('agent/error', ({ error }) => { childErrors.push(error) })

    await waitUntil(() => adapter.requests.length === 1 || childErrors.length > 0)
    expect(childErrors).toEqual([])
    const own = child.session.events.slice(child.session.header.seedLength ?? 0)
    expect(own.some(event => event.type === 'subagent/descriptor')).toBe(true)
    const ownUserMessages = own.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(ownUserMessages).toHaveLength(1)
    expect(ownUserMessages[0]?.data.content).toEqual([{ type: 'text', text: delegatedTask }])

    const request = adapter.requests[0]!
    const nativeUserMessages = request.messages.filter(message => message.source.kind === 'user')
    expect(nativeUserMessages).toHaveLength(1)
    expect(nativeUserMessages[0]?.content).toEqual([{ type: 'text', text: delegatedTask }])
    expect(JSON.stringify(request)).toContain('Control: route probe')

    const staleWrite = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-probe-one-shot-stale-edit' as never,
      name: 'edit',
      arguments: { content: 'must remain blocked without a fresh authority basis' },
      agent: child,
    })
    expect(staleWrite.isError).toBe(true)
    expect(edits).toBe(0)

    adapter.release()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
  })

  it('uses the first authoritative native descriptor and rejects a provider mismatch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-descriptor-mismatch-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-descriptor-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, parent, 'Build the accepted system with the full Plan Lattice.')
    valueOf(await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-descriptor-open' as never,
      name: 'lattice_open',
      arguments: {},
      agent: parent,
    }))

    let forged = false
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== parent && !forged) {
        forged = true
        agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({
          mode: 'one-shot',
          provider: 'different-provider',
        }))
      }
      return next()
    }, { global: true, prepend: true })

    const run = await ctx.subagents.start('spawn', {
      parent,
      prompt: [{ type: 'text', text: 'This descriptor must match the native start provider.' }],
      signal: new AbortController().signal,
    })
    const child = run.localAgent
    expect(child).toBeDefined()
    if (child === undefined) throw new Error('descriptor fixture did not publish a local child')
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(adapter.requests).toHaveLength(0)
    const descriptors = child.session.events
      .slice(child.session.header.seedLength ?? 0)
      .filter(event => event.type === 'subagent/descriptor')
    expect(descriptors).toHaveLength(2)
    expect(descriptors[0]?.data.provider).toBe('different-provider')
    expect(descriptors[1]?.data.provider).toBe('spawn')

    adapter.release()
    await run.dispose()
  })

  it('does not reuse a rejected one-shot start edge for a later direct user message', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-one-shot-reject-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-one-shot-reject-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, parent, 'Build the accepted system with the full Plan Lattice.')
    valueOf(await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-one-shot-reject-open' as never,
      name: 'lattice_open',
      arguments: {},
      agent: parent,
    }))

    let rejected = false
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === parent || rejected) return next()
      rejected = true
      return { kind: 'reject' as const }
    })
    const run = await Promise.race([
      ctx.subagents.start('spawn', {
        parent,
        prompt: [{ type: 'text', text: 'Implement the current accepted leaf.' }],
        signal: new AbortController().signal,
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('native rejected one-shot start did not publish')), 1_000)),
    ])
    const child = run.localAgent
    expect(child).toBeDefined()
    if (child === undefined) throw new Error('native rejected one-shot child was not exposed')
    const errors: unknown[] = []
    child.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    await waitUntil(() => rejected, 1_000)
    await waitUntil(() => child.status === 'idle', 1_000)
    const rejectedResult = await Promise.race([
      run.result,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('native rejected one-shot result did not settle')), 1_000)),
    ])
    expect(rejectedResult).toMatchObject({ stopReason: 'refusal' })
    expect(rejected).toBe(true)

    child.followup(createUserMessage({
      content: [{ type: 'text', text: 'Change the accepted product boundary directly in this child.' }],
      source: { kind: 'user' },
    }))

    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0, 1_000)
    expect(String(errors[0])).toMatch(/without native initial-delegation provenance/i)
    expect(adapter.requests).toHaveLength(0)

    adapter.release()
    await Promise.race([
      child.whenIdle(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('direct child followup did not settle')), 1_000)),
    ])
    await run.dispose()
  })

  it('does not let a remote run id collision authenticate a local child', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-remote-collision-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('native-collision-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, parent, 'Build the accepted system with the full Plan Lattice.')
    valueOf(await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-collision-open' as never,
      name: 'lattice_open',
      arguments: {},
      agent: parent,
    }))

    let rejected = false
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === parent || rejected) return next()
      rejected = true
      return { kind: 'reject' as const }
    })
    const localRun = await ctx.subagents.start('spawn', {
      parent,
      prompt: [{ type: 'text', text: 'This initial local delegation will be rejected.' }],
      signal: new AbortController().signal,
    })
    const localChild = localRun.localAgent
    expect(localChild).toBeDefined()
    if (localChild === undefined) throw new Error('collision fixture did not publish a local child')
    await expect(localRun.result).resolves.toMatchObject({ stopReason: 'refusal' })
    expect(ctx.agents.get(localChild.id)).toBe(localChild)

    const remoteParent = ctx.agentLoop.create(SessionId('native-collision-remote-parent'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: join(workspace, 'remote-parent') })
    const remoteResult = Promise.withResolvers<SubagentResult>()
    const remoteProvider: SubagentProvider = {
      name: 'remote-collision',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.resolve({
        id: localChild.id,
        localAgent: undefined,
        result: remoteResult.promise,
        dispose: () => {
          remoteResult.resolve({ output: [], stopReason: 'completed' })
          return Promise.resolve()
        },
      }),
    }
    ctx.subagents.registerProvider(remoteProvider)
    const remoteRun = await ctx.subagents.start('remote-collision', {
      parent: remoteParent,
      prompt: [{ type: 'text', text: 'Remote task in another parent namespace.' }],
      signal: new AbortController().signal,
    })
    expect(remoteRun.localAgent).toBeUndefined()
    expect(remoteRun.id).toBe(localChild.id)

    const errors: unknown[] = []
    localChild.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    localChild.followup(createUserMessage({
      content: [{ type: 'text', text: 'Direct human-role input must not inherit delegation authority.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => errors.length > 0 || adapter.requests.length > 0, 1_000)
    expect(String(errors[0])).toMatch(/without native initial-delegation provenance/i)
    expect(adapter.requests).toHaveLength(0)

    adapter.release()
    await remoteRun.dispose()
    await localRun.dispose()
  })

  it('preserves claimed input across pre-step compaction and refreshes the next native wire', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-pre-step-compaction-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-pre-step-compaction'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, agent, 'Build the accepted system with the full Plan Lattice.')
    valueOf(await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-pre-step-compaction-open' as never,
      name: 'lattice_open',
      arguments: {},
      agent,
    }))
    let compacted = false
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      if (!compacted) {
        compacted = true
        const source = agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Large native tool result.' }],
          source: { kind: 'plugin', plugin: 'native-compaction-fixture' },
        }), { surfaceOp: 'append' })
        agent.session.append('compaction/prune', {
          shadowedRange: { start: source.seq, end: source.seq },
          shadowedSeqs: [source.seq],
          shadowedTokenCount: 8,
        })
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Native replacement surface after pruning.' }],
          source: { kind: 'plugin', plugin: 'native-compaction-fixture' },
        }), {
          surfaceOp: { op: 'replace', start: source.seq, end: source.seq },
          sourceEventSeqs: [source.seq],
        })
      }
      return next()
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue the current accepted work.' }],
      source: { kind: 'plugin', plugin: 'native-operational-input' },
    }))

    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    expect(errors).toEqual([])
    expect(JSON.stringify(adapter.requests[0])).toContain('Continue the current accepted work.')
    expect(JSON.stringify(adapter.requests[0])).not.toContain('Latest history replacement: compaction/prune')
    adapter.release()
    await agent.whenIdle()

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start a fresh native step from the compacted boundary.' }],
      source: { kind: 'plugin', plugin: 'native-operational-input' },
    }))
    await waitUntil(() => adapter.requests.length === 2 || errors.length > 0)
    expect(errors).toEqual([])
    expect(JSON.stringify(adapter.requests[1])).toContain('Latest history replacement: user/message')
    const dshSnapshots = adapter.requests[1]!.messages.filter(message => message.source.kind === 'plugin'
      && message.source.plugin === '@deepseek-ai/dsh-system-prompt'
      && message.source.form === 'snapshot')
    expect(dshSnapshots.length).toBeGreaterThanOrEqual(1)
    adapter.release()
    await agent.whenIdle()
  })

  it('attests the final Code Mode request at llm/stream', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-code-request-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakeCodeRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-code-request'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.tools.presentAs('code')
    agent.ctx.systemPrompt.section({
      name: 'test:complete-code-persona',
      order: 0,
      text: 'You are a focused software engineer.',
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the complete accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    expect(errors).toEqual([])
    const request = adapter.requests[0]!
    expect(request.tools?.map(tool => tool.name)).toEqual(['run_code'])
    expect(request.system).toContain('You are a focused software engineer.')
    expect(request.system).toContain('## Plan Lattice')
    const runtimeSnapshot = [...request.messages].reverse().find(message => message.source.kind === 'plugin'
      && message.source.plugin === '@deepseek-ai/dsh-system-prompt'
      && message.source.form === 'snapshot')
    expect(JSON.stringify(runtimeSnapshot)).not.toContain('DSH Code Mode bridge')
    expect(JSON.stringify(runtimeSnapshot)).toContain('Read the task and repository normally')

    adapter.release()
    await agent.whenIdle()
  })

  it('fails closed when rc.7 restores a complete persona after the assembly waterfall', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-complete-persona-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-complete-persona'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.systemPrompt.section({
      name: 'test:complete-persona',
      order: 0,
      text: 'Only this system prompt may remain.',
      complete: true,
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => errors.length > 0)
    expect(String(errors[0])).toMatch(/system prompt differs from the attested DSH assembly/i)
    expect(adapter.requests).toHaveLength(0)
  })

  it('does not manufacture a Code Mode bridge before a control action is required', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-code-injected-schema-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakeCodeRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-code-injected-schema'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.tools.presentAs('code')
    ctx.on('system-prompt/assemble', async (_assembly, assemble, next) => {
      const transformed = await next()
      if (assemble.agent !== agent) return transformed
      const native = ctx.tools.schemas(agent).find(tool => tool.name === 'lattice_open')
      if (native === undefined) throw new Error('missing native lattice_open fixture schema')
      return { ...transformed, tools: [...transformed.tools, native] }
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    expect(errors).toEqual([])
    const request = adapter.requests[0]!
    expect(request.tools?.map(tool => tool.name).sort()).toEqual(['lattice_open', 'run_code'])
    expect(JSON.stringify(request.messages)).not.toContain('DSH Code Mode bridge')
    expect(JSON.stringify(request.messages)).toContain('Read the task and repository normally')

    adapter.release()
    await agent.whenIdle()
  })

  it('allows a first read-only request when a Code Mode bridge is absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-code-removed-bridge-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakeCodeRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-code-removed-bridge'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.tools.presentAs('code')
    ctx.on('system-prompt/assemble', async (_assembly, assemble, next) => {
      const transformed = await next()
      if (assemble.agent !== agent) return transformed
      const native = ctx.tools.schemas(agent).find(tool => tool.name === 'lattice_open')
      if (native === undefined) throw new Error('missing native lattice_open fixture schema')
      return { ...transformed, tools: [native] }
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    expect(errors).toEqual([])
    expect(adapter.requests).toHaveLength(1)
    adapter.release()
    await agent.whenIdle()
  })

  it('rejects a native request when DSH switches to Code Mode after assembly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-code-after-assembly-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakeCodeRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-code-after-assembly'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    let switched = false
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (!switched) {
        switched = true
        agent.ctx.tools.presentAs('code')
      }
      return decision
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => errors.length > 0)
    expect(String(errors[0])).toMatch(/tool presentation or registry state that changed after prompt assembly/i)
    expect(adapter.requests).toHaveLength(0)
  })

  it('does not force the Code Mode bridge when DSH presents both transports', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-both-request-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakeCodeRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-both-request'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.tools.presentAs('both')
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    expect(errors).toEqual([])
    const request = adapter.requests[0]!
    expect(request.tools?.map(tool => tool.name)).toContain('run_code')
    expect(request.tools?.map(tool => tool.name)).toContain('lattice_open')
    expect(JSON.stringify(request.messages)).not.toContain('DSH Code Mode bridge')

    adapter.release()
    await agent.whenIdle()
  })

  it('blocks a request when an outer prompt listener changes the attested system prompt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-final-system-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-final-system'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.on('system-prompt/assemble', async (_assembly, _assemble, next) => {
      const transformed = await next()
      return {
        ...transformed,
        sections: transformed.sections.filter(section => section.name !== 'plan:fractal-ledger'),
      }
    }, { prepend: true })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => errors.length > 0)
    expect(String(errors[0])).toMatch(/system prompt differs from the attested DSH assembly/i)
    expect(adapter.requests).toHaveLength(0)
  })

  it('preserves DSH overflow recovery but rejects its stale controlled retry before adapter dispatch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-overflow-retry-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new OverflowThenTextAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(BasicCompactionEngine, {
      thresholdRatio: 1,
      retainTokens: 100,
      maxTokens: 64,
      compactionRetries: 0,
      maxOverflowRetries: 1,
    })
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('native-overflow-retry'),
      seed: overflowHistorySeed(),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/stale execution-authorization epoch/i)
    expect(adapter.conversationRequests).toHaveLength(1)
    expect(adapter.summaryRequests).toHaveLength(1)
    expect(JSON.stringify(adapter.conversationRequests[0]!.messages)).toContain('OLD HISTORY SENTINEL')
    const snapshots = agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt'
      && event.data.source.form === 'snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.seq).toBeLessThan(agent.session.events.find(event => event.type === 'compaction/start')?.seq ?? Number.MAX_SAFE_INTEGER)
    expect(agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt'
      && event.data.source.form === 'snapshot'
      && event.seq > (agent.session.events.find(event => event.type === 'compaction/start')?.seq ?? Number.MAX_SAFE_INTEGER))).toBe(false)
    const events = agent.session.events
    expect(events.filter(event => event.type === 'compaction/start'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end').map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])
    expect(events.filter(event => event.type === 'step/start' && event.data.turn === 3)).toHaveLength(1)
  })

  it('restores exact native-first authority in an in-step overflow retry before requiring the next control wire', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-first-overflow-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await mountPlanLattice(ctx, {
      activationMode: 'auto',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    let edits = 0
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Guarded native-first recovery fixture.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        edits += 1
        return `edit-${edits}`
      },
    }))

    const adapter = new OverflowThenTextAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(BasicCompactionEngine, {
      thresholdRatio: 1,
      retainTokens: 100,
      maxTokens: 64,
      compactionRetries: 0,
      maxOverflowRetries: 1,
    })
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('native-first-overflow'),
      seed: overflowHistorySeed(),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const sentinel = 'NATIVE_FIRST_OVERFLOW_AUTHORITY_91bd must survive the retry.'

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `Build the accepted incident system. ${sentinel} Do not ask questions; make reversible assumptions.` }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(adapter.conversationRequests).toHaveLength(2)
    expect(adapter.conversationRequests[0]?.system).not.toContain('Plan Lattice')
    expect(adapter.conversationRequests[0]?.tools?.some(tool => tool.name.startsWith('lattice_')) ?? false).toBe(false)
    const retry = adapter.conversationRequests[1]!
    expect(JSON.stringify(retry.messages)).toContain('Rehydrated Human Authority')
    expect(JSON.stringify(retry.messages)).toContain(sentinel)
    expect(retry.tools?.some(tool => tool.name.startsWith('lattice_')) ?? false).toBe(false)
    const restoredAuthority = retry.messages.filter(message => message.source.kind === 'plugin'
      && message.source.plugin === 'plan-lattice'
      && JSON.stringify(message.content).includes('Rehydrated Human Authority'))
    expect(restoredAuthority).toHaveLength(1)
    const protectedWrite = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-first-overflow-protected-write' as never,
      name: 'edit',
      arguments: {},
      agent,
    })
    expect(protectedWrite.isError).toBe(true)
    expect(edits).toBe(0)
  })

  it('leaves a complete auto task on DSH native wire, then restores authority after the next surface boundary', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-first-wire-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'auto',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-first-wire'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const sentinel = 'NATIVE_WIRE_AUTHORITY_34d4 must return after DSH replacement.'

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `Build the accepted incident system. ${sentinel} Do not ask questions; make reversible assumptions.` }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    expect(errors).toEqual([])
    const native = adapter.requests[0]!
    expect(native.system).not.toContain('Plan Lattice')
    expect(native.tools?.some(tool => tool.name.startsWith('lattice_')) ?? false).toBe(false)
    expect(JSON.stringify(native.messages)).not.toContain('plan-lattice:execution-state')

    const shadowed = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'runtime material hidden by fixture compaction' }],
      source: { kind: 'plugin', plugin: 'native-first-wire-fixture' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Native compacted surface for the next step.' }],
      source: { kind: 'plugin', plugin: 'native-first-wire-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: shadowed.seq, end: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })

    adapter.release()
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue from the current native session boundary.' }],
      source: { kind: 'plugin', plugin: 'native-first-wire-fixture' },
    }))
    await waitUntil(() => adapter.requests.length === 2 || errors.length > 0)
    expect(errors).toEqual([])
    const recovered = adapter.requests[1]!
    expect(recovered.system).toContain('Plan Lattice contract control')
    expect(recovered.tools?.map(tool => tool.name)).toContain('lattice_intake')
    expect(JSON.stringify(recovered.messages)).toContain('Rehydrated Human Authority')
    expect(JSON.stringify(recovered.messages)).toContain(sentinel)
    await agent.whenIdle()
  })

  it('restores only the anchored root authority through real DSH persistence and resume', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-first-real-resume-'))
    workspaces.push(workspace)
    const sessions = join(workspace, '.sessions')
    const sessionId = SessionId('native-first-real-resume')
    const config = {
      activationMode: 'auto' as const,
      clarificationPolicy: 'never' as const,
      controlCeiling: 'lattice' as const,
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    }
    const historical = Session.create(sessionId)
    historical.append('turn/start', { turn: 1 })
    historical.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'STALE_RESUME_HISTORY_7e87 must never become current authority.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    historical.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'old completed task' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    historical.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const first = new Context()
    contexts.push(first)
    await mountAgentLoopTestDependencies(first)
    await first.plugin(SessionPersistence, { root: sessions })
    await first.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(first, config)
    const firstAdapter = new GatedTextAdapter()
    adapters.push(firstAdapter)
    first.llm.registerAdapter(['mock'], firstAdapter)
    const { agent: original } = await first.agentLoop.createAgent(first, {
      sessionId,
      seed: historical.events,
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const sentinel = 'ANCHOR_RESUME_AUTHORITY_4f31 must be restored exactly once.'
    original.followup(createUserMessage({
      content: [{ type: 'text', text: `Build the accepted incident system. ${sentinel} Do not ask questions; make reversible assumptions.` }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => firstAdapter.requests.length === 1)
    expect(firstAdapter.requests[0]?.system).not.toContain('Plan Lattice')
    firstAdapter.release()
    await original.whenIdle()

    const rootMessage = original.session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && JSON.stringify(event.data.content).includes(sentinel))
    if (rootMessage === undefined) throw new Error('native root task was not persisted')
    const shadowed = original.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'large transient context removed at the native boundary' }],
      source: { kind: 'plugin', plugin: 'resume-compaction-fixture' },
    }), { surfaceOp: 'append' })
    const replacedSurface = [...original.session.surface.nodes]
    if (replacedSurface.length === 0) throw new Error('native session had no surface to compact')
    original.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native compaction summary' }],
      source: { kind: 'plugin', plugin: 'resume-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: replacedSurface[0]!, end: shadowed.seq },
      sourceEventSeqs: replacedSurface,
    })
    await first.sessions.flush(original.session)
    contexts.splice(contexts.indexOf(first), 1)
    await first.fiber.dispose()

    const resumed = new Context()
    contexts.push(resumed)
    await mountAgentLoopTestDependencies(resumed)
    await resumed.plugin(SessionPersistence, { root: sessions })
    await resumed.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(resumed, config)
    let edits = 0
    resumed.tools.register(defineTool({
      name: 'edit',
      description: 'Guarded cold-resume mutation fixture.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        edits += 1
        return `edit-${edits}`
      },
    }))
    const resumedAdapter = new GatedTextAdapter()
    adapters.push(resumedAdapter)
    resumed.llm.registerAdapter(['mock'], resumedAdapter)
    const resumedAgent = (await resumed.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    resumedAgent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue from the durable native boundary.' }],
      source: { kind: 'plugin', plugin: 'resume-driver' },
    }))
    await waitUntil(() => resumedAdapter.requests.length === 1)
    const request = resumedAdapter.requests[0]!
    const recoverySnapshots = request.messages.filter(message => message.source.kind === 'plugin'
      && message.source.plugin === '@deepseek-ai/dsh-system-prompt'
      && message.source.form === 'snapshot'
      && JSON.stringify(message.content).includes('Rehydrated Human Authority'))
    expect(recoverySnapshots).toHaveLength(1)
    const recoveryText = recoverySnapshots[0]!.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(recoveryText).toContain(sentinel)
    expect(recoveryText).not.toContain('STALE_RESUME_HISTORY_7e87')
    expect(recoveryText.split(sentinel).length - 1).toBe(1)
    const protectedWrite = await resumed.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-first-real-resume-write' as never,
      name: 'edit',
      arguments: {},
      agent: resumedAgent,
    })
    expect(protectedWrite.isError).toBe(true)
    expect(edits).toBe(0)
    resumedAdapter.release()
    await resumedAgent.whenIdle()
  })

  it('leaves native context-overflow recovery untouched when activationMode is off', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-overflow-bypass-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await mountPlanLattice(ctx, {
      activationMode: 'off',
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new OverflowThenTextAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(BasicCompactionEngine, {
      thresholdRatio: 1,
      retainTokens: 100,
      maxTokens: 64,
      compactionRetries: 0,
      maxOverflowRetries: 1,
    })
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('native-overflow-bypass'),
      seed: overflowHistorySeed(),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue without Plan Lattice control.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(adapter.conversationRequests).toHaveLength(2)
    expect(adapter.summaryRequests).toHaveLength(1)
    expect(JSON.stringify(adapter.conversationRequests[1]!.messages)).toContain('RECOVERY CHECKPOINT')
    expect(JSON.stringify(adapter.conversationRequests[1]!.messages)).not.toContain('plan-lattice:execution-state')
    expect(adapter.conversationRequests[1]!.tools?.some(tool => tool.name.startsWith('lattice_')) ?? false).toBe(false)
  })

  it('rejects a final request when authority advances inside an asynchronous checkpoint window', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-checkpoint-race-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const checkpointEntered = Promise.withResolvers<void>()
    const checkpointRelease = Promise.withResolvers<void>()
    let advanced = false
    ctx.on('llm/stream', (options, next) => {
      if (!isAgentLoopRequest(options)) return next()
      return (async function*(): AsyncIterable<StreamChunk> {
        checkpointEntered.resolve()
        await checkpointRelease.promise
        if (!advanced) {
          advanced = true
          const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
          if (agent === undefined) throw new Error('checkpoint fixture lost its live agent')
          const source = agent.session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: 'Persisted while checkpointing.' }],
            source: { kind: 'plugin', plugin: 'native-checkpoint-fixture' },
          }), { surfaceOp: 'append' })
          agent.session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: 'Native replacement while checkpointing.' }],
            source: { kind: 'plugin', plugin: 'native-checkpoint-fixture' },
          }), {
            surfaceOp: { op: 'replace', start: source.seq, end: source.seq },
            sourceEventSeqs: [source.seq],
          })
        }
        yield* next()
      })()
    })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-checkpoint-race'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))

    await checkpointEntered.promise
    expect(adapter.requests).toHaveLength(0)
    checkpointRelease.resolve()
    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    if (adapter.requests.length === 1) adapter.release()
    await waitUntil(() => errors.length > 0)
    expect(String(errors[0])).toMatch(/stale execution-authorization epoch|stale projected runtime state/i)
    expect(adapter.requests.length).toBeLessThanOrEqual(1)
    expect(agent.session.events.some(event => event.type === 'assistant/chunk')).toBe(false)
  })

  it('records the bounded rc.7 finish-chunk admission gap without claiming atomicity', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-finish-admission-gap-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    let advanced = false
    ctx.on('llm/stream', (options, next) => {
      if (!isAgentLoopRequest(options)) return next()
      return (async function*(): AsyncIterable<StreamChunk> {
        for await (const chunk of next()) {
          if (!advanced && chunk.type === 'finish') {
            advanced = true
            const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
            if (agent === undefined) throw new Error('finish-admission fixture lost its live agent')
            const source = agent.session.append('user/message', createUserMessage({
              content: [{ type: 'text', text: 'Changed after Plan Lattice yielded the finish chunk.' }],
              source: { kind: 'plugin', plugin: 'finish-admission-fixture' },
            }), { surfaceOp: 'append' })
            agent.session.append('compaction/prune', {
              shadowedRange: { start: source.seq, end: source.seq },
              shadowedSeqs: [source.seq],
              shadowedTokenCount: 7,
            })
          }
          yield chunk
        }
      })()
    }, { global: true, prepend: true })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-finish-admission-gap'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))

    await waitUntil(() => adapter.requests.length === 1)
    adapter.release()
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(advanced).toBe(true)
    const events = agent.session.events
    const prune = events.find(event => event.type === 'compaction/prune')
    const finish = events.find(event => event.type === 'assistant/chunk' && event.data.chunk.type === 'finish')
    const message = events.find(event => event.type === 'assistant/message')
    expect(prune).toBeDefined()
    expect(finish).toBeDefined()
    expect(message).toBeDefined()
    expect(prune!.seq).toBeLessThan(finish!.seq)
    expect(finish!.seq).toBeLessThan(message!.seq)
  })

  it('blocks a real rc.7 request when later pre-step middleware strips the runtime snapshot', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-final-request-strip-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-final-request-strip'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: decision.messages.filter(message => !(message.source.kind === 'plugin'
          && message.source.plugin === '@deepseek-ai/dsh-system-prompt'
          && message.source.form === 'snapshot')),
      }
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => errors.length > 0)
    expect(String(errors[0])).toMatch(/final model request is missing the exact attested runtime-context snapshot/i)
    expect(adapter.requests).toHaveLength(0)
  })

  it('blocks a final request whose snapshot metadata survives but model-visible text is changed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-final-request-content-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-final-request-content'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: decision.messages.map(message => message.source.kind === 'plugin'
          && message.source.plugin === '@deepseek-ai/dsh-system-prompt'
          && message.source.form === 'snapshot'
          ? { ...message, content: [{ type: 'text' as const, text: 'forged runtime body' }] }
          : message),
      }
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system without asking questions.' }],
      source: { kind: 'user' },
    }))

    await waitUntil(() => errors.length > 0)
    expect(String(errors[0])).toMatch(/missing the exact attested runtime-context snapshot/i)
    expect(adapter.requests).toHaveLength(0)
  })

  it('blocks a request when authority advances after pre-step but before llm/stream', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-final-request-epoch-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })

    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-final-request-epoch'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, agent, 'Build the accepted system with the full Plan Lattice.')
    valueOf(await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-final-request-epoch-open' as never,
      name: 'lattice_open',
      arguments: {},
      agent,
    }))
    let advanced = false
    agent.ctx.on('agent/request', async (_payload, next) => {
      const request = await next()
      if (!advanced) {
        advanced = true
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: 'Change the accepted system boundary now.' }],
          source: { kind: 'user' },
        }))
      }
      return request
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue the current accepted work.' }],
      source: { kind: 'plugin', plugin: 'native-operational-input' },
    }))

    await waitUntil(() => errors.length > 0 || adapter.requests.length > 0)
    expect(String(errors[0])).toMatch(/stale execution-authorization epoch|stale projected runtime state/i)
    expect(adapter.requests).toHaveLength(0)
  })

  it('defers executable authority to native rc.7 plan mode and resumes only after exit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-native-plan-mode-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(UserQuestionService)
    let planReviewCount = 0
    let reviewedPlan: string | undefined
    ctx.userQuestions.registerProvider({
      ask: (request) => {
        planReviewCount += 1
        reviewedPlan = request.questions[0]?.detail
        return Promise.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
      },
    })
    await ctx.plugin(PlanMode, {
      section: 'You are in native plan mode. Explore and present the complete plan through exit_plan_mode.',
    })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })
    let edits = 0
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Protected native plan-mode mutation fixture.',
      parameters: { content: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: (args) => {
        edits += 1
        return Promise.resolve(args.content)
      },
    }))

    const adapter = new PlanExitBatchAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('native-plan-mode'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    expect(ctx.planMode.set(agent, true)).toBe('committed')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Design the accepted system before implementation.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const planning = adapter.requests[0]!
    expect(planning.system).toContain('You are in native plan mode.')
    expect(planning.system).toContain('DSH native plan mode exclusively owns this planning turn')
    expect(planning.system).not.toContain('Fresh-task bootstrap: lattice_open')
    expect(planning.tools?.map(tool => tool.name)).toContain('exit_plan_mode')
    expect(planning.tools?.map(tool => tool.name)).toContain('lattice_open')
    const executing = adapter.requests[1]!
    expect(executing.system).not.toContain('You are in native plan mode.')
    expect(executing.system).toContain('Work normally from the current human request and repository evidence')
    expect(JSON.stringify(executing.messages)).toContain('lattice_open {}')

    expect(planReviewCount).toBe(1)
    expect(reviewedPlan).toBe('# Approved implementation\n\nImplement the accepted system without changing its boundaries.')
    expect(edits).toBe(0)
    const results = agent.session.events.filter(event => event.type === 'tool/result')
    const exitResult = results.find(event => event.data.message.source.callId === 'plan-exit')
    const openResult = results.find(event => event.data.message.source.callId === 'same-batch-open')
    const editResult = results.find(event => event.data.message.source.callId === 'same-batch-edit')
    expect(exitResult?.data.message.content[0]?.isError).toBe(false)
    expect(openResult?.data.message.content[0]?.isError).toBe(true)
    expect(editResult?.data.message.content[0]?.isError).toBe(true)
    expect(JSON.stringify(openResult?.data.message.content)).toContain('native plan mode owns this turn')
    expect(JSON.stringify(editResult?.data.message.content)).toContain('native plan mode owns this turn')
    const exitBoundary = agent.session.events.find(event => event.type === 'plan/mode'
      && event.data.active === false)
    const secondStep = agent.session.events.find(event => event.type === 'step/start'
      && event.data.step === 2)
    expect(exitBoundary).toBeDefined()
    expect(secondStep).toBeDefined()
    expect(openResult!.seq).toBeLessThan(exitBoundary!.seq)
    expect(editResult!.seq).toBeLessThan(exitBoundary!.seq)
    expect(exitBoundary!.seq).toBeLessThan(secondStep!.seq)
    expect(ctx.planMode.get(agent)).toEqual({ active: false })
  })

  it('keeps explicit Plan Lattice bypass inert while native plan mode is active', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-plan-mode-bypass-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(PlanMode, { section: 'Use native plan mode.' })
    await mountPlanLattice(ctx, {
      activationMode: 'off',
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })
    let edits = 0
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Explicit bypass fixture.',
      parameters: { content: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: (args) => {
        edits += 1
        return Promise.resolve(args.content)
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('native-plan-mode-bypass'), {
      provider: 'mock', model: 'mock',
    }, { cwd: workspace })
    expect(ctx.planMode.set(agent, true)).toBe('committed')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-plan-mode-bypass-edit' as never,
      name: 'edit',
      arguments: { content: 'allowed by explicit bypass' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(edits).toBe(1)
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.sections.find(section => section.name === 'plan:fractal-ledger')?.text).toBe('')
    expect(assembly.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text).toBe('')
  })

  it('does not reject one Agent when another Agent changes its scoped tool view', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-agent-local-tools-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })
    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agentA = ctx.agentLoop.create(SessionId('agent-local-tools-a'), {
      provider: 'mock', model: 'mock',
    }, { cwd: workspace })
    const agentB = ctx.agentLoop.create(SessionId('agent-local-tools-b'), {
      provider: 'mock', model: 'mock',
    }, { cwd: workspace })
    let changed = false
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (agent === agentA && !changed) {
        changed = true
        agentB.ctx.tools.restrict({ deny: ['lattice_status'] })
      }
      return decision
    })
    const errors: unknown[] = []
    agentA.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agentA.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system.' }],
      source: { kind: 'user' },
    }))

    await waitUntil(() => adapter.requests.length === 1 || errors.length > 0)
    expect(errors).toEqual([])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('lattice_open')
    adapter.release()
    await agentA.whenIdle()
  })

  it('keeps an active guarded dispatch bound when only another Agent changes its scoped tools', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-agent-local-dispatch-'))
    workspaces.push(workspace)
    const target = join(workspace, 'a.ts')
    await writeFile(target, 'export const value = 1\n', 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: ['edit'],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })
    let edits = 0
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Cross-Agent guarded dispatch fixture.',
      parameters: {
        file_path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        edits += 1
        await writeFile(args.file_path, args.content, 'utf8')
        return `edit-${edits}`
      },
    }))
    const agentA = ctx.agentLoop.create(SessionId('agent-local-dispatch-a'), {
      provider: 'mock', model: 'mock',
    }, { cwd: workspace })
    const agentB = ctx.agentLoop.create(SessionId('agent-local-dispatch-b'), {
      provider: 'mock', model: 'mock',
    }, { cwd: workspace })
    sendUser(ctx, agentA, 'Use the full Plan Lattice to implement the accepted bounded change.')
    let call = 0
    const invoke = (agent: Agent, name: string, args: unknown) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `agent-local-dispatch-${++call}` as never,
      name,
      arguments: args,
      agent,
    })
    const opened = valueOf(await invoke(agentA, 'lattice_open', {}))
    const selected = (opened.initialPlan as { selectedLeaf: { node: { id: string } } }).selectedLeaf.node
    const context = valueOf(await invoke(agentA, 'lattice_refresh_context', { planNodeId: selected.id }))
    const receipt = context.receipt as { id: string; revision: number }
    valueOf(await invoke(agentA, 'lattice_checkout', {
      receiptId: receipt.id,
      expectedRevision: receipt.revision,
      nodeId: selected.id,
    }))
    valueOf(await invoke(agentA, 'lattice_refresh_context', { targetPaths: ['a.ts'] }))

    const dispatchEntered = Promise.withResolvers<void>()
    const dispatchRelease = Promise.withResolvers<void>()
    ctx.on('tools/execute', async (exec, next) => {
      if (String(exec.callId) === 'agent-a-guarded-edit') {
        dispatchEntered.resolve()
        await dispatchRelease.promise
      }
      return next()
    })
    const edit = ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'agent-a-guarded-edit' as never,
      name: 'edit',
      arguments: { file_path: target, content: 'export const value = 2\n' },
      agent: agentA,
    })
    await dispatchEntered.promise
    const releaseRestriction = agentB.ctx.tools.restrict({ deny: ['lattice_status'] })
    dispatchRelease.resolve()
    const edited = await edit
    releaseRestriction()

    expect(edited.isError).toBe(false)
    expect(edits).toBe(1)
    expect(await readFile(target, 'utf8')).toBe('export const value = 2\n')
    const status = valueOf(await invoke(agentA, 'lattice_status', { nodeId: selected.id }))
    expect(status.recentExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'agent-a-guarded-edit', outcome: 'success' }),
    ]))
  })

  it('fails closed when this Agent changes tool definitions inside one assembly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-same-assembly-tools-'))
    workspaces.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountPlanLattice(ctx, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: [],
      strictBash: false,
      contractAnchorRoot: join(workspace, '.authorization-anchors'),
    })
    const adapter = new GatedTextAdapter()
    adapters.push(adapter)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('same-assembly-tools'), {
      provider: 'mock', model: 'mock',
    }, { cwd: workspace })
    let changed = false
    ctx.on('system-prompt/assemble', async (assembly, assemble, next) => {
      const transformed = await next()
      if (assemble.agent === agent && !changed) {
        changed = true
        agent.ctx.tools.restrict({ deny: ['lattice_open'] })
      }
      return { ...transformed, tools: assembly.tools }
    })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted system.' }],
      source: { kind: 'user' },
    }))

    await waitUntil(() => errors.length > 0)
    expect(String(errors[0])).toMatch(/tool definitions changed for this Agent during prompt assembly|requires the current DSH control tool/i)
    expect(adapter.requests).toHaveLength(0)
  })
})
