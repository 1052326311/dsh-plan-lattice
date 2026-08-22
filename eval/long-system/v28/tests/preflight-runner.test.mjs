import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { V28_EXECUTION_PLAN, V28_PROTOCOL_ID } from '../analysis.mjs'
import { V28_UPSTREAM_BASE_URL_SHA256 } from '../manifest.mjs'
import { inspectModelEnvironment } from '../preflight.mjs'
import {
  attachV28AttemptSignature,
  executeStartedSlot,
  claimV28Trial,
  persistFatalTrialRecord,
  runComparativeTrial,
} from '../run-calibrations.mjs'
import { buildCandidateActivationReceiptBody } from '../driver/evocode-runner.mjs'
import { canonicalJson, sha256 } from '../../../v0.4/lib/canonical.mjs'

function analysis(attempts) {
  const legal = attempts.every((attempt, index) => attempt.arm === V28_EXECUTION_PLAN[index].arm)
  return {
    schemaVersion: 2,
    candidateExecutionAllowed: legal,
    releaseAllowed: legal && attempts.length === V28_EXECUTION_PLAN.length
      && attempts.every(attempt => attempt.status === 'completed'),
    qualification: { passed: legal, gates: [] },
  }
}

function candidateActivations(attemptId) {
  const body = buildCandidateActivationReceiptBody({
    attemptId,
    epoch: 1,
    epochSha256: 'f'.repeat(64),
    processPid: 12345,
    processNonce: '1'.repeat(64),
    pluginIdentity: {
      candidateCommit: 'c'.repeat(40),
      candidateVersion: '0.4.0-rc.9',
      candidatePackageSha256: 'a'.repeat(64),
      candidatePayloadSha256: 'b'.repeat(64),
      wrapperPackageSha256: 'd'.repeat(64),
    },
    pluginConfig: {
      activationMode: 'auto',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
    },
    bashAdapterSha256: 'e'.repeat(64),
  })
  return [{ ...body, activationReceiptDigest: sha256(body) }]
}

test('reports credential presence without returning the secret', () => {
  const secret = 'test-only-secret-value'
  const result = inspectModelEnvironment({
    DEEPSEEK_API_KEY: secret,
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  })
  assert.deepEqual(result, {
    credentialPresent: true,
    endpointValid: true,
    endpoint: 'https://api.deepseek.com',
    endpointSha256: V28_UPSTREAM_BASE_URL_SHA256,
  })
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
  assert.equal(inspectModelEnvironment({
    DEEPSEEK_API_KEY: secret,
    DEEPSEEK_BASE_URL: 'https://user:secret@example.com',
  }).endpointValid, false)
  assert.deepEqual(inspectModelEnvironment({
    DEEPSEEK_API_KEY: secret,
    DEEPSEEK_BASE_URL: 'https://attacker.example/v1',
  }), {
    credentialPresent: true,
    endpointValid: false,
    endpoint: null,
    endpointSha256: null,
  })
})

test('runs the exact twelve-pair AB/BA plan even when Native observations vary', async () => {
  const calls = []
  const checkpoints = []
  const result = await runComparativeTrial({
    protocolId: V28_PROTOCOL_ID,
    analyze: ({ attempts }) => analysis(attempts),
    async executeAttempt(slot) {
      calls.push(slot)
      const id = `attempt-${slot.label}`
      return {
        id,
        arm: slot.arm,
        status: 'completed',
        descriptiveScore: slot.arm === 'native' ? [0, 0, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0][slot.pair - 1] : 100,
        evidence: {
          processEpochs: 1,
          candidateActivations: slot.arm === 'native' ? [] : candidateActivations(id),
        },
      }
    },
    async writeCheckpoint(name) { checkpoints.push(name) },
  })

  assert.deepEqual(calls.map(({ pair, arm, label }) => ({ pair, arm, label })), V28_EXECUTION_PLAN)
  assert.equal(result.attempts.length, 24)
  assert.equal(result.candidateExecuted, true)
  assert.equal(result.analysis.releaseAllowed, true)
  assert.deepEqual(checkpoints, [
    ...V28_EXECUTION_PLAN.map(slot => `${slot.label}.json`),
    'trial-analysis.json',
  ])
})

test('stops on an infrastructure-invalid slot without replacing or rerunning it', async () => {
  const calls = []
  const result = await runComparativeTrial({
    protocolId: V28_PROTOCOL_ID,
    analyze: ({ attempts }) => analysis(attempts),
    async executeAttempt(slot) {
      calls.push(slot.label)
      const id = `attempt-${slot.label}`
      const status = slot.label === 'pair-2-candidate' ? 'failed' : 'completed'
      return {
        id,
        arm: slot.arm,
        status,
        evidence: {
          processEpochs: 1,
          candidateActivations: slot.arm === 'v0.4-native-continuity' && status === 'completed'
            ? candidateActivations(id)
            : [],
        },
      }
    },
  })

  assert.deepEqual(calls, ['pair-1-native', 'pair-1-candidate', 'pair-2-candidate'])
  assert.equal(result.attempts.length, 3)
  assert.equal(result.candidateExecuted, true)
  assert.equal(result.analysis.releaseAllowed, false)
})

test('passes pair identity and per-arm ordinal to every paid attempt', async () => {
  const observed = []
  await runComparativeTrial({
    protocolId: V28_PROTOCOL_ID,
    analyze: ({ attempts }) => analysis(attempts),
    async executeAttempt(slot) {
      observed.push({ pair: slot.pair, ordinal: slot.ordinal, arm: slot.arm })
      return { id: `attempt-${slot.label}`, arm: slot.arm, status: 'completed' }
    },
  })
  assert.ok(observed.every(entry => entry.ordinal === entry.pair))
  assert.equal(observed.filter(entry => entry.arm === 'native').length, 12)
  assert.equal(observed.filter(entry => entry.arm === 'v0.4-native-continuity').length, 12)
})

test('treats preparation and execution faults as trial-invalid infrastructure failures', async () => {
  for (const [label, failIn] of [
    ['directory creation', 'prepare'],
    ['workspace copy', 'prepare'],
    ['proxy activation', 'prepare'],
    ['Harness execution', 'execute'],
  ]) {
    await assert.rejects(executeStartedSlot({
      attemptId: `attempt-${label.replaceAll(' ', '-')}`,
      arm: 'native',
      async prepare() {
        if (failIn === 'prepare') throw new Error(label)
      },
      async execute() {
        if (failIn === 'execute') throw new Error(label)
        return { id: 'unexpected', arm: 'native', status: 'completed' }
      },
      async seal(value) { return { ...value, sealed: true } },
    }), new RegExp(label))
  }
})

test('does not disguise execution or sealing faults as a scoreable slot', async () => {
  await assert.rejects(executeStartedSlot({
    attemptId: 'attempt-seal-fault',
    arm: 'native',
    async prepare() {},
    async execute() { throw new Error('execute') },
    async seal() { throw new Error('seal') },
    async writeFailure() {},
  }), /execute/)

  await assert.rejects(executeStartedSlot({
    attemptId: 'attempt-seal-fault',
    arm: 'native',
    async prepare() {},
    async execute() { return { status: 'completed' } },
    async seal() { throw new Error('seal') },
  }), /seal/)
})

test('emits the same schema-v3 signing envelope required by the disk verifier', () => {
  const body = {
    schemaVersion: 3,
    attemptId: 'v28-signing-contract-attempt',
    runId: 'v28-signing-contract-run',
    ordinal: 1,
    signingLedgerId: 'plan-lattice-v28-signing-contract',
    executionEnvelopeDigest: 'e'.repeat(64),
    manifestDigest: 'f'.repeat(64),
    manifestCommit: 'c'.repeat(40),
    previousRecordDigest: '0'.repeat(64),
    recordDigest: 'a'.repeat(64),
  }
  const signed = attachV28AttemptSignature({
    attempt: { id: body.attemptId, evidence: { retained: true } },
    body,
    signaturePayloadDigest: sha256(canonicalJson(body)),
    signature: 's'.repeat(64),
  })
  assert.deepEqual(signed.evidence.signing, {
    schemaVersion: 3,
    body,
    signaturePayloadDigest: sha256(canonicalJson(body)),
    signature: 's'.repeat(64),
  })
})

test('checkpoint faults stop the plan and invoke the fatal terminal hook exactly once', async () => {
  const calls = []
  const fatals = []
  await assert.rejects(runComparativeTrial({
    protocolId: V28_PROTOCOL_ID,
    async executeAttempt(slot) {
      calls.push(slot.label)
      return { id: `attempt-${slot.label}`, arm: slot.arm, status: 'completed' }
    },
    async writeCheckpoint() { throw new Error('checkpoint') },
    async recordFatal(value) { fatals.push(value) },
  }), /checkpoint/)
  assert.deepEqual(calls, ['pair-1-native'])
  assert.equal(fatals.length, 1)
  assert.equal(fatals[0].phase, 'checkpoint-persistence')
})

test('persists one fsync-backed inconclusive run record and refuses replacement', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-fatal-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const options = {
    outputRoot: root,
    runId: 'v28-fatal-fixture',
    manifest: { protocolId: V28_PROTOCOL_ID, manifestDigest: 'f'.repeat(64) },
    phase: 'checkpoint-persistence',
    error: new Error('fixture failure'),
    manifestCommit: 'c'.repeat(40),
  }
  const record = await persistFatalTrialRecord(options)
  assert.equal(record.status, 'inconclusive')
  assert.equal(record.rerunAllowed, false)
  assert.deepEqual(JSON.parse(await readFile(
    join(root, `v28-trial-fatal-${options.manifest.manifestDigest}.json`),
    'utf8',
  )), record)
  await assert.rejects(persistFatalTrialRecord(options), error => error?.code === 'EEXIST')
})

test('binds a frozen manifest to one disclosed run identity while its claim remains present', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-claim-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const manifestCommit = 'c'.repeat(40)
  const manifest = {
    protocolId: V28_PROTOCOL_ID,
    manifestDigest: 'd'.repeat(64),
    trial: { runId: 'v28-first-run' },
    outputPolicy: { absoluteRoot: root },
  }
  const first = await claimV28Trial({ outputRoot: root, runId: 'v28-first-run', manifest, manifestCommit })
  assert.equal(first.claim.rerunAllowed, false)
  await assert.rejects(
    claimV28Trial({ outputRoot: root, runId: 'v28-replacement-run', manifest, manifestCommit }),
    /unique output root and run ID/,
  )
  await assert.rejects(
    claimV28Trial({ outputRoot: join(root, 'replacement'), runId: 'v28-first-run', manifest, manifestCommit }),
    /unique output root and run ID/,
  )
  await assert.rejects(
    claimV28Trial({ outputRoot: root, runId: 'v28-first-run', manifest, manifestCommit }),
    error => error?.code === 'EEXIST',
  )
})
