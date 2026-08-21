import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname } from 'node:path'

const MAX_BODY_BYTES = 16 * 1024 * 1024

function sameToken(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) reject(new Error('pilot budget proxy request exceeded body limit'))
      else chunks.push(chunk)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
  })
}

function responseUsage(chunks) {
  const text = Buffer.concat(chunks).toString('utf8')
  let usage
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data)
      if (parsed?.usage) usage = parsed.usage
    } catch {}
  }
  const inputTokens = Number(usage?.prompt_tokens)
  const outputTokens = Number(usage?.completion_tokens)
  const observed = Number.isSafeInteger(inputTokens) && inputTokens >= 0
    && Number.isSafeInteger(outputTokens) && outputTokens >= 0
  return {
    observed,
    inputTokens: observed ? inputTokens : 0,
    outputTokens: observed ? outputTokens : 0,
  }
}

export function budgetSnapshotWithinLimits(snapshot) {
  if (snapshot === undefined || snapshot === null || snapshot.limits === undefined) return false
  return snapshot.missingUsageResponses === 0
    && snapshot.agentRequests <= snapshot.limits.maxAgentRequests
    && snapshot.inputTokens <= snapshot.limits.maxInputTokens
    && snapshot.outputTokens <= snapshot.limits.maxOutputTokens
}

export async function startPilotBudgetProxy({ apiKey, baseURL, auditPath, limits, host = '127.0.0.1' }) {
  if (!apiKey) throw new Error('pilot budget proxy requires an upstream API key')
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`pilot budget ${name} must be a positive integer`)
  }
  const token = `plan-lattice-budget-${randomBytes(32).toString('hex')}`
  let activeAttemptId
  let inFlight = 0
  let queuedAgentRequests = 0
  let agentQueue = Promise.resolve()
  let state

  async function audit(record) {
    await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 })
    const handle = await open(auditPath, 'a', 0o600)
    try {
      await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const directory = await open(dirname(auditPath), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  function snapshot() {
    return state === undefined ? undefined : {
        ...state,
        firstBudgetRejection: state.firstBudgetRejection === null
          ? null
          : JSON.parse(JSON.stringify(state.firstBudgetRejection)),
        limits: { ...limits },
      }
  }

  function exhaustedDimensions() {
    return [
      ['agentRequests', 'maxAgentRequests'],
      ['inputTokens', 'maxInputTokens'],
      ['outputTokens', 'maxOutputTokens'],
    ].flatMap(([metric, limitName]) => state[metric] >= limits[limitName]
      ? [{ metric, actual: state[metric], limit: limits[limitName] }]
      : [])
  }

  function exhausted() {
    return state.agentRequests >= limits.maxAgentRequests
      || state.inputTokens >= limits.maxInputTokens
      || state.outputTokens >= limits.maxOutputTokens
  }

  async function serializeAgentRequest(agent, operation) {
    if (!agent) return operation()
    queuedAgentRequests += 1
    const predecessor = agentQueue
    let release
    agentQueue = new Promise(resolve => { release = resolve })
    await predecessor
    try {
      return await operation()
    } finally {
      queuedAgentRequests -= 1
      release()
    }
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!sameToken(request.headers.authorization ?? '', `Bearer ${token}`)) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized pilot budget proxy request"}\n')
        return
      }
      if (!activeAttemptId || state === undefined) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end('{"error":"no active pilot budget"}\n')
        return
      }
      const body = await readBody(request)
      let payload
      try { payload = JSON.parse(body.toString('utf8')) } catch {}
      const agent = typeof request.headers['x-deepseek-harness-session-id'] === 'string'
        && payload?.model === 'deepseek-v4-flash'
      await serializeAgentRequest(agent, async () => {
        if (!activeAttemptId || state === undefined) {
          response.writeHead(409, { 'content-type': 'application/json' })
          response.end('{"error":"pilot budget changed while request was queued"}\n')
          return
        }
        if (agent) state.agentRequestSequence += 1
        if (agent && exhausted()) {
          state.budgetRejections += 1
          state.localBudgetRejections += 1
          if (state.firstBudgetRejection === null) {
            const sessionId = request.headers['x-deepseek-harness-session-id']
            const exhausted = exhaustedDimensions()
            const terminalId = createHash('sha256').update(JSON.stringify({
              attemptId: activeAttemptId,
              sessionId,
              requestSequence: state.agentRequestSequence,
              agentRequests: state.agentRequests,
              inputTokens: state.inputTokens,
              outputTokens: state.outputTokens,
              exhausted,
            })).digest('hex')
            state.firstBudgetRejection = {
              terminalId,
              attemptId: activeAttemptId,
              sessionId,
              requestSequence: state.agentRequestSequence,
              exhausted,
              acceptedSnapshot: {
                agentRequests: state.agentRequests,
                inputTokens: state.inputTokens,
                outputTokens: state.outputTokens,
                missingUsageResponses: state.missingUsageResponses,
              },
            }
          }
          await audit({ event: 'budget-rejected', attemptId: activeAttemptId, snapshot: snapshot() })
          response.writeHead(429, { 'content-type': 'application/json' })
          response.end(`${JSON.stringify({ error: { code: 'PLAN_LATTICE_BUDGET_EXCEEDED', message: 'preregistered pilot budget exhausted' } })}\n`)
          return
        }

        if (agent) state.agentRequests += 1
        inFlight += 1
        const attemptId = activeAttemptId
        const destination = new URL(request.url, baseURL.endsWith('/') ? baseURL : `${baseURL}/`)
        const headers = { ...request.headers, host: destination.host, authorization: `Bearer ${apiKey}` }
        delete headers.connection
        headers['content-length'] = String(body.length)
        const transport = destination.protocol === 'https:' ? https : http
        try {
          await new Promise((resolveForward, rejectForward) => {
            let settled = false
            const chunks = []
            const settle = (kind, upstreamResponse) => {
              if (settled) return
              settled = true
              void (async () => {
                if (kind === 'complete') {
                  if (agent) {
                    const usage = responseUsage(chunks)
                    if (upstreamResponse.statusCode === 429) state.upstreamHttp429 += 1
                    state.inputTokens += usage.inputTokens
                    state.outputTokens += usage.outputTokens
                    if (!usage.observed) state.missingUsageResponses += 1
                    await audit({
                      event: 'agent-response', attemptId,
                      status: upstreamResponse.statusCode ?? 502, usage, snapshot: snapshot(),
                    })
                  }
                  response.end()
                  return
                }
                if (agent) {
                  state.upstreamTransportErrors += 1
                  state.missingUsageResponses += 1
                  await audit({ event: 'agent-response-error', attemptId, phase: kind, snapshot: snapshot() })
                }
                if (!response.headersSent) {
                  response.writeHead(502, { 'content-type': 'application/json' })
                  response.end('{"error":"pilot budget proxy upstream failure"}\n')
                } else {
                  response.destroy()
                }
              })().then(resolveForward, rejectForward)
            }
            const upstream = transport.request(destination, { method: request.method, headers }, upstreamResponse => {
              const responseHeaders = { ...upstreamResponse.headers }
              delete responseHeaders.connection
              response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
              upstreamResponse.on('data', chunk => {
                chunks.push(chunk)
                response.write(chunk)
              })
              upstreamResponse.once('end', () => settle('complete', upstreamResponse))
              upstreamResponse.once('aborted', () => settle('response-aborted', upstreamResponse))
              upstreamResponse.once('error', () => settle('response-error', upstreamResponse))
              upstreamResponse.once('close', () => {
                if (!upstreamResponse.complete) settle('response-close-before-complete', upstreamResponse)
              })
            })
            upstream.once('error', () => settle('request-error'))
            upstream.end(body)
          })
        } finally {
          inFlight -= 1
        }
      })
    })().catch(error => {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' })
      response.end(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('pilot budget proxy did not bind')
  return {
    token,
    hostBaseURL: `http://${host}:${address.port}`,
    async activate(attemptId) {
      if (inFlight !== 0 || queuedAgentRequests !== 0) {
        throw new Error('cannot replace an active pilot budget while a model request is pending')
      }
      activeAttemptId = attemptId
      agentQueue = Promise.resolve()
      state = {
        attemptId,
        agentRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        missingUsageResponses: 0,
        budgetRejections: 0,
        localBudgetRejections: 0,
        upstreamHttp429: 0,
        upstreamTransportErrors: 0,
        agentRequestSequence: 0,
        firstBudgetRejection: null,
      }
      await audit({ event: 'budget-activated', attemptId, limits })
    },
    snapshot,
    async close() {
      activeAttemptId = undefined
      server.closeAllConnections?.()
      if (server.listening) await new Promise(resolve => server.close(resolve))
    },
  }
}
