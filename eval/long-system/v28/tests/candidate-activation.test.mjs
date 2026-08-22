import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../../v0.4/lib/canonical.mjs'
import {
  buildCandidateActivationReceiptBody,
  candidateActivationReceiptName,
  candidateActivationProven,
  readCandidateActivationReceipt,
  validateCandidateActivations,
  validateCandidateActivationReceipt,
} from '../driver/evocode-runner.mjs'
import { verifyV28CandidateActivationEvidence } from '../report-verifier.mjs'
import { buildV28Protocol } from '../protocol.mjs'

const ATTEMPT_ID = 'v28-activation-fixture-pair-1-candidate'
const PLUGIN_IDENTITY = {
  candidateCommit: 'c'.repeat(40),
  candidateVersion: '0.4.0-rc.9',
  candidatePackageSha256: 'a'.repeat(64),
  candidatePayloadSha256: 'b'.repeat(64),
  wrapperPackageSha256: 'd'.repeat(64),
}
const PLUGIN_CONFIG = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
}
const ADAPTER_BYTES = Buffer.from('retained adapter fixture\n')
const PROCESS_PID = process.pid
const PROCESS_NONCE = '1'.repeat(64)
const EPOCH = { schemaVersion: 1, epoch: 1, rootSessionId: 'fixture-session', stages: [{ id: 'fixture' }] }

function activationProcess(overrides = {}) {
  return {
    epoch: overrides.epoch ?? EPOCH.epoch,
    epochSha256: overrides.epochSha256 ?? sha256(EPOCH),
    processPid: overrides.processPid ?? PROCESS_PID,
    processNonce: overrides.processNonce ?? PROCESS_NONCE,
  }
}

function receiptFixture(overrides = {}) {
  const process = activationProcess(overrides)
  const body = buildCandidateActivationReceiptBody({
    attemptId: ATTEMPT_ID,
    ...process,
    pluginIdentity: PLUGIN_IDENTITY,
    pluginConfig: PLUGIN_CONFIG,
    bashAdapterSha256: sha256(ADAPTER_BYTES),
  })
  return { ...body, activationReceiptDigest: sha256(body) }
}

function receiptFrom(overrides = {}) {
  const process = activationProcess(overrides)
  const body = buildCandidateActivationReceiptBody({
    attemptId: overrides.attemptId ?? ATTEMPT_ID,
    ...process,
    pluginIdentity: { ...PLUGIN_IDENTITY, ...(overrides.pluginIdentity ?? {}) },
    pluginConfig: { ...PLUGIN_CONFIG, ...(overrides.pluginConfig ?? {}) },
    bashAdapterSha256: overrides.bashAdapterSha256 ?? sha256(ADAPTER_BYTES),
  })
  return { ...body, activationReceiptDigest: sha256(body) }
}

async function loadInstalledWrapper(context) {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-installed-wrapper-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const wrapperRoot = join(root, 'node_modules', 'dsh-plan-lattice-long-system-wrapper')
  const candidateRoot = join(wrapperRoot, 'node_modules', 'dsh-plan-lattice')
  await cp(new URL('../driver/candidate-wrapper', import.meta.url), wrapperRoot, { recursive: true })
  await mkdir(candidateRoot, { recursive: true })
  await Promise.all([
    writeFile(join(candidateRoot, 'package.json'), JSON.stringify({
      name: 'dsh-plan-lattice',
      version: '0.4.0-rc.9',
      type: 'module',
      exports: './index.js',
    })),
    writeFile(join(candidateRoot, 'index.js'), [
      'export function apply() {',
      "  if (process.env.PLAN_LATTICE_TEST_APPLY_FAILURE === '1') throw new Error('candidate apply failed')",
      '}',
      '',
    ].join('\n')),
  ])
  return import(`${pathToFileURL(join(wrapperRoot, 'index.js')).href}?fixture=${Date.now()}`)
}

test('writes activation evidence only after candidate apply succeeds', async context => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-activation-apply-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const wrapper = await loadInstalledWrapper(context)
  const path = join(root, candidateActivationReceiptName(1))
  const unexpectedConfigPath = join(root, 'unexpected-config.json')
  const previous = Object.fromEntries([
    'DSH_PLAN_LATTICE_EVAL_ATTEMPT_ID',
    'DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_RECEIPT_PATH',
    'DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_IDENTITY_JSON',
    'DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_PROCESS_JSON',
    'PLAN_LATTICE_TEST_APPLY_FAILURE',
  ].map(name => [name, process.env[name]]))
  const ctx = { on() {}, inject() {}, tools: { guard() {} } }
  try {
    process.env.DSH_PLAN_LATTICE_EVAL_ATTEMPT_ID = ATTEMPT_ID
    process.env.DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_RECEIPT_PATH = path
    process.env.DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_IDENTITY_JSON = JSON.stringify({
      attemptId: ATTEMPT_ID,
      ...PLUGIN_IDENTITY,
    })
    process.env.DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_PROCESS_JSON = JSON.stringify({
      epoch: 1,
      epochSha256: sha256(EPOCH),
      processNonce: PROCESS_NONCE,
    })
    process.env.PLAN_LATTICE_TEST_APPLY_FAILURE = '1'
    assert.throws(() => wrapper.apply(ctx, PLUGIN_CONFIG), /candidate apply failed/)
    await assert.rejects(readFile(path), error => error?.code === 'ENOENT')

    delete process.env.PLAN_LATTICE_TEST_APPLY_FAILURE
    wrapper.apply(ctx, PLUGIN_CONFIG)
    const receipt = JSON.parse(await readFile(path, 'utf8'))
    validateCandidateActivationReceipt(receipt, { attemptId: ATTEMPT_ID })

    process.env.DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_RECEIPT_PATH = unexpectedConfigPath
    assert.throws(
      () => wrapper.apply(ctx, { ...PLUGIN_CONFIG, unboundOption: true }),
      /config differs from the frozen wrapper contract/,
    )
    await assert.rejects(readFile(unexpectedConfigPath), error => error?.code === 'ENOENT')
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('persists a canonical private durable activation receipt and accepts an exact same-process replay', async context => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-activation-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, candidateActivationReceiptName(1))
  const receipt = receiptFixture()
  const wrapper = await loadInstalledWrapper(context)
  assert.deepEqual(wrapper.buildCandidateActivationReceipt(
    { attemptId: ATTEMPT_ID, ...PLUGIN_IDENTITY },
    { epoch: 1, epochSha256: sha256(EPOCH), processNonce: PROCESS_NONCE },
    PLUGIN_CONFIG,
    ADAPTER_BYTES,
  ), receipt)

  wrapper.persistCandidateActivationReceipt(path, receipt)
  const firstBytes = await readFile(path)
  const firstStat = await stat(path, { bigint: true })
  assert.equal(firstBytes.toString('utf8'), canonicalJson(receipt))
  assert.equal(Number(firstStat.mode & 0o777n), 0o600)
  assert.deepEqual(await readCandidateActivationReceipt({
    receiptPath: path,
    expectedBody: buildCandidateActivationReceiptBody({
      attemptId: ATTEMPT_ID,
      ...activationProcess({ processPid: process.pid }),
      pluginIdentity: PLUGIN_IDENTITY,
      pluginConfig: PLUGIN_CONFIG,
      bashAdapterSha256: sha256(ADAPTER_BYTES),
    }),
    candidate: true,
  }), receipt)

  wrapper.persistCandidateActivationReceipt(path, receipt)
  const restartedStat = await stat(path, { bigint: true })
  assert.equal(restartedStat.ino, firstStat.ino)
  assert.equal(restartedStat.mtimeNs, firstStat.mtimeNs)
  assert.deepEqual(await readFile(path), firstBytes)
})

test('rejects a missing candidate receipt while Native requires it to remain absent', async context => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-activation-missing-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, candidateActivationReceiptName(1))
  await assert.rejects(readCandidateActivationReceipt({
    receiptPath: path,
    expectedBody: {},
    candidate: true,
  }), /receipt is missing/)
  assert.equal(await readCandidateActivationReceipt({
    receiptPath: path,
    candidate: false,
  }), null)
  await writeFile(path, '{}\n')
  await assert.rejects(readCandidateActivationReceipt({
    receiptPath: path,
    candidate: false,
  }), /native attempt unexpectedly produced/)
})

test('binds attempt, wrapper, candidate, config, and Bash adapter identities', () => {
  const receipt = receiptFixture()
  const expectedBody = buildCandidateActivationReceiptBody({
    attemptId: ATTEMPT_ID,
    ...activationProcess(),
    pluginIdentity: PLUGIN_IDENTITY,
    pluginConfig: PLUGIN_CONFIG,
    bashAdapterSha256: sha256(ADAPTER_BYTES),
  })
  validateCandidateActivationReceipt(receipt, { attemptId: ATTEMPT_ID, body: expectedBody })
  const secondReceipt = receiptFrom({
    epoch: 2,
    epochSha256: '2'.repeat(64),
    processPid: PROCESS_PID + 1,
    processNonce: '2'.repeat(64),
  })
  assert.equal(candidateActivationProven({
    id: ATTEMPT_ID,
    arm: 'v0.4-native-continuity',
    status: 'completed',
    evidence: {
      outcome: { class: 'completed' },
      processEpochs: 2,
      candidateActivations: [receipt, secondReceipt],
    },
  }), true)
  assert.equal(candidateActivationProven({
    id: ATTEMPT_ID,
    arm: 'v0.4-native-continuity',
    status: 'completed',
    evidence: {
      outcome: { class: 'completed' },
      processEpochs: 1,
      candidateActivations: [receipt],
    },
  }), false)

  for (const changed of [
    receiptFrom({ attemptId: 'v28-different-attempt' }),
    receiptFrom({ pluginIdentity: { wrapperPackageSha256: 'e'.repeat(64) } }),
    receiptFrom({ pluginIdentity: { candidatePayloadSha256: 'e'.repeat(64) } }),
    receiptFrom({ pluginConfig: { controlCeiling: 'different' } }),
    receiptFrom({ bashAdapterSha256: 'e'.repeat(64) }),
  ]) {
    assert.throws(() => validateCandidateActivationReceipt(changed, {
      attemptId: ATTEMPT_ID,
      body: expectedBody,
    }), /mismatch/)
  }
})

test('requires one unique activation receipt for every actual Harness process', () => {
  const firstStartedAt = '2026-08-22T00:00:00.000Z'
  const secondStartedAt = '2026-08-22T01:00:00.000Z'
  const secondEpoch = { ...EPOCH, epoch: 2 }
  const receipts = [
    receiptFixture(),
    receiptFixture({
      epoch: 2,
      epochSha256: sha256(secondEpoch),
      processPid: PROCESS_PID + 1,
      processNonce: '2'.repeat(64),
    }),
  ]
  const processLedger = [
    {
      epochId: 'epoch-1', pid: PROCESS_PID, startedAt: firstStartedAt,
      processId: `${PROCESS_PID}@${firstStartedAt}`,
    },
    {
      epochId: 'epoch-2', pid: PROCESS_PID + 1, startedAt: secondStartedAt,
      processId: `${PROCESS_PID + 1}@${secondStartedAt}`,
    },
  ]
  assert.deepEqual(validateCandidateActivations(receipts, {
    attemptId: ATTEMPT_ID,
    processLedger,
    expectedEpochs: [EPOCH, secondEpoch],
  }), receipts)
  assert.throws(() => validateCandidateActivations([receipts[0]], {
    attemptId: ATTEMPT_ID,
    processLedger,
  }), /process count/)
  assert.throws(() => validateCandidateActivations([receipts[0], receipts[0]], {
    attemptId: ATTEMPT_ID,
    processLedger,
  }), /Harness process|reused/)
})

test('same process refuses mismatched bytes without replacing its receipt', async context => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-activation-restart-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, candidateActivationReceiptName(1))
  const receipt = receiptFixture()
  const wrapper = await loadInstalledWrapper(context)
  wrapper.persistCandidateActivationReceipt(path, receipt)
  const original = await readFile(path)
  const mismatched = wrapper.buildCandidateActivationReceipt(
    { attemptId: 'v28-different-attempt', ...PLUGIN_IDENTITY },
    { epoch: 1, epochSha256: sha256(EPOCH), processNonce: PROCESS_NONCE },
    PLUGIN_CONFIG,
    ADAPTER_BYTES,
  )
  assert.throws(
    () => wrapper.persistCandidateActivationReceipt(path, mismatched),
    /differs within one Harness process/,
  )
  assert.deepEqual(await readFile(path), original)
})

test('final disk verifier rereads the receipt and rejects missing or cross-layer mismatch', async context => {
  const runRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-activation-final-'))
  context.after(() => rm(runRoot, { recursive: true, force: true }))
  const nativeRoot = join(runRoot, 'attempts', 'pair-1-native')
  const attemptRoot = join(runRoot, 'attempts', 'pair-1-candidate')
  const retained = join(
    runRoot,
    'input-snapshot',
    'driver-repository',
    'eval',
    'long-system',
    'v28',
    'driver',
    'candidate-wrapper',
    'workspace-shell-adapter.js',
  )
  const installed = join(
    attemptRoot,
    'dsh-home',
    'profiles',
    'headless',
    'node_modules',
    'dsh-plan-lattice-long-system-wrapper',
    'workspace-shell-adapter.js',
  )
  const taskRoot = join(runRoot, 'input-snapshot', 'task')
  const rootSessionId = 'v28-activation-final-session'
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([
    mkdir(join(attemptRoot), { recursive: true }),
    mkdir(nativeRoot, { recursive: true }),
    mkdir(join(retained, '..'), { recursive: true }),
    mkdir(join(installed, '..'), { recursive: true }),
    ...Array.from({ length: 9 }, (_, index) => mkdir(
      join(taskRoot, 'steps', `round-${index + 1}`), { recursive: true },
    )),
  ]))
  await Promise.all([
    writeFile(retained, ADAPTER_BYTES),
    writeFile(installed, ADAPTER_BYTES),
    ...Array.from({ length: 9 }, (_, index) => writeFile(
      join(taskRoot, 'steps', `round-${index + 1}`, 'instruction.md'),
      `Fixture instruction ${index + 1}\n`,
    )),
  ])
  const protocol = await buildV28Protocol(taskRoot, rootSessionId)
  const epoch = protocol.epochs[0]
  const receipt = receiptFixture({ epochSha256: sha256(epoch) })
  const receiptPath = join(attemptRoot, candidateActivationReceiptName(1))
  const wrapper = await loadInstalledWrapper(context)
  wrapper.persistCandidateActivationReceipt(receiptPath, receipt)
  const processLedger = [{
    epochId: 'epoch-1',
    pid: PROCESS_PID,
    startedAt: '2026-08-22T00:00:00.000Z',
    processId: `${PROCESS_PID}@2026-08-22T00:00:00.000Z`,
  }]
  const attempt = {
    id: ATTEMPT_ID,
    arm: 'v0.4-native-continuity',
    status: 'completed',
    evidence: { processEpochs: 1, candidateActivations: [receipt] },
  }
  const raw = {
    rootSessionId,
    outcome: { class: 'premature-terminal' },
    processLedger,
    pluginConfig: PLUGIN_CONFIG,
    pluginIdentity: PLUGIN_IDENTITY,
    wrapperPackageSha256: PLUGIN_IDENTITY.wrapperPackageSha256,
    candidateActivations: [receipt],
  }
  const manifest = {
    candidate: {
      mode: PLUGIN_CONFIG,
      commit: PLUGIN_IDENTITY.candidateCommit,
      packageVersion: PLUGIN_IDENTITY.candidateVersion,
      tarballSha256: PLUGIN_IDENTITY.candidatePackageSha256,
    },
  }
  const nativeAttempt = {
    id: 'v28-activation-fixture-pair-1-native',
    arm: 'native',
    status: 'completed',
    evidence: { processEpochs: 1, candidateActivations: [] },
  }
  assert.deepEqual(await verifyV28CandidateActivationEvidence({
    attempt: nativeAttempt,
    attemptRoot: nativeRoot,
    raw: { candidateActivations: [] },
    manifest,
  }), [])
  await writeFile(join(nativeRoot, candidateActivationReceiptName(1)), canonicalJson(receipt), { mode: 0o600 })
  await assert.rejects(verifyV28CandidateActivationEvidence({
    attempt: nativeAttempt,
    attemptRoot: nativeRoot,
    raw: { candidateActivations: [] },
    manifest,
  }), /has a candidate activation receipt on disk/)

  assert.deepEqual(await verifyV28CandidateActivationEvidence({
    attempt, attemptRoot, raw, manifest,
  }), [receipt])

  const falselyCompleted = structuredClone(raw)
  falselyCompleted.outcome = { class: 'completed' }
  await assert.rejects(verifyV28CandidateActivationEvidence({
    attempt, attemptRoot, raw: falselyCompleted, manifest,
  }), /receipt set differs/)

  const mismatch = structuredClone(raw)
  mismatch.candidateActivations = [{ ...receipt, candidateVersion: 'different' }]
  await assert.rejects(verifyV28CandidateActivationEvidence({
    attempt, attemptRoot, raw: mismatch, manifest,
  }), /differs across evidence layers/)
  await unlink(receiptPath)
  await assert.rejects(verifyV28CandidateActivationEvidence({
    attempt, attemptRoot, raw, manifest,
  }), /receipt set differs/)
})
