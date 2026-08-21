#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { open, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { V25_THRESHOLDS } from './analysis.mjs'
import { inspectEvoCodeTask } from './benchmark.mjs'
import {
  CANDIDATE_COMMIT,
  CANDIDATE_TARBALL_SHA256,
  CANDIDATE_TREE,
  EVOCODE_ARCHIVE_SHA256,
  EVOCODE_DATASET_COMMIT,
  FROZEN_MANIFEST_PATH,
  HARNESS_COMMIT,
  PROTOCOL_ID,
  TASK_RELATIVE_PATH,
  readV25FrozenManifest,
  validateV25Manifest,
} from './manifest.mjs'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const DRIVER_OBJECT_PATHS = [
  'eval/long-system/v25',
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
  if (status !== '') throw new Error('V25 driver sources must be committed and clean before freeze')
  const objects = Object.fromEntries(DRIVER_OBJECT_PATHS.map(path => [
    path,
    git(root, ['rev-parse', `${driverCommit}:${path}`]),
  ]))
  const candidateAncestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', CANDIDATE_COMMIT, driverCommit])
  if (candidateAncestor.status !== 0) throw new Error('candidate commit must precede the frozen V25 driver')
  return {
    commit: driverCommit,
    tree: git(root, ['rev-parse', `${driverCommit}:eval/long-system/v25`]),
    sourceObjects: objects,
    sourceDigest: sha256(objects),
  }
}

export function buildV25Manifest({ runtime, candidate, task, image, driver }) {
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
  const body = {
    schemaVersion: 1,
    protocolId: PROTOCOL_ID,
    status: 'preregistered-native-calibration',
    executionAllowed: true,
    resultClaimsAllowed: false,
    candidateExecutionInitiallyAllowed: false,
    claimBoundary: 'V24 first observed a native max-token planning failure. V25 preregisters symmetric terminal-outcome scoring before any candidate run: five retained native calibrations qualify one unseen candidate on the same fixed nine-round EvoCode Jobforge task. Release is allowed only by the frozen V25 analyzer.',
    terminalOutcomePolicy: {
      scorableTerminalKinds: ['completed', 'max-tokens'],
      officialVerifierAfterEveryProductTerminal: true,
      continueAfterMaxTokens: false,
      unreachedRoundsScoreZero: true,
      candidateMaxTokenProductTerminals: V25_THRESHOLDS.maximumCandidateMaxTokenProductTerminals,
    },
    priorObservation: {
      protocolId: 'plan-lattice-rc7-evocode-jobforge-v24',
      runId: 'v24-2026-08-21t10-50-49-322z-387a51e3',
      attemptId: 'v24-2026-08-21t10-50-49-322z-387a51e3-native-1',
      resultClass: 'preregistered-negative',
      scoringStatus: 'unscored-by-v24-policy',
      terminalReason: 'max-tokens',
      candidateExecuted: false,
      manifestDigest: '955d16c1555591c3d39a34bb8eba6970d7a243103620cadec706e6dfa616f765',
      reportDigest: '720ded251769138e1bf9e7fcae20a8dd8f8101818e69e97dfebe8a63a55ab6af',
      initialWorkspaceSha256: 'c8b58996c19ec7f1f07471694146ad3afc578714495645060557f6c2b2f302ed',
      finalWorkspaceSha256: 'c8b58996c19ec7f1f07471694146ad3afc578714495645060557f6c2b2f302ed',
      usage: { agentRequests: 3, inputTokens: 22563, outputTokens: 33136, terminalOutputTokens: 32766 },
      sourceDigests: {
        finalReport: '45b33d962b583fe59195bfdaca3ebb8a42db734ac7068e60af60ff1c364bcc88',
        runEnvelope: '662c2e56d1c3292e3f70a5168e3332a02c6540672ae8cd3857357955d80cc98c',
        modelProxyAudit: '143c499b00dd2458de318df02fb99c96e7c790e4eb0bc144dc8c5f64dda250aa',
        budgetAudit: 'aaf743cc07d34262543613badbbdfb09d68ca45da0740ea548520dea8acc75f2',
        attemptFailure: '45aca696493bb0887b515081f047d63870d043e6147a29e8f290ec98ae262fda',
        harnessStderr: 'c7f5c45c6fdbb3c66d0a1366fe23a1e4e485fa6f3a58d4e50306bbbb62b46b29',
        session: '85696d0f4654051bbb344c0964e0e75ed4697afe169679fbe7234b768f459167',
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
      runtimePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V25_HOST_RUNTIME',
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      tree: CANDIDATE_TREE,
      packageVersion: '0.4.0-rc.9',
      tarballSha256: candidate.sha256,
      packageManifestSha256: candidate.manifestSha256,
      packagePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V25_CANDIDATE_PACKAGE',
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
      rootPathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V25_TASK_ROOT',
      datasetPathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V25_DATASET_ROOT',
      archivePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V25_DATASET_ARCHIVE',
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
      nativeRuns: V25_THRESHOLDS.requiredNativeAttempts,
      candidateRunsMaximum: 1,
      order: ['native-1', 'native-2', 'native-3', 'native-4', 'native-5', 'candidate-if-qualified'],
      baselineAggregation: 'median-of-five-native-runs',
      candidateGateAuthority: 'eval/long-system/v25/analysis.mjs',
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
    thresholds: V25_THRESHOLDS,
    outputPolicy: {
      rootEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V25_OUTPUT_ROOT',
      exclusiveCreate: true,
      overwriteAllowed: false,
    },
    paidRuns: { native: 5, candidateMaximum: 1 },
  }
  return validateV25Manifest({ ...body, manifestDigest: sha256(body) })
}

export async function writeJsonExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(canonicalJson(value), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function freezeV25({
  runtimePath,
  candidatePackagePath,
  taskRoot,
  datasetRoot,
  archivePath,
  dockerImage,
  driverCommit,
}) {
  const [runtime, candidate, task] = await Promise.all([
    inspectHarnessRuntime(runtimePath),
    inspectCandidatePackage(candidatePackagePath),
    inspectTaskCheckout({ taskRoot, datasetRoot, archivePath }),
  ])
  const image = inspectDockerImage(dockerImage)
  const driver = inspectDriverCheckout(driverCommit)
  return buildV25Manifest({ runtime, candidate, task, image, driver })
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  if (!process.argv.includes('--write')) {
    process.stdout.write(`${(await readV25FrozenManifest()).manifestDigest}\n`)
    return
  }
  const manifest = await freezeV25({
    runtimePath: option('--host-runtime'),
    candidatePackagePath: option('--candidate-package'),
    taskRoot: option('--task-root'),
    datasetRoot: option('--dataset-root'),
    archivePath: option('--dataset-archive'),
    dockerImage: option('--docker-image'),
    driverCommit: option('--driver-commit'),
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
