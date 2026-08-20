import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type TodoItem } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

const contexts: Context[] = []
const workspaces: string[] = []
const ROOT_SENTINEL = 'ROOT_AUTHORITY_SENTINEL_8f42'

class FakeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const tools = request.bindings.find(binding => binding.global === 'tools')?.functions
    if (tools === undefined) return { logs: [], error: { kind: 'exception', message: 'missing tools binding' } }
    const todos = request.program.includes('todo_advance')
      ? [
          { content: 'Implement the API', status: 'completed' },
          { content: 'Verify the API', status: 'in_progress' },
        ]
      : [
          { content: 'Implement the API', status: 'in_progress' },
          { content: 'Verify the API', status: 'pending' },
        ]
    if (request.program.includes('todo_then_write')) {
      await tools.todo_write?.({ todos })
      try {
        await tools.write?.({ file_path: 'api.ts', content: 'bypass' })
      } catch (error) {
        return { logs: ['nested write rejected'], value: String(error) }
      }
    }
    if (request.program.includes('todo_only') || request.program.includes('todo_advance')) {
      return { logs: [], value: await tools.todo_write?.({ todos }) ?? null }
    }
    if (request.program.includes('write_only')) {
      try {
        return { logs: [], value: await tools.write?.({ file_path: 'api.ts', content: 'valid' }) ?? null }
      } catch (error) {
        return { logs: ['nested write rejected'], value: String(error) }
      }
    }
    if (request.program.includes('verify_only')) {
      return { logs: [], value: await tools.bash?.({ command: 'pnpm test' }) ?? null }
    }
    return { logs: [] }
  }
}

function resultText(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'plan-lattice-native-workflow-'))
  workspaces.push(workspace)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FakeCodeRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin({
    name: 'plan-lattice-native-workflow-test',
    inject: ['tools'],
    apply(inner) {
      apply(inner, {
        activationMode: 'auto',
        clarificationPolicy: 'never',
        controlCeiling: 'lattice',
        guardedTools: ['write', 'bash'],
        strictBash: false,
        contractAnchorRoot: join(workspace, '.anchors'),
      })
    },
  })

  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: 'Replace the DSH-native Todo.',
    parameters: {
      todos: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true },
            status: {
              type: 'string', required: true,
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('todo_write test fixture requires an agent')
      const todos = args.todos as TodoItem[]
      exec.agent.session.append('todo/write', { todos })
      return Promise.resolve({ todos })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Protected write fixture.',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve('write applied'),
  }))
  let bashExecutions = 0
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Verification command fixture.',
    parameters: {
      command: { type: 'string', required: true },
      run_in_background: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => {
      bashExecutions += 1
      return Promise.resolve(args.command.includes('fail')
        ? '1 test failed\n[exit code: 1]'
        : '12 tests passed\n[exit code: 0]')
    },
  }))
  let subagentExecutions = 0
  ctx.tools.register(defineTool({
    name: 'subagent',
    description: 'Native rc.7-shaped delegation fixture.',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      run_in_background: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => {
      subagentExecutions += 1
      return Promise.resolve('foreground child completed')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description: 'Native user-question fixture.',
    parameters: { questions: { type: 'array', required: true, items: { type: 'json' } } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve('Use PostgreSQL and retain audit history.'),
  }))
  let terminalSendExecutions = 0
  ctx.tools.register(defineTool({
    name: 'terminal_send',
    description: 'Detached terminal transport fixture.',
    parameters: {
      terminal_id: { type: 'string', required: true },
      input: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => {
      terminalSendExecutions += 1
      return Promise.resolve('detached command accepted')
    },
  }))

  const agent = ctx.agentLoop.create(SessionId(`native-workflow-${Date.now()}`), {
    provider: 'mock', model: 'mock',
  }, { cwd: workspace })
  const request = createUserMessage({
    content: [{
      type: 'text',
      text: `Build a production-ready multi-agent customer support application in 12 stages. ${ROOT_SENTINEL}. Do not ask questions; use reasonable assumptions.`,
    }],
    source: { kind: 'user' },
  })
  emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message: request })
  agent.session.append('user/message', request, { surfaceOp: 'append' })
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })

  let call = 0
  const invoke = async (name: string, arguments_: unknown): Promise<ToolExecutionResult> => {
    const callId = `native-workflow-call-${++call}` as never
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId, name, arguments: JSON.stringify(arguments_),
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId,
      name,
      arguments: arguments_,
      agent,
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: result.content,
        isError: result.isError,
      }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }, { surfaceOp: 'append' })
    return result
  }
  const sendRoot = (text: string): void => {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
  return {
    ctx,
    agent,
    invoke,
    sendRoot,
    bashExecutions: () => bashExecutions,
    subagentExecutions: () => subagentExecutions,
    terminalSendExecutions: () => terminalSendExecutions,
  }
}

describe('DSH-native workflow integration', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('requires an ordered Todo and post-mutation verification before advancing', async () => {
    const { invoke } = await setup()
    expect(resultText(await invoke('write', { file_path: 'app.ts', content: 'first' })))
      .toContain('create an initial Todo')

    const first: TodoItem[] = [
      { content: 'Implement the API behavior', status: 'in_progress' },
      { content: 'Build the UI flow', status: 'pending' },
    ]
    expect((await invoke('todo_write', { todos: first })).isError).toBe(false)
    expect((await invoke('write', { file_path: 'app.ts', content: 'implemented' })).isError).toBe(false)

    const advanced: TodoItem[] = [
      { content: 'Implement the API behavior', status: 'completed' },
      { content: 'Build the UI flow', status: 'in_progress' },
    ]
    expect(resultText(await invoke('todo_write', { todos: advanced })))
      .toContain('requires verification after the last mutation')
    expect((await invoke('bash', { command: 'pnpm test' })).isError).toBe(false)
    expect((await invoke('todo_write', { todos: advanced })).isError).toBe(false)
  })

  it('does not let a same-step tool batch cross the Todo boundary', async () => {
    const { agent, invoke } = await setup()
    const todos: TodoItem[] = [
      { content: 'Define the API contract', status: 'in_progress' },
      { content: 'Implement the API', status: 'pending' },
    ]
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [
          {
            type: 'tool-call', id: CallId('native-workflow-call-1'), name: 'todo_write',
            arguments: JSON.stringify({ todos }),
          },
          {
            type: 'tool-call', id: CallId('native-workflow-call-2'), name: 'write',
            arguments: JSON.stringify({ file_path: 'api.ts', content: 'too early' }),
          },
        ],
      }),
    }, { surfaceOp: 'append' })
    expect((await invoke('todo_write', { todos })).isError).toBe(false)
    expect(resultText(await invoke('write', { file_path: 'api.ts', content: 'too early' })))
      .toContain('separates todo_write from write')
  })

  it('does not accept a transport-successful non-zero verification result', async () => {
    const { invoke } = await setup()
    const todos: TodoItem[] = [
      { content: 'Implement persistence', status: 'in_progress' },
      { content: 'Verify restart recovery', status: 'pending' },
    ]
    await invoke('todo_write', { todos })
    await invoke('write', { file_path: 'store.ts', content: 'changed' })
    const failed = await invoke('bash', { command: 'pnpm test fail' })
    expect(failed.isError).toBe(false)
    const complete: TodoItem[] = [
      { content: 'Implement persistence', status: 'completed' },
      { content: 'Verify restart recovery', status: 'in_progress' },
    ]
    expect(resultText(await invoke('todo_write', { todos: complete })))
      .toContain('replan required after bash reported')
  })

  it('fails closed before a detached DSH transport can escape the active Todo', async () => {
    const { invoke, terminalSendExecutions } = await setup()
    await invoke('todo_write', { todos: [
      { content: 'Implement the foreground change', status: 'in_progress' },
      { content: 'Verify the foreground change', status: 'pending' },
    ] })

    const blocked = await invoke('terminal_send', {
      terminal_id: 'background-shell',
      input: 'pnpm test',
    })

    expect(blocked.isError).toBe(true)
    expect(resultText(blocked)).toContain('cannot observe and validate this multi-action transport')
    expect(terminalSendExecutions()).toBe(0)
  })

  it('blocks background Bash and default-background rc.7 subagents before dispatch', async () => {
    const { invoke, bashExecutions, subagentExecutions } = await setup()
    await invoke('todo_write', { todos: [
      { content: 'Implement the foreground change', status: 'in_progress' },
      { content: 'Verify the foreground change', status: 'pending' },
    ] })

    const shell = await invoke('bash', { command: 'pnpm test', run_in_background: true })
    expect(shell.isError).toBe(true)
    expect(resultText(shell)).toContain('cannot observe and validate this multi-action transport')
    expect(bashExecutions()).toBe(0)

    for (const run_in_background of [undefined, true]) {
      const child = await invoke('subagent', {
        description: 'Implement module',
        prompt: 'Implement the active Todo.',
        ...(run_in_background === undefined ? {} : { run_in_background }),
      })
      expect(child.isError).toBe(true)
      expect(resultText(child)).toContain('cannot observe and validate this multi-action transport')
    }
    expect(subagentExecutions()).toBe(0)
    expect((await invoke('lattice_refresh_context', {})).isError).toBe(false)
    expect((await invoke('todo_write', { todos: [
      { content: 'Implement the foreground change', status: 'in_progress' },
      { content: 'Verify the foreground change', status: 'pending' },
    ] })).isError).toBe(false)
    expect((await invoke('subagent', {
      description: 'Implement module',
      prompt: 'Implement the active Todo.',
      run_in_background: false,
    })).isError).toBe(false)
    expect(subagentExecutions()).toBe(1)
  })

  it('requires a refresh and Todo replan after a native user-question answer', async () => {
    const { invoke } = await setup()
    const todos: TodoItem[] = [
      { content: 'Implement persistence', status: 'in_progress' },
      { content: 'Verify persistence', status: 'pending' },
    ]
    await invoke('todo_write', { todos })
    await invoke('ask_user_question', { questions: [{ question: 'Which database?' }] })

    expect(resultText(await invoke('write', { file_path: 'store.ts', content: 'too early' })))
      .toContain('replan required after ask_user_question returned new human authority')
    const refreshed = resultText(await invoke('lattice_refresh_context', {}))
    expect(refreshed).toContain('Use PostgreSQL and retain audit history.')
    expect((await invoke('todo_write', { todos })).isError).toBe(false)
    expect((await invoke('write', { file_path: 'store.ts', content: 'postgres' })).isError).toBe(false)
  })

  it('allows one Todo replan only after exact native authority refresh', async () => {
    const { invoke } = await setup()
    const original: TodoItem[] = [
      { content: 'Implement the original API', status: 'in_progress' },
      { content: 'Build the original UI', status: 'pending' },
    ]
    await invoke('todo_write', { todos: original })
    const replacement: TodoItem[] = [
      { content: 'Repair the discovered API boundary', status: 'in_progress' },
      { content: 'Rebuild the affected UI', status: 'pending' },
    ]
    expect(resultText(await invoke('todo_write', { todos: replacement })))
      .toContain('requires a successful lattice_refresh_context')
    expect((await invoke('lattice_refresh_context', {})).isError).toBe(false)
    expect((await invoke('todo_write', { todos: replacement })).isError).toBe(false)

    const secondReplacement: TodoItem[] = [
      { content: 'Change the plan again', status: 'in_progress' },
      { content: 'Finish the changed plan', status: 'pending' },
    ]
    expect(resultText(await invoke('todo_write', { todos: secondReplacement })))
      .toContain('requires a successful lattice_refresh_context')
  })

  it('renders exact root authority, approved Plan, Todo, and evidence debt into the model-visible refresh result', async () => {
    const { agent, invoke } = await setup()
    const planSentinel = 'APPROVED_PLAN_SENTINEL_31ac'
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('approved-plan-refresh-fixture'),
      name: 'exit_plan_mode',
      arguments: JSON.stringify({ plan: `# Approved plan\n\n${planSentinel}` }),
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('approved-plan-refresh-fixture'),
        content: [{ type: 'text', text: 'Plan approved' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    await invoke('todo_write', { todos: [
      { content: 'Implement sentinel behavior', status: 'in_progress' },
      { content: 'Verify sentinel behavior', status: 'pending' },
    ] })
    await invoke('write', { file_path: 'sentinel.ts', content: 'implemented' })

    const rendered = resultText(await invoke('lattice_refresh_context', {}))
    expect(rendered).toContain(ROOT_SENTINEL)
    expect(rendered).toContain(planSentinel)
    expect(rendered).toContain('DSH-NATIVE TODO SNAPSHOT')
    expect(rendered).toContain('Implement sentinel behavior')
    expect(rendered).toContain('NATIVE EVIDENCE AND REPLAN DEBT')
    expect(rendered).toContain('mutation: write')
  })

  it('guards real rc.7 Code Mode sub-dispatches and forbids crossing a Todo boundary in one program', async () => {
    const { agent, invoke } = await setup()
    agent.ctx.tools.presentAs('code')
    expect(agent.ctx.tools.get('run_code', agent)).toBeDefined()
    const blocked = await invoke('run_code', {
      description: 'Cross the native Todo boundary in one Code Mode program.',
      code: 'todo_then_write',
    })
    expect(blocked.isError).toBe(false)
    expect(resultText(blocked)).toContain('nested write rejected')
    const starts = agent.session.events.filter(event => event.type === 'tool/code-dispatch-start')
    expect(starts.map(event => event.data.name)).toEqual(['todo_write', 'write'])
    const settles = agent.session.events.filter(event => event.type === 'tool/code-dispatch')
    expect(settles.map(event => [event.data.name, event.data.isError])).toEqual([
      ['todo_write', false],
      ['write', true],
    ])
    expect(resultText(await invoke('run_code', { description: 'Retry the blocked write.', code: 'write_only' })))
      .toContain('replan required after write failed')
  })

  it('allows a valid rc.7 Code Mode workflow when Todo, mutation, verification, and advance use separate programs', async () => {
    const { agent, invoke } = await setup()
    agent.ctx.tools.presentAs('code')
    expect((await invoke('run_code', { description: 'Create the native Todo.', code: 'todo_only' })).isError).toBe(false)
    expect((await invoke('run_code', { description: 'Implement the active item.', code: 'write_only' })).isError).toBe(false)
    expect((await invoke('run_code', { description: 'Verify the active item.', code: 'verify_only' })).isError).toBe(false)
    expect((await invoke('run_code', { description: 'Advance the native Todo.', code: 'todo_advance' })).isError).toBe(false)

    expect(agent.session.events.findLast(event => event.type === 'todo/write')?.data.todos).toEqual([
      { content: 'Implement the API', status: 'completed' },
      { content: 'Verify the API', status: 'in_progress' },
    ])
    expect(agent.session.events.filter(event => event.type === 'tool/code-dispatch').map(event => event.data.name))
      .toEqual(['todo_write', 'write', 'bash', 'todo_write'])
  })

  it('routes a simple request after a completed complex task back to zero-control bypass', async () => {
    const { invoke, sendRoot } = await setup()
    const initial: TodoItem[] = [
      { content: 'Implement the API behavior', status: 'in_progress' },
      { content: 'Build the UI flow', status: 'pending' },
    ]
    await invoke('todo_write', { todos: initial })
    await invoke('write', { file_path: 'api.ts', content: 'implemented' })
    await invoke('bash', { command: 'pnpm test' })
    await invoke('todo_write', { todos: [
      { content: 'Implement the API behavior', status: 'completed' },
      { content: 'Build the UI flow', status: 'in_progress' },
    ] })
    await invoke('write', { file_path: 'ui.ts', content: 'implemented' })
    await invoke('bash', { command: 'pnpm test' })
    await invoke('todo_write', { todos: [
      { content: 'Implement the API behavior', status: 'completed' },
      { content: 'Build the UI flow', status: 'completed' },
    ] })

    sendRoot('Fix the typo in README line 14.')
    expect((await invoke('write', { file_path: 'README.md', content: 'fixed' })).isError).toBe(false)
  })

  it('starts a fresh epoch for a new complex task without old authority, Plan, Todo, or evidence', async () => {
    const { invoke, sendRoot } = await setup()
    await invoke('todo_write', { todos: [
      { content: 'Implement the old API', status: 'in_progress' },
      { content: 'Implement the old UI', status: 'pending' },
    ] })
    await invoke('write', { file_path: 'old-api.ts', content: 'implemented' })
    await invoke('bash', { command: 'pnpm test' })
    await invoke('todo_write', { todos: [
      { content: 'Implement the old API', status: 'completed' },
      { content: 'Implement the old UI', status: 'in_progress' },
    ] })
    await invoke('write', { file_path: 'old-ui.ts', content: 'implemented' })
    await invoke('bash', { command: 'pnpm test' })
    await invoke('todo_write', { todos: [
      { content: 'Implement the old API', status: 'completed' },
      { content: 'Implement the old UI', status: 'completed' },
    ] })

    const nextSentinel = 'NEXT_ROOT_AUTHORITY_SENTINEL_7b31'
    sendRoot(`Build a production-ready billing application across 12 stages. ${nextSentinel}. Do not ask questions; use reasonable assumptions.`)

    expect(resultText(await invoke('write', { file_path: 'billing.ts', content: 'too early' })))
      .toContain('create an initial Todo')
    const refreshed = resultText(await invoke('lattice_refresh_context', {}))
    expect(refreshed).toContain(nextSentinel)
    expect(refreshed).not.toContain(ROOT_SENTINEL)
    expect(refreshed).not.toContain('Implement the old API')
    expect(refreshed).not.toContain('old-api.ts')
  })

  it('keeps simple work on the native zero-control path', async () => {
    const { ctx, agent } = await setup()
    const simple = ctx.agentLoop.create(SessionId(`native-bypass-${Date.now()}`), {
      provider: 'mock', model: 'mock',
    }, { cwd: agent.session.header.cwd })
    const request = createUserMessage({
      content: [{ type: 'text', text: 'Fix the typo in README line 14.' }],
      source: { kind: 'user' },
    })
    emitAgentEvent(ctx, simple, 'agent/inbox/inserted', { message: request })
    simple.session.append('user/message', request, { surfaceOp: 'append' })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'native-bypass-write' as never,
      name: 'write',
      arguments: { file_path: 'README.md', content: 'fixed' },
      agent: simple,
    })
    expect(result.isError).toBe(false)
  })
})
