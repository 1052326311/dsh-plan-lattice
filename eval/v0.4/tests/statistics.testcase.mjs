import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeEvaluation } from '../lib/analysis.mjs'
import { RESULT_CHAIN_GENESIS, digestResultRecord } from '../lib/attempt-integrity.mjs'
import { readJson, sha256 } from '../lib/canonical.mjs'
import { pairedBootstrapInterval } from '../lib/statistics.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const preregistration = await readJson(join(root, 'preregistration.json'))
const manifest = await readJson(join(root, 'frozen-manifest.json'))
const digest = 'a'.repeat(64)
const passingRouterBlindResult = { releaseGatePassed: true, metrics: { samples: 120 } }

function bindRouterResult(manifestValue, routerBlindResult) {
  const { manifestDigest: _manifestDigest, ...core } = manifestValue
  const rebound = { ...core, routerBlindResultDigest: sha256(routerBlindResult) }
  return { ...rebound, manifestDigest: sha256(rebound) }
}

const passingManifest = bindRouterResult(manifest, passingRouterBlindResult)

function metricsFor(run) {
  const common = {
    score: 90,
    maxScore: 100,
    modelTurns: 2,
    inputTokens: 900,
    outputTokens: 100,
    durationMs: 10_000,
    clarificationQuestions: 0,
  }
  if (run.suite === 'icae') {
    return {
      ...common,
      hiddenFeatureScore: run.arm.id === 'v0.4-critical' ? 40 : 20,
      criticalRequirementsMissed: run.arm.id === 'v0.4-critical' ? 1 : 4,
      clarificationQuestions: run.arm.id === 'v0.4-critical' ? 3 : 0,
    }
  }
  if (run.suite === 'evocode') {
    return {
      ...common,
      historicalRequirementRegressions: run.arm.id === 'v0.4-lattice' ? 1 : 4,
      cumulativeCaseScore: run.arm.id === 'v0.4-lattice' ? 70 : 50,
      clarificationQuestions: run.arm.id === 'v0.4-lattice' ? 3 : 0,
    }
  }
  return common
}

function passingRecords(manifestValue = passingManifest) {
  return sealRecords([...manifestValue.infrastructureRuns, ...manifestValue.statisticalRuns].map((run, index) => ({
    schemaVersion: 1,
    attemptId: `attempt-${index}`,
    runId: run.runId,
    attempt: 1,
    phase: run.phase,
    suite: run.suite,
    armId: run.arm.id,
    status: 'completed',
    metrics: metricsFor(run),
    provenance: {
      graderDigest: digest,
      taskDigest: digest,
      harnessCommit: manifestValue.sourceCommits.harness,
      modelId: manifestValue.model.modelId,
      modelConfigDigest: sha256(manifestValue.model),
      runtimePolicyDigest: sha256(manifestValue.runtimePolicy),
      endpointDigest: digest,
      sourceLockDigest: manifestValue.sourceLockDigest,
      runtimeArtifactsDigest: manifestValue.runtimeArtifactsDigest,
      driverSourceDigest: manifestValue.driverSourceDigest,
      pluginCommit: run.arm.plugin === 'none'
        ? null
        : run.arm.plugin === 'v0.3.0'
          ? manifestValue.pluginCommits['v0.3.0']
          : manifestValue.pluginCommits['v0.4.0Candidate'],
    },
    manifestDigest: manifestValue.manifestDigest,
    startedAt: '2026-08-15T00:00:00.000Z',
    finishedAt: '2026-08-15T00:01:00.000Z',
    stderrDigest: digest,
  })))
}

function sealRecords(records) {
  let previousRecordDigest = RESULT_CHAIN_GENESIS
  return records.map((record) => {
    const sealed = {
      ...record,
      artifactDigest: digest,
      driverPayloadDigest: digest,
      driverStdoutDigest: digest,
      previousRecordDigest,
      controllerReceiptDigest: digest,
    }
    sealed.recordDigest = digestResultRecord(sealed)
    previousRecordDigest = sealed.recordDigest
    return sealed
  })
}

test('a complete synthetic result set can pass every frozen gate', () => {
  const analysis = analyzeEvaluation({ preregistration, manifest: passingManifest, records: passingRecords(), routerBlindResult: passingRouterBlindResult })
  assert.equal(analysis.releaseAllowed, true)
  assert.equal(analysis.integrity.resolvedStatisticalSlots, 90)
  assert.equal(analysis.integrity.resolvedInfrastructureSlots, 6)
  assert.equal(analysis.icae.independentTasks, 6)
  assert.equal(analysis.icae.hiddenFeatureBootstrap.independentUnits, 6)
  assert.equal(analysis.evocode.independentTasks, 3)
  assert.equal(analysis.evocode.cumulativeCaseBootstrap.independentUnits, 3)
})

test('the RC.4 analyzer requires complete proxy accounting for every resolved attempt', () => {
  const missing = analyzeEvaluation({
    preregistration,
    manifest: passingManifest,
    records: passingRecords(),
    routerBlindResult: passingRouterBlindResult,
    requireProxyAccounting: true,
  })
  assert.equal(missing.releaseAllowed, false)
  assert.equal(missing.integrity.gates.find(entry => entry.name === 'complete proxy audit role and token accounting').passed, false)

  const records = passingRecords().map(record => ({
    ...record,
    metrics: {
      ...record.metrics,
      proxyAgentRequests: record.metrics.modelTurns,
      proxyOracleRequests: 0,
      oracleInputTokens: 0,
      oracleOutputTokens: 0,
    },
  }))
  const complete = analyzeEvaluation({
    preregistration,
    manifest: passingManifest,
    records: sealRecords(records),
    routerBlindResult: passingRouterBlindResult,
    requireProxyAccounting: true,
  })
  assert.equal(complete.releaseAllowed, true)
  assert.equal(complete.integrity.proxyAccounting.resolvedAttempts, 96)
})

test('the release gate blocks an ICAE result below the uplift threshold', () => {
  const records = passingRecords()
  for (const record of records) {
    if (record.suite === 'icae' && record.armId === 'v0.4-critical') {
      record.metrics.hiddenFeatureScore = 25
    }
  }
  const analysis = analyzeEvaluation({ preregistration, manifest: passingManifest, records: sealRecords(records), routerBlindResult: passingRouterBlindResult })
  assert.equal(analysis.releaseAllowed, false)
  assert.equal(analysis.icae.gates.find((entry) => entry.name === 'ICAE relative hidden-feature uplift').passed, false)
})

test('an incomplete result set never releases', () => {
  const records = passingRecords()
  records.splice(7, 1)
  const analysis = analyzeEvaluation({ preregistration, manifest: passingManifest, records: sealRecords(records), routerBlindResult: passingRouterBlindResult })
  assert.equal(analysis.releaseAllowed, false)
  assert.equal(analysis.integrity.missingRunIds.length, 1)
})

test('paired bootstrap is deterministic for a fixed seed', () => {
  const first = pairedBootstrapInterval([10, 20, 30, 40], { samples: 1000, seed: 'fixed' })
  const second = pairedBootstrapInterval([10, 20, 30, 40], { samples: 1000, seed: 'fixed' })
  assert.deepEqual(first, second)
  assert.ok(first.lower > 0)
})

test('paired bootstrap resamples independent tasks instead of treating repetitions as new tasks', () => {
  const differences = [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, -20, -20]
  const taskIds = ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd', 'e', 'e', 'f', 'f']
  const clustered = pairedBootstrapInterval(differences, { clusters: taskIds, samples: 20_000, seed: 'cluster-proof' })
  const pseudoReplicated = pairedBootstrapInterval(differences, { samples: 20_000, seed: 'cluster-proof' })

  assert.equal(clustered.observations, 12)
  assert.equal(clustered.independentUnits, 6)
  assert.equal(clustered.lower, 0)
  assert.ok(pseudoReplicated.lower > 0)
})

test('an unauthorized rerun blocks release even when its outcome passes', () => {
  const records = passingRecords()
  const original = records[0]
  records.push({
    ...original,
    attemptId: 'unauthorized-attempt',
    attempt: 2,
    rerunOfAttemptId: original.attemptId,
  })
  const analysis = analyzeEvaluation({ preregistration, manifest: passingManifest, records: sealRecords(records), routerBlindResult: passingRouterBlindResult })
  assert.equal(analysis.releaseAllowed, false)
  assert.match(analysis.integrity.errors.join('\n'), /unauthorized rerun/)
})

test('an allowed infrastructure rerun keeps both attempts and resolves the slot', () => {
  const records = passingRecords()
  const original = records[0]
  const completed = { ...original, attemptId: 'recovered-attempt', attempt: 2, rerunOfAttemptId: 'infra-attempt' }
  records[0] = {
    ...original,
    attemptId: 'infra-attempt',
    status: 'failed',
    failure: {
      classification: 'infrastructure',
      code: 'host_network_outage',
      message: 'network unavailable before completion',
    },
  }
  delete records[0].metrics
  delete records[0].provenance
  records.push(completed)
  const analysis = analyzeEvaluation({ preregistration, manifest: passingManifest, records: sealRecords(records), routerBlindResult: passingRouterBlindResult })
  assert.equal(analysis.releaseAllowed, true)
  assert.equal(analysis.integrity.retainedAttemptCount, 97)
})

test('statistical success cannot release without all six infrastructure runs', () => {
  const records = passingRecords().filter(record => record.phase === 'statistical')
  const analysis = analyzeEvaluation({ preregistration, manifest: passingManifest, records, routerBlindResult: passingRouterBlindResult })
  assert.equal(analysis.releaseAllowed, false)
  assert.equal(analysis.integrity.resolvedInfrastructureSlots, 0)
})

test('a failed real-source router blind gate blocks an otherwise passing matrix', () => {
  const routerBlindResult = { releaseGatePassed: false, metrics: { simpleFalseActivationRate: 0.575 } }
  const failedManifest = bindRouterResult(manifest, routerBlindResult)
  const analysis = analyzeEvaluation({
    preregistration,
    manifest: failedManifest,
    records: passingRecords(failedManifest),
    routerBlindResult,
  })
  assert.equal(analysis.releaseAllowed, false)
  assert.equal(analysis.integrity.gates.find((entry) => entry.name === 'real-source router blind precondition').passed, false)
})
