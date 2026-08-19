import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.js'

const contexts: Context[] = []
const workspaces: string[] = []

class MaxTokenAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly outcomes: Array<'max-tokens' | 'stop'>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const outcome = this.outcomes.shift() ?? 'stop'
    const text = outcome === 'max-tokens' ? 'partial response cut at the output ceiling' : 'completed after a clean new turn'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: outcome } }
  }
}

function stageHumanInput(ctx: Context, agent: Agent, text: string): void {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
}

async function invoke(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: callId as never,
    name,
    arguments: args,
    agent,
  })
}

async function createHarness(
  config: Config,
  outcomes: Array<'max-tokens' | 'stop'>,
  options: { workspace?: string; persistenceRoot?: string; sessionId?: SessionId } = {},
) {
  const workspace = options.workspace ?? await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-max-token-'))
  if (options.workspace === undefined) workspaces.push(workspace)
  await writeFile(join(workspace, 'target.ts'), 'export const value = 1\n', 'utf8')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  if (options.persistenceRoot !== undefined) await ctx.plugin(SessionPersistence, { root: options.persistenceRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  apply(ctx, {
    ...config,
    contractAnchorRoot: config.contractAnchorRoot ?? join(workspace, '.authorization-anchors'),
  })
  const adapter = new MaxTokenAdapter(outcomes)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(options.sessionId ?? SessionId(`max-token-${Math.random().toString(16).slice(2)}`), {
    provider: 'mock',
    model: 'mock',
  }, { cwd: workspace })
  return { workspace, ctx, agent, adapter }
}

async function resumeHarness(
  workspace: string,
  persistenceRoot: string,
  config: Config,
  outcomes: Array<'max-tokens' | 'stop'>,
  sessionId: SessionId,
) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionPersistence, { root: persistenceRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  apply(ctx, {
    ...config,
    contractAnchorRoot: config.contractAnchorRoot ?? join(workspace, '.authorization-anchors'),
  })
  const adapter = new MaxTokenAdapter(outcomes)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = (await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  return { ctx, agent, adapter }
}

async function openLattice(ctx: Context, agent: Agent): Promise<void> {
  const result = await invoke(ctx, agent, 'open-lattice', 'lattice_open', {})
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
}

function startNativeTurn(agent: Agent): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Continue the accepted task through the native agent loop.' }],
    source: { kind: 'plugin', plugin: 'max-token-test-driver' },
  }))
}

describe('native max-token continuation', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('uses one bounded native followup for an active lattice task without creating a reframe or bypassing writes', async () => {
    const { workspace, ctx, agent, adapter } = await createHarness({
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      maxTokenContinuations: 1,
      guardedTools: ['edit'],
      strictBash: false,
    }, ['max-tokens', 'stop'])

    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Guarded edit fixture.',
      parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        return 'unexpected unguarded edit'
      },
    }))

    stageHumanInput(ctx, agent, 'Build the accepted multi-step system without changing its stated boundary.')
    await openLattice(ctx, agent)
    startNativeTurn(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const continuations = agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'plan-lattice'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('max-token-continuation')))
    expect(continuations).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[1])).toContain('Reframe pending: no')
    expect(adapter.requests[1]?.messages.filter(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('max-token-continuation')))).toHaveLength(1)
    const reasons = agent.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)
    expect(reasons).toEqual(['max-tokens', 'completed'])

    const denied = await invoke(ctx, agent, 'guarded-edit-after-continuation', 'edit', {
      file_path: join(workspace, 'target.ts'),
      content: 'export const value = 2\n',
    })
    expect(denied.isError).toBe(true)
  })

  it('uses the DSH session identity to continue an auto native-first request', async () => {
    const { ctx, agent, adapter } = await createHarness({
      activationMode: 'auto',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      maxTokenContinuations: 1,
      strictBash: false,
    }, ['max-tokens', 'stop'])

    stageHumanInput(ctx, agent, 'Build a small complete system from the written requirements and continue until every acceptance item is complete.')
    startNativeTurn(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const continuations = agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'plan-lattice'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('max-token-continuation')))
    expect(continuations).toHaveLength(1)
    expect(adapter.requests.every(request => !(request.system ?? '').includes('Plan Lattice'))).toBe(true)
    expect(agent.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['max-tokens', 'completed'])
  })

  it('never schedules an automatic continuation for a bypass task', async () => {
    const { ctx, agent, adapter } = await createHarness({ activationMode: 'auto' }, ['max-tokens'])
    stageHumanInput(ctx, agent, 'Rename the local heading from Alpha to Beta.')
    startNativeTurn(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'plan-lattice')).toBe(false)
    const turnEnds = agent.session.events.filter(event => event.type === 'turn/end')
    expect(turnEnds).toHaveLength(1)
    expect(turnEnds[0]?.data.reason).toEqual({ kind: 'max-tokens' })
  })

  it('does not reset the durable continuation budget after a real DSH session resume', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-max-token-resume-'))
    workspaces.push(workspace)
    const sessions = join(workspace, '.sessions')
    const sessionId = SessionId('max-token-resume')
    const config: Config = {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      maxTokenContinuations: 1,
      strictBash: false,
    }
    const first = await createHarness(config, ['max-tokens', 'max-tokens'], {
      workspace,
      persistenceRoot: sessions,
      sessionId,
    })
    stageHumanInput(first.ctx, first.agent, 'Implement the accepted long-running system.')
    await openLattice(first.ctx, first.agent)
    startNativeTurn(first.agent)
    await first.agent.whenIdle()
    expect(first.adapter.requests).toHaveLength(2)
    await first.ctx.sessions.flush(first.agent.session)
    contexts.splice(contexts.indexOf(first.ctx), 1)
    await first.ctx.fiber.dispose()

    const resumed = await resumeHarness(workspace, sessions, config, ['max-tokens'], sessionId)
    startNativeTurn(resumed.agent)
    await resumed.agent.whenIdle()
    expect(resumed.adapter.requests).toHaveLength(1)
    const continuations = resumed.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'plan-lattice'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('max-token-continuation')))
    expect(continuations).toHaveLength(1)
  })
})
