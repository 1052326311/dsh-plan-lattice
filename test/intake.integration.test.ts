import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { INTAKE_DOCUMENT_PATH } from '../src/intake.js'

const contexts: Context[] = []

function valueOf(result: Awaited<ReturnType<Context['tools']['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value as Record<string, unknown>
}

function rootAgent(ctx: Context, workspace: string, id: string): Agent {
  const agent = {
    id: id as Agent['id'],
    session: { id, header: { cwd: workspace, delegationDepth: 0 } },
  } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

async function setup(
  workspace: string,
  config: Parameters<typeof apply>[1],
  ask?: (request: AskUserQuestionRequest) => Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>,
): Promise<{ ctx: Context; agent: Agent; invoke: (name: string, args: unknown, actor?: Agent) => ReturnType<Context['tools']['execute']> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  if (ask !== undefined) ctx.userQuestions.registerProvider({ ask })
  apply(ctx, config)
  const agent = rootAgent(ctx, workspace, 'intake-root')
  let call = 0
  return {
    ctx,
    agent,
    invoke: (name, args, actor = agent) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `intake-call-${++call}` as never,
      name,
      arguments: args,
      agent: actor,
    }),
  }
}

function intakeArgs(estimatedSteps = 12) {
  return {
    requestSummary: 'Build a durable release workflow from a sparse request.',
    estimatedSteps,
    systemBoundary: 'This repository and its public release artifacts; no upstream Harness changes.',
    timeHorizon: 'One release cycle.',
    desiredOutcome: 'A reproducible release whose acceptance suite passes.',
    confirmedFacts: ['The repository already builds a portable plugin tarball.'],
    decisions: ['Publish only after clean-install proof passes.'],
    invariants: ['Never publish before the acceptance suite passes.'],
    changeables: ['Implementation order and internal module boundaries.'],
    forces: ['Repository facts may change during a long-running agent session.'],
    keyVariables: ['Acceptance coverage and freshness of project facts.'],
    assumptions: ['The current package format remains supported.'],
    unknowns: ['Which deployment boundary the user intends.'],
    readiness: 'conditional',
    readinessRationale: 'The implementation can stay reversible until the deployment boundary is confirmed.',
    questions: [{
      id: 'deployment-boundary',
      header: 'Boundary',
      question: 'Which deployment boundary should the release support?',
      options: [
        { label: 'Local only', description: 'Keep the proof on one workstation.' },
        { label: 'Public package', description: 'Include clean-install and public artifact proof.' },
      ],
    }],
  }
}

describe('pre-execution intake state machine', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  })

  it('asks through the real interaction seam, confirms the exact contract, and injects it into lattice context', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-guided-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'PRODUCT_CONTRACT_SENTINEL\n', 'utf8')
      const asked: AskUserQuestionRequest[] = []
      const { ctx, invoke } = await setup(workspace, { intakeMode: 'guided', longTaskThreshold: 8 }, async request => {
        asked.push(request)
        if (request.questions[0]?.id === 'deployment-boundary') {
          return { answers: [{ id: 'deployment-boundary', selected: ['Public package'] }] }
        }
        return { answers: [{ id: 'intake-confirm', selected: ['Approve contract'] }] }
      })

      const blocked = await invoke('lattice_open', {
        title: 'Blocked before intake', objective: 'Must not open.', estimatedSteps: 12, contextPaths: ['PRODUCT.md'],
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('requires lattice_intake')

      const intakeResult = await invoke('lattice_intake', intakeArgs())
      expect(intakeResult.isError).toBe(false)
      expect(JSON.stringify(intakeResult.content)).toContain('Public package')
      expect(JSON.stringify(intakeResult.content)).toContain('Directional Forces')
      expect(asked).toHaveLength(2)
      expect(asked[1]?.questions[0]?.intent).toEqual({ kind: 'plan-review', approve: 'Approve contract' })
      const intake = valueOf(intakeResult)
      const receipt = intake.receipt as { id: string; decision: string; estimatedSteps: number }
      expect(receipt).toMatchObject({ decision: 'guided', estimatedSteps: 12 })
      expect(await readFile(join(workspace, INTAKE_DOCUMENT_PATH), 'utf8')).toContain('Public package')

      const openResult = await invoke('lattice_open', {
        title: 'Guided release',
        objective: 'Preserve the confirmed execution contract.',
        estimatedSteps: 12,
        intakeReceiptId: receipt.id,
        contextPaths: ['PRODUCT.md'],
      })
      expect(openResult.isError).toBe(false)
      expect(JSON.stringify(openResult.content)).toContain('Execution Intake Contract')
      expect(JSON.stringify(openResult.content)).toContain('PRODUCT_CONTRACT_SENTINEL')
      expect(JSON.stringify(valueOf(openResult))).toContain(INTAKE_DOCUMENT_PATH)

      const prompt = await ctx.systemPrompt.assemble()
      const policy = prompt.sections.find(section => section.name === 'plan:fractal-ledger')?.text
      expect(policy).toContain('define the boundary and time horizon')
      expect(policy).toContain('Intake policy is guided')
      expect(policy).toContain('8 or more steps')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('persists nothing when the user requests revision and keeps long execution locked', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-revision-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'REVISION_SENTINEL\n', 'utf8')
      const { invoke } = await setup(workspace, { intakeMode: 'guided' }, async request => {
        if (request.questions[0]?.id === 'deployment-boundary') {
          return { answers: [{ id: 'deployment-boundary', selected: ['Local only'] }] }
        }
        return { answers: [{ id: 'intake-confirm', selected: ['Revise contract'], custom: 'Include rollback proof.' }] }
      })

      const rejected = await invoke('lattice_intake', intakeArgs())
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toContain('Include rollback proof')
      await expect(readFile(join(workspace, INTAKE_DOCUMENT_PATH), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      const stillBlocked = await invoke('lattice_open', {
        title: 'Still blocked', objective: 'Must not open.', estimatedSteps: 12, contextPaths: ['PRODUCT.md'],
      })
      expect(stillBlocked.isError).toBe(true)
      expect(JSON.stringify(stillBlocked.content)).toContain('requires lattice_intake')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('lets adaptive users choose autonomous execution with one interaction and explicit assumptions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-autonomous-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'AUTONOMOUS_SENTINEL\n', 'utf8')
      const asked: AskUserQuestionRequest[] = []
      const { invoke } = await setup(workspace, { intakeMode: 'adaptive' }, async request => {
        asked.push(request)
        return { answers: [{ id: 'intake-mode', selected: ['Autonomous execution'] }] }
      })

      const invalidConditional = await invoke('lattice_intake', {
        ...intakeArgs(), questions: [], unknowns: [], readiness: 'conditional',
      })
      expect(invalidConditional.isError).toBe(true)
      expect(JSON.stringify(invalidConditional.content)).toContain('requires at least one explicit unresolved unknown')
      expect(asked).toHaveLength(0)

      const intake = valueOf(await invoke('lattice_intake', { ...intakeArgs(), questions: [] }))
      const receipt = intake.receipt as { id: string; decision: string }
      expect(receipt.decision).toBe('autonomous')
      expect(asked).toHaveLength(1)
      expect(asked[0]?.questions.map(question => question.id)).toEqual(['intake-mode'])
      expect(String(intake.contract)).toContain('The current package format remains supported.')
      expect(String(intake.contract)).toContain('The repository already builds a portable plugin tarball.')
      expect(String(intake.contract)).toContain('Publish only after clean-install proof passes.')
      expect(String(intake.contract)).toContain('No clarification round was requested')

      const open = await invoke('lattice_open', {
        title: 'Autonomous release', objective: 'Proceed from visible assumptions.', estimatedSteps: 12,
        intakeReceiptId: receipt.id, contextPaths: ['PRODUCT.md'],
      })
      expect(open.isError).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('reframes a live graph after material change and preserves nodes for explicit reconciliation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-reframe-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'REFRAME_SENTINEL\n', 'utf8')
      const asked: AskUserQuestionRequest[] = []
      const { invoke } = await setup(workspace, { intakeMode: 'adaptive' }, async request => {
        asked.push(request)
        return { answers: [{ id: 'intake-mode', selected: ['Autonomous execution'] }] }
      })
      const intake = valueOf(await invoke('lattice_intake', { ...intakeArgs(), questions: [] }))
      const intakeReceipt = intake.receipt as { id: string }
      const open = valueOf(await invoke('lattice_open', {
        title: 'Changing release', objective: 'Ship the original target.', estimatedSteps: 12,
        intakeReceiptId: intakeReceipt.id, contextPaths: ['PRODUCT.md'],
      }))
      const openReceipt = open.receipt as { id: string; revision: number }
      const added = valueOf(await invoke('lattice_add', {
        receiptId: openReceipt.id,
        expectedRevision: openReceipt.revision,
        title: 'Original implementation node',
        acceptanceCriteria: 'Satisfy the original target.',
      }))
      const node = added.node as { id: string }
      const beforeReframe = valueOf(await invoke('lattice_refresh_context', {}))
      const oldReceipt = beforeReframe.receipt as { id: string; revision: number }

      const changed = {
        ...intakeArgs(9),
        questions: [],
        requestSummary: 'The public registry changed its artifact policy during execution.',
        desiredOutcome: 'Ship a reproducible release with registry rollback proof.',
        forces: ['The registry now rejects releases without rollback metadata.'],
        assumptions: ['The new rollback metadata format remains stable for this release cycle.'],
      }
      const reframeResult = await invoke('lattice_reframe', {
        receiptId: oldReceipt.id,
        expectedRevision: oldReceipt.revision,
        ...changed,
      })
      expect(reframeResult.isError).toBe(false)
      expect(JSON.stringify(reframeResult.content)).toContain('registry now rejects')
      const reframe = valueOf(reframeResult)
      const reframeReceipt = reframe.receipt as { id: string; revision: number }
      expect(reframeReceipt.revision).toBe(oldReceipt.revision + 1)
      expect((reframe.project as { objective: string }).objective).toContain('rollback proof')
      expect(asked).toHaveLength(2)

      const stale = await invoke('lattice_update', {
        receiptId: oldReceipt.id,
        expectedRevision: oldReceipt.revision,
        nodeId: node.id,
        acceptanceCriteria: 'This stale mutation must not land.',
      })
      expect(stale.isError).toBe(true)

      const reconciled = await invoke('lattice_update', {
        receiptId: reframeReceipt.id,
        expectedRevision: reframeReceipt.revision,
        nodeId: node.id,
        acceptanceCriteria: 'Include registry rollback proof.',
      })
      expect(reconciled.isError).toBe(false)
      const status = valueOf(await invoke('lattice_status', {}))
      expect(JSON.stringify(status)).toContain('Original implementation node')
      expect(JSON.stringify(status)).toContain('Include registry rollback proof')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('binds intake to the exact session, step estimate, and confirmed document digest', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-binding-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'BINDING_SENTINEL\n', 'utf8')
      const { ctx, invoke } = await setup(workspace, { intakeMode: 'adaptive' }, async () => ({
        answers: [{ id: 'intake-mode', selected: ['Autonomous execution'] }],
      }))
      const intake = valueOf(await invoke('lattice_intake', intakeArgs()))
      const receipt = intake.receipt as { id: string }

      const changedEstimate = await invoke('lattice_open', {
        title: 'Wrong estimate', objective: 'Must not open.', estimatedSteps: 13,
        intakeReceiptId: receipt.id, contextPaths: ['PRODUCT.md'],
      })
      expect(changedEstimate.isError).toBe(true)
      expect(JSON.stringify(changedEstimate.content)).toContain('estimatedSteps changed')

      const other = rootAgent(ctx, workspace, 'other-root')
      const otherSession = await invoke('lattice_open', {
        title: 'Wrong session', objective: 'Must not open.', estimatedSteps: 12,
        intakeReceiptId: receipt.id, contextPaths: ['PRODUCT.md'],
      }, other)
      expect(otherSession.isError).toBe(true)
      expect(JSON.stringify(otherSession.content)).toContain('another session')

      await writeFile(join(workspace, INTAKE_DOCUMENT_PATH), '# Tampered contract\n', 'utf8')
      const tampered = await invoke('lattice_open', {
        title: 'Tampered', objective: 'Must not open.', estimatedSteps: 12,
        intakeReceiptId: receipt.id, contextPaths: ['PRODUCT.md'],
      })
      expect(tampered.isError).toBe(true)
      expect(JSON.stringify(tampered.content)).toContain('changed after confirmation')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not force intake below the configured long-task threshold', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-short-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'SHORT_TASK_SENTINEL\n', 'utf8')
      const { invoke } = await setup(workspace, { intakeMode: 'guided', longTaskThreshold: 8 })
      const open = await invoke('lattice_open', {
        title: 'Short task', objective: 'Finish a bounded change.', estimatedSteps: 7, contextPaths: ['PRODUCT.md'],
      })
      expect(open.isError).toBe(false)
      expect(JSON.stringify(open.content)).toContain('SHORT_TASK_SENTINEL')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
