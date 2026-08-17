import { createHash, createPublicKey } from 'node:crypto'
import { sha256 } from './canonical.mjs'

const HEX40 = /^[0-9a-f]{40}$/
const FINAL_STATUSES = new Set(['completed', 'failed'])

function fail(message) {
  throw new Error(message)
}

function requireValue(condition, message) {
  if (!condition) fail(message)
}

export function validatePreregistration(value, { executionReady = false } = {}) {
  requireValue(value?.schemaVersion === 1, 'preregistration.schemaVersion must be 1')
  requireValue(typeof value.protocolId === 'string' && value.protocolId.length > 0, 'protocolId is required')
  requireValue(value.design?.infrastructureRuns?.count === 6, 'infrastructure count must be 6')
  requireValue(value.design?.statisticalRuns?.count === 90, 'statistical count must be 90')
  requireValue(value.model?.apiKeyEnvironmentVariable === 'DEEPSEEK_API_KEY', 'API key must be environment-only')
  requireValue(value.model?.modelId === 'deepseek-v4-flash', 'modelId must remain deepseek-v4-flash')
  requireValue(value.resultSigning?.algorithm === 'Ed25519', 'result signing must use Ed25519')
  requireValue(value.resultSigning?.privateKeyEnvironmentVariable === 'PLAN_LATTICE_RESULT_SIGNING_PRIVATE_KEY_BASE64', 'result signing private key must remain environment-only')
  requireValue(value.resultSigning?.stateLedgerEnvironmentVariable === 'PLAN_LATTICE_RESULT_SIGNING_LEDGER', 'result signing state ledger must remain external')
  requireValue(value.runtimePolicy?.concurrencyPerRun === 1, 'runtime concurrency must remain one run at a time')
  requireValue(value.randomization?.seed, 'randomization seed is required')
  requireValue(value.releaseGates?.icae?.bootstrapUnit === '6 independent tasks', 'ICAE bootstrap unit must remain six independent tasks')
  requireValue(value.releaseGates?.evocode?.bootstrapUnit === '3 independent tasks', 'EvoCode bootstrap unit must remain three independent tasks')
  if (executionReady) {
    requireValue(HEX40.test(value.pluginCommits?.['v0.4.0Candidate'] ?? ''), 'v0.4 candidate commit is not frozen')
    requireValue(/^[A-Za-z0-9+/]+={0,2}$/.test(value.resultSigning?.publicKeySpkiBase64 ?? ''), 'result signing public key is not frozen')
    try {
      const key = createPublicKey({ key: Buffer.from(value.resultSigning.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
      requireValue(key.asymmetricKeyType === 'ed25519', 'result signing public key must be Ed25519')
    } catch {
      fail('result signing public key is invalid')
    }
  }
  return true
}

export function validateBenchmarkLock(value) {
  requireValue(value?.schemaVersion === 1, 'benchmark lock schemaVersion must be 1')
  for (const name of ['harness', 'harbor', 'icae', 'evocode']) {
    const source = value.sources?.[name]
    requireValue(source, `missing source ${name}`)
    requireValue(/^https:\/\/github\.com\/.+\.git$/.test(source.repository), `${name} repository must be an HTTPS Git URL`)
    requireValue(HEX40.test(source.commit ?? ''), `${name} commit must be an exact 40-character SHA`)
  }
  requireValue(value.sources.icae.selectedTasks?.length === 6, 'ICAE must contain exactly 6 selected tasks')
  requireValue(value.sources.evocode.selectedTasks?.length === 3, 'EvoCode must contain exactly 3 selected tasks')
  const icaeAssets = value.sources.icae.officialDataAssets
  for (const name of ['goldenRepositories', 'authoritativeTests', 'hiddenPrdBundle']) {
    const asset = icaeAssets?.[name]
    requireValue(/^https:\/\/zenodo\.org\/records\/.+/.test(asset?.url ?? ''), `ICAE ${name} must use an official Zenodo URL`)
    requireValue(/^[0-9a-f]{64}$/.test(asset?.sha256 ?? ''), `ICAE ${name} must have a frozen SHA256`)
  }
  const salt = value.sources.icae.selection?.salt
  for (const task of value.sources.icae.selectedTasks) {
    const expected = createHash('sha256').update(`${salt}:${task.repoId}`).digest('hex')
    requireValue(task.selectionHash === expected, `ICAE selection hash mismatch for ${task.id}`)
  }
  return true
}

export function validateManifest(value) {
  requireValue(value?.schemaVersion === 1, 'manifest schemaVersion must be 1')
  requireValue(value.status === 'frozen-unexecuted', 'manifest status must be frozen-unexecuted')
  const { manifestDigest, ...core } = value
  requireValue(manifestDigest === sha256(core), 'manifestDigest does not match the canonical manifest content')
  requireValue(value.infrastructureRuns?.length === 6, 'manifest must have 6 infrastructure runs')
  requireValue(value.statisticalRuns?.length === 90, 'manifest must have 90 statistical runs')
  requireValue(value.counts?.simple === 36, 'manifest must have 36 simple statistical runs')
  requireValue(value.counts?.icae === 36, 'manifest must have 36 ICAE statistical runs')
  requireValue(value.counts?.evocode === 18, 'manifest must have 18 EvoCode statistical runs')
  requireValue(value.runtimePolicy?.concurrencyPerRun === 1, 'manifest runtime policy is missing')
  requireValue(/^[0-9a-f]{64}$/.test(value.runtimeArtifactsDigest ?? ''), 'manifest runtime artifacts digest is invalid')
  requireValue(/^[0-9a-f]{64}$/.test(value.routerBlindResultDigest ?? ''), 'manifest router blind result digest is invalid')
  requireValue(/^[0-9a-f]{64}$/.test(value.driverSourceDigest ?? ''), 'manifest driver source digest is invalid')
  for (const source of ['harness', 'harbor', 'icae', 'evocode']) {
    requireValue(HEX40.test(value.sourceCommits?.[source] ?? ''), `manifest source commit ${source} is invalid`)
  }
  const all = [...value.infrastructureRuns, ...value.statisticalRuns]
  requireValue(new Set(all.map((run) => run.runId)).size === 96, 'run IDs must be unique')
  requireValue(new Set(value.statisticalRuns.map((run) => run.order)).size === 90, 'statistical order must be unique')
  requireValue(value.infrastructureRuns.every((run) => run.includedInStatistics === false), 'infrastructure runs must be excluded')
  requireValue(value.statisticalRuns.every((run) => run.includedInStatistics === true), 'statistical runs must be included')
  for (const run of all) {
    requireValue(['simple', 'icae', 'evocode'].includes(run.suite), `invalid suite for ${run.runId}`)
    requireValue(typeof run.arm?.id === 'string', `missing arm for ${run.runId}`)
    requireValue(Number.isInteger(run.repetition), `invalid repetition for ${run.runId}`)
  }
  return true
}

function finiteMetric(metrics, key, { required = true, minimum = 0 } = {}) {
  const value = metrics?.[key]
  if (!required && value == null) return
  requireValue(Number.isFinite(value) && value >= minimum, `metric ${key} must be a finite number >= ${minimum}`)
}

export function validateDriverPayload(payload, run, expectedProvenance) {
  requireValue(payload && typeof payload === 'object', 'driver must return a JSON object')
  requireValue(FINAL_STATUSES.has(payload.status), 'driver status must be completed or failed')
  if (payload.status === 'failed') {
    requireValue(['infrastructure', 'task'].includes(payload.failure?.classification), 'failed result needs infrastructure or task classification')
    requireValue(typeof payload.failure?.code === 'string' && payload.failure.code, 'failed result needs a failure code')
    if (payload.failure.classification === 'infrastructure') return true
  }
  finiteMetric(payload.metrics, 'score')
  finiteMetric(payload.metrics, 'maxScore', { minimum: 1 })
  finiteMetric(payload.metrics, 'modelTurns')
  finiteMetric(payload.metrics, 'inputTokens')
  finiteMetric(payload.metrics, 'outputTokens')
  finiteMetric(payload.metrics, 'durationMs')
  finiteMetric(payload.metrics, 'clarificationQuestions')
  if (run.suite === 'icae') {
    finiteMetric(payload.metrics, 'hiddenFeatureScore')
    finiteMetric(payload.metrics, 'criticalRequirementsMissed')
  }
  if (run.suite === 'evocode') {
    finiteMetric(payload.metrics, 'historicalRequirementRegressions')
    finiteMetric(payload.metrics, 'cumulativeCaseScore')
  }
  requireValue(typeof payload.provenance?.graderDigest === 'string' && /^[0-9a-f]{64}$/.test(payload.provenance.graderDigest), 'graderDigest is required')
  requireValue(typeof payload.provenance?.taskDigest === 'string' && /^[0-9a-f]{64}$/.test(payload.provenance.taskDigest), 'taskDigest is required')
  requireValue(payload.provenance.harnessCommit === expectedProvenance.harnessCommit, 'driver used a different Harness commit')
  requireValue(payload.provenance.modelId === expectedProvenance.modelId, 'driver used a different model')
  requireValue(payload.provenance.modelConfigDigest === expectedProvenance.modelConfigDigest, 'driver used a different model budget/configuration')
  requireValue(payload.provenance.runtimePolicyDigest === expectedProvenance.runtimePolicyDigest, 'driver used a different runtime policy')
  requireValue(payload.provenance.endpointDigest === expectedProvenance.endpointDigest, 'driver used a different endpoint')
  requireValue(payload.provenance.sourceLockDigest === expectedProvenance.sourceLockDigest, 'driver used a different benchmark lock')
  requireValue(payload.provenance.runtimeArtifactsDigest === expectedProvenance.runtimeArtifactsDigest, 'driver used a different runtime artifact lock')
  requireValue(payload.provenance.driverSourceDigest === expectedProvenance.driverSourceDigest, 'driver source differs from the frozen manifest')
  requireValue((payload.provenance.pluginCommit ?? null) === expectedProvenance.pluginCommit, 'driver used a different plugin commit')
  if (Object.hasOwn(expectedProvenance, 'pluginPackageDigest')) {
    requireValue((payload.provenance.pluginPackageDigest ?? null) === expectedProvenance.pluginPackageDigest, 'driver used different plugin package bytes')
  }
  return true
}

export function validateResultRecord(record) {
  requireValue(record?.schemaVersion === 1, 'result schemaVersion must be 1')
  requireValue(typeof record.attemptId === 'string' && record.attemptId, 'attemptId is required')
  requireValue(typeof record.runId === 'string' && record.runId, 'runId is required')
  requireValue(Number.isInteger(record.attempt) && record.attempt >= 1, 'attempt must be >= 1')
  requireValue(['infrastructure', 'statistical'].includes(record.phase), 'invalid phase')
  requireValue(['simple', 'icae', 'evocode'].includes(record.suite), 'invalid suite')
  requireValue(typeof record.armId === 'string' && record.armId, 'armId is required')
  requireValue(FINAL_STATUSES.has(record.status), 'invalid result status')
  if (record.status === 'completed') {
    requireValue(record.metrics && typeof record.metrics === 'object', 'completed result requires metrics')
    requireValue(record.provenance && typeof record.provenance === 'object', 'completed result requires provenance')
  } else {
    requireValue(record.failure && typeof record.failure === 'object', 'failed result requires failure')
  }
  requireValue(typeof record.manifestDigest === 'string' && /^[0-9a-f]{64}$/.test(record.manifestDigest), 'manifestDigest is required')
  for (const key of ['artifactDigest', 'driverPayloadDigest', 'driverStdoutDigest', 'previousRecordDigest', 'controllerReceiptDigest', 'recordDigest']) {
    requireValue(typeof record[key] === 'string' && /^[0-9a-f]{64}$/.test(record[key]), `${key} is required`)
  }
  requireValue(typeof record.recordSignature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(record.recordSignature), 'recordSignature is required')
  requireValue(typeof record.startedAt === 'string' && typeof record.finishedAt === 'string', 'timestamps are required')
  if (record.attempt > 1) requireValue(typeof record.rerunOfAttemptId === 'string', 'rerun must link to the prior attempt')
  return true
}

export function assertNoSecrets(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secrets.filter(Boolean)) {
    requireValue(!text.includes(secret), 'result payload contains a configured secret')
  }
}

export function isExactCommit(value) {
  return HEX40.test(value)
}
