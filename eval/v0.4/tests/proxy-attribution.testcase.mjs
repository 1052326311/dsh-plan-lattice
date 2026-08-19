import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startModelProxy } from '../../long-system/driver/model-proxy.mjs'

const signingLedgerId = 'plan-lattice-rc4-proxy-test'
const executionEnvelopeDigest = 'e'.repeat(64)

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  if (!server.listening) return
  await new Promise(resolve => server.close(resolve))
}

async function bindAttempt(proxy, attemptId) {
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify({ attemptId }),
  })
  assert.equal(response.status, 200)
}

function agentRequest(proxy) {
  return fetch(`${proxy.hostBaseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.token}`,
      'content-type': 'application/json',
      'x-deepseek-harness-session-id': 'plan-lattice-attribution-test',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      temperature: 0,
      max_tokens: 32768,
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
}

test('proxy response keeps the attempt identity captured when its request began', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-proxy-attribution-'))
  let releaseResponse
  let requestObserved
  const observed = new Promise(resolve => { requestObserved = resolve })
  const upstream = http.createServer((_request, response) => {
    requestObserved()
    releaseResponse = () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"usage":{"prompt_tokens":9,"completion_tokens":4}}')
    }
  })
  const baseURL = await listen(upstream)
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: 'test-upstream-secret',
    baseURL,
    auditPath: join(root, 'audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'signing.jsonl'),
    signingLedgerId,
    executionEnvelopeDigest,
  })
  try {
    await bindAttempt(proxy, 'attempt-original')
    const pending = agentRequest(proxy)
    await observed
    await bindAttempt(proxy, 'attempt-next')
    releaseResponse()
    const response = await pending
    assert.equal(response.status, 200)
    await response.text()

    const rows = (await readFile(join(root, 'audit.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
    const request = rows.find(row => row.event === 'request')
    const result = rows.find(row => row.event === 'response')
    assert.equal(request.attemptId, 'attempt-original')
    assert.equal(result.attemptId, 'attempt-original')
    assert.equal(result.sequence, request.sequence)
    assert.deepEqual(result.usage, { promptTokens: 9, completionTokens: 4 })
  } finally {
    await close(proxy.server)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test('proxy emits a response audit row for a rejected frozen-contract request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-proxy-rejection-'))
  const upstream = http.createServer((_request, response) => response.end('{}'))
  const baseURL = await listen(upstream)
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: 'test-upstream-secret',
    baseURL,
    auditPath: join(root, 'audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'signing.jsonl'),
    signingLedgerId,
    executionEnvelopeDigest,
  })
  try {
    await bindAttempt(proxy, 'attempt-rejected')
    const response = await fetch(`${proxy.hostBaseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.token}`,
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'plan-lattice-attribution-test',
      },
      body: JSON.stringify({ model: 'wrong-model' }),
    })
    assert.equal(response.status, 400)
    const rows = (await readFile(join(root, 'audit.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => [row.event, row.sequence, row.attemptId, row.role, row.status]), [
      ['request', 1, 'attempt-rejected', 'agent', undefined],
      ['response', 1, 'attempt-rejected', 'agent', 400],
    ])
  } finally {
    await close(proxy.server)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test('proxy accepts native DSH child UUID sessions and rejects unrelated ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-proxy-native-child-'))
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
    })
  })
  const baseURL = await listen(upstream)
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: 'test-upstream-secret',
    baseURL,
    auditPath: join(root, 'audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'signing.jsonl'),
    signingLedgerId,
    executionEnvelopeDigest,
  })
  const request = sessionId => fetch(`${proxy.hostBaseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.token}`,
      'content-type': 'application/json',
      'x-deepseek-harness-session-id': sessionId,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      temperature: 0,
      max_tokens: 32768,
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  try {
    await bindAttempt(proxy, 'attempt-native-child')
    const child = await request('a310a3c4-cf9c-43cc-b99e-cb730da4bc03')
    assert.equal(child.status, 200)
    await child.text()
    const unrelated = await request('unattributed-child')
    assert.equal(unrelated.status, 400)

    const rows = (await readFile(join(root, 'audit.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.deepEqual(rows.filter(row => row.event === 'request').map(row => [row.sessionId, row.contractValid]), [
      ['a310a3c4-cf9c-43cc-b99e-cb730da4bc03', true],
      ['unattributed-child', false],
    ])
  } finally {
    await close(proxy.server)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test('proxy accepts only the exact official Harness compaction envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-proxy-compaction-'))
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"summary"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
    })
  })
  const baseURL = await listen(upstream)
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: 'test-upstream-secret',
    baseURL,
    auditPath: join(root, 'audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'signing.jsonl'),
    signingLedgerId,
    executionEnvelopeDigest,
  })
  try {
    await bindAttempt(proxy, 'attempt-compaction')
    const request = body => fetch(`${proxy.hostBaseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.token}`,
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'plan-lattice-compaction-test',
        'x-deepseek-harness-compact': '1',
      },
      body: JSON.stringify(body),
    })
    const accepted = await request({
      model: 'deepseek-v4-flash', max_tokens: 8192, stream: true, stream_options: { include_usage: true },
    })
    assert.equal(accepted.status, 200)
    await accepted.text()
    const wrongTemperature = await request({
      model: 'deepseek-v4-flash', temperature: 0, max_tokens: 8192, stream: true, stream_options: { include_usage: true },
    })
    assert.equal(wrongTemperature.status, 400)
    const wrongLimit = await request({
      model: 'deepseek-v4-flash', max_tokens: 32768, stream: true, stream_options: { include_usage: true },
    })
    assert.equal(wrongLimit.status, 400)
    const rows = (await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.deepEqual(rows.filter(row => row.event === 'request').map(row => [row.compact, row.contractValid, row.maxTokens]), [
      [true, true, 8192],
      [true, false, 8192],
      [true, false, 32768],
    ])
  } finally {
    await close(proxy.server)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})
