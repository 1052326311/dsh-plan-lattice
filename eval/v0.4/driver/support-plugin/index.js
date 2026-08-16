import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'plan-lattice-eval-support'
export const inject = ['agentDefaultModel', 'agents', 'headlessStartup', 'sessions', 'userQuestions']

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

function createEvaluationMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
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

async function runEvaluationHeadless(ctx, sessionId) {
  await ctx.get('loader')?.await()
  const selection = ctx.agentDefaultModel.currentSelection()
  const handle = await openEvaluationAgent(ctx, sessionId, selection)
  const agent = handle.agent
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createEvaluationMessage(ctx.headlessStartup.task))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
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

  const sessionId = process.env.DSH_PLAN_LATTICE_EVAL_SESSION_ID
  if (sessionId) {
    void runEvaluationHeadless(ctx, sessionId).catch((error) => {
      process.stderr.write(`dsh eval support: ${String(error?.message ?? error)}\n`)
      ctx.get('appExit')?.(1)
    })
  }
}
