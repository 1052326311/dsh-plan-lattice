import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { assembleContextFor, emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTRACT_DOCUMENT_PATH,
  persistContract,
  readContractSync,
} from '../src/contract.js'
import { apply, type Config } from '../src/index.js'
import { persistIntake, verifyIntake } from '../src/intake.js'

const contexts: Context[] = []
const scopes: Scope[] = []
const workspaces: string[] = []
const WRITE_AUTHORITY = {
  externalActions: [{ toolName: 'write', resource: 'fixture-write', arguments: {} }],
}

function valueOf(result: Awaited<ReturnType<Context['tools']['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value as Record<string, unknown>
}

async function makeAgent(
  ctx: Context,
  workspace: string,
  id: string,
  parent?: Agent,
  seedReplacement = false,
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
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Replacement seed context.' }],
      source: { kind: 'user' },
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

function sendUser(ctx: Context, agent: Agent, text: string): void {
  emitAgentEvent(ctx, agent, 'agent/inbox/inserted', {
    message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  })
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

async function setup(workspace: string, config: Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.userQuestions.registerProvider({
    async ask(request) {
      return {
        answers: request.questions.map(question => ({
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
  return {
    ctx,
    writes: () => writes,
    shellCalls: () => shellCalls,
    invoke: (agent: Agent, name: string, args: unknown) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `auto-${++calls}` as never,
      name,
      arguments: args,
      agent,
    }),
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
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)
    expect((await invoke(agent, 'bash', { command: 'printf harmless' })).isError).toBe(false)
    expect(shellCalls()).toBe(1)
    expect(existsSync(join(workspace, '.dsh'))).toBe(false)
  })

  it('guards shell mutations by default once automatic control activates', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-default-shell-'))
    workspaces.push(workspace)
    const { ctx, invoke, shellCalls } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'default-shell-root')

    sendUser(ctx, agent, 'Build a customer support application.')
    const denied = await invoke(agent, 'bash', { command: 'printf unsafe > result.txt' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('lattice_refresh_context')
    expect(shellCalls()).toBe(0)
  })

  it('keeps an uncertain task read-only until lattice_route resolves it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-probe-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'probe-root')
    sendUser(ctx, agent, 'Investigate the repository carefully and improve the implementation where appropriate, preserving every existing behavior and validating the result against the surrounding architecture before making any change.')

    expect(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('lattice_')).map(tool => tool.name)).toEqual(['lattice_route'])
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    expect(writes()).toBe(0)
    valueOf(await invoke(agent, 'lattice_route', {
      recommendedLevel: 'bypass', estimatedSteps: 2, executionSpan: 2, productDefinitionGap: 0,
      outcomeCritical: false, evidence: ['Only one local implementation site exists.'], rationale: 'The inspected change is bounded.',
    }))
    expect(ctx.tools.schemas(agent).some(tool => tool.name.startsWith('lattice_'))).toBe(false)
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
  })

  it('commits a contract, pauses on material change and compaction, then resumes without node checkpoints', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'contract-root')
    sendUser(ctx, agent, 'Build a customer support application.')

    const visible = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(visible).toContain('lattice_intake')
    expect(visible).toContain('lattice_commit_intake')
    expect(visible).not.toContain('lattice_open')
    expect((await invoke(agent, 'write', {})).isError).toBe(true)

    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      questions: [{ id: 'truth', question: 'What is the authoritative case source?' }],
    })))
    const pendingIntakeId = intake.pendingIntakeId as string
    expect(pendingIntakeId).toBeTypeOf('string')
    valueOf(await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId,
      answerBindings: [{ questionId: 'truth', target: 'decision', statement: 'PostgreSQL is the authoritative case source.' }],
    }))
    expect(existsSync(join(workspace, CONTRACT_DOCUMENT_PATH))).toBe(true)
    valueOf(await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(1)

    sendUser(ctx, agent, 'Change the requirement: archived cases must remain searchable.')
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    valueOf(await invoke(agent, 'lattice_reframe', framing(5, {
      requestSummary: 'Archived cases must remain searchable.',
      desiredOutcome: 'Operators can resolve and search archived support cases.',
      decisions: ['Archived cases remain searchable.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'Outcome, scope, authority, truth source, and acceptance are known.',
    })))
    valueOf(await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY))
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
    expect(writes()).toBe(2)

    const shadowed = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old contract-visible context' }],
      source: { kind: 'user' },
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
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    expect((await invoke(agent, 'lattice_refresh_context', WRITE_AUTHORITY)).isError).toBe(false)
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

  it('does not issue contract-tier authority when user input advances the epoch during a host snapshot', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-read-epoch-'))
    workspaces.push(workspace)
    let signalStarted!: () => void
    let releaseSnapshot!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const release = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const { ctx, invoke, writes } = await setup(workspace, {
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
    sendUser(ctx, agent, 'Build a customer support application.')
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

  it('invalidates contract authority for model-free prune and a replacement already present at resume', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-replacement-boundaries-'))
    workspaces.push(workspace)
    const first = await setup(workspace)
    const firstAgent = await makeAgent(first.ctx, workspace, 'replacement-root')
    sendUser(first.ctx, firstAgent, 'Build a customer support application.')
    valueOf(await first.invoke(firstAgent, 'lattice_intake', framing(5, {
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The bounded local contract is complete.',
    })))
    valueOf(await first.invoke(firstAgent, 'lattice_refresh_context', WRITE_AUTHORITY))

    const source = firstAgent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Large tool result eligible for model-free pruning.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    firstAgent.session.append('compaction/prune', {
      shadowedRange: { start: source.seq, end: source.seq },
      shadowedSeqs: [source.seq],
      shadowedTokenCount: 8,
    })
    const deniedAfterPrune = await first.invoke(firstAgent, 'write', {})
    expect(deniedAfterPrune.isError).toBe(true)
    expect(JSON.stringify(deniedAfterPrune.content)).toContain('compaction/prune')
    expect(first.writes()).toBe(0)

    const resumed = await setup(workspace)
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
    const { ctx, invoke, writes } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'contract-anchor-root')
    sendUser(ctx, agent, 'Build a customer support application.')

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

  it('uses one exact target-file basis per contract-tier filesystem mutation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-contract-target-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'screen.ts'), 'export const title = "Old"\n', 'utf8')
    const { ctx, invoke } = await setup(workspace)
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
      questions: [{ id: 'truth', question: 'What is the authoritative case source?' }],
    })))
    valueOf(await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: intake.pendingIntakeId,
      answerBindings: [{ questionId: 'truth', target: 'decision', statement: 'PostgreSQL is authoritative.' }],
    }))

    const args = {
      file_path: join(workspace, 'screen.ts'),
      old_string: 'export const title = "Old"\n',
      new_string: 'export const title = "New"\n',
    }
    const deniedWithoutBasis = await invoke(agent, 'edit', args)
    expect(deniedWithoutBasis.isError).toBe(true)
    expect(JSON.stringify(deniedWithoutBasis.content)).toContain('targetPaths')

    const prepared = await invoke(agent, 'lattice_refresh_context', { targetPaths: ['screen.ts'] })
    expect(JSON.stringify(prepared.content)).toContain('PostgreSQL is authoritative')
    expect(JSON.stringify(prepared.content)).toContain('export const title')
    expect((await invoke(agent, 'edit', { ...args, new_string: 'FAIL' })).isError).toBe(true)
    const deniedAfterFailedAttempt = await invoke(agent, 'edit', args)
    expect(deniedAfterFailedAttempt.isError).toBe(true)
    expect(JSON.stringify(deniedAfterFailedAttempt.content)).toContain('targetPaths')

    await invoke(agent, 'lattice_refresh_context', { targetPaths: ['screen.ts'] })
    expect((await invoke(agent, 'edit', args)).isError).toBe(false)
    expect(edits).toBe(1)

    const deniedReuse = await invoke(agent, 'edit', { ...args, new_string: 'export const title = "Again"\n' })
    expect(deniedReuse.isError).toBe(true)
    expect(JSON.stringify(deniedReuse.content)).toContain('targetPaths')
  })

  it('uses full lattice for dynamic multi-agent work and makes children inherit the root level', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-parent-child-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'PRODUCT.md'), 'PARENT_CHILD_SENTINEL\n', 'utf8')
    const { ctx, invoke } = await setup(workspace)
    const parent = await makeAgent(ctx, workspace, 'lattice-parent')
    sendUser(ctx, parent, 'Build a production-ready multi-agent application from scratch; requirements will keep changing.')
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toContain('lattice_open')

    const intake = valueOf(await invoke(parent, 'lattice_intake', framing(12)))
    const contractReceipt = intake.receipt as { id: string }
    valueOf(await invoke(parent, 'lattice_open', {
      title: 'Dynamic support system',
      objective: 'Preserve valid support outcomes while requirements evolve.',
      estimatedSteps: 12,
      intakeReceiptId: contractReceipt.id,
      contextPaths: ['PRODUCT.md'],
    }))

    const child = await makeAgent(ctx, workspace, 'lattice-child', parent)
    const childTools = ctx.tools.schemas(child).map(tool => tool.name)
    expect(childTools).toContain('lattice_open')
    expect(childTools).not.toContain('lattice_route')
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(child))
    const policy = prompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? ''
    expect(policy).toContain('Execution capsule')
    expect(policy).toContain('Never question the human directly')
    expect(policy).toContain('Operators can resolve a support case')
  })

  it('restores v2 control after restart and treats an existing v1 graph as full lattice without rewriting it', async () => {
    const v2Workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-resume-v2-'))
    workspaces.push(v2Workspace)
    const first = await setup(v2Workspace)
    const firstAgent = await makeAgent(first.ctx, v2Workspace, 'resume-contract-root')
    sendUser(first.ctx, firstAgent, 'Build a customer support application.')
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

    const resumed = await setup(v2Workspace)
    const resumedAgent = await makeAgent(resumed.ctx, v2Workspace, 'resume-contract-root')
    expect(resumed.ctx.tools.schemas(resumedAgent).map(tool => tool.name)).toContain('lattice_intake')
    expect(resumed.ctx.tools.schemas(resumedAgent).map(tool => tool.name)).not.toContain('lattice_open')
    const resumedPrompt = await resumed.ctx.systemPrompt.assemble(assembleContextFor(resumedAgent))
    const resumedPolicy = resumedPrompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? ''
    expect(resumedPolicy).toContain('Execution capsule')
    expect(resumedPolicy).toContain('Operators can resolve a support case without losing data.')
    expect(resumedPolicy).not.toContain('pre-restart unreviewed replacement')
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
})
