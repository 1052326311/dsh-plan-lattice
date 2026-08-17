#!/usr/bin/env node
import { createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from '../lib/canonical.mjs'

const EXPECTED_AGENT_MODEL = 'deepseek-v4-flash'
const EXPECTED_AGENT_MAX_TOKENS = 32768
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024
const SIGNING_CHAIN_GENESIS = '0'.repeat(64)

function sameToken(left, right) {
  const a = Buffer.from(left ?? '')
  const b = Buffer.from(right ?? '')
  return a.length === b.length && timingSafeEqual(a, b)
}

function upstreamUrl(baseURL, requestPath) {
  const base = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`)
  return new URL(String(requestPath ?? '/').replace(/^\//, ''), base)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_PROXY_BODY_BYTES) {
        reject(new Error('evaluation proxy request exceeded the frozen body limit'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
  })
}

function responseUsage(body) {
  const text = Buffer.concat(body).toString('utf8')
  let usage
  for (const row of text.split(/\r?\n/)) {
    const value = row.startsWith('data:') ? row.slice(5).trim() : row.trim()
    if (!value || value === '[DONE]') continue
    try {
      const parsed = JSON.parse(value)
      if (parsed?.usage) usage = parsed.usage
    } catch {}
  }
  if (!usage) {
    try { usage = JSON.parse(text)?.usage } catch {}
  }
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) return null
  return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
}

export async function startModelProxy({
  apiKey,
  baseURL,
  auditPath,
  signingPrivateKeyBase64,
  signingLedgerPath,
  signingLedgerId,
  executionEnvelopeDigest,
  host = '0.0.0.0',
}) {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('model proxy requires one newline-free API key')
  if (!signingPrivateKeyBase64 || /[\r\n]/.test(signingPrivateKeyBase64)) throw new Error('model proxy requires one base64 Ed25519 signing key')
  const signingKey = createPrivateKey({ key: Buffer.from(signingPrivateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' })
  const signingPublicKeyBase64 = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).toString('base64')
  const signingPublicKeyDigest = sha256(Buffer.from(signingPublicKeyBase64, 'base64'))
  if (!signingLedgerPath || !isAbsolute(signingLedgerPath)) throw new Error('model proxy requires an absolute stateful signing ledger path')
  if (!/^[a-z0-9][a-z0-9._-]{15,127}$/u.test(signingLedgerId ?? '')) throw new Error('model proxy requires a frozen signing ledger identity')
  if (!/^[0-9a-f]{64}$/u.test(executionEnvelopeDigest ?? '')) throw new Error('model proxy requires a frozen execution envelope digest')
  const signingEntries = existsSync(signingLedgerPath)
    ? readFileSync(signingLedgerPath, 'utf8').split(/\r?\n/).filter(Boolean).map(row => JSON.parse(row))
    : []
  let signingHead = SIGNING_CHAIN_GENESIS
  let signingManifestDigest
  const signingAttempts = new Map()
  const signingAttemptIds = new Map()
  for (const entry of signingEntries) {
    if (entry.previousRecordDigest !== signingHead
      || !verify(null, Buffer.from(entry.recordDigest, 'hex'), createPublicKey(signingKey), Buffer.from(entry.signature, 'base64'))
      || entry.signingLedgerId !== signingLedgerId
      || entry.executionEnvelopeDigest !== executionEnvelopeDigest
      || (signingManifestDigest && entry.manifestDigest !== signingManifestDigest)
      || entry.attempt !== (signingAttempts.get(entry.runId) ?? 0) + 1
      || signingAttemptIds.has(entry.attemptId)) {
      throw new Error('stateful result signing ledger failed chain validation')
    }
    signingManifestDigest = entry.manifestDigest
    signingHead = entry.recordDigest
    signingAttempts.set(entry.runId, entry.attempt)
    signingAttemptIds.set(entry.attemptId, entry)
  }
  const parsed = new URL(baseURL)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('model proxy upstream must use HTTP or HTTPS')
  const token = `plan-lattice-${randomBytes(32).toString('hex')}`
  const oracleToken = `plan-lattice-oracle-${randomBytes(32).toString('hex')}`
  const controlToken = `plan-lattice-control-${randomBytes(32).toString('hex')}`
  const upstreamEndpointDigest = sha256(baseURL)
  const auditPathDigest = sha256(auditPath ?? '')
  let sequence = 0
  let activeAttemptId
  const audit = (entry) => {
    if (auditPath) appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  const server = http.createServer((request, response) => {
    void (async () => {
    const pathname = new URL(request.url ?? '/', 'http://evaluation-proxy.invalid').pathname
    if (pathname === '/__plan_lattice_health') {
      if (!sameToken(request.headers['x-plan-lattice-control'], controlToken)) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized evaluation proxy control request"}\n')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(`${JSON.stringify({
        pid: process.pid,
        upstreamEndpointDigest,
        auditPathDigest,
        signingPublicKeyDigest,
        signingLedgerId,
        executionEnvelopeDigest,
      })}\n`)
      return
    }
    if (pathname === '/__plan_lattice_sign') {
      if (!sameToken(request.headers['x-plan-lattice-control'], controlToken)) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized evaluation proxy control request"}\n')
        return
      }
      const payload = JSON.parse((await readBody(request)).toString('utf8'))
      if (!/^[0-9a-f]{64}$/.test(payload.recordDigest ?? '')
        || !/^[0-9a-f]{64}$/.test(payload.previousRecordDigest ?? '')
        || !/^[0-9a-f]{64}$/.test(payload.manifestDigest ?? '')
        || payload.signingLedgerId !== signingLedgerId
        || payload.executionEnvelopeDigest !== executionEnvelopeDigest
        || typeof payload.attemptId !== 'string'
        || typeof payload.runId !== 'string'
        || !Number.isSafeInteger(payload.attempt)) {
        throw new Error('result signer requires a complete record identity')
      }
      const existing = signingAttemptIds.get(payload.attemptId)
      if (existing) {
        if (existing.recordDigest !== payload.recordDigest
          || existing.runId !== payload.runId
          || existing.attempt !== payload.attempt
          || existing.manifestDigest !== payload.manifestDigest
          || existing.previousRecordDigest !== payload.previousRecordDigest
          || existing.signingLedgerId !== payload.signingLedgerId
          || existing.executionEnvelopeDigest !== payload.executionEnvelopeDigest) {
          throw new Error('result signer attempt ID was reused for different content')
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ signature: existing.signature })}\n`)
        return
      }
      if (payload.previousRecordDigest !== signingHead
        || (signingManifestDigest && payload.manifestDigest !== signingManifestDigest)
        || payload.attempt !== (signingAttempts.get(payload.runId) ?? 0) + 1) {
        throw new Error('result signer rejected a stale chain head or non-contiguous attempt')
      }
      const signature = sign(null, Buffer.from(payload.recordDigest, 'hex'), signingKey).toString('base64')
      const entry = {
        schemaVersion: 1,
        attemptId: payload.attemptId,
        runId: payload.runId,
        attempt: payload.attempt,
        signingLedgerId,
        executionEnvelopeDigest,
        manifestDigest: payload.manifestDigest,
        previousRecordDigest: payload.previousRecordDigest,
        recordDigest: payload.recordDigest,
        signature,
      }
      const descriptor = openSync(signingLedgerPath, 'a', 0o600)
      try {
        writeSync(descriptor, `${JSON.stringify(entry)}\n`)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      signingManifestDigest = payload.manifestDigest
      signingHead = payload.recordDigest
      signingAttempts.set(payload.runId, payload.attempt)
      signingAttemptIds.set(payload.attemptId, entry)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(`${JSON.stringify({ signature })}\n`)
      return
    }
    if (pathname === '/__plan_lattice_attempt') {
      if (!sameToken(request.headers['x-plan-lattice-control'], controlToken)) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized evaluation proxy control request"}\n')
        return
      }
      const payload = JSON.parse((await readBody(request)).toString('utf8'))
      if (payload.attemptId !== null && (typeof payload.attemptId !== 'string' || payload.attemptId.length < 8)) {
        throw new Error('evaluation proxy attempt binding is invalid')
      }
      activeAttemptId = payload.attemptId ?? undefined
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}\n')
      return
    }
    const authorization = request.headers.authorization ?? ''
    const role = sameToken(authorization, `Bearer ${token}`)
      ? 'agent'
      : sameToken(authorization, `Bearer ${oracleToken}`)
        ? 'oracle'
        : undefined
    if (role === undefined) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"unauthorized evaluation proxy request"}\n')
      return
    }
    if (!activeAttemptId) {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end('{"error":"no active frozen evaluation attempt"}\n')
      return
    }
    // An attempt can be unbound as soon as the driver process exits. Keep the
    // identity that authorized this request stable until its response is
    // audited, even if another attempt is selected in the meantime.
    const requestAttemptId = activeAttemptId
    const body = await readBody(request)
    let requestPayload
    try { requestPayload = JSON.parse(body.toString('utf8')) } catch {}
    const sessionId = request.headers['x-deepseek-harness-session-id'] ?? null
    const contractValid = role !== 'agent' || (
      request.method === 'POST'
      && pathname.endsWith('/chat/completions')
      && requestPayload?.model === EXPECTED_AGENT_MODEL
      && requestPayload?.temperature === 0
      && requestPayload?.max_tokens === EXPECTED_AGENT_MAX_TOKENS
      && requestPayload?.stream === true
      && requestPayload?.stream_options?.include_usage === true
      && typeof sessionId === 'string'
      && sessionId.startsWith('plan-lattice-')
    )
    sequence += 1
    const requestSequence = sequence
    audit({
      event: 'request',
      sequence: requestSequence,
      attemptId: requestAttemptId,
      role,
      method: request.method,
      path: request.url,
      sessionId,
      compact: request.headers['x-deepseek-harness-compact'] === '1',
      bodyDigest: sha256(body),
      contractValid,
      model: requestPayload?.model ?? null,
      temperature: requestPayload?.temperature ?? null,
      maxTokens: requestPayload?.max_tokens ?? null,
    })
    if (!contractValid) {
      audit({ event: 'response', sequence: requestSequence, attemptId: requestAttemptId, role, status: 400, usage: null })
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end('{"error":"agent request violates the frozen model contract"}\n')
      return
    }
    const destination = upstreamUrl(baseURL, request.url)
    const headers = { ...request.headers, host: destination.host, authorization: `Bearer ${apiKey}` }
    delete headers.connection
    delete headers['proxy-authorization']
    delete headers['x-plan-lattice-control']
    headers['content-length'] = String(body.length)
    const transport = destination.protocol === 'https:' ? https : http
    let responseAudited = false
    const auditResponse = (status, usage) => {
      if (responseAudited) return
      responseAudited = true
      audit({ event: 'response', sequence: requestSequence, attemptId: requestAttemptId, role, status, usage })
    }
    const upstream = transport.request(destination, {
      method: request.method,
      headers,
    }, (upstreamResponse) => {
      const responseBody = []
      const responseHeaders = { ...upstreamResponse.headers }
      delete responseHeaders.connection
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      upstreamResponse.on('data', (chunk) => {
        responseBody.push(chunk)
        response.write(chunk)
      })
      upstreamResponse.once('end', () => {
        auditResponse(upstreamResponse.statusCode ?? 502, responseUsage(responseBody))
        response.end()
      })
    })
    upstream.on('error', () => {
      auditResponse(502, null)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end('{"error":"evaluation model proxy upstream failure"}\n')
    })
    upstream.end(body)
    })().catch((error) => {
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
  if (typeof address !== 'object' || address === null) throw new Error('model proxy did not allocate a TCP port')
  return {
    server,
    token,
    oracleToken,
    controlToken,
    signingPublicKeyBase64,
    signingLedgerId,
    executionEnvelopeDigest,
    hostBaseURL: `http://127.0.0.1:${address.port}`,
    dockerBaseURL: `http://host.docker.internal:${address.port}`,
    upstreamEndpointDigest,
  }
}

async function readConfiguration() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const lines = input.split(/\r?\n/)
  return {
    baseURL: lines[0],
    apiKey: lines[1],
    auditPath: lines[2],
    signingPrivateKeyBase64: lines[3],
    signingLedgerPath: lines[4],
    signingLedgerId: lines[5],
    executionEnvelopeDigest: lines[6],
  }
}

async function main() {
  const proxy = await startModelProxy(await readConfiguration())
  process.stdout.write(`READY\t${proxy.hostBaseURL}\t${proxy.dockerBaseURL}\t${proxy.token}\t${proxy.oracleToken}\t${proxy.controlToken}\t${proxy.upstreamEndpointDigest}\t${proxy.signingPublicKeyBase64}\n`)
  const close = () => proxy.server.close(() => process.exit(0))
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`model proxy startup failed: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
