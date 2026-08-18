import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
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
  let state

  async function audit(record) {
    await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 })
    await appendFile(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  function snapshot() {
    return state === undefined ? undefined : { ...state, limits: { ...limits } }
  }

  function exhausted() {
    return state.agentRequests >= limits.maxAgentRequests
      || state.inputTokens >= limits.maxInputTokens
      || state.outputTokens >= limits.maxOutputTokens
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
      if (agent && exhausted()) {
        state.budgetRejections += 1
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
      const upstream = transport.request(destination, { method: request.method, headers }, upstreamResponse => {
        const chunks = []
        const responseHeaders = { ...upstreamResponse.headers }
        delete responseHeaders.connection
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.on('data', chunk => {
          chunks.push(chunk)
          response.write(chunk)
        })
        upstreamResponse.once('end', () => {
          let recorded = Promise.resolve()
          if (agent) {
            const usage = responseUsage(chunks)
            state.inputTokens += usage.inputTokens
            state.outputTokens += usage.outputTokens
            if (!usage.observed) state.missingUsageResponses += 1
            recorded = audit({ event: 'agent-response', attemptId, status: upstreamResponse.statusCode ?? 502, usage, snapshot: snapshot() })
          }
          inFlight -= 1
          void recorded.finally(() => response.end())
        })
      })
      upstream.once('error', () => {
        inFlight -= 1
        if (agent) {
          state.missingUsageResponses += 1
          void audit({ event: 'agent-response-error', attemptId, snapshot: snapshot() })
        }
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
        response.end('{"error":"pilot budget proxy upstream failure"}\n')
      })
      upstream.end(body)
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
      if (inFlight !== 0) throw new Error('cannot replace an active pilot budget while a model request is in flight')
      activeAttemptId = attemptId
      state = {
        attemptId,
        agentRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        missingUsageResponses: 0,
        budgetRejections: 0,
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
