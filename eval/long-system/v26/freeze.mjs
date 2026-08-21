#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { V26_THRESHOLDS } from './analysis.mjs'
import { inspectEvoCodeTask } from './benchmark.mjs'
import {
  CANDIDATE_COMMIT,
  CANDIDATE_TARBALL_SHA256,
  CANDIDATE_TREE,
  EVOCODE_ARCHIVE_SHA256,
  EVOCODE_DATASET_COMMIT,
  FROZEN_EVIDENCE_PUBLIC_KEY_BASE64,
  FROZEN_EVIDENCE_PUBLIC_KEY_SHA256,
  FROZEN_MANIFEST_PATH,
  HARNESS_COMMIT,
  PROTOCOL_ID,
  SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE,
  TASK_RELATIVE_PATH,
  readV26FrozenManifest,
  validateV26Manifest,
} from './manifest.mjs'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const DRIVER_OBJECT_PATHS = [
  'eval/long-system/v26',
  'eval/long-system/driver/model-proxy.mjs',
  'eval/pilots/driver/budget-proxy.mjs',
  'eval/v0.4/driver/lib',
  'eval/v0.4/lib/canonical.mjs',
]

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr
    throw new Error(`${commandName} ${args.join(' ')} failed: ${String(detail || result.stdout || '').trim()}`)
  }
  return result.stdout
}

function git(root, args) {
  return String(command('git', ['-C', root, ...args])).trim()
}

function exactCommit(value, field) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`${field} must be an exact Git commit`)
  return value
}

function exactDigest(value, field) {
  if (!/^[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${field} must be an exact SHA-256 digest`)
  return value
}

function parseTarJson(path, entry) {
  const bytes = command('tar', ['-xOf', resolve(path), entry], { encoding: null })
  try {
    return { value: JSON.parse(Buffer.from(bytes).toString('utf8')), bytes: Buffer.from(bytes) }
  } catch {
    throw new Error(`${entry} in ${path} is not valid JSON`)
  }
}

export async function inspectHarnessRuntime(path) {
  const absolute = resolve(path)
  const bytes = await readFile(absolute)
  const metadata = parseTarJson(absolute, 'runtime.json')
  if (metadata.value?.harnessCommit !== HARNESS_COMMIT) {
    throw new Error(`Harness runtime metadata is not bound to ${HARNESS_COMMIT}`)
  }
  return {
    path: absolute,
    sha256: sha256(bytes),
    metadataSha256: sha256(metadata.bytes),
    platform: metadata.value.platform,
    architecture: metadata.value.architecture,
    node: metadata.value.node,
  }
}

export async function inspectCandidatePackage(path) {
  const absolute = resolve(path)
  const bytes = await readFile(absolute)
  const digest = sha256(bytes)
  if (digest !== CANDIDATE_TARBALL_SHA256) {
    throw new Error(`candidate tarball digest mismatch: ${digest}`)
  }
  const manifest = parseTarJson(absolute, 'package/package.json')
  if (manifest.value?.name !== 'dsh-plan-lattice' || manifest.value?.version !== '0.4.0-rc.9') {
    throw new Error('candidate tarball package identity is not dsh-plan-lattice v0.4.0-rc.9')
  }
  return { path: absolute, sha256: digest, manifestSha256: sha256(manifest.bytes) }
}

export async function inspectSigningPrivateKey(path) {
  const absolute = resolve(path)
  const [bytes, metadata] = await Promise.all([readFile(absolute), stat(absolute)])
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('V26 signing private key must not be readable or writable by group or others')
  }
  let privateKey
  try {
    privateKey = createPrivateKey(bytes)
  } catch {
    throw new Error('V26 signing private key is invalid')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('V26 signing private key must use Ed25519')
  }
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return {
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyBase64: publicKey.toString('base64'),
    publicKeySha256: sha256(publicKey),
  }
}

export async function inspectTaskCheckout({ taskRoot, datasetRoot, archivePath }) {
  const checkout = await realpath(resolve(datasetRoot))
  const task = await realpath(resolve(taskRoot))
  const expectedTask = await realpath(join(checkout, TASK_RELATIVE_PATH))
  if (task !== expectedTask) throw new Error('task root is not the fixed EvoCode task path')
  const archiveSha256 = sha256(await readFile(resolve(archivePath)))
  if (archiveSha256 !== EVOCODE_ARCHIVE_SHA256) {
    throw new Error(`EvoCode dataset archive digest mismatch: ${archiveSha256}`)
  }
  const identity = await inspectEvoCodeTask(task)
  const digests = {
    public: identity.digests.public.sha256,
    hidden: identity.digests.hidden.sha256,
    oracle: identity.digests.oracle.sha256,
  }
  return {
    root: task,
    datasetRoot: checkout,
    datasetCommit: EVOCODE_DATASET_COMMIT,
    archiveSha256,
    roundCount: identity.roundCount,
    digests,
    assetSha256: sha256(digests),
  }
}

export function inspectDockerImage(reference, runner = command) {
  const match = String(reference ?? '').match(/^([^\s@]+(?:\/[^\s@]+)*)@sha256:([0-9a-f]{64})$/)
  if (!match) throw new Error('Docker image must be an exact repository@sha256 manifest reference')
  const raw = runner('docker', ['image', 'inspect', reference])
  let records
  try { records = JSON.parse(String(raw)) } catch { throw new Error('docker image inspect returned invalid JSON') }
  const record = records?.[0]
  const config = String(record?.Id ?? '').match(/^sha256:([0-9a-f]{64})$/)?.[1]
  if (!config || !Array.isArray(record?.RepoDigests) || !record.RepoDigests.includes(reference)) {
    throw new Error('local Docker image does not expose the requested immutable digest')
  }
  return { reference, manifestSha256: match[2], configSha256: config }
}

export function inspectDriverCheckout(driverCommit, root = repositoryRoot) {
  exactCommit(driverCommit, 'driver commit')
  git(root, ['cat-file', '-e', `${driverCommit}^{commit}`])
  if (git(root, ['rev-parse', 'HEAD']) !== driverCommit) {
    throw new Error('freeze must run from the exact driver commit')
  }
  const status = git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...DRIVER_OBJECT_PATHS])
  if (status !== '') throw new Error('V26 driver sources must be committed and clean before freeze')
  const objects = Object.fromEntries(DRIVER_OBJECT_PATHS.map(path => [
    path,
    git(root, ['rev-parse', `${driverCommit}:${path}`]),
  ]))
  const candidateAncestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', CANDIDATE_COMMIT, driverCommit])
  if (candidateAncestor.status !== 0) throw new Error('candidate commit must precede the frozen V26 driver')
  return {
    commit: driverCommit,
    tree: git(root, ['rev-parse', `${driverCommit}:eval/long-system/v26`]),
    sourceObjects: objects,
    sourceDigest: sha256(objects),
  }
}

export function buildV26Manifest({ runtime, candidate, task, image, driver, signing }) {
  exactDigest(runtime?.sha256, 'runtime digest')
  exactDigest(runtime?.metadataSha256, 'runtime metadata digest')
  if (candidate?.sha256 !== CANDIDATE_TARBALL_SHA256) throw new Error('candidate package is not the fixed tarball')
  if (task?.datasetCommit !== EVOCODE_DATASET_COMMIT
    || task?.archiveSha256 !== EVOCODE_ARCHIVE_SHA256
    || task?.roundCount !== 9) {
    throw new Error('task is not the complete fixed nine-round EvoCode checkout')
  }
  for (const value of Object.values(task.digests ?? {})) exactDigest(value, 'task partition digest')
  if (sha256(driver?.sourceObjects ?? {}) !== driver?.sourceDigest) {
    throw new Error('driver source object table does not match its digest')
  }
  exactDigest(signing?.publicKeySha256, 'evidence signing public key digest')
  if (signing.publicKeyBase64 !== FROZEN_EVIDENCE_PUBLIC_KEY_BASE64
    || signing.publicKeySha256 !== FROZEN_EVIDENCE_PUBLIC_KEY_SHA256) {
    throw new Error('evidence signing key does not match the public key frozen in the driver')
  }
  const body = {
    schemaVersion: 1,
    protocolId: PROTOCOL_ID,
    status: 'preregistered-native-calibration',
    executionAllowed: true,
    resultClaimsAllowed: false,
    candidateExecutionInitiallyAllowed: false,
    claimBoundary: 'V25 retained two native max-token outcomes and then stopped on an evaluator budget-classification gap before any candidate execution. V26 preregisters host-authenticated budget terminal scoring before any candidate run, reruns all five native calibrations, and permits one still-unseen candidate only through the frozen analyzer.',
    terminalOutcomePolicy: {
      scorableTerminalKinds: ['completed', 'max-tokens', 'attempt-budget-exhausted'],
      budgetTerminalAuthority: 'host-budget-proxy-first-rejection',
      budgetScope: 'attempt-including-compaction-and-subagents',
      stageStartBarrier: true,
      agentRequestConcurrency: 1,
      firstCrossingResponseRetained: true,
      officialVerifierAfterEveryProductTerminal: true,
      continueAfterPrematureTerminal: false,
      unreachedRoundsScoreZero: true,
      terminalEchoRequired: true,
      receiptDurability: 'exclusive-file-fsync-and-directory-fsync-before-ack',
      attemptSummaryAuthority: 'ed25519-chained-ledger',
      candidatePrematureTaskTerminals: V26_THRESHOLDS.maximumCandidatePrematureTaskTerminals,
    },
    evidenceSigning: {
      algorithm: 'Ed25519',
      publicKeyBase64: signing.publicKeyBase64,
      publicKeySha256: signing.publicKeySha256,
      privateKeyPathEnvironmentVariable: SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE,
    },
    priorObservation: {
      protocolId: 'plan-lattice-rc7-evocode-jobforge-v25',
      runId: 'v25-2026-08-21t11-34-50-183z-55a10ad9',
      resultClass: 'preregistered-negative',
      scoringStatus: 'no-valid-comparison-by-v25-policy',
      failureReason: 'evaluator-budget-terminal-was-unscorable',
      candidateExecuted: false,
      manifestDigest: 'c696ef80f0aa2696a8d76d1c8ebeaf496d309e02a7290184d2f82a109ddfb57f',
      reportDigest: '3f6d3123dddb9c9b1e21ca8320b328ef2b3c3bf1d919192f69e2d9f9988c8392',
      retainedNativeAttempts: 3,
      failedAttempt: {
        id: 'v25-2026-08-21t11-34-50-183z-55a10ad9-native-3',
        successfulModelResponses: 67,
        inputTokens: 6004986,
        outputTokens: 117086,
        localBudgetRejections: 3,
        reachedRoundsDescriptiveOnly: 3,
      },
      sourceDigests: {
        finalReport: '35a66cc2628609889080a4ce12cc25f75cca5e724eb606dc5147f98879243e77',
        modelProxyAudit: '70bcfa96c856acdd3029fee959da7c88cc41b63548793041232e9f12ab7d12ff',
        budgetAudit: '2cc96ed0528a9fcab909ea7a3b0b64afe07cb344177a8db54cf755bd81ae901c',
        attemptFailure: '620ae20b67a899dadaa3acb4222f124400767eaa18264f03aa27ee355b77a774',
      },
    },
    harness: {
      commit: HARNESS_COMMIT,
      tag: 'dsh-v0.1.0-rc.7',
      runtimeSha256: runtime.sha256,
      runtimeMetadataSha256: runtime.metadataSha256,
      platform: runtime.platform,
      architecture: runtime.architecture,
      node: runtime.node,
      runtimePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V26_HOST_RUNTIME',
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      tree: CANDIDATE_TREE,
      packageVersion: '0.4.0-rc.9',
      tarballSha256: candidate.sha256,
      packageManifestSha256: candidate.manifestSha256,
      packagePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V26_CANDIDATE_PACKAGE',
      mode: { activationMode: 'auto', clarificationPolicy: 'critical', controlCeiling: 'lattice' },
      evaluationWrapper: {
        strictBash: true,
        preconditionAdapter: 'workspace-shell-adapter',
        publicDefaultEquivalent: false,
        claimScope: 'The candidate is the frozen Plan Lattice tarball installed through the disclosed DSH Bash adapter; the adapter is evaluation integration, not part of the candidate tarball.',
      },
    },
    driver,
    task: {
      id: 'theme_d1_w1_code_build_greenfield_implementation',
      datasetCommit: EVOCODE_DATASET_COMMIT,
      archiveSha256: task.archiveSha256,
      relativePath: TASK_RELATIVE_PATH,
      assetSha256: task.assetSha256,
      rounds: task.roundCount,
      digests: task.digests,
      rootPathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V26_TASK_ROOT',
      datasetPathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V26_DATASET_ROOT',
      archivePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V26_DATASET_ARCHIVE',
    },
    image: { ...image, taskPublicSha256: task.digests.public },
    model: {
      provider: 'DeepSeek',
      id: 'deepseek-v4-flash',
      temperature: 0,
      agentMaxOutputTokens: 32768,
      compactionMaxOutputTokens: 8192,
      timeoutMsPerEpoch: 14_400_000,
    },
    budgetPerAttempt: {
      maxAgentRequests: 240,
      maxInputTokens: 6_000_000,
      maxOutputTokens: 750_000,
    },
    calibration: {
      nativeRuns: V26_THRESHOLDS.requiredNativeAttempts,
      candidateRunsMaximum: 1,
      order: ['native-1', 'native-2', 'native-3', 'native-4', 'native-5', 'candidate-if-qualified'],
      baselineAggregation: 'median-of-five-native-runs',
      candidateGateAuthority: 'eval/long-system/v26/analysis.mjs',
    },
    arms: {
      native: { id: 'native', plugin: 'none' },
      candidate: {
        id: 'v0.4-native-continuity',
        plugin: 'v0.4.0-rc.9',
        activationMode: 'auto',
        clarificationPolicy: 'critical',
        controlCeiling: 'lattice',
        strictBash: true,
        preconditionAdapter: 'workspace-shell-adapter',
      },
    },
    thresholds: V26_THRESHOLDS,
    outputPolicy: {
      rootEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V26_OUTPUT_ROOT',
      exclusiveCreate: true,
      overwriteAllowed: false,
    },
    paidRuns: { native: 5, candidateMaximum: 1 },
  }
  return validateV26Manifest({ ...body, manifestDigest: sha256(body) })
}

export async function writeJsonExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(canonicalJson(value), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function freezeV26({
  runtimePath,
  candidatePackagePath,
  taskRoot,
  datasetRoot,
  archivePath,
  dockerImage,
  driverCommit,
  signingPrivateKeyPath,
}) {
  const [runtime, candidate, task, signing] = await Promise.all([
    inspectHarnessRuntime(runtimePath),
    inspectCandidatePackage(candidatePackagePath),
    inspectTaskCheckout({ taskRoot, datasetRoot, archivePath }),
    inspectSigningPrivateKey(signingPrivateKeyPath),
  ])
  const image = inspectDockerImage(dockerImage)
  const driver = inspectDriverCheckout(driverCommit)
  return buildV26Manifest({ runtime, candidate, task, image, driver, signing })
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  if (!process.argv.includes('--write')) {
    process.stdout.write(`${(await readV26FrozenManifest()).manifestDigest}\n`)
    return
  }
  const manifest = await freezeV26({
    runtimePath: option('--host-runtime'),
    candidatePackagePath: option('--candidate-package'),
    taskRoot: option('--task-root'),
    datasetRoot: option('--dataset-root'),
    archivePath: option('--dataset-archive'),
    dockerImage: option('--docker-image'),
    driverCommit: option('--driver-commit'),
    signingPrivateKeyPath: option('--signing-private-key'),
  })
  await writeJsonExclusive(FROZEN_MANIFEST_PATH, manifest)
  process.stdout.write(`${manifest.manifestDigest}\n`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
