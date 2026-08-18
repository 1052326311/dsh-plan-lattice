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

function sendUser(ctx: Context, agent: Agent, text: string): void {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  emitAgentEvent(ctx, agent, 'agent/inbox/inserted', {
    message,
  })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
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
) {
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
    expect(JSON.stringify(denied.content)).toContain('lattice_intake')
    expect(JSON.stringify(denied.content)).not.toContain('lattice_reframe')
    expect(shellCalls()).toBe(0)
  })

  it('binds a fresh never-policy request once, opens without copied receipt fields, and restores raw authority after compaction', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-authority-bootstrap-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, {
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
    })
    const agent = await makeAgent(ctx, workspace, 'authority-bootstrap-root')
    const authoritySentinel = 'IMMUTABLE_PRD_SENTINEL_8f74e1 must survive every compaction and delegation.'
    sendUser(ctx, agent, `Build a complete incident system. ${authoritySentinel}`)

    const intakeResult = await invoke(agent, 'lattice_intake', {
      requestSummary: 'Build and verify the staged incident system.',
      estimatedSteps: 9,
    })
    expect(intakeResult.isError).toBe(false)
    expect(JSON.stringify(intakeResult.content)).toContain('lattice_open can infer this receipt')
    expect(JSON.stringify(intakeResult.content)).not.toContain(authoritySentinel)
    const contract = readContractSync(workspace)
    expect(contract?.authoritySources).toHaveLength(1)
    expect(contract?.framing.assumptions).toEqual([
      'Implementation choices not fixed by human authority remain reversible until verified.',
    ])
    expect(await readFile(join(workspace, CONTRACT_DOCUMENT_PATH), 'utf8')).not.toContain(authoritySentinel)

    const opened = valueOf(await invoke(agent, 'lattice_open', {
      title: 'Incident delivery',
      objective: 'Deliver one tested incident-system increment.',
      initialPlan: [{
        key: 'delivery',
        title: 'Deliver the current milestone',
        acceptanceCriteria: 'The current milestone behavior and focused tests pass.',
      }],
      selectedLeafKey: 'delivery',
    }))
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

    const shadowed = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Replaceable runtime detail.' }],
      source: { kind: 'plugin', plugin: 'authority-bootstrap-test' },
    }), { surfaceOp: 'append' })
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
    const restored = await invoke(agent, 'lattice_refresh_context', { planNodeId: selected.id })
    expect(restored.isError).toBe(false)
    expect(JSON.stringify(restored.content)).toContain(authoritySentinel)
    expect(JSON.stringify(restored.content)).toContain('session://human-authority/')

    const child = await makeAgent(ctx, workspace, 'authority-bootstrap-child', agent)
    const delegated = await invoke(child, 'lattice_refresh_context', { planNodeId: selected.id })
    expect(delegated.isError).toBe(false)
    expect(JSON.stringify(delegated.content)).toContain(authoritySentinel)

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

  it('requires a real critical clarification for a polite, underspecified application request', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-critical-intake-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'critical-intake-root')
    sendUser(ctx, agent, 'Can you build a customer support application?')

    const skipped = await invoke(agent, 'lattice_intake', framing(6, {
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The model claims the contract is ready without asking.',
    }))
    expect(skipped.isError).toBe(true)
    expect(JSON.stringify(skipped.content)).toMatch(/outcome-critical|focused clarification/i)

    const cosmetic = await invoke(agent, 'lattice_intake', framing(6, {
      questions: [{ id: 'color', question: 'Which accent color should the header use?' }],
    }))
    expect(cosmetic.isError).toBe(true)
    expect(JSON.stringify(cosmetic.content)).toMatch(/outcome, scope, acceptance/i)

    const intake = valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      questions: [productContractQuestion()],
    })))
    const unresolved = await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: intake.pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'unknown' }],
    })
    expect(unresolved.isError).toBe(true)
    expect(JSON.stringify(unresolved.content)).toMatch(/cannot be rebound|clarify/i)

    const committed = valueOf(await invoke(agent, 'lattice_commit_intake', {
      pendingIntakeId: intake.pendingIntakeId,
      answerBindings: [{ questionId: 'contract', target: 'decision' }],
    }))
    expect(JSON.stringify(committed.contract)).toContain('Question: What observable outcome must users achieve')
  })

  it('rejects clarification answers that select an option the user was never offered', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-invalid-answer-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace, {}, questions => questions.map(question => ({
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
    const { ctx, invoke } = await setup(workspace, {}, questions => questions.map(question => ({
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
    const { ctx, invoke } = await setup(workspace, {}, questions => questions.map(question => ({
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

  it('keeps an uncertain task read-only until lattice_route resolves it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-probe-'))
    workspaces.push(workspace)
    const { ctx, invoke, writes } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'probe-root')
    sendUser(ctx, agent, 'Investigate the repository carefully and improve the implementation where appropriate, preserving every existing behavior and validating the result against the surrounding architecture before making any change.')
    await writeFile(join(workspace, 'ROUTE.md'), 'The requested change is confined to one reversible local helper.\n', 'utf8')

    expect(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('lattice_')).map(tool => tool.name)).toEqual(['lattice_route'])
    expect((await invoke(agent, 'write', {})).isError).toBe(true)
    expect(writes()).toBe(0)
    const inspected = valueOf(await invoke(agent, 'lattice_route', {
      operation: 'inspect', evidencePaths: ['ROUTE.md'],
    }))
    const probeReceipt = inspected.probeReceipt as { id: string }
    await writeFile(join(workspace, 'ROUTE.md'), 'The route-sensitive ownership boundary changed.\n', 'utf8')
    const stale = await invoke(agent, 'lattice_route', {
      operation: 'resolve', probeReceiptId: probeReceipt.id,
      recommendedLevel: 'bypass', estimatedSteps: 2, executionSpan: 2, productDefinitionGap: 0,
      outcomeCritical: false, evidence: ['One local helper.'], rationale: 'The inspected change is bounded.',
    })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toMatch(/changed|inspect.*again/i)
    await writeFile(join(workspace, 'ROUTE.md'), 'The requested change is confined to one reversible local helper.\n', 'utf8')
    const reinspected = valueOf(await invoke(agent, 'lattice_route', {
      operation: 'inspect', evidencePaths: ['ROUTE.md'],
    }))
    const currentProbeReceipt = reinspected.probeReceipt as { id: string }
    valueOf(await invoke(agent, 'lattice_route', {
      operation: 'resolve', probeReceiptId: currentProbeReceipt.id,
      recommendedLevel: 'bypass', estimatedSteps: 2, executionSpan: 2, productDefinitionGap: 0,
      outcomeCritical: false, evidence: ['Only one local implementation site exists.'], rationale: 'The inspected change is bounded.',
    }))
    expect(ctx.tools.schemas(agent).some(tool => tool.name.startsWith('lattice_'))).toBe(false)
    expect((await invoke(agent, 'write', {})).isError).toBe(false)
  })

  it('loads an authoritative requirements file and routes long execution through the lattice', async () => {
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

    expect(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('lattice_')).map(tool => tool.name)).toEqual(['lattice_route'])
    const inspectResult = await invoke(agent, 'lattice_route', {
      operation: 'inspect', evidencePaths: ['start.md'],
    })
    const inspected = valueOf(inspectResult)
    const probeReceipt = inspected.probeReceipt as { id: string; digest: string; paths: string[] }
    const documents = inspected.documents as Array<{ path: string; digest: string; content: string }>
    const modelVisibleInspect = inspectResult.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    expect(modelVisibleInspect).toContain(`probeReceiptId: ${probeReceipt.id}`)
    expect(modelVisibleInspect).toContain(`evidenceDigest: ${probeReceipt.digest}`)
    expect(modelVisibleInspect).toContain(`evidencePaths: ${probeReceipt.paths.join(', ')}`)
    expect(documents).toHaveLength(1)
    expect(documents[0]?.content).toBe(authoritativeRequirements)
    for (const document of documents) {
      expect(modelVisibleInspect).toContain(
        `--- ROUTE EVIDENCE ${document.path} (sha256:${document.digest}) ---\n${document.content}`,
      )
    }

    const resolveResult = await invoke(agent, 'lattice_route', {
      operation: 'resolve', probeReceiptId: probeReceipt.id,
      recommendedLevel: 'contract', estimatedSteps: 8, executionSpan: 4, productDefinitionGap: 2,
      outcomeCritical: true, evidence: ['The PRD defines multiple implementation obligations.'],
      rationale: 'The authoritative requirements define a long, ambiguity-sensitive implementation.',
    })
    const resolved = valueOf(resolveResult)
    const modelVisibleResolve = resolveResult.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')

    expect((resolved.route as { phase: string }).phase).toBe('lattice')
    expect(modelVisibleResolve).toContain('Route resolved to lattice.')
    expect(modelVisibleResolve).toContain(
      `--- RESOLVED PLAN LATTICE ROUTE ---\n${JSON.stringify(resolved.route, null, 2)}`,
    )
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('lattice_intake')
  })

  it('joins the original request with inspected evidence before deciding critical gaps', async () => {
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

    const inspected = valueOf(await invoke(agent, 'lattice_route', {
      operation: 'inspect', evidencePaths: ['start.md'],
    }))
    const probeReceipt = inspected.probeReceipt as { id: string }
    const resolved = valueOf(await invoke(agent, 'lattice_route', {
      operation: 'resolve', probeReceiptId: probeReceipt.id,
      recommendedLevel: 'contract', estimatedSteps: 10, executionSpan: 5, productDefinitionGap: 4,
      outcomeCritical: true, evidence: ['The file defines a multi-module adapter with unresolved wire policy.'],
      rationale: 'The implementation is long and exact behavior remains definition-sensitive.',
    }))

    expect((resolved.route as { criticalGaps: string[] }).criticalGaps).not.toContain('acceptance')
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
    expect(JSON.stringify(afterReframe.content)).toContain('UNCHANGED AUTHORITATIVE DOCUMENTS')
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
    const { ctx, invoke } = await setup(workspace)
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
    const { ctx, invoke, writes } = await setup(workspace)
    const agent = await makeAgent(ctx, workspace, 'input-review-root')
    sendUser(ctx, agent, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await invoke(agent, 'lattice_intake', framing(6, {
      decisions: ['PostgreSQL is the authoritative case source.'],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'Outcome, scope, authority, truth source, and acceptance are known.',
    })))

    sendUser(ctx, agent, 'continue')
    const firstReview = valueOf(await invoke(agent, 'lattice_review_input', {}))
    expect(JSON.stringify(firstReview.pendingInputs)).toContain('continue')
    const firstReceipt = firstReview.reviewReceipt as { id: string }

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
    const first = await setup(workspace)
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

    const resumed = await setup(workspace)
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
    const first = await setup(workspace)
    const root = await makeAgent(first.ctx, workspace, 'delegated-input-resume-root')
    sendUser(first.ctx, root, 'Build a customer support application. Do not ask questions; make reversible assumptions.')
    valueOf(await first.invoke(root, 'lattice_intake', framing(5)))
    const child = await makeAgent(first.ctx, workspace, 'delegated-input-resume-child', root)
    sendUser(first.ctx, child, 'Change the requirement: archived cases must remain searchable.')
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const resumed = await setup(workspace)
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

  it('requires focused questions when a material reframe introduces new critical gaps', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-critical-reframe-'))
    workspaces.push(workspace)
    const { ctx, invoke } = await setup(workspace)
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
    const denied = await invoke(agent, 'lattice_reframe', framing(5, {
      requestSummary: 'Change the authorization model.',
      questions: [],
    }))

    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/focused clarification/i)
    expect(JSON.stringify(denied.content)).toMatch(/authority|truth-source|acceptance/i)
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
    const reframeContext = valueOf(await invoke(agent, 'lattice_refresh_context', {}))
    const reframeReceipt = reframeContext.receipt as { id: string; revision: number }
    valueOf(await invoke(agent, 'lattice_reframe', {
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

    const reconcileRootContext = valueOf(await invoke(agent, 'lattice_refresh_context', { planNodeId: root.id }))
    const reconcileRootReceipt = reconcileRootContext.receipt as { id: string; revision: number }
    valueOf(await invoke(agent, 'lattice_update', {
      receiptId: reconcileRootReceipt.id,
      expectedRevision: reconcileRootReceipt.revision,
      nodeId: root.id,
      acceptanceCriteria: 'Current and archived support cases are searchable.',
    }))
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

  it('invalidates contract authority for model-free prune and a replacement already present at resume', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-replacement-boundaries-'))
    workspaces.push(workspace)
    const first = await setup(workspace)
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
    expect(JSON.stringify(deniedWithoutBasis.content)).toContain('targetPaths')

    const prepared = await invoke(agent, 'lattice_refresh_context', { targetPaths: ['screen.ts'] })
    expect(JSON.stringify(prepared.content)).toContain('UNCHANGED AUTHORITATIVE DOCUMENTS')
    expect(JSON.stringify(prepared.content)).toMatch(/CONTRACT\.md.*sha256/i)
    expect(JSON.stringify(prepared.content)).not.toContain('PostgreSQL is authoritative')
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
    expect(childTools).toContain('lattice_open')
    expect(childTools).not.toContain('lattice_route')
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(child))
    const policy = prompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text ?? ''
    expect(policy).toContain('Execution capsule')
    expect(policy).toContain('Never question the human directly')
    expect(policy).toContain('Operators can resolve a support case')
    expect(policy).toContain('Implement durable case routing')
    expect(policy).toContain('Every accepted case reaches the authoritative queue exactly once.')
    expect(policy).toContain(node.id)
  })

  it('restores v2 control after restart and treats an existing v1 graph as full lattice without rewriting it', async () => {
    const v2Workspace = await mkdtemp(join(tmpdir(), 'dsh-lattice-resume-v2-'))
    workspaces.push(v2Workspace)
    const first = await setup(v2Workspace)
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

    const resumed = await setup(workspace)
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

    const resumed = await setup(workspace)
    const resumedAgent = await makeAgent(resumed.ctx, workspace, 'empty-interrupted-reframe-root')
    const denied = await resumed.invoke(resumedAgent, 'write', {})
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/reframe|contract changed|material change/i)
    },
  )
})
