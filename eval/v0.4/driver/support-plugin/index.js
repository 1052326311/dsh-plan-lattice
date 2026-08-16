import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'plan-lattice-eval-support'
export const inject = ['agentDefaultModel', 'agents', 'headlessStartup', 'sessions', 'userQuestions']

const MODEL_ID = 'deepseek-v4-flash'
const PROVIDER = 'deepseek-official'
const MAX_TOKENS = 32768

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
      questionId: question.id,
      questionDigest: questionDigest(question),
    })}\n`, { encoding: 'utf8', mode: 0o600 })
  }
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

async function openEvaluationAgent(ctx, sessionId, selection) {
  const setup = (agentCtx) => {
    const selected = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  try {
    return await ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
  } catch (error) {
    if (!/not found/i.test(String(error?.message ?? error))) throw error
    return ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
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
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: ctx.headlessStartup.task }],
    source: { kind: 'user' },
  }))
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

  if (process.env.DSH_PLAN_LATTICE_ORACLE_URL || process.env.DSH_PLAN_LATTICE_FALLBACK_ANSWER) {
    ctx.userQuestions.registerProvider({
      async ask(request) {
        await auditQuestions(request.questions)
        const answers = []
        for (const question of request.questions) {
          const custom = process.env.DSH_PLAN_LATTICE_ORACLE_URL
            ? await askOracle(question, request.signal)
            : process.env.DSH_PLAN_LATTICE_FALLBACK_ANSWER
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
