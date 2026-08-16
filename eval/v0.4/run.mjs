#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, readJson, sha256 } from './lib/canonical.mjs'
import {
  RESULT_CHAIN_GENESIS,
  canonicalRecord,
  digestAttemptArtifacts,
  digestResultRecord,
  renderControllerReceipt,
  verifyAttemptReceipts,
} from './lib/attempt-integrity.mjs'
import { buildManifest } from './lib/design.mjs'
import { assertCandidateCheckout, driverSourceDigest, verifyProtocolChecksums } from './lib/integrity.mjs'
import { readJsonLines, resolveEvaluationSlots } from './lib/results.mjs'
import { assertNoSecrets, validateBenchmarkLock, validateDriverPayload, validateManifest, validatePreregistration } from './lib/validation.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const arguments_ = process.argv.slice(2)
const has = (name) => arguments_.includes(name)
const option = (name) => {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}
const preregistration = await readJson(join(root, 'preregistration.json'))
const manifest = await readJson(join(root, 'frozen-manifest.json'))
const benchmarkLock = await readJson(join(root, 'benchmark-lock.json'))
const simpleTasks = await readJson(join(root, 'simple-tasks.json'))
const runtimeArtifacts = await readJson(join(root, 'runtime-artifacts.json'))
const routerBlindResult = await readJson(join(root, '..', 'router-corpus', 'blind-real-results.json'))
validatePreregistration(preregistration, { executionReady: has('--execute') })
validateBenchmarkLock(benchmarkLock)
validateManifest(manifest)
await verifyProtocolChecksums()
const currentDriverDigest = await driverSourceDigest()
const deterministicManifest = buildManifest(preregistration, benchmarkLock, simpleTasks, runtimeArtifacts, routerBlindResult, currentDriverDigest)
if (canonicalJson(deterministicManifest) !== canonicalJson(manifest)) throw new Error('frozen manifest differs from the current deterministic protocol')

const allRuns = [...manifest.infrastructureRuns, ...manifest.statisticalRuns]
const requestedRun = option('--run-id')
const phase = option('--phase')
let selected = allRuns.filter((run) => (!requestedRun || run.runId === requestedRun) && (!phase || run.phase === phase))
if (requestedRun && selected.length !== 1) throw new Error(`unknown run ID: ${requestedRun}`)
if (phase && !['infrastructure', 'statistical'].includes(phase)) throw new Error('--phase must be infrastructure or statistical')

if (!has('--execute')) {
  const summary = {
    mode: 'dry-run',
    paidModelInvocations: 0,
    manifestDigest: manifest.manifestDigest,
    selectedRuns: selected.length,
    counts: Object.fromEntries(['infrastructure', 'statistical'].map((name) => [name, selected.filter((run) => run.phase === name).length])),
    firstRuns: selected.slice(0, 10).map((run) => ({ order: run.order, runId: run.runId })),
  }
  process.stdout.write(has('--json') ? canonicalJson(summary) : `dry-run only: ${summary.selectedRuns} selected, 0 paid model calls\nmanifest: ${summary.manifestDigest}\n`)
  process.exit(0)
}

const acknowledgement = 'I_UNDERSTAND_THIS_RUN_USES_PAID_MODELS'
if (process.env.PLAN_LATTICE_CREDENTIAL_PROXY !== '1') {
  throw new Error('paid execution must start through eval/v0.4/secure-run.sh so the real API key never reaches Harness or its parent process')
}
if (process.env.PLAN_LATTICE_EVAL_ALLOW_PAID !== acknowledgement) {
  throw new Error(`paid execution requires PLAN_LATTICE_EVAL_ALLOW_PAID=${acknowledgement}`)
}
const apiKey = process.env[preregistration.model.apiKeyEnvironmentVariable]
if (!apiKey) throw new Error(`${preregistration.model.apiKeyEnvironmentVariable} must be supplied through the environment`)
const endpointDigest = process.env.PLAN_LATTICE_UPSTREAM_ENDPOINT_DIGEST
if (!/^[0-9a-f]{64}$/.test(endpointDigest ?? '')) throw new Error('secure launcher did not bind the upstream endpoint digest')
const proxyPid = Number(process.env.PLAN_LATTICE_CREDENTIAL_PROXY_PID)
if (!Number.isSafeInteger(proxyPid) || proxyPid <= 1) throw new Error('secure launcher did not provide a credential proxy PID')
const proxyControlToken = process.env.PLAN_LATTICE_MODEL_PROXY_CONTROL_TOKEN
if (!proxyControlToken?.startsWith('plan-lattice-control-')) throw new Error('secure launcher did not provide a model proxy control token')
let proxyStopped = false
const proxyAuditPath = process.env.PLAN_LATTICE_MODEL_PROXY_AUDIT
const proxyControlRoot = process.env.PLAN_LATTICE_CREDENTIAL_PROXY_ROOT
if (!proxyAuditPath || !isAbsolute(proxyAuditPath) || !proxyControlRoot || !isAbsolute(proxyControlRoot)) {
  throw new Error('secure launcher did not provide the model proxy audit channel')
}
const stopProxy = () => {
  if (proxyStopped) return
  proxyStopped = true
  try { process.kill(proxyPid, 'SIGTERM') } catch {}
  try { rmSync(proxyControlRoot, { recursive: true, force: true }) } catch {}
}
process.once('exit', stopProxy)
process.once('SIGINT', () => { stopProxy(); process.exit(130) })
process.once('SIGTERM', () => { stopProxy(); process.exit(143) })
const proxyURL = new URL(process.env.DEEPSEEK_BASE_URL)
if (proxyURL.protocol !== 'http:' || proxyURL.hostname !== '127.0.0.1') {
  throw new Error('secure launcher model proxy must be an HTTP loopback endpoint')
}
const healthResponse = await fetch(new URL('/__plan_lattice_health', proxyURL), {
  headers: { 'x-plan-lattice-control': proxyControlToken },
})
if (!healthResponse.ok) throw new Error('credential proxy rejected its one-time controller handshake')
const health = await healthResponse.json()
const signingPublicKeyBase64 = process.env.PLAN_LATTICE_RESULT_SIGNING_PUBLIC_KEY_BASE64
if (signingPublicKeyBase64 !== preregistration.resultSigning.publicKeySpkiBase64) {
  throw new Error('secure launcher result signing key does not match the preregistration')
}
if (health.pid !== proxyPid
  || health.upstreamEndpointDigest !== endpointDigest
  || health.auditPathDigest !== sha256(proxyAuditPath)
  || health.signingPublicKeyDigest !== sha256(Buffer.from(signingPublicKeyBase64, 'base64'))) {
  throw new Error('credential proxy handshake did not match the frozen execution channel')
}
async function bindProxyAttempt(attemptId) {
  const response = await fetch(new URL('/__plan_lattice_attempt', proxyURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxyControlToken },
    body: JSON.stringify({ attemptId }),
  })
  if (!response.ok) throw new Error('credential proxy rejected the frozen attempt binding')
}
async function signResultRecord(record) {
  const response = await fetch(new URL('/__plan_lattice_sign', proxyURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxyControlToken },
    body: JSON.stringify({
      attemptId: record.attemptId,
      runId: record.runId,
      attempt: record.attempt,
      manifestDigest: record.manifestDigest,
      previousRecordDigest: record.previousRecordDigest,
      recordDigest: record.recordDigest,
    }),
  })
  if (!response.ok) throw new Error('isolated result signer rejected the record digest')
  const payload = await response.json()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload.signature ?? '')) throw new Error('isolated result signer returned an invalid signature')
  return payload.signature
}
const driver = process.env.PLAN_LATTICE_EVAL_DRIVER
if (!driver || !isAbsolute(driver)) throw new Error('PLAN_LATTICE_EVAL_DRIVER must be an absolute executable path')
const bundledDriver = join(root, 'driver', 'dsh-driver.mjs')
if (await realpath(driver) !== await realpath(bundledDriver)) throw new Error('PLAN_LATTICE_EVAL_DRIVER must resolve to the frozen repository-owned driver')
if (currentDriverDigest !== manifest.driverSourceDigest) throw new Error('driver source digest differs from the frozen manifest')
assertCandidateCheckout(preregistration.pluginCommits['v0.4.0Candidate'])
if (!requestedRun && !has('--execute-all')) throw new Error('paid execution requires --run-id; add --execute-all only for an intentional batch')
if (has('--execute-all') && option('--confirm-manifest') !== manifest.manifestDigest) {
  throw new Error(`batch execution requires --confirm-manifest ${manifest.manifestDigest}`)
}

const driverEnvironment = { ...process.env }
for (const key of [
  'PLAN_LATTICE_MODEL_PROXY_CONTROL_TOKEN',
  'PLAN_LATTICE_MODEL_PROXY_AUDIT',
  'PLAN_LATTICE_CREDENTIAL_PROXY_ROOT',
  'PLAN_LATTICE_CREDENTIAL_PROXY_PID',
  'PLAN_LATTICE_UPSTREAM_ENDPOINT_DIGEST',
  'PLAN_LATTICE_RESULT_SIGNING_PUBLIC_KEY_BASE64',
]) delete driverEnvironment[key]

const resultsDir = option('--results-dir') ? resolve(option('--results-dir')) : undefined
if (!resultsDir) throw new Error('--results-dir outside the repository is required for paid execution')
const repositoryRoot = resolve(root, '..', '..')
if (resultsDir === repositoryRoot || resultsDir.startsWith(`${repositoryRoot}/`)) {
  throw new Error('--results-dir must be outside the repository')
}
await mkdir(resultsDir, { recursive: true })
const resultsPath = join(resultsDir, 'results.jsonl')
const existing = await readJsonLines(resultsPath)
const existingIntegrityErrors = await verifyAttemptReceipts(existing, resultsPath, preregistration.resultSigning.publicKeySpkiBase64)
if (existingIntegrityErrors.length > 0) throw new Error(`existing result ledger failed integrity validation: ${existingIntegrityErrors.join('; ')}`)
const allowedCodes = preregistration.retryPolicy.allowedInfrastructureCodes
const rerunRunId = option('--rerun-of')
if (rerunRunId) {
  if (!requestedRun || requestedRun !== rerunRunId) throw new Error('--rerun-of must equal --run-id')
  const prior = existing.filter((record) => record.runId === rerunRunId).sort((a, b) => a.attempt - b.attempt).at(-1)
  if (!prior || prior.status !== 'failed' || prior.failure?.classification !== 'infrastructure' || !allowedCodes.includes(prior.failure.code)) {
    throw new Error('rerun rejected: the latest attempt is not an allowed infrastructure failure')
  }
} else {
  const completedIds = new Set(existing.map((record) => record.runId))
  selected = selected.filter((run) => !completedIds.has(run.runId))
}

function scrub(text) {
  if (!text) return ''
  return text
    .split(apiKey).join('[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
}

function expectedProvenanceFor(run) {
  return {
    harnessCommit: manifest.sourceCommits.harness,
    modelId: manifest.model.modelId,
    modelConfigDigest: sha256(manifest.model),
    runtimePolicyDigest: sha256(manifest.runtimePolicy),
    endpointDigest,
    sourceLockDigest: manifest.sourceLockDigest,
    runtimeArtifactsDigest: manifest.runtimeArtifactsDigest,
    driverSourceDigest: manifest.driverSourceDigest,
    pluginCommit: run.arm.plugin === 'none'
      ? null
      : run.arm.plugin === 'v0.3.0'
        ? manifest.pluginCommits['v0.3.0']
        : manifest.pluginCommits['v0.4.0Candidate'],
  }
}

for (const run of selected) {
  if (run.phase === 'statistical') {
    const infrastructure = resolveEvaluationSlots(existing, manifest, preregistration.retryPolicy)
    if (infrastructure.errors.length > 0 || infrastructure.infrastructure.missingRunIds.length > 0) {
      throw new Error('statistical execution is locked until all six infrastructure runs complete without integrity errors')
    }
    for (const [runId, record] of infrastructure.infrastructure.resolved) {
      const expectedRun = manifest.infrastructureRuns.find(entry => entry.runId === runId)
      validateDriverPayload(record, expectedRun, expectedProvenanceFor(expectedRun))
    }
  }
  const priorAttempts = existing.filter((record) => record.runId === run.runId).sort((a, b) => a.attempt - b.attempt)
  const proxyAuditBefore = await readJsonLines(proxyAuditPath, { validate: false })
  const prior = priorAttempts.at(-1)
  const attempt = priorAttempts.length + 1
  const attemptId = randomUUID()
  const attemptDir = join(resultsDir, 'attempts', attemptId)
  await mkdir(attemptDir, { recursive: true })
  const expectedProvenance = expectedProvenanceFor(run)
  const spec = {
    schemaVersion: 1,
    protocolId: manifest.protocolId,
    manifestDigest: manifest.manifestDigest,
    run,
    model: manifest.model,
    runtimePolicy: manifest.runtimePolicy,
    pluginCommits: manifest.pluginCommits,
    sourceLockDigest: manifest.sourceLockDigest,
    sourceCommits: manifest.sourceCommits,
    benchmarkLock,
    runtimeArtifacts,
    attemptDir,
    routerBlindResultDigest: manifest.routerBlindResultDigest,
    expectedProvenance,
    simpleTask: run.suite === 'simple' ? simpleTasks.tasks.find((task) => task.id === run.taskId) : undefined,
    benchmarkRoots: {
      harness: process.env.DEEPSEEK_HARNESS_ROOT ?? null,
      harbor: process.env.HARBOR_ROOT ?? null,
      icae: process.env.ICAE_EVAL_ROOT ?? null,
      evocode: process.env.EVOCODE_BENCH_ROOT ?? null,
    },
  }
  const controllerDir = join(attemptDir, 'controller')
  await mkdir(controllerDir, { recursive: true, mode: 0o700 })
  const specPath = join(controllerDir, 'run-spec.json')
  await writeFile(specPath, canonicalJson(spec), { encoding: 'utf8', mode: 0o600 })
  const attemptEnvironment = { ...driverEnvironment, PLAN_LATTICE_EVAL_ATTEMPT_ID: attemptId }
  if (run.suite !== 'icae') delete attemptEnvironment.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN
  if (run.suite !== 'evocode') delete attemptEnvironment.PLAN_LATTICE_DOCKER_MODEL_PROXY_URL
  const preflightChild = spawnSync(process.execPath, [driver, '--preflight', specPath], {
    encoding: 'utf8',
    env: attemptEnvironment,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  })
  let preflight
  try {
    preflight = JSON.parse(scrub(preflightChild.stdout ?? ''))
  } catch {
    throw new Error('frozen driver preflight returned unusable output; no experiment attempt was recorded')
  }
  await writeFile(join(attemptDir, 'preflight.json'), canonicalJson(preflight), 'utf8')
  if (preflightChild.status !== 0 || preflight.ok !== true) {
    throw new Error('frozen driver preflight failed; no model call or experiment attempt was recorded')
  }
  const startedAt = new Date().toISOString()
  await bindProxyAttempt(attemptId)
  const child = spawnSync(process.execPath, [driver, specPath], {
    encoding: 'utf8',
    env: attemptEnvironment,
    maxBuffer: 32 * 1024 * 1024,
    timeout: preregistration.model.timeoutMs + 60_000,
  })
  let proxyControlFailure = false
  try { await bindProxyAttempt(null) } catch { proxyControlFailure = true }
  const safeStdout = scrub(child.stdout ?? '')
  const safeStderr = scrub(child.stderr ?? '')
  await writeFile(join(attemptDir, 'driver.stdout.log'), safeStdout, 'utf8')
  await writeFile(join(attemptDir, 'driver.stderr.log'), safeStderr, 'utf8')
  let payload
  try {
    payload = JSON.parse(safeStdout)
    assertNoSecrets(payload, [apiKey])
    validateDriverPayload(payload, run, expectedProvenance)
  } catch (error) {
    payload = {
      status: 'failed',
      failure: {
        classification: 'task',
        code: 'driver_output_unusable_after_execution',
        message: `Driver output was unusable: ${error.message}`,
      },
    }
  }
  if (child.status !== 0 && payload.status === 'completed') {
    payload = {
      status: 'failed',
      failure: { classification: 'task', code: 'driver_exit_after_execution', message: `Driver exited with status ${child.status}` },
      metrics: payload.metrics,
      provenance: payload.provenance,
    }
  }
  const proxyAuditAfter = await readJsonLines(proxyAuditPath, { validate: false })
  const proxyRequests = proxyAuditAfter.slice(proxyAuditBefore.length)
  await writeFile(join(attemptDir, 'model-proxy-requests.json'), canonicalJson(proxyRequests), 'utf8')
  const agentRequests = proxyRequests.filter(entry => entry.event === 'request' && entry.role === 'agent')
  const agentResponses = proxyRequests.filter(entry => entry.event === 'response' && entry.role === 'agent')
  const oracleRequests = proxyRequests.filter(entry => entry.event === 'request' && entry.role === 'oracle')
  const observedTurns = payload.metrics?.modelTurns
  const responseBySequence = new Map(agentResponses.map(entry => [entry.sequence, entry]))
  const sumUsage = (entries, key) => entries.reduce((sum, entry) => sum + (entry.usage?.[key] ?? 0), 0)
  const accountingMismatch = Number.isFinite(observedTurns) && (
    agentResponses.length !== observedTurns
    || sumUsage(agentResponses, 'promptTokens') !== payload.metrics.inputTokens
    || sumUsage(agentResponses, 'completionTokens') !== payload.metrics.outputTokens
  )
  const incompleteResponses = agentResponses.length !== agentRequests.length
    || agentResponses.some(entry => entry.status < 200 || entry.status >= 300 || entry.usage === null)
  const invalidRequest = agentRequests.some(entry => entry.attemptId !== attemptId || entry.contractValid !== true)
    || oracleRequests.some(entry => entry.attemptId !== attemptId)
  const invalidOracleUse = run.suite === 'icae' ? oracleRequests.length > 5 : oracleRequests.length > 0
  if (accountingMismatch || incompleteResponses || invalidRequest || invalidOracleUse || proxyControlFailure) {
    payload = {
      status: 'failed',
      failure: {
        classification: 'task',
        code: 'model_request_accounting_mismatch',
        message: 'Credential proxy requests did not match the durable Harness session metrics',
      },
      ...(payload.metrics ? { metrics: payload.metrics } : {}),
      ...(payload.provenance ? { provenance: payload.provenance } : {}),
    }
  }
  await writeFile(join(attemptDir, 'controller-payload.json'), canonicalJson(payload), { encoding: 'utf8', mode: 0o600 })
  const artifactDigest = await digestAttemptArtifacts(attemptDir)
  const previousRecordDigest = existing.at(-1)?.recordDigest ?? RESULT_CHAIN_GENESIS
  const record = {
    schemaVersion: 1,
    attemptId,
    runId: run.runId,
    attempt,
    ...(prior ? { rerunOfAttemptId: prior.attemptId } : {}),
    phase: run.phase,
    suite: run.suite,
    armId: run.arm.id,
    status: payload.status,
    ...(payload.failure ? { failure: payload.failure } : {}),
    ...(payload.metrics ? { metrics: payload.metrics } : {}),
    ...(payload.provenance ? { provenance: payload.provenance } : {}),
    manifestDigest: manifest.manifestDigest,
    artifactDigest,
    driverPayloadDigest: sha256(payload),
    driverStdoutDigest: sha256(safeStdout),
    previousRecordDigest,
    startedAt,
    finishedAt: new Date().toISOString(),
    stderrDigest: sha256(safeStderr),
  }
  const receipt = renderControllerReceipt(record)
  await writeFile(join(attemptDir, 'controller-receipt.json'), canonicalJson(receipt), { encoding: 'utf8', mode: 0o600 })
  record.controllerReceiptDigest = sha256(receipt)
  record.recordDigest = digestResultRecord(record)
  record.recordSignature = await signResultRecord(record)
  assertNoSecrets(record, [apiKey])
  await appendFile(resultsPath, canonicalRecord(record), 'utf8')
  existing.push(record)
  console.log(`${run.runId}: ${record.status} (attempt ${attempt})`)
}

await readFile(resultsPath, 'utf8')
