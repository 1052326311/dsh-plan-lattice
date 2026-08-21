import { spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { analyzeV27, V27_EXECUTION_PLAN, V27_PROTOCOL_ID } from './analysis.mjs'
import { summarizeOfficialRounds } from './benchmark.mjs'
import { FROZEN_MANIFEST_PATH, readV27FrozenManifest } from './manifest.mjs'
import { inspectV27PublicManifestCommit } from './public-anchor.mjs'
import { isolatedGit } from './git-safety.mjs'
import { assertV27ExecutionSnapshotIdentity } from './execution-snapshot.mjs'
import { gradeV27Trace, sessionTreeSha256 } from './trace-grader.mjs'
import { buildV27Protocol } from './protocol.mjs'
import { inspectCandidatePackage, inspectHarnessRuntime, writeJsonExclusive } from './freeze.mjs'
import { digestTree, immutableTreeSha256 } from './driver/runtime.mjs'
import { assertV27CheckoutIntegrity } from './checkout-integrity.mjs'
import {
  buildCandidateActivationReceiptBody,
  candidateActivationProven,
  candidateActivationReceiptName,
  validateCandidateActivations,
  validateCandidateActivationReceipt,
} from './driver/evocode-runner.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function materializeTrustedRuntime(manifest, runtimePath) {
  if (typeof runtimePath !== 'string' || runtimePath.length === 0) {
    throw new Error(`${manifest.harness.runtimePathEnvironmentVariable} is required for trusted Session decoding`)
  }
  const inspected = await inspectHarnessRuntime(runtimePath)
  if (inspected.sha256 !== manifest.harness.runtimeSha256
    || inspected.metadataSha256 !== manifest.harness.runtimeMetadataSha256
    || inspected.platform !== manifest.harness.platform
    || inspected.architecture !== manifest.harness.architecture
    || inspected.node !== manifest.harness.node) {
    throw new Error('trusted V27 Harness runtime differs from the frozen manifest')
  }
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-trusted-runtime-'))
  const extracted = spawnSync('tar', ['-xzf', resolve(runtimePath), '-C', root], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (extracted.error || extracted.status !== 0) {
    await rm(root, { recursive: true, force: true })
    throw extracted.error ?? new Error((extracted.stderr || 'trusted Harness extraction failed').trim())
  }
  const sessionPackageRoot = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session')
  const decoderModulePath = join(sessionPackageRoot, 'lib', 'index.js')
  try {
    if (!(await stat(decoderModulePath)).isFile()) throw new Error('not a file')
  } catch {
    await rm(root, { recursive: true, force: true })
    throw new Error('trusted V27 Harness runtime has no Session decoder')
  }
  return {
    root,
    decoderModulePath,
    sessionPackageSha256: await immutableTreeSha256(sessionPackageRoot),
  }
}

const includeCandidatePayload = (relativePath, entry) => entry.isDirectory()
  ? relativePath === 'lib' || relativePath.startsWith('lib/')
  : relativePath === 'package.json' || relativePath.startsWith('lib/')

async function materializeTrustedCandidate(manifest, candidatePath) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) {
    throw new Error(`${manifest.candidate.packagePathEnvironmentVariable} is required for candidate verification`)
  }
  const inspected = await inspectCandidatePackage(candidatePath)
  if (inspected.sha256 !== manifest.candidate.tarballSha256
    || inspected.manifestSha256 !== manifest.candidate.packageManifestSha256
    || !same(inspected.sourceProvenance, manifest.candidate.sourceProvenance)
    || inspected.sourceProvenanceSha256 !== manifest.candidate.sourceProvenanceSha256) {
    throw new Error('trusted V27 candidate package differs from the frozen manifest')
  }
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-trusted-candidate-'))
  const extracted = spawnSync('tar', ['-xzf', resolve(candidatePath), '-C', root], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (extracted.error || extracted.status !== 0) {
    await rm(root, { recursive: true, force: true })
    throw extracted.error ?? new Error((extracted.stderr || 'trusted candidate extraction failed').trim())
  }
  return {
    root,
    payloadSha256: await digestTree(join(root, 'package'), includeCandidatePayload),
  }
}

async function materializeTrustedAssets(manifest, runtimePath, candidatePath) {
  const runtime = await materializeTrustedRuntime(manifest, runtimePath)
  try {
    const candidate = await materializeTrustedCandidate(manifest, candidatePath)
    return { runtime, candidate }
  } catch (error) {
    await rm(runtime.root, { recursive: true, force: true })
    throw error
  }
}

function gitCommand(root, args) {
  return isolatedGit(root, args)
}

export function verifyV27AnalyzerCheckout(manifest, {
  root = repositoryRoot,
  git = args => gitCommand(root, args),
  manifestCommit,
  inspectCheckout = input => assertV27CheckoutIntegrity(input),
} = {}) {
  const commit = manifest?.driver?.commit
  const sourceObjects = manifest?.driver?.sourceObjects
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')
    || !/^[0-9a-f]{40}$/.test(manifestCommit ?? '')
    || !sourceObjects
    || typeof sourceObjects !== 'object') {
    throw new Error('V27 frozen analyzer identity is incomplete')
  }
  git(['cat-file', '-e', `${commit}^{commit}`])
  git(['merge-base', '--is-ancestor', commit, 'HEAD'])
  const sourcePaths = Object.keys(sourceObjects).sort()
  const changed = git(['diff', '--name-only', commit, '--', ...sourcePaths])
    .split(/\r?\n/).filter(Boolean)
  const allowed = new Set(['eval/long-system/v27/frozen-manifest.json'])
  const forbidden = changed.filter(path => !allowed.has(path))
  if (forbidden.length > 0) {
    throw new Error(`V27 analyzer sources changed after freeze: ${forbidden.join(', ')}`)
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths])
  if (dirty !== '') throw new Error('V27 analyzer checkout is not clean')
  const integrity = inspectCheckout({ root, commit: manifestCommit, sourcePaths })
  if (!Number.isSafeInteger(integrity?.fileCount)
    || integrity.fileCount < 1
    || !/^[0-9a-f]{64}$/u.test(integrity?.recordsSha256 ?? '')) {
    throw new Error('V27 analyzer checkout has no complete byte-and-mode identity')
  }
  const observedObjects = Object.fromEntries(sourcePaths.map(path => [
    path,
    git(['rev-parse', `${commit}:${path}`]),
  ]))
  if (!same(observedObjects, sourceObjects)
    || sha256(observedObjects) !== manifest.driver.sourceDigest
    || git(['rev-parse', `${commit}:eval/long-system/v27`]) !== manifest.driver.tree) {
    throw new Error('V27 analyzer source identity differs from the frozen manifest')
  }
  return {
    commit,
    tree: manifest.driver.tree,
    sourceDigest: manifest.driver.sourceDigest,
    checkoutFileCount: integrity.fileCount,
    checkoutRecordsSha256: integrity.recordsSha256,
  }
}

function validateDigestRecord(record, field) {
  if (!record || typeof record !== 'object') throw new Error(`${field} must be an object`)
  const { [field]: digest, ...body } = record
  if (!/^[0-9a-f]{64}$/.test(digest ?? '') || sha256(body) !== digest) {
    throw new Error(`${field} does not authenticate its body`)
  }
  return body
}

export function validateV27ReportEnvelope(report, manifest) {
  validateDigestRecord(report, 'reportDigest')
  if (report.schemaVersion !== 3
    || report.protocolId !== V27_PROTOCOL_ID
    || report.protocolId !== manifest?.protocolId
    || report.frozenManifestDigest !== manifest?.manifestDigest
    || !/^[0-9a-f]{40}$/u.test(report.manifestCommit ?? '')
    || !/^[0-9a-f]{64}$/.test(report.executionEnvelopeDigest ?? '')
    || typeof report.runId !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{7,47}$/.test(report.runId)
    || !Array.isArray(report.attempts)
    || report.signing?.publicKeyBase64 !== manifest?.evidenceSigning?.publicKeyBase64
    || report.signing?.ledgerId !== `${V27_PROTOCOL_ID}.${report.runId}`
    || !/^[0-9a-f]{64}$/.test(report.signing?.head ?? '')
    || report.signing?.records !== report.attempts.length) {
    throw new Error('V27 report is not bound to the frozen run envelope')
  }
  const expectedIds = report.attempts.map((_, index) => `${report.runId}-${V27_EXECUTION_PLAN[index]?.label}`)
  if (!same(report.attempts.map(attempt => attempt?.id), expectedIds)
    || !same(report.attempts.map(attempt => attempt?.arm),
      report.attempts.map((_, index) => V27_EXECUTION_PLAN[index]?.arm))
    || report.attempts.length > V27_EXECUTION_PLAN.length
    || report.attempts.some(attempt => attempt?.status === 'completed'
      && attempt?.arm === 'v0.4-native-continuity'
      && !candidateActivationProven(attempt))
    || report.attempts.some(attempt => attempt?.status === 'completed'
      && attempt?.arm === 'native'
      && (!Array.isArray(attempt?.evidence?.candidateActivations)
        || attempt.evidence.candidateActivations.length !== 0))
    || report.candidateExecuted !== report.attempts.some(candidateActivationProven)) {
    throw new Error('V27 report attempt identities or candidate execution flag are inconsistent')
  }

  const analysis = analyzeV27({ protocolId: report.protocolId, attempts: report.attempts })
  if (!same(report.qualification, analysis.qualification) || !same(report.analysis, analysis)) {
    throw new Error('V27 report embeds an analysis that cannot be reproduced from its attempts')
  }
  return analysis
}

export async function verifyV27SigningLedger(report, manifest, runRoot) {
  const entries = String(await readFile(join(runRoot, 'signing-ledger.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  if (entries.length !== report.attempts.length) {
    throw new Error('V27 signing ledger does not contain exactly one record per attempt')
  }
  let publicKey
  try {
    publicKey = createPublicKey({
      key: Buffer.from(manifest.evidenceSigning.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    throw new Error('V27 signing ledger public key is invalid')
  }
  let head = '0'.repeat(64)
  for (const [index, attempt] of report.attempts.entries()) {
    const { signing, ...evidence } = attempt.evidence ?? {}
    const unsigned = { ...attempt, evidence }
    const body = {
      schemaVersion: 3,
      attemptId: attempt.id,
      runId: report.runId,
      ordinal: index + 1,
      signingLedgerId: report.signing.ledgerId,
      executionEnvelopeDigest: report.executionEnvelopeDigest,
      manifestDigest: manifest.manifestDigest,
      manifestCommit: report.manifestCommit,
      previousRecordDigest: head,
      recordDigest: sha256(unsigned),
    }
    const expected = {
      schemaVersion: 3,
      body,
      signaturePayloadDigest: sha256(canonicalJson(body)),
      signature: signing?.signature,
    }
    if (!same(signing, expected) || !same(entries[index], expected)
      || !verify(null, Buffer.from(expected.signaturePayloadDigest, 'hex'), publicKey, Buffer.from(expected.signature ?? '', 'base64'))) {
      throw new Error(`V27 attempt ${attempt.id} failed its signing-ledger proof`)
    }
    head = expected.signaturePayloadDigest
  }
  if (head !== report.signing.head) throw new Error('V27 report signing head differs from the verified ledger')
}

function attemptLabel(index) {
  return V27_EXECUTION_PLAN[index]?.label
}

function within(path, parent) {
  const absolute = resolve(path)
  const root = `${resolve(parent)}${sep}`
  return absolute.startsWith(root)
}

function selectedRawMetrics(raw) {
  return {
    score: raw.productGrade.rewardScore,
    cumulativeCaseScore: raw.productGrade.cumulativeCaseScore,
    historicalRequirementRegressions: raw.productGrade.historicalRequirementRegressions,
    hardRequirementsMissed: raw.productGrade.rounds.filter(round => round.reward !== 1).length,
    inputTokens: raw.metrics.inputTokens,
    outputTokens: raw.metrics.outputTokens,
    modelTurns: raw.metrics.modelTurns,
    maxTokenProductTerminals: raw.metrics.maxTokenProductTerminals,
    prematureTaskTerminals: raw.metrics.prematureTaskTerminals,
    attemptBudgetTerminals: raw.metrics.attemptBudgetTerminals,
  }
}

async function verifyReceipts(attemptRoot, raw, hiddenAssetsSha256) {
  const receiptRoot = join(attemptRoot, 'round-receipts')
  const names = (await readdir(receiptRoot)).sort()
  const receipts = []
  for (const name of names) {
    if (!/^round-[1-9](?:\.terminal)?\.json$/.test(name)) {
      throw new Error(`unexpected V27 receipt file ${name}`)
    }
    const receipt = await readJson(join(receiptRoot, name))
    const { receiptDigest, ...body } = receipt
    if (!/^[0-9a-f]{64}$/.test(receiptDigest ?? '') || sha256(body) !== receiptDigest) {
      throw new Error(`V27 receipt ${name} failed its digest`)
    }
    if (receipt.hiddenAssetsSha256 !== hiddenAssetsSha256) {
      throw new Error(`V27 receipt ${name} is not bound to the hidden task assets`)
    }
    receipts.push({ name, receipt })
  }
  const productReceipts = receipts
    .filter(entry => /^round-[1-9]\.json$/.test(entry.name))
    .map(entry => entry.receipt)
  const rebuilt = summarizeOfficialRounds(productReceipts)
  rebuilt.hidden = true
  rebuilt.hiddenAssetsSha256 = hiddenAssetsSha256
  rebuilt.staleBehavior = {
    hidden: true,
    failures: rebuilt.historicalRequirementRegressions,
    passed: rebuilt.historicalRequirementRegressions === 0,
  }
  if (!same(rebuilt, raw.productGrade)) {
    throw new Error('V27 product grade does not reproduce from immutable round receipts')
  }
  const receiptDigests = new Set(receipts.map(entry => entry.receipt.receiptDigest))
  for (const terminal of raw.budgetTerminalReceipts ?? []) {
    if (!receiptDigests.has(terminal?.receiptDigest)) {
      throw new Error('V27 budget terminal is not bound to a persisted receipt')
    }
  }
}

async function verifyProtectedRuntimeTrees({ attempt, attemptRoot, raw, trustedRuntime }) {
  const expectedPaths = {
    hostHarnessRuntime: 'host-harness-runtime',
    sessionDecoderPackage: 'host-harness-runtime/dsh/node_modules/@deepseek-ai/dsh-session',
    profileModules: 'dsh-home/profiles/headless/node_modules',
    packages: 'packages',
  }
  if (raw.runtimeIntegrity?.schemaVersion !== 1
    || raw.runtimeIntegrity?.permissionMode !== 'workspace-write-private-host-deny-seatbelt-command'
    || !same(Object.keys(raw.runtimeIntegrity?.roots ?? {}).sort(), Object.keys(expectedPaths).sort())) {
    throw new Error(`V27 attempt ${attempt.id} has no complete protected-runtime identity`)
  }
  for (const [name, expectedRelativePath] of Object.entries(expectedPaths)) {
    const identity = raw.runtimeIntegrity.roots[name]
    if (identity?.relativePath !== expectedRelativePath
      || !/^[0-9a-f]{64}$/.test(identity?.sha256 ?? '')) {
      throw new Error(`V27 attempt ${attempt.id} has an invalid protected-runtime root ${name}`)
    }
    const path = join(attemptRoot, expectedRelativePath)
    let actual
    try {
      const resolved = await realpath(path)
      if (!within(resolved, attemptRoot)) throw new Error('outside attempt')
      actual = await immutableTreeSha256(path)
    } catch {
      throw new Error(`V27 attempt ${attempt.id} protected-runtime root ${name} is missing or unsafe`)
    }
    if (actual !== identity.sha256) {
      throw new Error(`V27 attempt ${attempt.id} protected-runtime root ${name} changed after execution`)
    }
  }
  if (raw.runtimeIntegrity.roots.sessionDecoderPackage.sha256 !== trustedRuntime.sessionPackageSha256) {
    throw new Error(`V27 attempt ${attempt.id} Session decoder package differs from frozen rc.7`)
  }
}

async function verifyInstalledCandidateEvidence({ attempt, attemptRoot, raw, manifest, trustedCandidate }) {
  if (attempt.arm === 'native') {
    if (raw.pluginIdentity !== null || attempt.evidence?.pluginIdentity !== null) {
      throw new Error(`V27 native attempt ${attempt.id} unexpectedly loaded the candidate`)
    }
    return
  }
  const identity = raw.pluginIdentity
  if (!same(attempt.evidence?.pluginIdentity, identity)
    || identity?.candidateCommit !== manifest.candidate.commit
    || identity?.candidateVersion !== manifest.candidate.packageVersion
    || identity?.candidatePackageSha256 !== manifest.candidate.tarballSha256
    || identity?.candidatePayloadSha256 !== trustedCandidate.payloadSha256
    || !/^[0-9a-f]{64}$/.test(identity?.wrapperPackageSha256 ?? '')) {
    throw new Error(`V27 candidate attempt ${attempt.id} is not bound to the frozen rc.9 package`)
  }
  const wrapperEntry = join(
    attemptRoot,
    'dsh-home',
    'profiles',
    'headless',
    'node_modules',
    'dsh-plan-lattice-long-system-wrapper',
    'index.js',
  )
  let candidateRoot
  try {
    const resolvedWrapper = await realpath(wrapperEntry)
    if (!within(resolvedWrapper, attemptRoot)) throw new Error('wrapper escaped attempt root')
    const candidateEntry = await realpath(createRequire(resolvedWrapper).resolve('dsh-plan-lattice'))
    candidateRoot = resolve(dirname(candidateEntry), '..')
    if (!within(candidateRoot, attemptRoot)) throw new Error('candidate escaped attempt root')
  } catch {
    throw new Error(`V27 candidate attempt ${attempt.id} has no safe installed rc.9 package`)
  }
  if (await digestTree(candidateRoot, includeCandidatePayload) !== trustedCandidate.payloadSha256) {
    throw new Error(`V27 candidate attempt ${attempt.id} installed payload differs from frozen rc.9`)
  }
}

const WRAPPER_FILES = [
  'common-boundary.js',
  'common-prompt.js',
  'cordis.patch.yml',
  'index.js',
  'package.json',
  'tool-boundary.js',
  'workspace-shell-adapter.js',
]

export async function verifyV27WrapperEvidence({ attempt, attemptRoot, raw }) {
  const candidate = attempt.arm === 'v0.4-native-continuity'
  const runRoot = dirname(dirname(attemptRoot))
  const driverRoot = join(
    runRoot,
    'input-snapshot',
    'driver-repository',
    'eval',
    'long-system',
    'v27',
    'driver',
  )
  const packageName = candidate
    ? 'dsh-plan-lattice-long-system-wrapper'
    : 'dsh-plan-lattice-long-system-native-wrapper'
  const tarballName = `${packageName}.tgz`
  const tarball = join(attemptRoot, 'packages', tarballName)
  const bytes = await readFile(tarball)
  if (sha256(bytes) !== raw.wrapperPackageSha256
    || (candidate && raw.pluginIdentity?.wrapperPackageSha256 !== raw.wrapperPackageSha256)) {
    throw new Error(`V27 attempt ${attempt.id} wrapper archive differs from its execution evidence`)
  }
  const listed = spawnSync('/usr/bin/tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (listed.error || listed.status !== 0) {
    throw listed.error ?? new Error(`V27 attempt ${attempt.id} wrapper archive cannot be listed`)
  }
  const expectedEntries = WRAPPER_FILES.map(name => `package/${name}`).sort()
  const entries = listed.stdout.split(/\r?\n/u).filter(Boolean).sort()
  if (!same(entries, expectedEntries)) {
    throw new Error(`V27 attempt ${attempt.id} wrapper archive has an unexpected publication payload`)
  }

  const extractedRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-wrapper-'))
  try {
    const extracted = spawnSync('/usr/bin/tar', ['-xzf', tarball, '-C', extractedRoot], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    if (extracted.error || extracted.status !== 0) {
      throw extracted.error ?? new Error(`V27 attempt ${attempt.id} wrapper archive cannot be extracted`)
    }
    const installedRoot = await realpath(join(
      attemptRoot,
      'dsh-home',
      'profiles',
      'headless',
      'node_modules',
      packageName,
    ))
    const canonicalAttemptRoot = await realpath(attemptRoot)
    if (!within(installedRoot, canonicalAttemptRoot)) {
      throw new Error(`V27 attempt ${attempt.id} installed wrapper escaped its attempt root`)
    }
    for (const name of WRAPPER_FILES) {
      const sourceRoot = !candidate && [
        'common-boundary.js',
        'common-prompt.js',
        'tool-boundary.js',
        'workspace-shell-adapter.js',
      ].includes(name)
        ? join(driverRoot, 'candidate-wrapper')
        : join(driverRoot, candidate ? 'candidate-wrapper' : 'native-wrapper')
      const source = await readFile(join(sourceRoot, name))
      const packed = await readFile(join(extractedRoot, 'package', name))
      const installed = await readFile(join(installedRoot, name))
      if (name === 'package.json') {
        const expected = JSON.parse(source)
        if (candidate) {
          expected.dependencies = {
            'dsh-plan-lattice': `file:${join(runRoot, 'input-snapshot', 'candidate-package.tgz')}`,
          }
        }
        if (!same(JSON.parse(packed), expected) || !same(JSON.parse(installed), expected)) {
          throw new Error(`V27 attempt ${attempt.id} wrapper package manifest differs from frozen driver input`)
        }
      } else if (!packed.equals(source) || !installed.equals(source)) {
        throw new Error(`V27 attempt ${attempt.id} wrapper file ${name} differs from frozen driver input`)
      }
    }
  } finally {
    await rm(extractedRoot, { recursive: true, force: true })
  }
}

export async function verifyV27CandidateActivationEvidence({ attempt, attemptRoot, raw, manifest }) {
  const diskNames = (await readdir(attemptRoot))
    .filter(name => name.startsWith('candidate-activation'))
    .sort()
  if (attempt.arm === 'native') {
    if (!Array.isArray(raw.candidateActivations) || raw.candidateActivations.length !== 0
      || !Array.isArray(attempt.evidence?.candidateActivations)
      || attempt.evidence.candidateActivations.length !== 0) {
      throw new Error(`V27 native attempt ${attempt.id} unexpectedly claims candidate activation`)
    }
    if (diskNames.length !== 0) {
      throw new Error(`V27 native attempt ${attempt.id} has a candidate activation receipt on disk`)
    }
    return []
  }

  const runRoot = dirname(dirname(attemptRoot))
  const protocol = await buildV27Protocol(join(runRoot, 'input-snapshot', 'task'), raw.rootSessionId)
  const expectedEpochs = protocol.epochs.slice(0, raw.processLedger?.length)
  const expectedNames = expectedEpochs.map(epoch => candidateActivationReceiptName(epoch.epoch)).sort()
  if (!same(diskNames, expectedNames)) {
    throw new Error(`V27 candidate attempt ${attempt.id} activation receipt set differs from its processes`)
  }
  const receipts = []
  for (const name of diskNames) {
    const path = join(attemptRoot, name)
    const [info, bytes] = await Promise.all([lstat(path), readFile(path)])
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw new Error(`V27 candidate attempt ${attempt.id} activation receipt is not a private regular file`)
    }
    let receipt
    try {
      receipt = JSON.parse(bytes)
    } catch {
      throw new Error(`V27 candidate attempt ${attempt.id} activation receipt is not valid JSON`)
    }
    if (!bytes.equals(Buffer.from(canonicalJson(receipt), 'utf8'))) {
      throw new Error(`V27 candidate attempt ${attempt.id} activation receipt bytes are not canonical`)
    }
    receipts.push(receipt)
  }

  const retainedAdapter = await readFile(join(
    runRoot,
    'input-snapshot',
    'driver-repository',
    'eval',
    'long-system',
    'v27',
    'driver',
    'candidate-wrapper',
    'workspace-shell-adapter.js',
  ))
  const installedAdapter = await readFile(join(
    attemptRoot,
    'dsh-home',
    'profiles',
    'headless',
    'node_modules',
    'dsh-plan-lattice-long-system-wrapper',
    'workspace-shell-adapter.js',
  ))
  if (!installedAdapter.equals(retainedAdapter)
    || !same(raw.pluginConfig, manifest.candidate.mode)) {
    throw new Error(`V27 candidate attempt ${attempt.id} activation inputs differ from frozen evidence`)
  }
  validateCandidateActivations(receipts, {
    attemptId: attempt.id,
    processLedger: raw.processLedger,
    expectedEpochs,
  })
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]
    const expectedBody = buildCandidateActivationReceiptBody({
      attemptId: attempt.id,
      epoch: expectedEpochs[index].epoch,
      epochSha256: sha256(expectedEpochs[index]),
      processPid: raw.processLedger[index].pid,
      processNonce: raw.candidateActivations?.[index]?.processNonce,
      pluginIdentity: raw.pluginIdentity,
      pluginConfig: manifest.candidate.mode,
      bashAdapterSha256: sha256(retainedAdapter),
    })
    validateCandidateActivationReceipt(receipt, { attemptId: attempt.id, body: expectedBody })
  }
  if (receipts.some(receipt => receipt.wrapperPackageSha256 !== raw.wrapperPackageSha256
      || receipt.candidateCommit !== manifest.candidate.commit
      || receipt.candidateVersion !== manifest.candidate.packageVersion
      || receipt.candidatePackageSha256 !== manifest.candidate.tarballSha256)
    || !same(receipts, raw.candidateActivations)
    || !same(receipts, attempt.evidence?.candidateActivations)) {
    throw new Error(`V27 candidate attempt ${attempt.id} activation receipt differs across evidence layers`)
  }
  return receipts
}

async function verifyCompletedAttempt({ attempt, attemptRoot, manifest, trustedRuntime, trustedCandidate }) {
  const raw = await readJson(join(attemptRoot, 'attempt-result.json'))
  if (sha256(raw) !== attempt?.evidence?.rawAttemptSha256
    || raw.attemptId !== attempt.id
    || raw.arm !== attempt.arm
    || raw.protocolId !== manifest.protocolId
    || raw.dockerImage !== manifest.image.reference
    || !same(attempt.productGrade, raw.productGrade)
    || !same(attempt.metrics, selectedRawMetrics(raw))
    || !same(attempt.trace, raw.trace)
    || !same(attempt.evidence?.outcome, raw.outcome)
    || attempt.evidence?.rootSessionId !== raw.rootSessionId
    || attempt.evidence?.processEpochs !== raw.processLedger?.length
    || !same(attempt.evidence?.terminalOutcomes, raw.terminalOutcomes)
    || !same(attempt.evidence?.budgetTerminalReceipts, raw.budgetTerminalReceipts)
    || !same(attempt.evidence?.candidateActivations, raw.candidateActivations)
    || !same(attempt.evidence?.taskDigests, manifest.task.digests)
    || !same(attempt.evidence?.taskDigests, Object.fromEntries(
      Object.entries(raw.taskIdentity.digests).map(([name, identity]) => [name, identity.sha256]),
    ))) {
    throw new Error(`V27 attempt ${attempt.id} does not reproduce from its raw result`)
  }
  if (!within(raw.sessionsRoot, attemptRoot)) {
    throw new Error(`V27 attempt ${attempt.id} references Session state outside its attempt root`)
  }
  let sessionsRoot
  try {
    sessionsRoot = await realpath(raw.sessionsRoot)
    const expectedSessionsRoot = await realpath(join(attemptRoot, 'sessions'))
    if (sessionsRoot !== expectedSessionsRoot || !(await stat(sessionsRoot)).isDirectory()) throw new Error('mismatch')
  } catch {
    throw new Error(`V27 attempt ${attempt.id} does not contain its referenced durable Session state`)
  }
  if (await sessionTreeSha256(sessionsRoot) !== raw.sessionTreeSha256) {
    throw new Error(`V27 attempt ${attempt.id} durable Session tree digest changed after execution`)
  }
  await verifyProtectedRuntimeTrees({ attempt, attemptRoot, raw, trustedRuntime })
  await verifyInstalledCandidateEvidence({ attempt, attemptRoot, raw, manifest, trustedCandidate })
  await verifyV27WrapperEvidence({ attempt, attemptRoot, raw })
  await verifyV27CandidateActivationEvidence({ attempt, attemptRoot, raw, manifest })
  if (attempt.arm === 'v0.4-native-continuity' && raw.outcome?.class === 'completed') {
    const rebuiltTrace = await rebuildV27TraceFromDisk({
      raw,
      sessionsRoot,
      trustedDecoderModulePath: trustedRuntime.decoderModulePath,
    })
    if (!same(rebuiltTrace, raw.trace) || !same(rebuiltTrace, attempt.trace)) {
      throw new Error(`V27 attempt ${attempt.id} trace does not reproduce from durable Session state`)
    }
  }
  await verifyReceipts(attemptRoot, raw, manifest.task.digests.hidden)
}

export async function rebuildV27TraceFromDisk({
  raw,
  sessionsRoot,
  trustedDecoderModulePath,
  traceGrader = gradeV27Trace,
}) {
  try {
    if (typeof trustedDecoderModulePath !== 'string'
      || !(await stat(trustedDecoderModulePath)).isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`V27 attempt ${raw?.attemptId ?? 'unknown'} has no trusted frozen Session decoder`)
  }
  return traceGrader({
    sessionsRoot,
    rootSessionId: raw.rootSessionId,
    stageProtocol: raw.traceProtocol,
    processLedger: raw.processLedger,
    productGrade: raw.productGrade,
    decoderModulePath: trustedDecoderModulePath,
  })
}

async function verifyRunEnvelope(report, manifest, runRoot) {
  const envelope = await readJson(join(runRoot, 'run-envelope.json'))
  const { executionEnvelopeDigest, ...body } = envelope
  if (sha256(body) !== executionEnvelopeDigest
    || executionEnvelopeDigest !== report.executionEnvelopeDigest
    || body.schemaVersion !== 3
    || body.runId !== report.runId
    || body.protocolId !== manifest.protocolId
    || body.manifestDigest !== manifest.manifestDigest
    || body.manifestCommit !== report.manifestCommit
    || body.harnessCommit !== manifest.harness.commit
    || body.candidateCommit !== manifest.candidate.commit
    || body.taskDatasetCommit !== manifest.task.datasetCommit
    || !same(body.taskDigests, manifest.task.digests)
    || !same(body.image, manifest.image)
    || body.upstreamBaseUrl !== manifest.model.upstreamBaseUrl
    || body.upstreamBaseUrlSha256 !== manifest.model.upstreamBaseUrlSha256
    || sha256(body.upstreamBaseUrl) !== body.upstreamBaseUrlSha256
    || body.evidenceSigningPublicKeySha256 !== manifest.evidenceSigning.publicKeySha256
    || body.executionSnapshot?.relativePath !== 'input-snapshot'
    || body.executionSnapshot?.identityDigest !== sha256(body.executionSnapshot?.identity)) {
    throw new Error('V27 run envelope does not authenticate the frozen execution context')
  }
  await assertV27ExecutionSnapshotIdentity(
    join(runRoot, body.executionSnapshot.relativePath),
    manifest,
    body.executionSnapshot.identity,
  )
}

async function verifyTrialClaim(report, manifest, runRoot) {
  const outputRoot = dirname(runRoot)
  if (outputRoot !== manifest.outputPolicy.absoluteRoot
    || basename(runRoot) !== manifest.trial.runId
    || report.runId !== manifest.trial.runId) {
    throw new Error('V27 evidence is not under the unique output root and run ID')
  }
  const path = join(outputRoot, `v27-trial-claim-${manifest.manifestDigest}.json`)
  const claim = await readJson(path)
  const { trialClaimDigest, ...body } = claim
  if (sha256(body) !== trialClaimDigest
    || body.schemaVersion !== 2
    || body.runId !== report.runId
    || body.protocolId !== manifest.protocolId
    || body.manifestDigest !== manifest.manifestDigest
    || body.manifestCommit !== report.manifestCommit
    || body.replacementAllowed !== false
    || body.rerunAllowed !== false) {
    throw new Error('V27 trial claim does not bind the one permitted run ID')
  }
}

async function verifySlotStarted({ attempt, attemptRoot, report, manifest, index }) {
  const record = await readJson(join(attemptRoot, 'slot-started.json'))
  const { slotStartedDigest, ...body } = record
  const slot = V27_EXECUTION_PLAN[index]
  if (sha256(body) !== slotStartedDigest
    || attempt.evidence?.slotStartedDigest !== slotStartedDigest
    || body.schemaVersion !== 2
    || body.attemptId !== attempt.id
    || body.runId !== report.runId
    || body.protocolId !== manifest.protocolId
    || body.manifestDigest !== manifest.manifestDigest
    || body.manifestCommit !== report.manifestCommit
    || body.label !== slot.label
    || body.arm !== slot.arm
    || body.ordinal !== slot.pair) {
    throw new Error(`V27 attempt ${attempt.id} has no authentic durable slot-start record`)
  }
}

async function readBudgetSnapshots(path) {
  const records = String(await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const snapshots = new Map()
  for (const record of records) {
    if (typeof record?.attemptId === 'string' && record.snapshot !== undefined) {
      snapshots.set(record.attemptId, record.snapshot)
    }
  }
  return snapshots
}

async function verifyV27ReportEvidence({
  reportPath,
  manifestPath,
  manifest,
  trustedRuntime,
  trustedCandidate,
}) {
  const absoluteReport = resolve(reportPath)
  const runRoot = dirname(absoluteReport)
  const [report, budgetSnapshots] = await Promise.all([
    readJson(absoluteReport),
    readBudgetSnapshots(join(runRoot, 'budget-audit.jsonl')),
  ])
  if ((await readdir(dirname(runRoot))).includes(`v27-trial-fatal-${manifest.manifestDigest}.json`)) {
    throw new Error('V27 run is inconclusive because a fatal terminal record exists')
  }
  const analysis = validateV27ReportEnvelope(report, manifest)
  const publicAnchor = inspectV27PublicManifestCommit({
    manifest,
    manifestPath,
    manifestCommit: report.manifestCommit,
    root: repositoryRoot,
  })
  const analyzer = verifyV27AnalyzerCheckout(manifest, { manifestCommit: report.manifestCommit })
  await verifyTrialClaim(report, manifest, runRoot)
  await verifyRunEnvelope(report, manifest, runRoot)
  await verifyV27SigningLedger(report, manifest, runRoot)
  for (const [index, attempt] of report.attempts.entries()) {
    const root = join(runRoot, 'attempts', attemptLabel(index))
    await verifySlotStarted({ attempt, attemptRoot: root, report, manifest, index })
    if (attempt.status === 'completed') {
      await verifyCompletedAttempt({
        attempt,
        attemptRoot: root,
        manifest,
        trustedRuntime,
        trustedCandidate,
      })
      if (!same(attempt.budget, budgetSnapshots.get(attempt.id))
        || !same(attempt.budget?.limits, manifest.budgetPerAttempt)) {
        throw new Error(`V27 attempt ${attempt.id} budget does not match the host audit log`)
      }
    } else {
      const failure = await readJson(join(root, 'attempt-failure.json'))
      if (!same(failure, attempt)) throw new Error(`V27 failure ${attempt.id} differs from its exclusive record`)
    }
  }
  return {
    ...analysis,
    evidenceVerified: true,
    frozenManifestDigest: manifest.manifestDigest,
    reportDigest: report.reportDigest,
    analyzer,
    publicAnchor,
  }
}

export async function verifyV27TrialTerminal({ report, manifest, analysis, runRoot }) {
  const outputRoot = dirname(runRoot)
  const names = await readdir(outputRoot)
  const fatalName = `v27-trial-fatal-${manifest.manifestDigest}.json`
  if (names.includes(fatalName)) {
    throw new Error('V27 run is inconclusive because a fatal terminal record exists')
  }
  const terminalName = `v27-trial-terminal-${manifest.manifestDigest}.json`
  if (names.filter(name => name === terminalName).length !== 1) {
    throw new Error('V27 release authority requires one durable trial terminal')
  }
  const terminal = await readJson(join(outputRoot, terminalName))
  const { terminalPayloadDigest, signature, ...body } = terminal
  let publicKey
  try {
    publicKey = createPublicKey({
      key: Buffer.from(manifest.evidenceSigning.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    throw new Error('V27 terminal signing public key is invalid')
  }
  const expectedRelease = analysis.releaseAllowed === true
  if (sha256(body) !== terminalPayloadDigest
    || !verify(null, Buffer.from(terminalPayloadDigest ?? '', 'hex'), publicKey, Buffer.from(signature ?? '', 'base64'))
    || body.schemaVersion !== 3
    || body.status !== (expectedRelease ? 'release-allowed' : 'release-prohibited')
    || body.runId !== report.runId
    || body.protocolId !== manifest.protocolId
    || body.manifestDigest !== manifest.manifestDigest
    || body.manifestCommit !== report.manifestCommit
    || body.executionEnvelopeDigest !== report.executionEnvelopeDigest
    || body.reportDigest !== report.reportDigest
    || body.signingLedgerHead !== report.signing.head
    || body.signingRecords !== report.signing.records
    || body.releaseAllowed !== expectedRelease
    || body.replacementAllowed !== false
    || body.rerunAllowed !== false) {
    throw new Error('V27 trial terminal is missing, forged, or not bound to the final report')
  }
  return terminal
}

export async function verifyV27ReportFile({
  reportPath,
  manifestPath = FROZEN_MANIFEST_PATH,
  runtimePath,
  candidatePath,
}) {
  const manifest = await readV27FrozenManifest(manifestPath)
  const { runtime: trustedRuntime, candidate: trustedCandidate } = await materializeTrustedAssets(
    manifest,
    runtimePath ?? process.env[manifest.harness.runtimePathEnvironmentVariable],
    candidatePath ?? process.env[manifest.candidate.packagePathEnvironmentVariable],
  )
  try {
    const verified = await verifyV27ReportEvidence({ reportPath, manifestPath, manifest, trustedRuntime, trustedCandidate })
    const report = await readJson(resolve(reportPath))
    const runRoot = dirname(resolve(reportPath))
    const terminal = await verifyV27TrialTerminal({ report, manifest, analysis: verified, runRoot })
    return { ...verified, trialTerminalDigest: terminal.terminalPayloadDigest }
  } finally {
    await Promise.all([
      rm(trustedRuntime.root, { recursive: true, force: true }),
      rm(trustedCandidate.root, { recursive: true, force: true }),
    ])
  }
}

export async function finalizeV27ReportFile({
  reportPath,
  manifestPath = FROZEN_MANIFEST_PATH,
  runtimePath,
  candidatePath,
  signingPrivateKeyBase64,
}) {
  const manifest = await readV27FrozenManifest(manifestPath)
  const resolvedRuntimePath = runtimePath ?? process.env[manifest.harness.runtimePathEnvironmentVariable]
  const resolvedCandidatePath = candidatePath ?? process.env[manifest.candidate.packagePathEnvironmentVariable]
  const { runtime: trustedRuntime, candidate: trustedCandidate } = await materializeTrustedAssets(
    manifest,
    resolvedRuntimePath,
    resolvedCandidatePath,
  )
  let verified
  try {
    verified = await verifyV27ReportEvidence({ reportPath, manifestPath, manifest, trustedRuntime, trustedCandidate })
  } finally {
    await Promise.all([
      rm(trustedRuntime.root, { recursive: true, force: true }),
      rm(trustedCandidate.root, { recursive: true, force: true }),
    ])
  }
  const report = await readJson(resolve(reportPath))
  let privateKey
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(signingPrivateKeyBase64 ?? '', 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    const derivedPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
    if (derivedPublic !== manifest.evidenceSigning.publicKeyBase64) throw new Error('mismatch')
  } catch {
    throw new Error('V27 finalizer does not hold the frozen evidence signing key')
  }
  const body = {
    schemaVersion: 3,
    status: verified.releaseAllowed ? 'release-allowed' : 'release-prohibited',
    runId: report.runId,
    protocolId: manifest.protocolId,
    manifestDigest: manifest.manifestDigest,
    manifestCommit: report.manifestCommit,
    executionEnvelopeDigest: report.executionEnvelopeDigest,
    reportDigest: report.reportDigest,
    signingLedgerHead: report.signing.head,
    signingRecords: report.signing.records,
    releaseAllowed: verified.releaseAllowed === true,
    completedAt: new Date().toISOString(),
    replacementAllowed: false,
    rerunAllowed: false,
  }
  const terminalPayloadDigest = sha256(body)
  const terminal = {
    ...body,
    terminalPayloadDigest,
    signature: sign(null, Buffer.from(terminalPayloadDigest, 'hex'), privateKey).toString('base64'),
  }
  await writeJsonExclusive(
    join(dirname(dirname(resolve(reportPath))), `v27-trial-terminal-${manifest.manifestDigest}.json`),
    terminal,
  )
  return verifyV27ReportFile({
    reportPath,
    manifestPath,
    runtimePath: resolvedRuntimePath,
    candidatePath: resolvedCandidatePath,
  })
}
