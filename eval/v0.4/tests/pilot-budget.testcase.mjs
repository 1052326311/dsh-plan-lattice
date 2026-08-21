import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { budgetSnapshotWithinLimits, startPilotBudgetProxy } from '../../pilots/driver/budget-proxy.mjs'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  server.closeAllConnections?.()
  if (server.listening) await new Promise(resolve => server.close(resolve))
}

test('pilot budget is attempt-scoped and rejects the next agent request after a hard limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-budget-proxy-'))
  let includeUsage = true
  let upstreamStatus = 200
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      if (upstreamStatus === 429) {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"upstream rate limit"}}\n')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(includeUsage
        ? 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
        : 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    })
  })
  const upstreamURL = await listen(upstream)
  const proxy = await startPilotBudgetProxy({
    apiKey: 'fixture-upstream-key',
    baseURL: upstreamURL,
    auditPath: join(root, 'audit.jsonl'),
    limits: { maxAgentRequests: 1, maxInputTokens: 100, maxOutputTokens: 100 },
  })
  const request = () => fetch(`${proxy.hostBaseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${proxy.token}`,
      'x-deepseek-harness-session-id': 'plan-lattice-budget-fixture',
    },
    body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
  })
  try {
    await proxy.activate('budget-attempt-one')
    const accepted = await request()
    assert.equal(accepted.status, 200)
    await accepted.text()
    const rejected = await request()
    assert.equal(rejected.status, 429)
    assert.match(await rejected.text(), /PLAN_LATTICE_BUDGET_EXCEEDED/)
    const firstSnapshot = proxy.snapshot()
    assert.equal(firstSnapshot.attemptId, 'budget-attempt-one')
    assert.equal(firstSnapshot.agentRequests, 1)
    assert.equal(firstSnapshot.inputTokens, 11)
    assert.equal(firstSnapshot.outputTokens, 3)
    assert.equal(firstSnapshot.missingUsageResponses, 0)
    assert.equal(firstSnapshot.budgetRejections, 1)
    assert.equal(firstSnapshot.localBudgetRejections, 1)
    assert.equal(firstSnapshot.upstreamHttp429, 0)
    assert.equal(firstSnapshot.upstreamTransportErrors, 0)
    assert.equal(firstSnapshot.agentRequestSequence, 2)
    assert.equal(firstSnapshot.firstBudgetRejection.attemptId, 'budget-attempt-one')
    assert.equal(firstSnapshot.firstBudgetRejection.sessionId, 'plan-lattice-budget-fixture')
    assert.equal(firstSnapshot.firstBudgetRejection.requestSequence, 2)
    assert.match(firstSnapshot.firstBudgetRejection.terminalId, /^[0-9a-f]{64}$/)
    assert.deepEqual(firstSnapshot.firstBudgetRejection.exhausted, [
      { metric: 'agentRequests', actual: 1, limit: 1 },
    ])
    assert.deepEqual(firstSnapshot.limits, {
      maxAgentRequests: 1, maxInputTokens: 100, maxOutputTokens: 100,
    })
    assert.equal(budgetSnapshotWithinLimits(firstSnapshot), true)

    await proxy.activate('budget-attempt-two')
    const reset = await request()
    assert.equal(reset.status, 200)
    await reset.text()
    assert.equal(proxy.snapshot().agentRequests, 1)
    assert.equal(budgetSnapshotWithinLimits(proxy.snapshot()), true)

    includeUsage = false
    await proxy.activate('budget-attempt-missing-usage')
    const interrupted = await request()
    assert.equal(interrupted.status, 200)
    await interrupted.text()
    assert.equal(proxy.snapshot().missingUsageResponses, 1)
    assert.equal(budgetSnapshotWithinLimits(proxy.snapshot()), false)

    includeUsage = true
    upstreamStatus = 429
    await proxy.activate('budget-upstream-429')
    const rateLimited = await request()
    assert.equal(rateLimited.status, 429)
    await rateLimited.text()
    assert.equal(proxy.snapshot().upstreamHttp429, 1)
    assert.equal(proxy.snapshot().localBudgetRejections, 0)
    assert.equal(proxy.snapshot().firstBudgetRejection, null)
    const audit = await readFile(join(root, 'audit.jsonl'), 'utf8')
    assert.match(audit, /budget-attempt-one/)
    assert.match(audit, /budget-attempt-two/)
    assert.doesNotMatch(audit, /fixture-upstream-key/)
  } finally {
    await proxy.close()
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test('serializes concurrent agent requests so only the first crossing response is retained', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-budget-serial-'))
  let upstreamRequests = 0
  const upstream = http.createServer((request, response) => {
    upstreamRequests += 1
    request.resume()
    request.once('end', () => setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\ndata: [DONE]\n\n')
    }, 30))
  })
  const upstreamURL = await listen(upstream)
  const proxy = await startPilotBudgetProxy({
    apiKey: 'fixture-upstream-key',
    baseURL: upstreamURL,
    auditPath: join(root, 'audit.jsonl'),
    limits: { maxAgentRequests: 1, maxInputTokens: 100, maxOutputTokens: 100 },
  })
  const request = () => fetch(`${proxy.hostBaseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${proxy.token}`,
      'x-deepseek-harness-session-id': 'parallel-session',
    },
    body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
  })
  try {
    await proxy.activate('parallel-attempt')
    const responses = await Promise.all([request(), request()])
    await Promise.all(responses.map(response => response.text()))
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 429])
    assert.equal(upstreamRequests, 1)
    const snapshot = proxy.snapshot()
    assert.equal(snapshot.agentRequests, 1)
    assert.equal(snapshot.agentRequestSequence, 2)
    assert.equal(snapshot.localBudgetRejections, 1)
    assert.equal(snapshot.firstBudgetRejection.requestSequence, 2)
  } finally {
    await proxy.close()
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test('records and releases an upstream response that aborts after headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-budget-abort-'))
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
      setImmediate(() => response.destroy())
    })
  })
  const upstreamURL = await listen(upstream)
  const proxy = await startPilotBudgetProxy({
    apiKey: 'fixture-upstream-key',
    baseURL: upstreamURL,
    auditPath: join(root, 'audit.jsonl'),
    limits: { maxAgentRequests: 5, maxInputTokens: 100, maxOutputTokens: 100 },
  })
  try {
    await proxy.activate('aborted-attempt')
    await assert.rejects(async () => {
      const response = await fetch(`${proxy.hostBaseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${proxy.token}`,
          'x-deepseek-harness-session-id': 'aborted-session',
        },
        body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
      })
      await response.text()
    })
    assert.equal(proxy.snapshot().upstreamTransportErrors, 1)
    assert.equal(proxy.snapshot().missingUsageResponses, 1)
    await proxy.activate('after-abort-attempt')
    assert.equal(proxy.snapshot().upstreamTransportErrors, 0)
  } finally {
    await proxy.close()
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})
