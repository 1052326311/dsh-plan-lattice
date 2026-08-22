import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startModelProxy } from '../../driver/model-proxy.mjs'
import { canonicalJson, sha256 } from '../../../v0.4/lib/canonical.mjs'

function rawRequest(url, path, headers, body) {
  const endpoint = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      method: 'POST',
      path,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

test('schema-v3 signer authenticates the public manifest commit and complete attempt envelope', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-proxy-signing-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const executionEnvelopeDigest = 'e'.repeat(64)
  const proxy = await startModelProxy({
    apiKey: 'fixture-upstream-key',
    baseURL: 'https://example.invalid',
    signingPrivateKeyBase64: privateKey,
    signingLedgerPath: join(root, 'ledger.jsonl'),
    signingLedgerId: 'plan-lattice-v28-signing-fixture',
    executionEnvelopeDigest,
    signingSchemaVersion: 3,
    host: '127.0.0.1',
  })
  context.after(async () => {
    proxy.server.closeAllConnections?.()
    if (proxy.server.listening) await new Promise(resolve => proxy.server.close(resolve))
  })

  const body = {
    schemaVersion: 3,
    attemptId: 'fixture-attempt',
    runId: 'fixture-run',
    ordinal: 1,
    signingLedgerId: proxy.signingLedgerId,
    executionEnvelopeDigest,
    manifestDigest: 'f'.repeat(64),
    manifestCommit: 'd'.repeat(40),
    previousRecordDigest: '0'.repeat(64),
    recordDigest: 'a'.repeat(64),
  }
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  const signed = await response.json()
  assert.equal(signed.signaturePayloadDigest, sha256(canonicalJson(body)))
  assert.equal(verify(
    null,
    Buffer.from(signed.signaturePayloadDigest, 'hex'),
    keys.publicKey,
    Buffer.from(signed.signature, 'base64'),
  ), true)
  const ledger = JSON.parse((await readFile(join(root, 'ledger.jsonl'), 'utf8')).trim())
  assert.equal(ledger.schemaVersion, 3)
  assert.deepEqual(ledger.body, body)

  for (const field of ['manifestDigest', 'manifestCommit', 'executionEnvelopeDigest', 'ordinal', 'previousRecordDigest']) {
    const altered = structuredClone(body)
    altered[field] = field === 'ordinal'
      ? 2
      : field === 'manifestCommit'
        ? 'b'.repeat(40)
        : 'b'.repeat(64)
    const rejected = await fetch(`${proxy.hostBaseURL}/__plan_lattice_sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
      body: JSON.stringify(altered),
    })
    assert.equal(rejected.status, 400)
  }

  proxy.server.closeAllConnections?.()
  await new Promise(resolve => proxy.server.close(resolve))
  const resumed = await startModelProxy({
    apiKey: 'fixture-upstream-key',
    baseURL: 'https://example.invalid',
    signingPrivateKeyBase64: privateKey,
    signingLedgerPath: join(root, 'ledger.jsonl'),
    signingLedgerId: 'plan-lattice-v28-signing-fixture',
    executionEnvelopeDigest,
    signingSchemaVersion: 3,
    host: '127.0.0.1',
  })
  context.after(async () => {
    resumed.server.closeAllConnections?.()
    if (resumed.server.listening) await new Promise(resolve => resumed.server.close(resolve))
  })
  const nextBody = {
    ...body,
    attemptId: 'fixture-attempt-2',
    ordinal: 2,
    previousRecordDigest: signed.signaturePayloadDigest,
    recordDigest: 'c'.repeat(64),
  }
  const resumedResponse = await fetch(`${resumed.hostBaseURL}/__plan_lattice_sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': resumed.controlToken },
    body: JSON.stringify(nextBody),
  })
  assert.equal(resumedResponse.status, 200)
})

test('schema-v2 signer remains compatible without a public manifest commit', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-proxy-v2-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: 'fixture-upstream-key',
    baseURL: 'https://example.invalid',
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'ledger.jsonl'),
    signingLedgerId: 'plan-lattice-v28-v2-compatibility',
    executionEnvelopeDigest: 'e'.repeat(64),
    signingSchemaVersion: 2,
    host: '127.0.0.1',
  })
  context.after(async () => {
    proxy.server.closeAllConnections?.()
    if (proxy.server.listening) await new Promise(resolve => proxy.server.close(resolve))
  })
  const body = {
    schemaVersion: 2,
    attemptId: 'fixture-v2-attempt',
    runId: 'fixture-v2-run',
    ordinal: 1,
    signingLedgerId: proxy.signingLedgerId,
    executionEnvelopeDigest: 'e'.repeat(64),
    manifestDigest: 'f'.repeat(64),
    previousRecordDigest: '0'.repeat(64),
    recordDigest: 'a'.repeat(64),
  }
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  const ledger = JSON.parse((await readFile(join(root, 'ledger.jsonl'), 'utf8')).trim())
  assert.equal(ledger.schemaVersion, 2)
  assert.deepEqual(ledger.body, body)
})

test('model proxy rejects an absolute-form model target before forwarding', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-proxy-path-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const upstream = http.createServer((_request, response) => {
    response.writeHead(500)
    response.end()
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  context.after(async () => {
    upstream.closeAllConnections?.()
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve))
  })
  const upstreamAddress = upstream.address()
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: 'fixture-upstream-key',
    baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
    auditPath: join(root, 'model-audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'ledger.jsonl'),
    signingLedgerId: 'plan-lattice-v28-path-fixture',
    executionEnvelopeDigest: 'e'.repeat(64),
    signingSchemaVersion: 3,
    host: '127.0.0.1',
  })
  context.after(async () => {
    proxy.server.closeAllConnections?.()
    if (proxy.server.listening) await new Promise(resolve => proxy.server.close(resolve))
  })
  const activated = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify({ attemptId: 'fixture-path-attempt' }),
  })
  assert.equal(activated.status, 200)
  const body = JSON.stringify({
    model: 'deepseek-v4-flash',
    temperature: 0,
    max_tokens: 32768,
    stream: true,
    stream_options: { include_usage: true },
  })
  const rejected = await rawRequest(
    proxy.hostBaseURL,
    'https://escape.invalid/chat/completions',
    {
      authorization: `Bearer ${proxy.token}`,
      'content-type': 'application/json',
      'x-deepseek-harness-session-id': 'plan-lattice-path-fixture',
    },
    body,
  )
  assert.equal(rejected.status, 400)
  assert.match(rejected.body, /frozen model contract/)
  const audit = (await readFile(join(root, 'model-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(audit[0].path, 'https://escape.invalid/chat/completions')
  assert.equal(audit[0].contractValid, false)
  assert.equal(audit[1].status, 400)
})
