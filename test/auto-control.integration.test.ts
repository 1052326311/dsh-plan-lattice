import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { assembleContextFor, emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTRACT_DOCUMENT_PATH,
  persistContract,
  readContractSync,
} from '../src/contract.js'
import { persistContractAnchor } from '../src/contract-anchor.js'
import { apply, type Config } from '../src/index.js'
import { persistIntake, verifyIntake, type IntakeAnswer, type IntakeQuestion } from '../src/intake.js'

const contexts: Context[] = []
const scopes: Scope[] = []
const workspaces: string[] = []
const WRITE_AUTHORITY = {
  externalActions: [{ toolName: 'write', resource: 'fixture-write', arguments: {} }],
}

class FakeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'

  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] })
  }
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

async function makeAgent(
  ctx: Context,
  workspace: string,
  id: string,
  parent?: Agent,
  seedReplacement = false,
  seed?: readonly SessionEvent[],
): Promise<Agent> {
  const shell = {} as Agent
  let scope: Scope | undefined
  await ctx.plugin({
    name: `test-agent-scope-${id}`,
    inject: ['tools'],
    apply(injected: Context) {
      scope = createScope(injected, shell, parent === undefined ? {} : { parent })
    },
  })
  if (scope === undefined) throw new Error('failed to create an injected agent scope')
  scopes.push(scope)
  const session = ctx.sessions.create(SessionId(id), {
    ...(seed === undefined ? {} : { seed }),
    meta: {
      cwd: workspace,
      ...(parent === undefined ? {} : {
        parentSession: parent.session.id,
        origin: 'subagent' as const,
        delegationDepth: (parent.session.header.delegationDepth ?? 0) + 1,
      }),
    },
  })
  if (seedReplacement) {
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Pre-resume model-visible context.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Replacement seed context.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })
  }
  Object.assign(shell, {
    id: session.id,
    options: {},
    session,
    inbox: {},
    status: 'idle',
    ctx: scope.ctx,
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  })
  ctx.agents.enter(shell, parent)
  ctx.agents.announce(shell)
  return shell
}

function sendUser(ctx: Context, agent: Agent, text: string): Extract<SessionEvent, { type: 'user/message' }> {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  emitAgentEvent(ctx, agent, 'agent/inbox/inserted', {
    message,
  })
  return agent.session.append('user/message', message, { surfaceOp: 'append' })
}

async function proposeStep(ctx: Context, agent: Agent, signal: AbortSignal) {
  return ctx.waterfall('agent/pre-step', {
    agent,
    messages: [],
    turn: 1,
    step: 1,
    signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
}

function framing(estimatedSteps: number, overrides: Record<string, unknown> = {}) {
  return {
    requestSummary: 'Build a support application from an incomplete request.',
    estimatedSteps,
    systemBoundary: 'This repository only; no production deployment.',
    timeHorizon: 'One implementation cycle.',
    desiredOutcome: 'Operators can resolve a support case without losing data.',
    confirmedFacts: ['The repository uses TypeScript.'],
    decisions: [],
    invariants: ['Existing cases remain readable.'],
    changeables: ['UI layout and implementation order.'],
    forces: ['Requirements may evolve during implementation.'],
    keyVariables: ['Case correctness and acceptance coverage.'],
    assumptions: ['Local storage remains reversible.'],
    unknowns: ['Authoritative case source.'],
    readiness: 'conditional',
    readinessRationale: 'Storage remains reversible until its source is confirmed.',
    questions: [],
    ...overrides,
  }
}

function productContractQuestion(options?: IntakeQuestion['options']): IntakeQuestion {
  return {
    id: 'contract',
    question: 'What observable outcome must users achieve, which modules are in scope, and which tests or evidence must pass for acceptance?',
    ...(options === undefined ? {} : { options }),
  }
}

async function setup(
  workspace: string,
  config: Config = {},
  providerAnswers?: (questions: IntakeQuestion[]) => IntakeAnswer[],
  toolMode: 'native' | 'code' = 'native',
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: toolMode })
  if (toolMode === 'code') await ctx.plugin(FakeCodeRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.userQuestions.registerProvider({
    async ask(request) {
      return {
        answers: providerAnswers?.([...request.questions]) ?? request.questions.map(question => ({
          id: question.id,
          selected: question.options?.[0] === undefined ? [] : [question.options[0].label],
          ...(question.options?.[0] === undefined ? { custom: 'PostgreSQL is authoritative.' } : {}),
        })),
      }
    },
  })
  apply(ctx, {
    ...config,
    contractAnchorRoot: join(workspace, '.plan-lattice-anchor-store'),
    preconditionAdapters: {
      write: {
        async snapshot() {
          return { stateDigest: 'fixture-write-ready', description: 'The in-memory write fixture is ready.' }
        },
        verify({ expectedStateDigest }) {
          return expectedStateDigest === 'fixture-write-ready' ? undefined : 'write fixture state changed'
        },
      },
      ...config.preconditionAdapters,
    },
  })
  let writes = 0
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Guarded write fixture.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      writes += 1
      return `write-${writes}`
    },
  }))
  let shellCalls = 0
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Shell mutation fixture.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      shellCalls += 1
      return `bash-${shellCalls}`
    },
  }))
  let calls = 0
  const invoke = async (agent: Agent, name: string, args: unknown) => {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `auto-${++calls}` as never,
      name,
      arguments: args,
      agent,
    })
    // This direct-tool test harness has no AgentLoop to commit additional
    // contexts. Mirror the production commit point after the tool result.
    for (const context of result.additionalContexts ?? []) {
      agent.session.append('user/message', context, { surfaceOp: 'append' })
    }
    return result
  }
  return {
    ctx,
    writes: () => writes,
    shellCalls: () => shellCalls,
    invoke,
  }
}

describe('real Harness automatic control', () => {
  afterEach(async () => {
    await Promise.all(scopes.splice(0).map(scope => scope.dispose()))
    await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
    await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('routes a bounded first message before prompt assembly with no tools, guard, state, or model call', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-bypass-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes, shellCalls } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'bypass-root')

    sendUser(ctx, agent, 'Fix the typo in README line 14.')
    const names = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(names.filter(name => name.startsWith('lattice_'))).toEqual([])
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(prompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? '').toBe('')
    expect(prompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? '').toBe('')
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)
    expect((await invoke(agent, 'bash', { command: 'printf harmless' })).isError).toBe(false)
    expect(shellCalls()).toBe(1)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('leaves shell mutations on the native DSH path in automatic mode', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-default-shell-'))
    workspaces.push(workspace)
    const { ctx, invoke, shellCalls } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'default-shell-root')

    sendUser(ctx, agent, 'Build a customer support application.')
    const result = await invoke(agent, 'bash', { command: 'printf native > result.txt' })
    expect(result.isError).toBe(false)
    expect(shellCalls()).toBe(1)
    expect(ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('lattice_'))).toEqual([])
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('keeps a positively read-only Bash inspection on the native path before authority is needed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-readonly-shell-'))
    workspaces.push(workspace)
    const { ctx, invoke, shellCalls } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'readonly-shell-root')

    sendUser(ctx, agent, 'Build a customer support application.')
    const inspected = await invoke(agent, 'bash', { command: 'pwd && ls -la' })
    expect(inspected.isError).toBe(false)
    expect(shellCalls()).toBe(1)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('keeps a complete auto task native until DSH replaces history, then rehydrates its exact root authority', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-native-first-pass-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace, { clarificationPolicy: 'never' })
    const agent = await makeAgent(ctx, workspace, 'native-first-pass-root')
    const sentinel = 'NATIVE_FIRST_PASS_AUTHORITY_9c40 must survive compaction.'

    const authority = sendUser(ctx, agent, `Build the accepted incident system. ${sentinel} Do not ask questions; make reversible assumptions.`)
    expect(ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('lattice_'))).toEqual([])
    const firstPrompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(firstPrompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? '').toBe('')
    expect(firstPrompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? '').toBe('')
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)

    const shadowed = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'discarded runtime detail' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native compacted summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: authority.seq, end: shadowed.seq },
      sourceEventSeqs: [authority.seq, shadowed.seq],
    })

    expect(ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('lattice_'))).toEqual([])
    const recoveredPrompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const recovery = recoveredPrompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(recovery).toContain('Rehydrated Human Authority')
    expect(recovery).toContain(sentinel)
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(2)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('does not duplicate root authority when a replacement leaves its source on the native surface', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-native-visible-authority-'))
    workspaces.push(workspace)
    const { ctx } = await setup(workspace, { clarificationPolicy: 'never' })
    const agent = await makeAgent(ctx, workspace, 'native-visible-authority-root')
    const sentinel = 'VISIBLE_NATIVE_AUTHORITY_63b1 remains on the DSH surface.'

    sendUser(ctx, agent, `Build the accepted incident system. ${sentinel} Do not ask questions.`)
    const unrelated = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Replace only this unrelated runtime detail.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Native summary for the unrelated detail.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: unrelated.seq, end: unrelated.seq },
      sourceEventSeqs: [unrelated.seq],
    })

    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const continuity = prompt.contexts
      .find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(continuity).toBe('')
    expect(JSON.stringify(prompt)).not.toContain('Rehydrated Human Authority')
  })

  it('adds only native authority continuity to a fully specified 12-stage auto task', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-native-contract-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'native-contract-root')
    const sentinel = 'NATIVE_CONTRACT_AUTHORITY_f173 must remain exact after compaction.'
    const request = `Implement the accepted incident-response system in 12 atomic stages across the API, storage, and web UI.
Goal: operators can create, assign, resolve, and audit incidents without losing data. ${sentinel}
Scope is only src/api, src/storage, src/web, and their tests; do not deploy or touch production.
The existing repository schemas and tests are the source of truth. Inputs are incident commands and outputs are persisted incident records plus the UI state.
Existing data must remain readable and role checks must remain unchanged.
Done when pnpm test and pnpm check pass and the end-to-end fixture proves create, assign, resolve, and audit.
Do not ask questions; make only reversible implementation assumptions.`

    const authority = sendUser(ctx, agent, request)

    const firstTools = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(firstTools.filter(name => name.startsWith('lattice_'))).toEqual([])
    const firstPrompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(firstPrompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? '').toBe('')
    expect(firstPrompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? '').toBe('')
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)

    const shadowed = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native intermediate implementation history' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native compacted implementation summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: authority.seq, end: shadowed.seq },
      sourceEventSeqs: [authority.seq, shadowed.seq],
    })

    const boundaryTools = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(boundaryTools.filter(name => name.startsWith('lattice_'))).toEqual([])
    const recovered = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const continuity = recovered.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(continuity).toContain('Plan Lattice native continuity projection')
    expect(continuity).toContain(sentinel)
    expect(continuity).toContain('No lattice_* action is required or available')
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(2)
    expect(existsSync(join(workspace, CONTRACT_DOCUMENT_PATH))).toBe(false)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)

    const laterAuthority = 'LATER_NATIVE_AUTHORITY_723f stays visible through the DSH user message.'
    sendUser(ctx, agent, laterAuthority)
    const afterLaterInput = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const stableContinuity = afterLaterInput.contexts
      .find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(stableContinuity).toBe(continuity)
    expect(stableContinuity).not.toContain(laterAuthority)
  })

  it('binds automatic continuity only to the current task instead of older Session messages', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-native-current-authority-'))
    workspaces.push(workspace)
    const historical = Session.create(SessionId('native-current-authority-history'))
    const staleSentinel = 'STALE_SESSION_AUTHORITY_318d must not enter the current contract.'
    historical.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `A previous completed task said: ${staleSentinel}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const first = await setup(workspace)
    const agent = await makeAgent(
      first.ctx,
      workspace,
      'native-current-authority-root',
      undefined,
      false,
      historical.events,
    )
    const currentSentinel = 'CURRENT_TASK_AUTHORITY_a1f9 must survive compaction.'
    const authority = sendUser(first.ctx, agent, `Implement the accepted incident-response system in 12 atomic stages across API, storage, and UI.
Goal: operators can create, assign, resolve, and audit incidents. ${currentSentinel}
Scope is src/api, src/storage, src/web, and tests only; do not deploy.
Repository schemas and tests are authoritative; existing data and role checks must remain unchanged.
Done when pnpm test, pnpm check, and the end-to-end incident fixture pass.
Do not ask questions; make only reversible assumptions.`)

    expect(first.ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('lattice_'))).toEqual([])
    const shadowed = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native implementation detail replaced by compaction' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native compacted implementation summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: authority.seq, end: shadowed.seq },
      sourceEventSeqs: [authority.seq, shadowed.seq],
    })

    const seed = agent.session.events
    const resumed = await setup(workspace)
    const resumedAgent = await makeAgent(
      resumed.ctx,
      workspace,
      'native-current-authority-root',
      undefined,
      false,
      seed,
    )
    const restoredTools = resumed.ctx.tools.schemas(resumedAgent).map(tool => tool.name)
    expect(restoredTools.filter(name => name.startsWith('lattice_'))).toEqual([])
    const prompt = await resumed.ctx.systemPrompt.assemble(assembleContextFor(resumedAgent))
    const rendered = prompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(rendered).toContain(currentSentinel)
    expect(rendered).not.toContain(staleSentinel)
    expect(readContractSync(workspace)).toBeUndefined()
  })

  it('does not infer authority from unanchored Session history', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-native-missing-authority-'))
    workspaces.push(workspace)
    const history = Session.create(SessionId('native-missing-authority-history'))
    const staleSentinel = 'UNANCHORED_HISTORY_ef62 must never authorize resumed work.'
    const old = history.append('user/message', createUserMessage({
      content: [{ type: 'text', text: staleSentinel }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    history.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native summary with no trusted current-task anchor' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: old.seq, end: old.seq },
      sourceEventSeqs: [old.seq],
    })

    const { ctx, invoke } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'native-missing-authority-root', undefined, false, history.events)
    expect(ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('lattice_'))).toEqual([])
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const rendered = prompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(rendered).toContain('No durable root user authority is available')
    expect(rendered).not.toContain(staleSentinel)
    expect(readContractSync(workspace)).toBeUndefined()
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
  })

  it('reconstructs native-first authority from the durable DSH log after a process restart', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-native-first-restart-'))
    workspaces.push(workspace)
    const first = await setup(workspace, { clarificationPolicy: 'never' })
    const historical = Session.create(SessionId('native-first-restart-history'))
    historical.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'STALE_HISTORY_1f28 must never become current task authority.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const firstAgent = await makeAgent(first.ctx, workspace, 'native-first-restart-root', undefined, false, historical.events)
    const sentinel = 'NATIVE_FIRST_RESTART_AUTHORITY_b584 must survive process recovery.'
    const authority = sendUser(first.ctx, firstAgent, `Build the accepted incident system. ${sentinel} Do not ask questions; make reversible assumptions.`)
    const shadowed = firstAgent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old model-visible context' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    firstAgent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native compacted summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: authority.seq, end: shadowed.seq },
      sourceEventSeqs: [authority.seq, shadowed.seq],
    })
    const beforeRestartPrompt = await first.ctx.systemPrompt.assemble(assembleContextFor(firstAgent))
    const beforeRestart = beforeRestartPrompt.contexts
      .find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    const seed = firstAgent.session.events
    const resumed = await setup(workspace, { clarificationPolicy: 'never' })
    const resumedAgent = await makeAgent(resumed.ctx, workspace, 'native-first-restart-root', undefined, false, seed)
    const restoredTools = resumed.ctx.tools.schemas(resumedAgent).map(tool => tool.name)
    expect(restoredTools.filter(name => name.startsWith('lattice_'))).toEqual([])

    resumed.ctx.on('system-prompt/assemble', async (_assembly, assemble, next) => {
      const transformed = await next()
      if (assemble.agent !== resumedAgent) return transformed
      return { ...transformed, tools: resumed.ctx.tools.schemas(resumedAgent) }
    })
    const prompt = await resumed.ctx.systemPrompt.assemble(assembleContextFor(resumedAgent))
    const recovery = prompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(recovery).toBe(beforeRestart)
    expect(recovery).toContain('Rehydrated Human Authority')
    expect(recovery).toContain(sentinel)
    expect(recovery).not.toContain('STALE_HISTORY_1f28')
  })

  it('opens a fresh never-policy lattice directly, ignores operational reminders, and restores raw authority after compaction', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-authority-bootstrap-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
    })
    let todoWrites = 0
    ctx.tools.register(defineTool({
      name: 'todo_write',
      description: 'Native current-turn task projection fixture.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() {
        todoWrites += 1
        return Promise.resolve('todo-projected')
      },
    }))
    const agent = await makeAgent(ctx, workspace, 'authority-bootstrap-root')
    const authoritySentinel = 'IMMUTABLE_PRD_SENTINEL_8f74e1 must survive every compaction and delegation.'
    sendUser(ctx, agent, `Build a complete incident system. ${authoritySentinel}`)
    const freshTools = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(freshTools).toContain('lattice_open')
    expect(freshTools).not.toContain('lattice_intake')
    expect(freshTools.filter(name => name.startsWith('lattice_'))).toEqual(['lattice_open'])
    expect(freshTools).toContain('todo_write')
    expect((await invoke(agent, 'todo_write', {})).isError).toBe(false)
    expect(todoWrites).toBe(1)
    const blockedWrite = await invoke(agent, 'write', {})
    expect(blockedWrite.isError).toBe(true)
    expect(JSON.stringify(blockedWrite.content)).toContain('before this protected mutation')
    expect(writes()).toBe(0)
    const bootstrapPrompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const bootstrapPolicy = bootstrapPrompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? ''
    expect(bootstrapPolicy).toContain('Work normally from the current human request and repository evidence')
    expect(bootstrapPolicy).toContain('first protected mutation')
    expect(bootstrapPolicy).not.toContain('before repository inspection')
    expect(bootstrapPolicy).not.toContain('native todo list may show the immediate working set')
    const bootstrapState = bootstrapPrompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(bootstrapState).toContain('Contract: pending initial commitment')

    const opened = valueOf(await invoke(agent, 'lattice_open', {}))
    const contract = readContractSync(workspace)
    expect(contract?.authoritySources).toHaveLength(1)
    expect(contract?.framing.estimatedSteps).toBe(8)
    expect(contract?.framing.assumptions).toEqual([
      'Implementation choices not fixed by human authority remain reversible until verified.',
    ])
    expect(await readFile(join(workspace, CONTRACT_DOCUMENT_PATH), 'utf8')).not.toContain(authoritySentinel)
    expect(opened.controllerBootstrap).toBe(true)
    const bootstrapNodes = (opened.initialPlan as {
      nodes: Array<{ key: string; node: { id: string; parentId?: string; contractRevision: number; contractDigest: string } }>
      selectedLeaf: { key: string; node: { id: string } }
    }).nodes
    expect(bootstrapNodes).toHaveLength(2)
    expect(bootstrapNodes[0]?.key).toBe('accepted-outcome')
    expect(bootstrapNodes[1]?.key).toBe('next-verified-increment')
    expect(bootstrapNodes[1]?.node.parentId).toBe(bootstrapNodes[0]?.node.id)
    expect(bootstrapNodes.every(({ node }) => node.contractRevision === contract?.revision)).toBe(true)
    expect(bootstrapNodes.every(({ node }) => node.contractDigest === contract?.documentDigest)).toBe(true)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('lattice_intake')
    const afterOpenSignal = new AbortController().signal
    await ctx.systemPrompt.assemble(assembleContextFor(agent, afterOpenSignal))
    await expect(proposeStep(ctx, agent, afterOpenSignal)).resolves.toMatchObject({ kind: 'enter' })
    const receipt = opened.receipt as { id: string; revision: number }
    const selected = (opened.initialPlan as {
      selectedLeaf: { node: { id: string } }
    }).selectedLeaf.node
    const checkedOut = await invoke(agent, 'lattice_checkout', {
      receiptId: receipt.id,
      expectedRevision: receipt.revision,
      nodeId: selected.id,
    })
    expect(checkedOut.isError).toBe(false)
    const visibleStatus = await invoke(agent, 'lattice_status', {})
    expect(visibleStatus.isError).toBe(false)
    expect(JSON.stringify(visibleStatus.content)).toContain(selected.id)

    const reminder = createUserMessage({
      content: [{
        type: 'text',
        text: 'You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.',
      }],
      source: { kind: 'plugin', plugin: 'repeat-tool-reminder' },
    })
    emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message: reminder })
    const shadowed = agent.session.append('user/message', reminder, { surfaceOp: 'append' })
    const afterReminder = await invoke(agent, 'lattice_refresh_context', { planNodeId: selected.id })
    expect(afterReminder.isError).toBe(false)
    expect(JSON.stringify(afterReminder.content)).not.toMatch(/material change requires lattice_reframe/i)
    expect(JSON.stringify(afterReminder.content)).not.toContain(authoritySentinel)

    const compactionId = CompactionId('authority-bootstrap-compaction')
    agent.session.append('compaction/start', { compactionId, turn: null })
    agent.session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'A lossy summary that omits the immutable sentinel.' }],
      shadowedRange: { start: shadowed.seq, end: shadowed.seq },
      shadowedSeqs: [shadowed.seq],
      shadowedTokenCount: 1,
      provider: 'proof',
      model: 'proof',
    })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Native compacted surface without the immutable sentinel.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: shadowed.seq, end: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })
    const restored = await invoke(agent, 'lattice_refresh_context', { planNodeId: selected.id })
    expect(restored.isError).toBe(false)
    expect(JSON.stringify(restored.content)).toContain(authoritySentinel)
    expect(JSON.stringify(restored.content)).toContain('session://human-authority/')

    const child = await makeAgent(ctx, workspace, 'authority-bootstrap-child', agent)
    const delegated = await invoke(child, 'lattice_refresh_context', { planNodeId: selected.id })
    expect(delegated.isError).toBe(false)
    expect(JSON.stringify(delegated.content)).toContain(authoritySentinel)
    const delegatedStable = await invoke(child, 'lattice_refresh_context', { planNodeId: selected.id })
    expect(delegatedStable.isError).toBe(false)
    expect(JSON.stringify(delegatedStable.content)).not.toContain(authoritySentinel)

    const resumed = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
    })
    const resumedAgent = await makeAgent(
      resumed.ctx,
      workspace,
      'authority-bootstrap-root',
      undefined,
      false,
      agent.session.events,
    )
    const afterRestart = await resumed.invoke(resumedAgent, 'lattice_refresh_context', { planNodeId: selected.id })
    expect(afterRestart.isError).toBe(false)
    expect(JSON.stringify(afterRestart.content)).toContain(authoritySentinel)
  })

  it('uses runtime context under a complete persona without requiring a first-turn control tool', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-prompt-capability-'))
    workspaces.push(workspace)
    const { ctx } = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
    })
    const agent = await makeAgent(ctx, workspace, 'prompt-capability-root')
    sendUser(ctx, agent, 'Build the complete system from the accepted product requirements.')
    ctx.systemPrompt.section({
      name: 'test:complete-persona',
      order: 0,
      text: 'You are a focused software engineer.',
      complete: true,
    })

    const compatibleSignal = new AbortController().signal
    const compatible = await ctx.systemPrompt.assemble(assembleContextFor(agent, compatibleSignal))
    expect(compatible.sections.map(section => section.name)).toEqual(['test:complete-persona'])
    const state = compatible.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(state).toContain('Required next action:')
    expect(state).toContain('lattice_open {}')
    await expect(proposeStep(ctx, agent, compatibleSignal)).resolves.toMatchObject({ kind: 'enter' })

    const removeRuntimeAfterProviders = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const transformed = await next()
      return {
        ...transformed,
        contexts: transformed.contexts.filter(entry => entry.name !== 'plan-lattice:execution-state'),
      }
    })
    await expect(ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal)))
      .rejects.toThrow(/exact final DSH runtime context/i)
    removeRuntimeAfterProviders()

    const restoreRuntimeContext = ctx.systemPrompt.suppressRuntimeContext()
    const suppressedSignal = new AbortController().signal
    await expect(ctx.systemPrompt.assemble(assembleContextFor(agent, suppressedSignal)))
      .rejects.toThrow(/requires its exact final DSH runtime context/i)
    await expect(proposeStep(ctx, agent, suppressedSignal)).rejects.toThrow(/validated final DSH runtime context/i)
    restoreRuntimeContext()

    const restoreTools = agent.ctx.tools.restrict({ deny: ['lattice_open'] })
    const hiddenToolSignal = new AbortController().signal
    await expect(ctx.systemPrompt.assemble(assembleContextFor(agent, hiddenToolSignal)))
      .resolves.toBeDefined()
    await expect(proposeStep(ctx, agent, hiddenToolSignal)).resolves.toMatchObject({ kind: 'enter' })
    restoreTools()

    const replaceRequiredSchema = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const transformed = await next()
      return {
        ...transformed,
        tools: transformed.tools.map(tool => tool.name === 'lattice_open'
          ? { ...tool, description: 'forged same-name schema' }
          : tool),
      }
    })
    await expect(ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal)))
      .resolves.toBeDefined()
    replaceRequiredSchema()
  })

  it('keeps the first rc.7 Code Mode request free of a forced control bridge', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-code-mode-'))
    workspaces.push(workspace)
    const { ctx } = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
    }, undefined, 'code')
    const agent = await makeAgent(ctx, workspace, 'code-mode-root')
    sendUser(ctx, agent, 'Build the complete system from the accepted requirements.')
    ctx.systemPrompt.section({
      name: 'test:complete-code-persona',
      order: 0,
      text: 'You are a focused software engineer.',
      complete: true,
    })

    const signal = new AbortController().signal
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    expect(assembly.sections.map(section => section.name)).toEqual(['test:complete-code-persona'])
    const runtime = assembly.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(runtime).not.toContain('DSH Code Mode bridge')
    expect(runtime).not.toContain('tools.lattice_open')
    expect(runtime).toContain('Read the task and repository normally')
    await expect(proposeStep(ctx, agent, signal)).resolves.toMatchObject({ kind: 'enter' })

    const restoreTools = agent.ctx.tools.restrict({ deny: ['lattice_open'] })
    await expect(ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal)))
      .resolves.toBeDefined()
    restoreTools()
  })

  it('refines a controller-owned bootstrap leaf without weakening its contract binding', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-bootstrap-refinement-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
    })
    const agent = await makeAgent(ctx, workspace, 'bootstrap-refinement-root')
    sendUser(ctx, agent, 'Build a complete incident system and preserve every accepted boundary while implementation evidence evolves.')

    const opened = valueOf(await invoke(agent, 'lattice_open', {}))
    const openReceipt = opened.receipt as { id: string; revision: number }
    const bootstrapLeaf = (opened.initialPlan as {
      selectedLeaf: { node: { id: string } }
    }).selectedLeaf.node
    const contract = readContractSync(workspace)
    if (contract === undefined) throw new Error('expected controller bootstrap contract')

    const refinedResult = await invoke(agent, 'lattice_split', {
      receiptId: openReceipt.id,
      expectedRevision: openReceipt.revision,
      nodeId: bootstrapLeaf.id,
      children: [
        {
          title: 'Implement the first evidence-backed increment',
          acceptanceCriteria: 'The focused production behavior and tests pass.',
        },
        {
          title: 'Integrate the remaining accepted outcome',
          acceptanceCriteria: 'Every still-applicable authority requirement has final evidence.',
        },
      ],
    })
    const refined = valueOf(refinedResult)
    const children = refined.children as Array<{
      id: string
      parentId: string
      contractRevision: number
      contractDigest: string
    }>
    expect(children).toHaveLength(2)
    expect(children.every(child => child.parentId === bootstrapLeaf.id)).toBe(true)
    expect(children.every(child => child.contractRevision === contract.revision)).toBe(true)
    expect(children.every(child => child.contractDigest === contract.documentDigest)).toBe(true)
    expect(JSON.stringify(refinedResult.content)).toContain(children[0]!.id)
    expect(JSON.stringify(refinedResult.content)).toContain(children[1]!.id)
    expect(JSON.stringify(refinedResult.content)).toContain('Implement the first evidence-backed increment')
    expect(JSON.stringify(refinedResult.content)).toContain('Every still-applicable authority requirement has final evidence.')

    const current = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: children[0]!.id }))
    expect(JSON.stringify(current.planContext)).toContain('Implement the first evidence-backed increment')
    const currentReceipt = current.receipt as { id: string; revision: number }
    const checkout = await invoke(agent, 'lattice_checkout', {
      receiptId: currentReceipt.id,
      expectedRevision: currentReceipt.revision,
      nodeId: children[0]!.id,
    })
    expect(checkout.isError).toBe(false)
  })

  it('reports terminal lattice completion instead of requesting a nonexistent next leaf', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-terminal-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
    })
    const agent = await makeAgent(ctx, workspace, 'terminal-root')
    sendUser(ctx, agent, 'Build and verify the accepted bounded system.')
    const opened = valueOf(await invoke(agent, 'lattice_open', {}))
    const firstReceipt = opened.receipt as { id: string; revision: number }
    const leaf = (opened.initialPlan as { selectedLeaf: { node: { id: string } } }).selectedLeaf.node
    valueOf(await invoke(agent, 'lattice_checkout', {
      receiptId: firstReceipt.id,
      expectedRevision: firstReceipt.revision,
      nodeId: leaf.id,
    }))
    const refreshed = valueOf(await invoke(agent, 'lattice_refresh_context', {}))
    const completionReceipt = refreshed.receipt as { id: string; revision: number }
    valueOf(await invoke(agent, 'lattice_checkpoint', {
      receiptId: completionReceipt.id,
      expectedRevision: completionReceipt.revision,
      summary: 'The accepted outcome was verified through the focused production path.',
      references: ['focused verification passed'],
      complete: true,
    }))

    const signal = new AbortController().signal
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    const runtime = assembly.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(runtime).toContain('All lattice work is complete')
    expect(runtime).not.toContain('check out one current leaf')
    await expect(proposeStep(ctx, agent, signal)).resolves.toMatchObject({ kind: 'enter' })
  })

  it('keeps title and objective mandatory for the legacy intake protocol', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-legacy-open-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { intakeMode: 'off' })
    const agent = await makeAgent(ctx, workspace, 'legacy-open-root')

    const opened = await invoke(agent, 'lattice_open', {})
    expect(opened.isError).toBe(true)
    expect(JSON.stringify(opened.content)).toContain('legacy lattice_open requires title and objective')
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('keeps explicit contract intake available without automatic heuristic questions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-critical-intake-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const agent = await makeAgent(ctx, workspace, 'critical-intake-root')
    sendUser(ctx, agent, 'Can you build a customer support application?')

    const skipped = await invoke(agent, 'lattice_intake', framing(6, {
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The operator explicitly selected contract control.',
    }))
    expect(skipped.isError).toBe(false)
  })

  it('rejects clarification answers that select an option the user was never offered', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-invalid-answer-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' }, questions => questions.map(question => ({
      id: question.id,
      selected: ['SQLite'],
    })))
    const agent = await makeAgent(ctx, workspace, 'invalid-answer-root')
    sendUser(ctx, agent, 'Can you build a customer support application?')

    const denied = await invoke(agent, 'lattice_intake', framing(6, {
      questions: [{
        ...productContractQuestion([{ label: 'PostgreSQL' }]),
      }],
    }))
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/option.*not offered/i)
  })

  it('does not let a model relabel an outcome-critical non-answer as a decision', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-unanswered-critical-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' }, questions => questions.map(question => ({
      id: question.id,
      selected: [],
      custom: 'No additional requirement is available. Make reasonable assumptions.',
    })))
    const agent = await makeAgent(ctx, workspace, 'unanswered-critical-root')
    sendUser(ctx, agent, 'Can you build a customer support application?')

    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      questions: [productContractQuestion()],
    })))
    const denied = await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: intake.pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'decision' }],
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/was not answered|cannot be relabeled/i)
    expect(existsSync(join(workspace, CONTRACT_DOCUMENT_PATH))).toBe(false)
  })

  it.each([
    'I have no preference; choose what works best.',
    '你看着办即可。',
  ])('rejects delegated critical decisions phrased as %s', async custom => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-delegated-answer-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' }, questions => questions.map(question => ({
      id: question.id,
      selected: [],
      custom,
    })))
    const agent = await makeAgent(ctx, workspace, 'delegated-answer-root')
    sendUser(ctx, agent, 'Can you build a customer support application?')

    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      questions: [productContractQuestion()],
    })))
    const denied = await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: intake.pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'decision' }],
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/was not answered|cannot be relabeled/i)
  })

  it('does not alter tool middleware semantics on an explicit bypass task', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-bypass-middleware-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace)
    ctx.tools.register(defineTool({
      name: 'normalize_fixture',
      description: 'Middleware composition fixture.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        return args.value
      },
    }))
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'normalize_fixture') {
        exec.arguments = { value: 'normalized-by-later-middleware' }
      }
      return next()
    })
    const agent = await makeAgent(ctx, workspace, 'bypass-middleware-root')
    sendUser(ctx, agent, 'Do not use Plan Lattice. Normalize this one value.')

    const result = await invoke(agent, 'normalize_fixture', { value: 'original' })
    expect(result.isError).toBe(false)
    expect(result.value).toBe('normalized-by-later-middleware')
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('keeps activationMode off inert when durable v1 and v2 state already exists', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-off-existing-state-'))
    workspaces.push(workspace)
    const active = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      guardedTools: ['write'],
    })
    const original = await makeAgent(active.ctx, workspace, 'off-existing-state-root')
    sendUser(active.ctx, original, 'Use the full Plan Lattice to build the accepted support application.')
    valueOf(await active.invoke(original, 'lattice_open', {}))
    expect(existsSync(join(workspace, CONTRACT_DOCUMENT_PATH))).toBe(true)
    expect(existsSync(join(workspace, '.dsh', 'plan-lattice', 'v1', 'snapshot.json'))).toBe(true)

    const disabled = await setup(workspace, {
      activationMode: 'off',
      guardedTools: ['write'],
    })
    const resumed = await makeAgent(disabled.ctx, workspace, 'off-existing-state-root')
    sendUser(disabled.ctx, resumed, 'Use the full Lattice despite the previous task state.')

    expect(disabled.ctx.tools.schemas(resumed).some(tool => tool.name.startsWith('lattice_'))).toBe(false)
    const written = await disabled.invoke(resumed, 'write', {})
    expect(written.isError).toBe(false)
    expect(disabled.writes()).toBe(1)
    const assembly = await disabled.ctx.systemPrompt.assemble(assembleContextFor(resumed))
    expect(assembly.sections.find(section => section.name === 'plan:fractal-ledger')?.text).toBe('')
    expect(assembly.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text).toBe('')
  })

  it('keeps an uncertain automatic task on native DSH without a route tool', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-probe-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'probe-root')
    sendUser(ctx, agent, 'Investigate the repository carefully and improve the implementation where appropriate, preserving every existing behavior and validating the result against the surrounding architecture before making any change.')
    await writeFile(join(workspace, 'ROUTE.md'), 'The requested change is confined to one reversible local helper.\n', 'utf8')

    expect(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('lattice_'))).toEqual([])
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('leaves authoritative requirements inspection to native DSH tools', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-authority-probe-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'authority-probe-root')
    sendUser(ctx, agent, 'Read start.md, the authoritative PRD, and implement its required functionality based solely on that document.')
    const authoritativeRequirements = [
      'BEGIN AUTHORITATIVE REQUIREMENTS',
      'Build the adapter.',
      'The expiration conflict policy is unclear. Ask before implementing it.',
      'END AUTHORITATIVE REQUIREMENTS',
      '',
    ].join('\n')
    await writeFile(join(workspace, 'start.md'), authoritativeRequirements, 'utf8')

    expect(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('lattice_'))).toEqual([])
    expect(await readFile(join(workspace, 'start.md'), 'utf8')).toBe(authoritativeRequirements)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('does not create a parallel route contract for a file-backed automatic task', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-probe-authority-join-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'probe-authority-join-root')
    sendUser(ctx, agent, `Read start.md, the authoritative PRD, and implement its required functionality based solely on that document.
The evaluation protocol runs test.sh with hidden cases; only then is the task complete.`)
    await writeFile(join(workspace, 'start.md'), [
      'Build a multi-module adapter from scratch.',
      'The exact wire-format policy is intentionally unclear and must be investigated.',
      '',
    ].join('\n'), 'utf8')

    expect(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('lattice_'))).toEqual([])
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(prompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? '').toBe('')
    expect(readContractSync(workspace)).toBeUndefined()
  })

  it('commits a contract, pauses on material change and compaction, then resumes without node checkpoints', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const agent = await makeAgent(ctx, workspace, 'contract-root')
    sendUser(ctx, agent, 'Build a customer support application.')

    const visible = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(visible).toContain('lattice_intake')
    expect(visible).toContain('lattice_commit_intake')
    expect(visible).not.toContain('lattice_open')
    expect((await invoke(agent, 'write', {})).isError).toBe(true)

    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      questions: [productContractQuestion()],
    })))
    const pendingIntakeId = intake.pendingIntakeId as string
    expect(pendingIntakeId).toBeTypeOf('string')
    valueOf(await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'decision' }],
    }))
    expect(existsSync(join(workspace, CONTRACT_DOCUMENT_PATH))).toBe(true)
    valueOf(await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)

    sendUser(ctx, agent, 'Change the requirement: archived cases must remain searchable.')
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    const reframed = await invoke(agent, 'lattice_reframe', framing(5, {
      requestSummary: 'Archived cases must remain searchable.',
      desiredOutcome: 'Operators can resolve and search archived support cases.',
      decisions: ['Archived cases remain searchable.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'Outcome, scope, authority, truth source, and acceptance are known.',
    }))
    expect(JSON.stringify(reframed.content)).toContain('Durable execution contract')
    const afterReframe = await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY)
    expect(JSON.stringify(afterReframe.content)).not.toContain('UNCHANGED AUTHORITATIVE DOCUMENTS')
    expect(JSON.stringify(afterReframe.content)).not.toContain('Archived cases remain searchable.')
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(2)

    const shadowed = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old contract-visible context' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    const compactionId = CompactionId('contract-compaction')
    agent.session.append('compaction/start', { compactionId, turn: null })
    agent.session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'compacted contract context' }],
      shadowedRange: { start: shadowed.seq, end: shadowed.seq },
      shadowedSeqs: [shadowed.seq],
      shadowedTokenCount: 1,
      provider: 'proof',
      model: 'proof',
    })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Native compacted contract context.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: shadowed.seq, end: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    const afterCompaction = await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY)
    expect(afterCompaction.isError).toBe(false)
    expect(JSON.stringify(afterCompaction.content)).toContain('Archived cases remain searchable.')
    expect(JSON.stringify(afterCompaction.content)).not.toContain('UNCHANGED AUTHORITATIVE DOCUMENTS')
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(3)

    await writeFile(join(workspace, CONTRACT_DOCUMENT_PATH), '# externally changed contract\n', 'utf8')
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    valueOf(await invoke(agent, 'lattice_reframe', framing(4, {
      requestSummary: 'Repair the externally changed contract from trusted task facts.',
      desiredOutcome: 'Operators can resolve and search archived support cases.',
      decisions: ['Ignore the untrusted manual contract edit.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The root task supplied a complete replacement contract.',
    })))
    valueOf(await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(4)
  })

  it('renders a root reframe in full to an already-live child before using digest references', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-child-reframe-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const root = await makeAgent(ctx, workspace, 'child-reframe-root')
    sendUser(ctx, root, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await invoke(root, 'lattice_intake', framing(6)))
    const child = await makeAgent(ctx, workspace, 'child-reframe-worker', root)

    sendUser(ctx, root, 'Change the requirement: archived cases must remain searchable.')
    const reframed = await invoke(root, 'lattice_reframe', framing(5, {
      requestSummary: 'Archived cases must remain searchable.',
      desiredOutcome: 'Operators can resolve and search archived support cases.',
      decisions: ['Archived cases remain searchable after the reframe.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The changed outcome and acceptance boundary are explicit.',
    }))
    expect(reframed.isError).toBe(false)

    const childContext = await invoke(child, 'lattice_refresh_context', WRITE_AUTHORITY)
    expect(childContext.isError).toBe(false)
    expect(JSON.stringify(childContext.content)).toContain('Archived cases remain searchable after the reframe.')
    expect(JSON.stringify(childContext.content)).not.toContain('UNCHANGED AUTHORITATIVE DOCUMENTS')
  })

  it('binds review to the exact durable message sequence and makes implicit changes reframe', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-input-review-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const agent = await makeAgent(ctx, workspace, 'input-review-root')
    sendUser(ctx, agent, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      decisions: ['PostgreSQL is the authoritative case source.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'Outcome, scope, authority, truth source, and acceptance are known.',
    })))

    sendUser(ctx, agent, 'continue')
    const firstReviewResult = await invoke(agent, 'lattice_review_input', {})
    const firstReview = valueOf(firstReviewResult)
    expect(JSON.stringify(firstReview.pendingInputs)).toContain('continue')
    const firstReceipt = firstReview.reviewReceipt as { id: string; pendingDigest: string; throughSeq: number }
    const [firstPendingInput] = firstReview.pendingInputs as Array<{ messageId: string; digest: string }>
    const firstReviewContent = JSON.stringify(firstReviewResult.content)
    expect(firstReviewContent).toContain(firstReceipt.id)
    expect(firstReviewContent).toContain(firstReceipt.pendingDigest)
    expect(firstReviewContent).toContain(String(firstReceipt.throughSeq))
    expect(firstReviewContent).toContain(firstPendingInput!.messageId)
    expect(firstReviewContent).toContain(firstPendingInput!.digest)
    expect(firstReviewContent).toContain('continue')

    sendUser(ctx, agent, 'Archived cases should be searchable too')
    const racedCommit = await invoke(agent, 'lattice_commit_input_review', {
      reviewReceiptId: firstReceipt.id,
      disposition: 'contract-unchanged',
      rationale: 'The first message alone does not alter outcome, boundary, authority, truth source, or acceptance.',
    })
    expect(racedCommit.isError).toBe(true)

    sendUser(ctx, agent, '订单状态以后以仓库事件为准')
    const completeReview = valueOf(await invoke(agent, 'lattice_review_input', {}))
    expect(completeReview.pendingInputs).toHaveLength(3)
    expect(JSON.stringify(completeReview.pendingInputs)).toContain('Archived cases should be searchable too')
    expect(JSON.stringify(completeReview.pendingInputs)).toContain('订单状态以后以仓库事件为准')
    const completeReceipt = completeReview.reviewReceipt as { id: string }
    valueOf(await invoke(agent, 'lattice_commit_input_review', {
      reviewReceiptId: completeReceipt.id,
      disposition: 'contract-changed',
      rationale: 'Searchability changes acceptance and the warehouse-event instruction changes the authoritative truth source.',
    }))
    expect((await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY)).isError).toBe(false)
    expect((await invoke(agent, 'write', {})).isError).toBe(true)

    valueOf(await invoke(agent, 'lattice_reframe', framing(5, {
      requestSummary: 'Archived cases remain searchable and warehouse events become authoritative for order status.',
      desiredOutcome: 'Operators can search archived cases while order status follows warehouse events.',
      decisions: ['Archived cases remain searchable.', 'Warehouse events are authoritative for order status.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'Outcome, scope, authority, truth sources, and acceptance are now explicit.',
    })))
    valueOf(await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)
  })

  it('reconstructs unreviewed human input from durable session history after restart', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-input-review-resume-'))
    workspaces.push(workspace)
    const first = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const firstAgent = await makeAgent(first.ctx, workspace, 'input-review-resume-root')
    sendUser(first.ctx, firstAgent, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await first.invoke(firstAgent, 'lattice_intake', framing(5, {
      decisions: ['PostgreSQL is authoritative.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The bounded local contract is complete.',
    })))
    sendUser(first.ctx, firstAgent, 'Continue with the accepted scope; this does not change requirements.')
    const seed = firstAgent.session.events

    const resumed = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const resumedAgent = await makeAgent(resumed.ctx, workspace, 'input-review-resume-root', undefined, false, seed)
    const denied = await resumed.invoke(resumedAgent, 'write', {})
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('lattice_review_input')
    const review = valueOf(await resumed.invoke(resumedAgent, 'lattice_review_input', {}))
    expect(review.pendingInputs).toHaveLength(1)
    expect(JSON.stringify(review.pendingInputs)).toContain('Continue with the accepted scope')
    const receipt = review.reviewReceipt as { id: string }
    valueOf(await resumed.invoke(resumedAgent, 'lattice_commit_input_review', {
      reviewReceiptId: receipt.id,
      disposition: 'contract-unchanged',
      rationale: 'The message explicitly preserves the accepted outcome, boundary, authority, truth source, and acceptance.',
    }))
    valueOf(await resumed.invoke(resumedAgent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await resumed.invoke(resumedAgent, 'write', {})).isError).toBe(false)
    expect(resumed.writes()).toBe(1)
  })

  it('restores a delegated human-input fence even when the child session log is unavailable after restart', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-delegated-input-resume-'))
    workspaces.push(workspace)
    const first = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const root = await makeAgent(first.ctx, workspace, 'delegated-input-resume-root')
    sendUser(first.ctx, root, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await first.invoke(root, 'lattice_intake', framing(5)))
    const child = await makeAgent(first.ctx, workspace, 'delegated-input-resume-child', root)
    sendUser(first.ctx, child, 'Implement the reporting leaf assigned by the parent coordinator.')
    sendUser(first.ctx, child, 'Change the requirement: archived cases must remain searchable.')
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const resumed = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const resumedRoot = await makeAgent(resumed.ctx, workspace, 'delegated-input-resume-root')
    const denied = await resumed.invoke(resumedRoot, 'write', {})
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/delegated|reframe|contract revision/i)

    valueOf(await resumed.invoke(resumedRoot, 'lattice_reframe', framing(5, {
      requestSummary: 'Archived cases must remain searchable.',
      desiredOutcome: 'Operators can search active and archived support cases.',
      decisions: ['Archived cases remain searchable.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The delegated change is now part of the root contract.',
    })))
    valueOf(await resumed.invoke(resumedRoot, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await resumed.invoke(resumedRoot, 'write', {})).isError).toBe(false)
  })

  it('lets explicit contract control adopt a material reframe without automatic heuristic questions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-critical-reframe-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const agent = await makeAgent(ctx, workspace, 'critical-reframe-root')
    sendUser(ctx, agent, 'Build a customer support application.')
    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(5, {
      questions: [productContractQuestion()],
    })))
    valueOf(await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: intake.pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'decision' }],
    }))

    sendUser(ctx, agent, 'Change the authorization model.')
    const reframed = await invoke(agent, 'lattice_reframe', framing(5, {
      requestSummary: 'Change the authorization model.',
      questions: [],
    }))
    expect(reframed.isError).toBe(false)
  })

  it('renders the lattice receipt after a question-based reframe commit for immediate reconciliation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-question-reframe-receipt-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'always',
      controlCeiling: 'lattice',
    })
    const agent = await makeAgent(ctx, workspace, 'question-reframe-receipt-root')
    sendUser(ctx, agent, 'Use the full Lattice to build a changing support application.')

    const pendingIntake = valueOf(await invoke(agent, 'lattice_intake', framing(12, {
      questions: [productContractQuestion()],
    })))
    const intake = valueOf(await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: pendingIntake.pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'decision' }],
    }))
    const contractReceipt = intake.receipt as { id: string }
    const opened = valueOf(await invoke(agent, 'lattice_open', {
      title: 'Question reframe receipt proof',
      objective: 'Keep support search reconciled with clarified requirements.',
      estimatedSteps: 12,
      intakeReceiptId: contractReceipt.id,
      contextPaths: [],
    }))
    const openedReceipt = opened.receipt as { id: string; revision: number }
    const added = valueOf(await invoke(agent, 'lattice_add', {
      receiptId: openedReceipt.id,
      expectedRevision: openedReceipt.revision,
      title: 'Implement support search',
      acceptanceCriteria: 'Current support cases are searchable.',
    }))
    const root = added.node as { id: string }

    sendUser(ctx, agent, 'Change the requirement: archived cases must also remain searchable.')
    const reframeContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: root.id }))
    const reframeReceipt = reframeContext.receipt as { id: string; revision: number }
    const pendingReframe = valueOf(await invoke(agent, 'lattice_reframe', {
      receiptId: reframeReceipt.id,
      expectedRevision: reframeReceipt.revision,
      ...framing(10, {
        requestSummary: 'Archived cases must also remain searchable.',
        desiredOutcome: 'Operators can search current and archived support cases.',
        questions: [{ id: 'archive-source', question: 'Which source is authoritative for archived cases?' }],
      }),
    }))
    const committedResult = await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: pendingReframe.pendingIntakeId,
      answerBindings: [{ questionId: 'archive-source', target: 'decision' }],
    })
    const committed = valueOf(committedResult)
    const latticeReceipt = committed.latticeReceipt as { id: string; revision: number }
    const visibleReceipt = renderedLatticeReceipt(committedResult)
    expect(visibleReceipt).toEqual({ id: latticeReceipt.id, revision: latticeReceipt.revision })

    const reconciled = valueOf(await invoke(agent, 'lattice_update', {
      receiptId: visibleReceipt.id,
      expectedRevision: visibleReceipt.revision,
      nodeId: root.id,
      acceptanceCriteria: 'Current and archived support cases are searchable from the clarified source.',
    }))
    expect(reconciled.node).toMatchObject({ id: root.id })
    expect(reconciled.node).not.toHaveProperty('reconciliationRequired')
  })

  it('requires every reframed root-to-leaf node to be explicitly reconciled before checkout', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-node-reconciliation-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'PRODUCT.md'), 'Archived search is not yet required.\n', 'utf8')
    const { ctx, invoke } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'node-reconciliation-root')
    sendUser(ctx, agent, 'Use the full Lattice for a changing multi-module support application.')
    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(12)))
    const contractReceipt = intake.receipt as { id: string }
    const opened = valueOf(await invoke(agent, 'lattice_open', {
      title: 'Reconciliation proof',
      objective: 'Keep every executable plan path bound to accepted intent.',
      estimatedSteps: 12,
      intakeReceiptId: contractReceipt.id,
      contextPaths: ['PRODUCT.md'],
    }))
    const openedReceipt = opened.receipt as { id: string; revision: number }
    const added = valueOf(await invoke(agent, 'lattice_add', {
      receiptId: openedReceipt.id,
      expectedRevision: openedReceipt.revision,
      title: 'Implement support search',
      acceptanceCriteria: 'Current support cases are searchable.',
    }))
    const root = added.node as { id: string; title: string }
    const rootContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: root.id }))
    const rootReceipt = rootContext.receipt as { id: string; revision: number }
    const split = valueOf(await invoke(agent, 'lattice_split', {
      receiptId: rootReceipt.id,
      expectedRevision: rootReceipt.revision,
      nodeId: root.id,
      children: [
        { title: 'Index support cases', acceptanceCriteria: 'Current cases are indexed.' },
        { title: 'Query support cases', acceptanceCriteria: 'Current cases can be queried.' },
      ],
    }))
    const child = (split.children as Array<{ id: string; title: string }>)[0]!

    const completedChildContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: child.id }))
    const completedChildReceipt = completedChildContext.receipt as { id: string; revision: number }
    valueOf(await invoke(agent, 'lattice_checkout', {
      receiptId: completedChildReceipt.id,
      expectedRevision: completedChildReceipt.revision,
      nodeId: child.id,
    }))
    const checkpointContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: child.id }))
    const checkpointReceipt = checkpointContext.receipt as { id: string; revision: number }
    valueOf(await invoke(agent, 'lattice_checkpoint', {
      receiptId: checkpointReceipt.id,
      expectedRevision: checkpointReceipt.revision,
      summary: 'Verified the original current-case indexing criterion.',
      references: ['original acceptance fixture'],
      complete: true,
    }))

    sendUser(ctx, agent, 'Change the requirement: archived cases must also remain searchable.')
    const reframeContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: root.id }))
    const reframeReceipt = reframeContext.receipt as { id: string; revision: number }
    const reframedResult = await invoke(agent, 'lattice_reframe', {
      receiptId: reframeReceipt.id,
      expectedRevision: reframeReceipt.revision,
      ...framing(10, {
        requestSummary: 'Archived cases must also remain searchable.',
        desiredOutcome: 'Operators can search current and archived support cases.',
        decisions: ['Archived cases remain searchable.'],
        unknowns: [],
        readiness: 'ready',
        readinessRationale: 'The expanded search acceptance is explicit.',
      }),
    })
    const reframed = valueOf(reframedResult)
    const latticeReceipt = reframed.latticeReceipt as { id: string; revision: number }
    const visibleReceipt = renderedLatticeReceipt(reframedResult)
    expect(visibleReceipt).toEqual({ id: latticeReceipt.id, revision: latticeReceipt.revision })
    valueOf(await invoke(agent, 'lattice_update', {
      receiptId: visibleReceipt.id,
      expectedRevision: visibleReceipt.revision,
      nodeId: root.id,
      acceptanceCriteria: 'Current and archived support cases are searchable.',
    }))

    const reopened = valueOf(await invoke(agent, 'lattice_status', { nodeId: child.id }))
    expect(reopened.status).toMatchObject({
      focus: { node: { status: 'pending', reconciliationRequired: true } },
    })

    const staleChildContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: child.id }))
    const staleChildReceipt = staleChildContext.receipt as { id: string; revision: number }
    const staleCheckout = await invoke(agent, 'lattice_checkout', {
      receiptId: staleChildReceipt.id,
      expectedRevision: staleChildReceipt.revision,
      nodeId: child.id,
    })
    expect(staleCheckout.isError).toBe(true)
    expect(JSON.stringify(staleCheckout.content)).toMatch(/predates|reconcile/i)

    const stillStaleContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: child.id }))
    const stillStaleReceipt = stillStaleContext.receipt as { id: string; revision: number }
    const stillStale = await invoke(agent, 'lattice_checkout', {
      receiptId: stillStaleReceipt.id,
      expectedRevision: stillStaleReceipt.revision,
      nodeId: child.id,
    })
    expect(stillStale.isError).toBe(true)

    const reconcileChildContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: child.id }))
    const reconcileChildReceipt = reconcileChildContext.receipt as { id: string; revision: number }
    valueOf(await invoke(agent, 'lattice_update', {
      receiptId: reconcileChildReceipt.id,
      expectedRevision: reconcileChildReceipt.revision,
      nodeId: child.id,
      acceptanceCriteria: 'Current and archived cases are indexed.',
    }))
    const checkoutContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: child.id }))
    const checkoutReceipt = checkoutContext.receipt as { id: string; revision: number }
    expect((await invoke(agent, 'lattice_checkout', {
      receiptId: checkoutReceipt.id,
      expectedRevision: checkoutReceipt.revision,
      nodeId: child.id,
    })).isError).toBe(false)
  })

  it('does not issue contract-tier authority when user input advances the epoch during a host snapshot', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-read-epoch-'))
    workspaces.push(workspace)
    let signalStarted!: () => void
    let releaseSnapshot!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const release = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const { ctx, invoke, writes } = await setup(workspace, {
      activationMode: 'always',
      controlCeiling: 'contract',
      preconditionAdapters: {
        write: {
          async snapshot() {
            signalStarted()
            await release
            return { stateDigest: 'fixture-write-ready', description: 'The delayed write fixture is ready.' }
          },
          verify({ expectedStateDigest }) {
            return expectedStateDigest === 'fixture-write-ready' ? undefined : 'write fixture state changed'
          },
        },
      },
    })
    const agent = await makeAgent(ctx, workspace, 'contract-read-epoch-root')
    sendUser(ctx, agent, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await invoke(agent, 'lattice_intake', framing(5, {
      decisions: ['PostgreSQL is authoritative.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'Outcome, scope, authority, truth source, and acceptance are known.',
    })))

    const refresh = invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY)
    await started
    sendUser(ctx, agent, 'Additional context arrived while the host state was being read.')
    releaseSnapshot()

    const denied = await refresh
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/authority changed during|retry lattice_refresh_context/i)
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    expect(writes()).toBe(0)
  })

  it('keeps stable contract refreshes incremental and restores authority after native compaction', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-continuity-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const agent = await makeAgent(ctx, workspace, 'contract-continuity-root')
    const authoritySentinel = 'CONTRACT_CONTINUITY_SENTINEL_42a0 must return after native history replacement.'
    sendUser(ctx, agent, `Build a customer support application. Do not ask questions; make reversible assumptions. ${authoritySentinel}`)
    valueOf(await invoke(agent, 'lattice_intake', framing(5, {
      decisions: ['PostgreSQL is authoritative.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'Outcome, scope, authority, truth source, and acceptance are known.',
    })))

    const stable = await invoke(agent, 'lattice_refresh_context', {})
    expect(stable.isError).toBe(false)
    expect(JSON.stringify(stable.content)).not.toContain(authoritySentinel)

    const userEvent = agent.session.events.find(event => event.type === 'user/message')
    if (userEvent === undefined) throw new Error('missing durable human authority fixture')
    const compactionId = CompactionId('contract-continuity-compaction')
    agent.session.append('compaction/start', { compactionId, turn: null })
    agent.session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'A lossy native summary without the contract sentinel.' }],
      shadowedRange: { start: userEvent.seq, end: userEvent.seq },
      shadowedSeqs: [userEvent.seq],
      shadowedTokenCount: 1,
      provider: 'proof',
      model: 'proof',
    })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'A lossy native surface without the contract sentinel.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: userEvent.seq, end: userEvent.seq },
      sourceEventSeqs: [userEvent.seq],
    })

    const restored = await invoke(agent, 'lattice_refresh_context', {})
    expect(restored.isError).toBe(false)
    expect(JSON.stringify(restored.content)).toContain(authoritySentinel)
  })

  it('ignores log-only prune but invalidates contract authority for a real replacement and at resume', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-replacement-boundaries-'))
    workspaces.push(workspace)
    const first = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const firstAgent = await makeAgent(first.ctx, workspace, 'replacement-root')
    sendUser(first.ctx, firstAgent, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await first.invoke(firstAgent, 'lattice_intake', framing(5, {
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The bounded local contract is complete.',
    })))
    valueOf(await first.invoke(firstAgent, 'lattice_refresh_context', WRITE_AUTHORITY))

    const source = firstAgent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Large tool result eligible for model-free pruning.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), { surfaceOp: 'append' })
    firstAgent.session.append('compaction/prune', {
      shadowedRange: { start: source.seq, end: source.seq },
      shadowedSeqs: [source.seq],
      shadowedTokenCount: 8,
    })
    expect((await first.invoke(firstAgent, 'write', {})).isError).toBe(false)
    expect(first.writes()).toBe(1)
    firstAgent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Native replacement after model-free pruning.' }],
      source: { kind: 'plugin', plugin: 'test-compaction-fixture' },
    }), {
      surfaceOp: { op: 'replace', start: source.seq, end: source.seq },
      sourceEventSeqs: [source.seq],
    })
    const deniedAfterReplacement = await first.invoke(firstAgent, 'write', {})
    expect(deniedAfterReplacement.isError).toBe(true)
    expect(JSON.stringify(deniedAfterReplacement.content)).toContain('user/message')
    expect(first.writes()).toBe(1)

    const resumed = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const resumedAgent = await makeAgent(resumed.ctx, workspace, 'replacement-root', undefined, true)
    const deniedFromSeed = await resumed.invoke(resumedAgent, 'write', {})
    expect(deniedFromSeed.isError).toBe(true)
    expect(JSON.stringify(deniedFromSeed.content)).toContain('seeded-surface-replacement')
    valueOf(await resumed.invoke(resumedAgent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await resumed.invoke(resumedAgent, 'write', {})).isError).toBe(false)
    expect(resumed.writes()).toBe(1)
  })

  it('rejects a self-consistent contract rewrite until a legitimate reframe replaces the anchor', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-anchor-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const agent = await makeAgent(ctx, workspace, 'contract-anchor-root')
    sendUser(ctx, agent, 'Build a customer support application. Do not ask questions; make reversible assumptions.')

    valueOf(await invoke(agent, 'lattice_intake', framing(5, {
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The bounded local contract is complete.',
    })))
    valueOf(await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)

    const anchored = readContractSync(workspace)
    if (anchored === undefined) throw new Error('expected a persisted contract')
    await persistContract({
      workspace,
      sessionId: anchored.sessionId,
      controlLevel: anchored.controlLevel,
      clarificationPolicy: anchored.clarificationPolicy,
      framing: {
        ...anchored.framing,
        desiredOutcome: 'An unreviewed replacement outcome.',
      },
      questions: anchored.questions,
      answers: anchored.answers,
      answerBindings: anchored.answerBindings,
      receiptId: anchored.id,
      revision: anchored.revision,
      createdAt: anchored.createdAt,
    })

    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    expect(writes()).toBe(1)
    valueOf(await invoke(agent, 'lattice_reframe', framing(4, {
      requestSummary: 'Restore the confirmed support workflow contract.',
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The root task supplied the replacement contract.',
    })))
    valueOf(await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(2)
  })

  it('keeps explicit contract mode on a one-refresh-per-mutation basis', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-target-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'screen.ts'), 'export const title = "Old"\n', 'utf8')
    const { ctx, invoke } = await setup(workspace, { activationMode: 'always', controlCeiling: 'contract' })
    let edits = 0
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Real-shaped contract-tier edit fixture.',
      parameters: {
        file_path: { type: 'string', required: true },
        old_string: { type: 'string', required: true },
        new_string: { type: 'string', required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        if (args.new_string === 'FAIL') throw new Error('fixture failure after authorization')
        await writeFile(args.file_path, args.new_string, 'utf8')
        edits += 1
        return `edit-${edits}`
      },
    }))
    const agent = await makeAgent(ctx, workspace, 'contract-target-root')
    sendUser(ctx, agent, 'Build a customer support application.')
    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      questions: [productContractQuestion()],
    })))
    valueOf(await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: intake.pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'decision' }],
    }))

    const args = {
      file_path: join(workspace, 'screen.ts'),
      old_string: 'export const title = "Old"\n',
      new_string: 'export const title = "New"\n',
    }
    const deniedWithoutBasis = await invoke(agent, 'edit', args)
    expect(deniedWithoutBasis.isError).toBe(true)
    expect(JSON.stringify(deniedWithoutBasis.content)).toContain('lattice_refresh_context')

    const prepared = await invoke(agent, 'lattice_refresh_context', {})
    expect(JSON.stringify(prepared.content)).not.toContain('UNCHANGED AUTHORITATIVE DOCUMENTS')
    expect(JSON.stringify(prepared.content)).not.toMatch(/CONTRACT\.md.*sha256/i)
    expect(JSON.stringify(prepared.content)).not.toContain('PostgreSQL is authoritative')
    expect((await invoke(agent, 'edit', { ...args, new_string: 'FAIL' })).isError).toBe(true)
    expect((await invoke(agent, 'edit', args)).isError).toBe(true)
    valueOf(await invoke(agent, 'lattice_refresh_context', { targetPaths: ['screen.ts'] }))
    expect((await invoke(agent, 'edit', args)).isError).toBe(false)
    expect(edits).toBe(1)

    expect((await invoke(agent, 'edit', { ...args, new_string: 'export const title = "Again"\n' })).isError).toBe(true)
    valueOf(await invoke(agent, 'lattice_refresh_context', { targetPaths: ['screen.ts'] }))
    expect((await invoke(agent, 'edit', { ...args, new_string: 'export const title = "Again"\n' })).isError).toBe(false)
    expect(edits).toBe(2)

    sendUser(ctx, agent, 'Change the accepted title to a localized product name.')
    expect((await invoke(agent, 'edit', args)).isError).toBe(true)
  })

  it('uses full lattice for dynamic multi-agent work and makes children inherit the root level', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-parent-child-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'PRODUCT.md'), 'PARENT_CHILD_SENTINEL\n', 'utf8')
    const { ctx, invoke } = await setup(workspace)
    const parent = await makeAgent(ctx, workspace, 'lattice-parent')
    sendUser(ctx, parent, 'Use the full Plan Lattice to build a production-ready multi-agent application from scratch; requirements will keep changing.')
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toContain('lattice_open')

    const intake = valueOf(await invoke(parent, 'lattice_intake', framing(12)))
    const contractReceipt = intake.receipt as { id: string }
    const opened = valueOf(await invoke(parent, 'lattice_open', {
      title: 'Dynamic support system',
      objective: 'Preserve valid support outcomes while requirements evolve.',
      estimatedSteps: 12,
      intakeReceiptId: contractReceipt.id,
      contextPaths: ['PRODUCT.md'],
    }))
    const openReceipt = opened.receipt as { id: string; revision: number }
    const added = valueOf(await invoke(parent, 'lattice_add', {
      receiptId: openReceipt.id,
      expectedRevision: openReceipt.revision,
      title: 'Implement durable case routing',
      acceptanceCriteria: 'Every accepted case reaches the authoritative queue exactly once.',
    }))
    const node = added.node as { id: string }
    const current = valueOf(await invoke(parent, 'lattice_refresh_context', { planNodeId: node.id }))
    const currentReceipt = current.receipt as { id: string; revision: number }
    valueOf(await invoke(parent, 'lattice_checkout', {
      receiptId: currentReceipt.id,
      expectedRevision: currentReceipt.revision,
      nodeId: node.id,
    }))

    const child = await makeAgent(ctx, workspace, 'lattice-child', parent)
    const childTools = ctx.tools.schemas(child).map(tool => tool.name)
    expect(childTools).not.toContain('lattice_open')
    expect(childTools).not.toContain('lattice_intake')
    expect(childTools).not.toContain('lattice_reframe')
    expect(childTools).not.toContain('lattice_route')
    expect(childTools).toContain('lattice_refresh_context')
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(child))
    const policy = prompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? ''
    expect(policy).toContain('Never question the human directly')
    expect(policy).toContain('DSH owns conversation compaction and tool-result pruning')
    const runtimeState = prompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(runtimeState).toContain('Operators can resolve a support case')
    expect(runtimeState).toContain('Implement durable case routing')
    expect(runtimeState).toContain('Every accepted case reaches the authoritative queue exactly once.')
    expect(runtimeState).toContain(node.id)
    expect(runtimeState).toContain(`Root session: ${parent.id}`)
  })

  it('restores v2 control after restart and treats an existing v1 graph as full lattice without rewriting it', async () => {
    const v2Workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-resume-v2-'))
    workspaces.push(v2Workspace)
    const first = await setup(v2Workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const firstAgent = await makeAgent(first.ctx, v2Workspace, 'resume-contract-root')
    sendUser(first.ctx, firstAgent, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await first.invoke(firstAgent, 'lattice_intake', framing(6)))

    const confirmed = readContractSync(v2Workspace)
    if (confirmed === undefined) throw new Error('expected the confirmed contract')
    await persistContract({
      workspace: v2Workspace,
      sessionId: confirmed.sessionId,
      controlLevel: confirmed.controlLevel,
      clarificationPolicy: confirmed.clarificationPolicy,
      framing: {
        ...confirmed.framing,
        desiredOutcome: 'A pre-restart unreviewed replacement outcome.',
      },
      questions: confirmed.questions,
      answers: confirmed.answers,
      answerBindings: confirmed.answerBindings,
      receiptId: confirmed.id,
      revision: confirmed.revision,
      createdAt: confirmed.createdAt,
    })

    const resumed = await setup(v2Workspace, { activationMode: 'always', controlCeiling: 'contract' })
    const resumedAgent = await makeAgent(resumed.ctx, v2Workspace, 'resume-contract-root')
    expect(resumed.ctx.tools.schemas(resumedAgent).map(tool => tool.name)).toContain('lattice_refresh_context')
    expect(resumed.ctx.tools.schemas(resumedAgent).map(tool => tool.name)).not.toContain('lattice_open')
    const resumedPrompt = await resumed.ctx.systemPrompt.assemble(assembleContextFor(resumedAgent))
    const resumedPolicy = resumedPrompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? ''
    expect(resumedPolicy).toContain('Plan Lattice contract control')
    const resumedState = resumedPrompt.contexts.find(context => context.name === 'plan-lattice:execution-state')?.text ?? ''
    expect(resumedState).toContain('Plan Lattice execution state')
    expect(resumedState).toContain('Contract revision: 1')
    expect(resumedState).not.toContain('pre-restart unreviewed replacement')
    expect((await resumed.invoke(resumedAgent, 'write', {})).isError).toBe(true)
    valueOf(await resumed.invoke(resumedAgent, 'lattice_reframe', framing(5, {
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The root task supplied a complete replacement contract.',
    })))
    valueOf(await resumed.invoke(resumedAgent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await resumed.invoke(resumedAgent, 'write', {})).isError).toBe(false)

    const v1Workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-resume-v1-'))
    workspaces.push(v1Workspace)
    await writeFile(join(v1Workspace, 'PRODUCT.md'), 'LEGACY_PRODUCT_CONTRACT\n', 'utf8')
    const v1Directory = join(v1Workspace, '.dsh/plan-lattice/v1')
    await mkdir(v1Directory, { recursive: true })
    const legacyIntake = await persistIntake({
      workspace: v1Workspace,
      sessionId: 'legacy-intake-root',
      decision: 'autonomous',
      framing: framing(4, {
        requestSummary: 'Preserve a legacy intake while adopting v2 control.',
        unknowns: [],
        readiness: 'ready',
        readinessRationale: 'The legacy graph already has an accepted execution boundary.',
      }),
      questions: [],
      answers: [],
    })
    const now = Date.now()
    const snapshot = `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      project: {
        title: 'Legacy graph',
        objective: 'Resume without migration.',
        contextPaths: ['PRODUCT.md'],
        createdAt: now,
        updatedAt: now,
      },
      nodes: {
        'legacy-node': {
          id: 'legacy-node',
          title: 'Original legacy work',
          acceptanceCriteria: 'The pre-v2 node remains operable.',
          status: 'pending',
          evidence: [{ summary: 'Legacy proof.', references: ['legacy:test'], recordedAt: now }],
          createdAt: now,
          updatedAt: now,
        },
      },
    }, null, 2)}\n`
    const ledgerNode = {
      id: 'legacy-node',
      title: 'Ledger-restored legacy work',
      acceptanceCriteria: 'The pre-v2 node remains operable.',
      status: 'pending',
      evidence: [{ summary: 'Legacy proof.', references: ['legacy:test'], recordedAt: now }],
      createdAt: now,
      updatedAt: now + 1,
    }
    const ledger = `${JSON.stringify({
      revision: 2,
      upserts: [ledgerNode],
      action: 'legacy-update',
      at: now + 1,
    })}\n`
    await writeFile(join(v1Directory, 'snapshot.json'), snapshot, 'utf8')
    await writeFile(join(v1Directory, 'ledger.jsonl'), ledger, 'utf8')
    const legacy = await setup(v1Workspace)
    const legacyAgent = await makeAgent(legacy.ctx, v1Workspace, 'resume-v1-root')
    const legacyTools = legacy.ctx.tools.schemas(legacyAgent).map(tool => tool.name)
    expect(legacyTools).toContain('lattice_open')
    expect(legacyTools).not.toContain('lattice_route')
    expect(existsSync(join(v1Workspace, CONTRACT_DOCUMENT_PATH))).toBe(false)
    const legacyContext = valueOf(await legacy.invoke(legacyAgent, 'lattice_refresh_context', {}))
    const legacyReceipt = legacyContext.receipt as { id: string; revision: number }
    valueOf(await legacy.invoke(legacyAgent, 'lattice_reframe', {
      receiptId: legacyReceipt.id,
      expectedRevision: legacyReceipt.revision,
      ...framing(4, {
        requestSummary: 'Adopt a v2 contract while preserving the v1 graph.',
        desiredOutcome: 'Resume the legacy graph under an explicit execution contract.',
        unknowns: [],
        readiness: 'ready',
        readinessRationale: 'The legacy objective and current boundary are known.',
      }),
    }))
    expect(existsSync(join(v1Workspace, CONTRACT_DOCUMENT_PATH))).toBe(true)
    expect(await readFile(join(v1Directory, 'snapshot.json'), 'utf8')).toBe(snapshot)
    expect((await readFile(join(v1Directory, 'ledger.jsonl'), 'utf8')).startsWith(ledger)).toBe(true)
    await expect(verifyIntake({
      workspace: v1Workspace,
      sessionId: 'legacy-intake-root',
      receiptId: legacyIntake.receipt.id,
    })).resolves.toMatchObject({ id: legacyIntake.receipt.id })

    const migratedContext = valueOf(await legacy.invoke(legacyAgent, 'lattice_refresh_context', { planNodeId: 'legacy-node' }))
    const migratedReceipt = migratedContext.receipt as { id: string; revision: number }
    const updated = valueOf(await legacy.invoke(legacyAgent, 'lattice_update', {
      receiptId: migratedReceipt.id,
      expectedRevision: migratedReceipt.revision,
      nodeId: 'legacy-node',
      title: 'Continued under the v2 contract',
    }))
    expect((updated.node as { title: string }).title).toBe('Continued under the v2 contract')
    expect(JSON.stringify(migratedContext)).toContain('Ledger-restored legacy work')
  })

  it('fails closed after a crash leaves a new contract over an all-complete old graph', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-interrupted-reframe-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'PRODUCT.md'), 'The original accepted product boundary.\n', 'utf8')
    const first = await setup(workspace)
    const firstAgent = await makeAgent(first.ctx, workspace, 'interrupted-reframe-root')
    sendUser(first.ctx, firstAgent, 'Use the full Plan Lattice to implement a changing support application.')
    const intake = valueOf(await first.invoke(firstAgent, 'lattice_intake', framing(12)))
    const contractReceipt = intake.receipt as { id: string }
    const opened = valueOf(await first.invoke(firstAgent, 'lattice_open', {
      title: 'Interrupted reframe proof',
      objective: 'Never execute an old branch against a new contract.',
      estimatedSteps: 12,
      intakeReceiptId: contractReceipt.id,
      contextPaths: ['PRODUCT.md'],
    }))
    const openedReceipt = opened.receipt as { id: string; revision: number }
    const added = valueOf(await first.invoke(firstAgent, 'lattice_add', {
      receiptId: openedReceipt.id,
      expectedRevision: openedReceipt.revision,
      title: 'Implement the original branch',
      acceptanceCriteria: 'The original contract is satisfied.',
    }))
    const nodeId = (added.node as { id: string }).id
    const checkoutContext = valueOf(await first.invoke(firstAgent, 'lattice_refresh_context', { planNodeId: nodeId }))
    const checkoutReceipt = checkoutContext.receipt as { id: string; revision: number }
    valueOf(await first.invoke(firstAgent, 'lattice_checkout', {
      receiptId: checkoutReceipt.id,
      expectedRevision: checkoutReceipt.revision,
      nodeId,
    }))
    const checkpointContext = valueOf(await first.invoke(firstAgent, 'lattice_refresh_context', { planNodeId: nodeId }))
    const checkpointReceipt = checkpointContext.receipt as { id: string; revision: number }
    valueOf(await first.invoke(firstAgent, 'lattice_checkpoint', {
      receiptId: checkpointReceipt.id,
      expectedRevision: checkpointReceipt.revision,
      summary: 'The original contract was fully satisfied before the interrupted reframe.',
      references: ['all-complete interrupted reframe fixture'],
      complete: true,
    }))

    const accepted = readContractSync(workspace)
    if (accepted === undefined) throw new Error('expected the accepted contract')
    await persistContract({
      workspace,
      sessionId: accepted.sessionId,
      controlLevel: 'lattice',
      clarificationPolicy: accepted.clarificationPolicy,
      framing: {
        ...accepted.framing,
        desiredOutcome: 'The replacement outcome that the graph never reconciled.',
      },
      questions: accepted.questions,
      answers: accepted.answers,
      answerBindings: accepted.answerBindings,
      receiptId: accepted.id,
      revision: accepted.revision + 1,
      createdAt: accepted.createdAt,
    }, {
      beforeWrite: record => persistContractAnchor(join(workspace, '.plan-lattice-anchor-store'), record),
    })

    const resumed = await setup(workspace, { activationMode: 'always', controlCeiling: 'lattice' })
    const resumedAgent = await makeAgent(resumed.ctx, workspace, 'interrupted-reframe-root')
    const denied = await resumed.invoke(resumedAgent, 'write', {})
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/reframe|contract changed|material change/i)
  })

  it.each(['empty', 'all-archived'] as const)(
    'fails closed when contract publication outruns a legacy %s graph during reframe',
    async graphShape => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-empty-interrupted-reframe-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'PRODUCT.md'), 'The original empty-plan boundary.\n', 'utf8')
    const first = await setup(workspace)
    const firstAgent = await makeAgent(first.ctx, workspace, 'empty-interrupted-reframe-root')
    sendUser(first.ctx, firstAgent, 'Use the full Plan Lattice for a changing support application.')
    const intake = valueOf(await first.invoke(firstAgent, 'lattice_intake', framing(12)))
    const receipt = intake.receipt as { id: string }
    valueOf(await first.invoke(firstAgent, 'lattice_open', {
      title: 'Empty interrupted reframe proof',
      objective: 'Do not accept a revised contract over an unreconciled graph.',
      estimatedSteps: 12,
      intakeReceiptId: receipt.id,
      contextPaths: ['PRODUCT.md'],
    }))

    // Simulate an RC.4 graph, which predates the project-level contract
    // binding. With no live node, node reconciliation cannot prove whether a
    // newly published contract reached the graph.
    const snapshotPath = join(workspace, '.dsh', 'plan-lattice', 'v1', 'snapshot.json')
    const legacyState = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      project: { contractRevision?: number; contractDigest?: string }
      nodes: Record<string, unknown>
    }
    delete legacyState.project.contractRevision
    delete legacyState.project.contractDigest
    if (graphShape === 'all-archived') {
      const now = Date.now()
      legacyState.nodes['archived-node'] = {
        id: 'archived-node',
        title: 'Historical archived work',
        acceptanceCriteria: 'Historical work remains non-executable.',
        status: 'archived',
        evidence: [],
        createdAt: now,
        updatedAt: now,
      }
    }
    await writeFile(snapshotPath, `${JSON.stringify(legacyState, null, 2)}\n`, 'utf8')

    const accepted = readContractSync(workspace)
    if (accepted === undefined) throw new Error('expected the accepted contract')
    await persistContract({
      workspace,
      sessionId: accepted.sessionId,
      controlLevel: 'lattice',
      clarificationPolicy: accepted.clarificationPolicy,
      framing: { ...accepted.framing, desiredOutcome: 'A replacement outcome with no graph commit.' },
      questions: accepted.questions,
      answers: accepted.answers,
      answerBindings: accepted.answerBindings,
      receiptId: accepted.id,
      revision: accepted.revision + 1,
      createdAt: accepted.createdAt,
    }, {
      beforeWrite: record => persistContractAnchor(join(workspace, '.plan-lattice-anchor-store'), record),
    })

    const resumed = await setup(workspace, { activationMode: 'always', controlCeiling: 'lattice' })
    const resumedAgent = await makeAgent(resumed.ctx, workspace, 'empty-interrupted-reframe-root')
    const denied = await resumed.invoke(resumedAgent, 'write', {})
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/reframe|contract changed|material change/i)
    },
  )
})
