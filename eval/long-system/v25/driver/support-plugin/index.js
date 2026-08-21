import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

export const name = 'plan-lattice-v25-eval-support'
export const inject = ['agentDefaultModel', 'agents', 'headlessStartup', 'sessions', 'userQuestions']

const MODEL_ID = 'deepseek-v4-flash'
const PROVIDER = 'deepseek-official'
const MAX_TOKENS = 32768
const CLOSED_WORLD_POLICY = 'closed-world-task-requirements'
const MARKER = '@@PLAN_LATTICE_V25@@'
let questionSequence = 0

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
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
  return 'No additional requirement is available. Preserve every still-active requirement from this and earlier rounds. When later authority explicitly corrects or conflicts with an earlier rule, retain the latest rule and retire only the contradicted behavior.'
}

async function askOracle(question, signal) {
  const response = await fetch(requiredEnvironment('DSH_PLAN_LATTICE_ORACLE_URL'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${requiredEnvironment('DSH_PLAN_LATTICE_ORACLE_TOKEN')}`,
    },
    body: JSON.stringify({ question: [question.question, question.detail].filter(Boolean).join('\n\n') }),
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

export function isV25ScorableTerminal(reason) {
  return reason?.kind === 'completed' || reason?.kind === 'max-tokens'
}

async function openEvaluationAgent(ctx, sessionId, selection, allowCreate) {
  try {
    return await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
    })
  } catch (error) {
    if (!allowCreate || !/not found/i.test(String(error?.message ?? error))) throw error
    return ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
    })
  }
}

function readEpochProtocol() {
  const encoded = requiredEnvironment('DSH_PLAN_LATTICE_V25_EPOCH_JSON')
  delete process.env.DSH_PLAN_LATTICE_V25_EPOCH_JSON
  const protocol = JSON.parse(encoded)
  if (protocol?.schemaVersion !== 1
    || !Number.isSafeInteger(protocol.epoch)
    || typeof protocol.rootSessionId !== 'string'
    || !Array.isArray(protocol.stages)
    || protocol.stages.length === 0) {
    throw new Error('V25 epoch protocol is malformed')
  }
  const ids = new Set()
  for (const stage of protocol.stages) {
    if (!stage || !Number.isSafeInteger(stage.index)
      || typeof stage.id !== 'string' || stage.id.length === 0 || ids.has(stage.id)
      || (stage.kind !== 'product' && stage.kind !== 'audit')
      || typeof stage.message !== 'string' || stage.message.trim() === ''
      || typeof stage.revision !== 'string' || stage.revision.length < 8) {
      throw new Error(`V25 stage ${String(stage?.id)} is malformed`)
    }
    ids.add(stage.id)
  }
  return protocol
}

function marker(value) {
  process.stderr.write(`${MARKER}${JSON.stringify(value)}\n`)
}

function createAcknowledgements() {
  const pending = []
  const buffered = new Map()
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  input.on('line', line => {
    let value
    try { value = JSON.parse(line) } catch { return }
    if (value?.type !== 'stage-ack' || typeof value.stageId !== 'string') return
    const index = pending.findIndex(item => item.stageId === value.stageId)
    if (index === -1) buffered.set(value.stageId, value)
    else pending.splice(index, 1)[0].resolve(value)
  })
  return {
    async wait(stageId) {
      const ready = buffered.get(stageId)
      if (ready !== undefined) {
        buffered.delete(stageId)
        return ready
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = pending.findIndex(item => item.stageId === stageId)
          if (index >= 0) pending.splice(index, 1)
          reject(new Error(`timed out waiting for evaluator acknowledgement of ${stageId}`))
        }, 30 * 60 * 1000)
        timer.unref?.()
        pending.push({
          stageId,
          resolve(value) {
            clearTimeout(timer)
            resolve(value)
          },
        })
      })
    },
    close() { input.close() },
  }
}

async function compactAfterStage(ctx, root, stage) {
  if (stage.compactAfter !== true) return
  const compaction = root.ctx.get('compaction')
  if (compaction === undefined) throw new Error('V25 requires the real Harness compaction service')
  const result = await compaction.compactNow(root, new AbortController().signal)
  if (result === null) throw new Error(`stage ${stage.id} requested compaction but no useful range was compactable`)
  await ctx.sessions.flush(root.session)
  marker({ type: 'compaction-complete', stageId: stage.id, revision: stage.revision, sessionId: String(root.session.id) })
}

async function runEvaluationHeadless(ctx, sessionId) {
  await ctx.get('loader')?.await()
  const protocol = readEpochProtocol()
  if (protocol.rootSessionId !== sessionId) throw new Error('V25 epoch does not name the active root session')
  const selection = ctx.agentDefaultModel.currentSelection()
  const handle = await openEvaluationAgent(ctx, sessionId, selection, protocol.epoch === 1)
  const root = handle.agent
  await root.whenIdle()
  const acknowledgements = createAcknowledgements()
  const latestEndSeed = root.session.events.findLast(event => event.type === 'session/end-seed')
  if (protocol.epoch === 1 && latestEndSeed !== undefined) {
    throw new Error('V25 epoch 1 unexpectedly resumed pre-existing Session state')
  }
  if (protocol.epoch > 1 && latestEndSeed === undefined) {
    throw new Error(`V25 epoch ${protocol.epoch} resumed without a durable session/end-seed boundary`)
  }
  marker({
    type: 'epoch-ready',
    epoch: protocol.epoch,
    sessionId: String(root.session.id),
    resumed: latestEndSeed !== undefined,
    firstSeq: latestEndSeed?.seq ?? 0,
    endSeedSeq: latestEndSeed?.seq ?? null,
  })

  try {
    for (const stage of protocol.stages) {
      const firstSeq = root.session.seq
      marker({
        type: 'stage-start',
        epoch: protocol.epoch,
        stageId: stage.id,
        stageIndex: stage.index,
        kind: stage.kind,
        revision: stage.revision,
        firstSeq,
        sessionId: String(root.session.id),
      })
      const message = createEvaluationMessage(stage.message, stage.kind === 'product'
        ? { kind: 'user' }
        : { kind: 'plugin', plugin: 'plan-lattice-v25-eval-support' })
      root.followup(message)
      await root.whenIdle()
      await ctx.sessions.flush(root.session)
      const reason = latestTurnReason(root)
      marker({
        type: 'stage-complete',
        epoch: protocol.epoch,
        stageId: stage.id,
        stageIndex: stage.index,
        kind: stage.kind,
        revision: stage.revision,
        firstSeq,
        lastSeq: root.session.seq,
        sessionId: String(root.session.id),
        terminalReason: reason ?? null,
      })
      if (!isV25ScorableTerminal(reason)) {
        throw new Error(`stage ${stage.id} ended with an unscorable terminal: ${String(reason?.kind ?? 'missing')}`)
      }
      const acknowledgement = await acknowledgements.wait(stage.id)
      if (reason.kind === 'max-tokens') {
        if (acknowledgement.continue !== false) {
          throw new Error(`evaluator attempted to continue after terminal ${stage.id}`)
        }
        await ctx.sessions.flush(root.session)
        marker({
          type: 'attempt-terminal',
          epoch: protocol.epoch,
          stageId: stage.id,
          stageIndex: stage.index,
          kind: stage.kind,
          revision: stage.revision,
          terminalReason: reason,
          sessionId: String(root.session.id),
        })
        marker({
          type: 'epoch-complete',
          epoch: protocol.epoch,
          sessionId: String(root.session.id),
          lastSeq: root.session.events.at(-1)?.seq ?? 0,
          attemptTerminal: true,
        })
        ctx.get('appExit')?.(0)
        return
      }
      if (acknowledgement.continue !== true) throw new Error(`evaluator stopped after ${stage.id}`)
      await compactAfterStage(ctx, root, stage)
    }
    await ctx.sessions.flush(root.session)
    marker({
      type: 'epoch-complete',
      epoch: protocol.epoch,
      sessionId: String(root.session.id),
      lastSeq: root.session.events.at(-1)?.seq ?? 0,
    })
    ctx.get('appExit')?.(0)
  } finally {
    acknowledgements.close()
  }
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
      marker({ type: 'epoch-error', message: String(error?.message ?? error) })
      ctx.get('appExit')?.(1)
    })
  }
}
