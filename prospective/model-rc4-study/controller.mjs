#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { access, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { canonicalJson, readJson, sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import {
  RESULT_CHAIN_GENESIS,
  digestAttemptArtifacts,
  digestResultRecord,
  renderControllerReceipt,
  verifyAttemptReceipts,
} from '../../eval/v0.4/lib/attempt-integrity.mjs'
import { readJsonLines, resolveEvaluationSlots } from '../../eval/v0.4/lib/results.mjs'
import { assertNoSecrets, validateBenchmarkLock, validateDriverPayload, validateManifest, validatePreregistration } from '../../eval/v0.4/lib/validation.mjs'
import {
  acquireResultsLock,
  commitModelInvocation,
  openAttemptJournal,
  persistPendingResult,
  recoverPendingResults,
  reserveAttempt,
  writeDurable,
} from './attempt-persistence.mjs'
import { reconcileDriverPayload, summarizeProxyAudit } from './controller-accounting.mjs'
import { buildRc4RunManifest, verifyExecutionEnvelope } from './design.mjs'
import { loadExecutionEnvelope, studySourceDigest } from './integrity.mjs'
import { assertCandidateFreeze, assertStudyProtocolFreeze, loadStudySpec } from './protocol.mjs'
import { buildRunSpec } from './run-spec.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const arguments_ = process.argv.slice(2)
const has = (name) => arguments_.includes(name)
const option = (name) => {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}
const envelopePath = option('--execution-envelope')
if (!envelopePath) throw new Error('--execution-envelope must point to the publicly frozen RC.4 envelope')
const { spec: studySpec } = await loadStudySpec()
const studyFreeze = assertStudyProtocolFreeze(studySpec)
assertCandidateFreeze(studySpec)
const { envelope, freeze: executionFreeze } = await loadExecutionEnvelope(envelopePath, studySpec)
verifyExecutionEnvelope(envelope, studySpec)
const preregistration = envelope.preregistration
const manifest = envelope.runManifest
const benchmarkLock = await readJson(resolve(root, '../../eval/v0.4/benchmark-lock.json'))
const simpleTasks = await readJson(resolve(root, '../../eval/v0.4/simple-tasks.json'))
const runtimeArtifacts = envelope.runtimeArtifacts
const routerBlindResult = envelope.routerEvidence
validatePreregistration(preregistration, { executionReady: has('--execute') })
validateBenchmarkLock(benchmarkLock)
validateManifest(manifest)
const source = studySourceDigest(studyFreeze.commit)
const currentDriverDigest = source.digest
if (currentDriverDigest !== envelope.controllerSourceDigest || currentDriverDigest !== envelope.driverSourceDigest) {
  throw new Error('RC.4 study source differs from the frozen execution envelope')
}
const deterministicManifest = buildRc4RunManifest({
  studySpec,
  preregistration,
  runtimeArtifacts,
  routerEvidence: routerBlindResult,
  driverSourceDigest: currentDriverDigest,
})
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
  throw new Error('paid execution must start through the frozen RC.4 secure-run.sh so the real API key never reaches Harness or its parent process')
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
const oracleProxyToken = process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN
if (!oracleProxyToken?.startsWith('plan-lattice-oracle-')) throw new Error('secure launcher did not provide an Oracle proxy token')
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
if (process.env.PLAN_LATTICE_RESULT_SIGNING_LEDGER_ID !== envelope.signingLedgerId) {
  throw new Error('secure launcher signing ledger identity does not match the RC.4 execution freeze')
}
if (process.env.PLAN_LATTICE_EXECUTION_ENVELOPE_DIGEST !== envelope.envelopeDigest) {
  throw new Error('secure launcher execution envelope digest does not match the RC.4 execution freeze')
}
if (health.pid !== proxyPid
  || health.upstreamEndpointDigest !== endpointDigest
  || health.auditPathDigest !== sha256(proxyAuditPath)
  || health.signingPublicKeyDigest !== sha256(Buffer.from(signingPublicKeyBase64, 'base64'))
  || health.signingLedgerId !== envelope.signingLedgerId
  || health.executionEnvelopeDigest !== envelope.envelopeDigest) {
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
      signingLedgerId: envelope.signingLedgerId,
      executionEnvelopeDigest: envelope.envelopeDigest,
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
const bundledDriver = join(root, 'driver.mjs')
if (await realpath(driver) !== await realpath(bundledDriver)) throw new Error('PLAN_LATTICE_EVAL_DRIVER must resolve to the frozen repository-owned driver')
if (currentDriverDigest !== manifest.driverSourceDigest) throw new Error('driver source digest differs from the frozen manifest')
if (preregistration.pluginCommits['v0.4.0Candidate'] !== studySpec.candidate.commit) throw new Error('execution manifest uses another plugin candidate')
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
const persistenceBinding = {
  signingLedgerId: envelope.signingLedgerId,
  executionEnvelopeDigest: envelope.envelopeDigest,
  manifestDigest: manifest.manifestDigest,
}
const resultsLock = await acquireResultsLock(resultsDir, persistenceBinding)
process.once('exit', resultsLock.releaseSync)
const journal = await openAttemptJournal(resultsDir, persistenceBinding)
const existing = await readJsonLines(resultsPath)
const existingIntegrityErrors = await verifyAttemptReceipts(existing, resultsPath, preregistration.resultSigning.publicKeySpkiBase64)
if (existingIntegrityErrors.length > 0) throw new Error(`existing result ledger failed integrity validation: ${existingIntegrityErrors.join('; ')}`)
async function pathExists(path) {
  return access(path).then(() => true, () => false)
}

async function preserveUnfinalizedFile(path, preservedPath) {
  if (!(await pathExists(path)) || await pathExists(preservedPath)) return
  await writeDurable(preservedPath, await readFile(path), { exclusive: true })
}

async function materializeCrashRecovery({ reservation, recovery }) {
  const run = allRuns.find(entry => entry.runId === reservation.runId)
  if (!run) throw new Error(`crash recovery cannot resolve frozen run ${reservation.runId}`)
  const attemptDir = join(resultsDir, 'attempts', reservation.attemptId)
  const controllerDir = join(attemptDir, 'controller')
  await mkdir(controllerDir, { recursive: true, mode: 0o700 })
  const stdoutPath = join(attemptDir, 'driver.stdout.log')
  const stderrPath = join(attemptDir, 'driver.stderr.log')
  const payloadPath = join(attemptDir, 'controller-payload.json')
  const receiptPath = join(attemptDir, 'controller-receipt.json')
  const recoveryPath = join(controllerDir, 'crash-recovery.json')
  if (!(await pathExists(stdoutPath))) await writeDurable(stdoutPath, '')
  if (!(await pathExists(stderrPath))) await writeDurable(stderrPath, '')
  if (!(await pathExists(recoveryPath))) {
    await preserveUnfinalizedFile(payloadPath, join(controllerDir, 'unfinalized-controller-payload.json'))
    await preserveUnfinalizedFile(receiptPath, join(controllerDir, 'unfinalized-controller-receipt.json'))
    await writeDurable(recoveryPath, canonicalJson({
      schemaVersion: 1,
      attemptId: reservation.attemptId,
      stage: recovery.stage,
      recoveryEventDigest: recovery.eventDigest,
      recoveryAt: recovery.recoveryAt,
    }), { exclusive: true })
  }

  const failure = recovery.stage === 'before-invocation'
    ? {
        classification: 'infrastructure',
        code: 'runner_crash_before_model_call',
        message: 'The prior controller exited before durably committing permission for a paid model invocation',
      }
    : {
        classification: 'task',
        code: 'controller_crash_after_model_call_committed',
        message: 'The prior controller exited after a paid model invocation became possible and before an immutable response was persisted; this attempt cannot be rerun',
      }
  const payload = { status: 'failed', failure }
  assertNoSecrets(payload, [apiKey, oracleProxyToken])
  await writeDurable(payloadPath, canonicalJson(payload))

  const safeStdout = await readFile(stdoutPath)
  const safeStderr = await readFile(stderrPath)
  const artifactDigest = await digestAttemptArtifacts(attemptDir)
  const record = {
    schemaVersion: 1,
    attemptId: reservation.attemptId,
    runId: reservation.runId,
    attempt: reservation.attempt,
    ...(reservation.rerunOfAttemptId ? { rerunOfAttemptId: reservation.rerunOfAttemptId } : {}),
    phase: run.phase,
    suite: run.suite,
    armId: run.arm.id,
    status: 'failed',
    failure,
    manifestDigest: manifest.manifestDigest,
    artifactDigest,
    driverPayloadDigest: sha256(payload),
    driverStdoutDigest: sha256(safeStdout),
    previousRecordDigest: reservation.previousRecordDigest,
    startedAt: reservation.reservedAt,
    finishedAt: recovery.recoveryAt,
    stderrDigest: sha256(safeStderr),
  }
  const receipt = renderControllerReceipt(record)
  await writeDurable(receiptPath, canonicalJson(receipt))
  record.controllerReceiptDigest = sha256(receipt)
  record.recordDigest = digestResultRecord(record)
  assertNoSecrets(record, [apiKey, oracleProxyToken])
  return record
}

const recovery = await recoverPendingResults({
  journal,
  records: existing,
  resultsPath,
  publicKeySpkiBase64: preregistration.resultSigning.publicKeySpkiBase64,
  signRecord: signResultRecord,
  recoverAbandonedAttempt: materializeCrashRecovery,
})
if (recovery.recovered > 0) {
  const recoveredIntegrityErrors = await verifyAttemptReceipts(existing, resultsPath, preregistration.resultSigning.publicKeySpkiBase64)
  if (recoveredIntegrityErrors.length > 0) {
    throw new Error(`recovered result ledger failed integrity validation: ${recoveredIntegrityErrors.join('; ')}`)
  }
}
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
  let scrubbed = text
  for (const secret of [apiKey, oracleProxyToken]) scrubbed = scrubbed.split(secret).join('[REDACTED]')
  return scrubbed.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
}

function expectedProvenanceFor(run) {
  const pluginPackageDigest = run.arm.plugin === 'none'
    ? null
    : run.arm.plugin === 'v0.3.0'
      ? runtimeArtifacts.hostPlugins['v0.3.0'].sha256
      : run.suite === 'evocode'
        ? runtimeArtifacts.artifacts[run.arm.id].pluginPackageDigest
        : runtimeArtifacts.hostPlugins['v0.4.0-candidate'].sha256
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
    pluginPackageDigest,
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
  const prior = priorAttempts.at(-1)
  const attempt = priorAttempts.length + 1
  const attemptId = randomUUID()
  const attemptDir = join(resultsDir, 'attempts', attemptId)
  await mkdir(attemptDir, { recursive: true })
  const expectedProvenance = expectedProvenanceFor(run)
  const spec = buildRunSpec({
    run,
    envelope,
    studySpec,
    executionFreezeCommit: executionFreeze.executionCommit,
    benchmarkLock,
    simpleTasks,
    attemptDir,
    expectedProvenance,
    benchmarkRoots: {
      harness: process.env.DEEPSEEK_HARNESS_ROOT ?? null,
      harbor: process.env.HARBOR_ROOT ?? null,
      icae: process.env.ICAE_EVAL_ROOT ?? null,
      evocode: process.env.EVOCODE_BENCH_ROOT ?? null,
    },
  })
  const controllerDir = join(attemptDir, 'controller')
  await mkdir(controllerDir, { recursive: true, mode: 0o700 })
  const specPath = join(controllerDir, 'run-spec.json')
  await writeDurable(specPath, canonicalJson(spec))
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
  await writeDurable(join(attemptDir, 'preflight.json'), canonicalJson(preflight))
  if (preflightChild.status !== 0 || preflight.ok !== true) {
    throw new Error('frozen driver preflight failed; no model call or experiment attempt was recorded')
  }
  const startedAt = new Date().toISOString()
  const previousRecordDigest = existing.at(-1)?.recordDigest ?? RESULT_CHAIN_GENESIS
  await reserveAttempt(journal, {
    attemptId,
    runId: run.runId,
    attempt,
    ...(prior ? { rerunOfAttemptId: prior.attemptId } : {}),
    previousRecordDigest,
    reservedAt: startedAt,
  })
  await commitModelInvocation(journal, attemptId)
  const executionStarted = performance.now()
  let child = { status: null, stdout: '', stderr: '' }
  let setupError
  try {
    await bindProxyAttempt(attemptId)
    child = spawnSync(process.execPath, [driver, specPath], {
      encoding: 'utf8',
      env: attemptEnvironment,
      maxBuffer: 32 * 1024 * 1024,
      timeout: preregistration.model.timeoutMs + 60_000,
    })
    if (child.error) setupError = child.error
  } catch (error) {
    setupError = error
  }
  let proxyControlFailure = false
  try { await bindProxyAttempt(null) } catch { proxyControlFailure = true }
  const safeStdout = scrub(child.stdout ?? '')
  const safeStderr = scrub(child.stderr ?? '')
  await writeDurable(join(attemptDir, 'driver.stdout.log'), safeStdout)
  await writeDurable(join(attemptDir, 'driver.stderr.log'), safeStderr)
  let payload
  try {
    payload = JSON.parse(safeStdout)
    assertNoSecrets(payload, [apiKey, oracleProxyToken])
    validateDriverPayload(payload, run, expectedProvenance)
  } catch (error) {
    const parsed = payload && typeof payload === 'object' ? payload : undefined
    payload = {
      status: 'failed',
      failure: {
        classification: 'task',
        code: 'driver_output_unusable_after_execution',
        message: `Driver output was unusable: ${error.message}`,
      },
      ...(parsed?.metrics ? { metrics: parsed.metrics } : {}),
      ...(parsed?.provenance ? { provenance: parsed.provenance } : {}),
    }
  }
  if (setupError) {
    payload = {
      status: 'failed',
      failure: {
        classification: 'task',
        code: 'driver_setup_error_after_reservation',
        message: `Driver setup failed after reservation: ${setupError.message}`,
      },
      ...(payload.metrics ? { metrics: payload.metrics } : {}),
      ...(payload.provenance ? { provenance: payload.provenance } : {}),
    }
  }
  let fullAudit = []
  let audit
  try {
    fullAudit = await readJsonLines(proxyAuditPath, { validate: false })
    audit = summarizeProxyAudit(fullAudit, attemptId)
  } catch (error) {
    audit = {
      attemptId,
      entries: [],
      requestCount: 0,
      responseCount: 0,
      agentRequestCount: 0,
      agentResponseCount: 0,
      oracleRequestCount: 0,
      modelTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      oracleInputTokens: 0,
      oracleOutputTokens: 0,
      errors: [`proxy audit could not be verified: ${error.message}`],
    }
  }
  await writeDurable(join(attemptDir, 'model-proxy-requests.json'), canonicalJson({
    schemaVersion: 1,
    attemptId,
    fullAuditDigest: sha256(fullAudit),
    ...audit,
  }))
  const durationMs = Math.max(0, performance.now() - executionStarted)
  payload = reconcileDriverPayload({
    payload,
    childStatus: child.status,
    audit,
    durationMs,
    proxyControlFailure,
    suite: run.suite,
  })
  await writeDurable(join(attemptDir, 'controller-payload.json'), canonicalJson(payload))
  const artifactDigest = await digestAttemptArtifacts(attemptDir)
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
  await writeDurable(join(attemptDir, 'controller-receipt.json'), canonicalJson(receipt))
  record.controllerReceiptDigest = sha256(receipt)
  record.recordDigest = digestResultRecord(record)
  assertNoSecrets(record, [apiKey, oracleProxyToken])
  await persistPendingResult(journal, record)
  const finalized = await recoverPendingResults({
    journal,
    records: existing,
    resultsPath,
    publicKeySpkiBase64: preregistration.resultSigning.publicKeySpkiBase64,
    signRecord: signResultRecord,
  })
  if (finalized.recovered !== 1) throw new Error(`attempt ${attemptId} was not finalized exactly once`)
  console.log(`${run.runId}: ${record.status} (attempt ${attempt})`)
}

await readFile(resultsPath, 'utf8')
await resultsLock.release()
