import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'plan-lattice-pilot-support'
export const inject = ['agentDefaultModel', 'agents', 'headlessStartup', 'sessions', 'subagents', 'userQuestions']

const MODEL_ID = 'deepseek-v4-flash'
const PROVIDER = 'deepseek-official'
const MAX_TOKENS = 32768
const CLOSED_WORLD_POLICY = 'closed-world-task-requirements'
let questionSequence = 0

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required for the evaluation Oracle`)
  return value
}

function questionDigest(question) {
  return createHash('sha256').update(JSON.stringify({
    id: question.id,
    question: question.question,
    detail: question.detail ?? null,
    options: question.options ?? [],
  })).digest('hex')
}

async function auditQuestions(questions) {
  const path = process.env.DSH_PLAN_LATTICE_ORACLE_AUDIT_PATH
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  for (const question of questions) {
    await appendFile(path, `${JSON.stringify({
      time: new Date().toISOString(),
      sequence: questionSequence += 1,
      questionId: question.id,
      questionDigest: questionDigest(question),
    })}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}

async function auditNativeSubagentStart(info) {
  const path = process.env.DSH_PLAN_LATTICE_NATIVE_SUBAGENT_EVIDENCE_PATH
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify({
    type: 'subagent/start',
    runId: String(info.runId),
    provider: info.provider,
    sessionId: String(info.id),
    local: info.local === true,
  })}\n`, { encoding: 'utf8', mode: 0o600 })
}

function closedWorldAnswer() {
  if (process.env.DSH_PLAN_LATTICE_ORACLE_POLICY !== CLOSED_WORLD_POLICY) {
    throw new Error('unsupported evaluation Oracle policy')
  }
  return 'No additional requirement is available. Preserve every requirement supplied in the current and earlier rounds, and make only reversible assumptions that do not conflict with them.'
}

async function askOracle(question, signal) {
  const endpoint = requiredEnvironment('DSH_PLAN_LATTICE_ORACLE_URL')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${requiredEnvironment('DSH_PLAN_LATTICE_ORACLE_TOKEN')}`,
    },
    body: JSON.stringify({
      question: [question.question, question.detail].filter(Boolean).join('\n\n'),
    }),
    signal,
  })
  if (!response.ok) throw new Error(`Oracle HTTP ${response.status}`)
  const payload = await response.json()
  if (payload?.status?.ok !== true || typeof payload.data !== 'string') {
    throw new Error(`Oracle rejected question: ${String(payload?.status?.error ?? 'invalid response')}`)
  }
  return payload.data
}

function createEvaluationMessage(text, source = { kind: 'user' }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze(source),
  })
}

function latestTurnReason(agent) {
  return agent.session.events.filter(event => event.type === 'turn/end').at(-1)?.data?.reason
}

function recoveryEpoch() {
  const raw = process.env.DSH_PLAN_LATTICE_EVAL_RECOVERY_EPOCH ?? '0'
  if (!/^\d+$/.test(raw)) throw new Error('DSH_PLAN_LATTICE_EVAL_RECOVERY_EPOCH must be a non-negative integer')
  return Number(raw)
}

async function openEvaluationAgent(ctx, sessionId, selection) {
  try {
    return await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
    })
  } catch (error) {
    if (!/not found/i.test(String(error?.message ?? error))) throw error
    return ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
    })
  }
}

async function readStageProtocol() {
  const encoded = process.env.DSH_PLAN_LATTICE_EVAL_STAGE_JSON
  if (!encoded) return undefined
  const stage = JSON.parse(encoded)
  const rawIndex = process.env.DSH_PLAN_LATTICE_EVAL_STAGE_INDEX
  if (!/^\d+$/.test(rawIndex ?? '')) throw new Error('evaluation stage index is missing')
  const index = Number(rawIndex)
  if (!stage || typeof stage.id !== 'string' || stage.id.length === 0
    || (stage.actor !== 'root' && stage.actor !== 'child')
    || (stage.actor === 'root' && (typeof stage.sessionId !== 'string' || stage.sessionId.length === 0))
    || (stage.actor === 'child' && stage.sessionId !== undefined)
    || (stage.source !== 'user' && stage.source !== 'plugin')
    || typeof stage.message !== 'string' || stage.message.trim() === '') {
    throw new Error(`evaluation stage ${index} is malformed: ${JSON.stringify({
      id: stage?.id,
      actor: stage?.actor,
      source: stage?.source,
      sessionId: stage?.sessionId,
      parentSessionId: stage?.parentSessionId,
      messageType: typeof stage?.message,
    })}`)
  }
  return { stage, index }
}

async function runNativeChildStage(sessions, subagents, root, selection, stage) {
  if (stage.parentSessionId !== String(root.session.id)) {
    throw new Error('child stage must name the live evaluation root as parent')
  }
  const signal = new AbortController().signal
  const run = await subagents.start('spawn', {
    label: stage.id,
    prompt: [{ type: 'text', text: stage.message }],
    parent: root,
    signal,
    agentOptions: { provider: selection.provider, model: selection.model },
  })
  if (run.localAgent === undefined) {
    await run.dispose()
    throw new Error('V17 requires the local native spawn provider')
  }
  try {
    const outcome = await run.result
    await sessions.flush(run.localAgent.session)
    return {
      sessionId: String(run.localAgent.session.id),
      outcome,
      reason: latestTurnReason(run.localAgent),
    }
  } finally {
    await run.dispose()
  }
}

async function compactBeforeStage(root, stage, epoch) {
  if (!stage.compactBefore || epoch > 0) return
  const compaction = root.ctx.get('compaction')
  if (compaction === undefined) throw new Error('staged evaluation requires the real Harness compaction service')
  const result = await compaction.compactNow(root, new AbortController().signal)
  if (result === null) throw new Error(`stage ${stage.id} requested compaction but no useful range was compactable`)
}

async function runEvaluationHeadless(ctx, sessionId) {
  await ctx.get('loader')?.await()
  const selection = ctx.agentDefaultModel.currentSelection()
  const handle = await openEvaluationAgent(ctx, sessionId, selection)
  const root = handle.agent
  await root.whenIdle()
  const staged = await readStageProtocol()
  const epoch = recoveryEpoch()
  if (staged !== undefined) await compactBeforeStage(root, staged.stage, epoch)
  if (staged?.stage.actor === 'child') {
    const child = await runNativeChildStage(ctx.sessions, ctx.subagents, root, selection, staged.stage)
    await ctx.sessions.flush(root.session)
    const text = child.outcome.output
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reason = child.reason
    process.stdout.write(`${text}\n`)
    if (reason?.kind === 'error') process.stderr.write(`dsh: ${reason.error.code}: ${reason.error.message}\n`)
    ctx.get('appExit')?.(reason?.kind === 'completed' ? 0 : 1)
    return
  }
  const agent = root
  if (staged !== undefined && staged.stage.sessionId !== String(root.session.id)) {
    throw new Error('root stage session does not match the evaluation root session')
  }
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const priorReason = latestTurnReason(agent)
  if (epoch > 0 && priorReason?.kind === 'completed') {
    await ctx.sessions.flush(agent.session)
    ctx.get('appExit')?.(0)
    return
  }
  const stageMessage = staged?.stage.message ?? ctx.headlessStartup.task
  const stageSource = staged?.stage.source === 'plugin'
    ? { kind: 'plugin', plugin: 'plan-lattice-long-system-protocol' }
    : { kind: 'user' }
  const message = epoch === 0
    ? createEvaluationMessage(stageMessage, stageSource)
    : createEvaluationMessage(
        'Continue the same evaluation attempt from its durable session, workspace, requirements, plan, and evidence. This is infrastructure recovery, not new human authority. Do not resend, reinterpret, or weaken the original task. Use only tools visible in this resumed session, inspect unfinished work and any durable control state, and continue from the first incomplete acceptance criterion without replaying completed side effects.',
        { kind: 'plugin', plugin: 'plan-lattice-pilot-support' },
      )
  agent.followup(message)
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  if (agent !== root) await ctx.sessions.flush(root.session)
  let text = ''
  let reason
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const message = event.data.message
      const content = message?.content ?? event.data.content ?? []
      const joined = content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      if (joined) text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  process.stdout.write(`${text}\n`)
  if (reason?.kind === 'error') process.stderr.write(`dsh: ${reason.error.code}: ${reason.error.message}\n`)
  ctx.get('appExit')?.(reason?.kind === 'completed' ? 0 : 1)
}

export function apply(ctx) {
  ctx.on('agent/request', async (_payload, next) => ({
    ...await next(),
    provider: PROVIDER,
    model: MODEL_ID,
    temperature: 0,
    maxTokens: MAX_TOKENS,
  }))

  if (process.env.DSH_PLAN_LATTICE_ORACLE_URL || process.env.DSH_PLAN_LATTICE_ORACLE_POLICY) {
    ctx.userQuestions.registerProvider({
      async ask(request) {
        await auditQuestions(request.questions)
        const answers = []
        for (const question of request.questions) {
          const custom = process.env.DSH_PLAN_LATTICE_ORACLE_URL
            ? await askOracle(question, request.signal)
            : closedWorldAnswer()
          answers.push({ id: question.id, selected: [], custom })
        }
        return { answers }
      },
    })
  }

  ctx.on('subagent/start', async info => {
    await auditNativeSubagentStart(info)
  })

  const sessionId = process.env.DSH_PLAN_LATTICE_EVAL_SESSION_ID
  if (sessionId) {
    void runEvaluationHeadless(ctx, sessionId).catch((error) => {
      process.stderr.write(`dsh pilot support: ${String(error?.message ?? error)}\n`)
      ctx.get('appExit')?.(1)
    })
  }
}
