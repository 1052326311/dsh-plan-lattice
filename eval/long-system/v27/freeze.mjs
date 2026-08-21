#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { V27_EXECUTION_PLAN, V27_THRESHOLDS } from './analysis.mjs'
import { inspectEvoCodeTask } from './benchmark.mjs'
import {
  CANDIDATE_COMMIT,
  CANDIDATE_LOCKFILE_SHA256,
  CANDIDATE_NPM_VERSION,
  CANDIDATE_NODE_VERSION,
  CANDIDATE_PNPM_VERSION,
  CANDIDATE_SOURCE_PROVENANCE,
  CANDIDATE_SOURCE_PAYLOAD_SHA256,
  CANDIDATE_TARBALL_SHA256,
  CANDIDATE_TREE,
  EVOCODE_ARCHIVE_SHA256,
  EVOCODE_ARCHIVE_RELATIVE_PATH,
  EVOCODE_DATASET_COMMIT,
  EVOCODE_DATASET_REMOTE,
  FROZEN_EVIDENCE_PUBLIC_KEY_BASE64,
  FROZEN_EVIDENCE_PUBLIC_KEY_SHA256,
  FROZEN_MANIFEST_PATH,
  HARNESS_COMMIT,
  PROTOCOL_ID,
  SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE,
  TASK_RELATIVE_PATH,
  V27_ATTEMPT_BUDGET,
  V27_DRIVER_OBJECT_PATHS,
  V27_EXECUTION_SANDBOX,
  V27_MODEL,
  V27_ZSTD_RELEASE_URL,
  V27_ZSTD_SHA256,
  V27_ZSTD_SOURCE_ARCHIVE_SHA256,
  V27_ZSTD_VERSION,
  V27_PRIOR_OBSERVATION,
  readV27FrozenManifest,
  validateV27Manifest,
} from './manifest.mjs'
import {
  V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
  V27_MANIFEST_RELATIVE_PATH,
  V27_PUBLIC_REF,
  V27_PUBLIC_REMOTE_URL,
} from './public-anchor.mjs'
import { isolatedGit } from './git-safety.mjs'
import { assertV27CheckoutIntegrity } from './checkout-integrity.mjs'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

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
  return String(isolatedGit(root, args)).trim()
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

function validateTarEntries(listing) {
  const entries = String(listing).split(/\r?\n/u).filter(Boolean)
  const seen = new Set()
  for (const raw of entries) {
    const entry = raw.endsWith('/') ? raw.slice(0, -1) : raw
    const segments = entry.split('/')
    if (segments[0] !== 'package'
      || segments.some(segment => segment === '' || segment === '.' || segment === '..')
      || entry.includes('\\')
      || seen.has(entry)) {
      throw new Error('candidate tarball contains an unsafe or duplicate path')
    }
    seen.add(entry)
  }
  if (entries.length === 0) throw new Error('candidate tarball is empty')
}

async function candidatePayloadRecords(root, directory = root) {
  const records = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    const name = relative(root, path).split(sep).join('/')
    const metadata = await lstat(path)
    if (entry.isDirectory()) records.push(...await candidatePayloadRecords(root, path))
    else if (entry.isFile()) {
      let bytes = await readFile(path)
      if (name === 'package.json') {
        const manifest = JSON.parse(bytes)
        if (manifest?.scripts && typeof manifest.scripts === 'object') delete manifest.scripts.prepack
        bytes = Buffer.from(canonicalJson(manifest), 'utf8')
      }
      records.push({
        path: name,
        mode: (metadata.mode & 0o111) === 0 ? '100644' : '100755',
        bytes: bytes.length,
        sha256: sha256(bytes),
      })
    } else {
      throw new Error(`candidate package contains an unsupported entry: ${name}`)
    }
  }
  return records
}

async function extractCandidatePayload(archive, destination) {
  validateTarEntries(command('tar', ['-tzf', archive]))
  command('tar', ['-xzf', archive, '-C', destination], { timeout: 60_000, killSignal: 'SIGKILL' })
  const packageRoot = join(destination, 'package')
  if (!(await stat(packageRoot)).isDirectory()) throw new Error('candidate tarball has no package root')
  return candidatePayloadRecords(packageRoot)
}

export async function inspectCandidateSourceProvenance(candidatePath, sourceRoot = repositoryRoot) {
  const absolute = resolve(candidatePath)
  git(sourceRoot, ['cat-file', '-e', `${CANDIDATE_COMMIT}^{commit}`])
  if (git(sourceRoot, ['rev-parse', `${CANDIDATE_COMMIT}^{tree}`]) !== CANDIDATE_TREE) {
    throw new Error('candidate source commit does not have the frozen tree')
  }
  const pnpmStore = await realpath(String(command('pnpm', ['store', 'path'], {
    cwd: sourceRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? tmpdir(),
      ...(process.env.XDG_DATA_HOME ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {}),
      ...(process.env.PNPM_HOME ? { PNPM_HOME: process.env.PNPM_HOME } : {}),
    },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })).trim())
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-candidate-source-'))
  try {
    const source = join(root, 'source')
    const packed = join(root, 'packed')
    const expected = join(root, 'expected')
    const observed = join(root, 'observed')
    const home = join(root, 'home')
    const cache = join(root, 'npm-cache')
    const temp = join(root, 'tmp')
    const userNpmConfig = join(root, 'user.npmrc')
    const globalNpmConfig = join(root, 'global.npmrc')
    await Promise.all([source, packed, expected, observed, home, cache, temp]
      .map(path => mkdir(path, { mode: 0o700 })))
    await Promise.all([
      writeFile(userNpmConfig, '', { mode: 0o600 }),
      writeFile(globalNpmConfig, '', { mode: 0o600 }),
    ])
    const sourceArchive = join(root, 'source.tar')
    isolatedGit(sourceRoot, [
      'archive', '--format=tar', `--output=${sourceArchive}`, CANDIDATE_COMMIT,
    ])
    command('tar', ['-xf', sourceArchive, '-C', source], { timeout: 60_000, killSignal: 'SIGKILL' })
    const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (sourceManifest?.name !== 'dsh-plan-lattice'
      || sourceManifest?.version !== '0.4.0-rc.9'
      || sourceManifest?.scripts?.build !== 'tsc -p tsconfig.json'
      || sha256(await readFile(join(source, 'pnpm-lock.yaml'))) !== CANDIDATE_LOCKFILE_SHA256
      || process.version !== CANDIDATE_NODE_VERSION) {
      throw new Error('candidate source build inputs differ from the frozen commit contract')
    }
    const buildEnvironment = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: temp,
      CI: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      npm_config_userconfig: userNpmConfig,
      npm_config_globalconfig: globalNpmConfig,
      npm_config_cache: cache,
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_provenance: 'false',
      npm_config_update_notifier: 'false',
    }
    const pnpmVersion = String(command('pnpm', ['--version'], {
      cwd: source, env: buildEnvironment, timeout: 30_000, killSignal: 'SIGKILL',
    })).trim()
    const npmVersion = String(command('npm', ['--version'], {
      cwd: source, env: buildEnvironment, timeout: 30_000, killSignal: 'SIGKILL',
    })).trim()
    if (pnpmVersion !== CANDIDATE_PNPM_VERSION || npmVersion !== CANDIDATE_NPM_VERSION) {
      throw new Error('candidate source build toolchain differs from the frozen versions')
    }
    command('pnpm', [
      'install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--store-dir', pnpmStore,
    ], {
      cwd: source, env: buildEnvironment, timeout: 120_000, killSignal: 'SIGKILL',
    })
    command('pnpm', ['run', 'build'], {
      cwd: source, env: buildEnvironment, timeout: 120_000, killSignal: 'SIGKILL',
    })
    const packedResult = JSON.parse(String(command('npm', [
      'pack', '--ignore-scripts', '--json', `--pack-destination=${packed}`,
    ], {
      cwd: source, env: buildEnvironment, timeout: 120_000, killSignal: 'SIGKILL',
    })))
    if (!Array.isArray(packedResult) || packedResult.length !== 1
      || typeof packedResult[0]?.filename !== 'string') {
      throw new Error('candidate source rebuild did not produce exactly one package')
    }
    const [expectedRecords, observedRecords] = await Promise.all([
      extractCandidatePayload(join(packed, packedResult[0].filename), expected),
      extractCandidatePayload(absolute, observed),
    ])
    if (canonicalJson(expectedRecords) !== canonicalJson(observedRecords)) {
      throw new Error('candidate tarball payload cannot be reproduced from its frozen source commit')
    }
    const payloadSha256 = sha256(observedRecords)
    if (payloadSha256 !== CANDIDATE_SOURCE_PAYLOAD_SHA256) {
      throw new Error('candidate source payload differs from the frozen provenance digest')
    }
    if (observedRecords.length !== CANDIDATE_SOURCE_PROVENANCE.entryCount) {
      throw new Error('candidate source payload entry count differs from the frozen provenance')
    }
    return { ...CANDIDATE_SOURCE_PROVENANCE }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function inspectCandidatePackage(path, { sourceRoot = repositoryRoot } = {}) {
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
  const sourceProvenance = await inspectCandidateSourceProvenance(absolute, sourceRoot)
  return {
    path: absolute,
    sha256: digest,
    manifestSha256: sha256(manifest.bytes),
    sourceProvenance,
    sourceProvenanceSha256: sha256(sourceProvenance),
  }
}

export async function inspectSigningPrivateKey(path) {
  const absolute = resolve(path)
  const [bytes, metadata] = await Promise.all([readFile(absolute), stat(absolute)])
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('V27 signing private key must not be readable or writable by group or others')
  }
  let privateKey
  try {
    privateKey = createPrivateKey(bytes)
  } catch {
    throw new Error('V27 signing private key is invalid')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('V27 signing private key must use Ed25519')
  }
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return {
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyBase64: publicKey.toString('base64'),
    publicKeySha256: sha256(publicKey),
  }
}

export async function inspectTaskCheckout({ taskRoot, datasetRoot, archivePath, zstdPath }) {
  const checkout = await realpath(resolve(datasetRoot))
  const task = await realpath(resolve(taskRoot))
  const archive = resolve(archivePath)
  if (!isAbsolute(zstdPath ?? '') || basename(zstdPath) !== 'zstd') {
    throw new Error('V27 requires an absolute zstd executable path')
  }
  const zstd = resolve(zstdPath)
  const zstdBytes = await readFile(zstd)
  const zstdVersion = String(command(zstd, ['--version'])).trim()
  if (!new RegExp(`\\bv${V27_ZSTD_VERSION.replaceAll('.', '\\.')}\\b`, 'u').test(zstdVersion)
    || sha256(zstdBytes) !== V27_ZSTD_SHA256) {
    throw new Error('V27 requires the exact frozen zstd 1.5.7 decompressor')
  }
  const archiveBytes = await readFile(archive)
  const archiveSha256 = sha256(archiveBytes)
  if (archiveSha256 !== EVOCODE_ARCHIVE_SHA256) {
    throw new Error(`EvoCode dataset archive digest mismatch: ${archiveSha256}`)
  }
  if (git(checkout, ['rev-parse', 'HEAD']) !== EVOCODE_DATASET_COMMIT) {
    throw new Error('EvoCode dataset checkout is not the frozen Hugging Face commit')
  }
  const origin = git(checkout, ['remote', 'get-url', 'origin']).replace(/\.git$/u, '')
  if (origin !== EVOCODE_DATASET_REMOTE) {
    throw new Error('EvoCode dataset checkout does not cite the official Hugging Face remote')
  }
  if (git(checkout, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new Error('EvoCode dataset checkout is not clean')
  }
  const datasetTree = git(checkout, ['rev-parse', `${EVOCODE_DATASET_COMMIT}^{tree}`])
  const archivePointerBlob = git(checkout, [
    'rev-parse', `${EVOCODE_DATASET_COMMIT}:${EVOCODE_ARCHIVE_RELATIVE_PATH}`,
  ])
  const pointer = git(checkout, ['show', `${EVOCODE_DATASET_COMMIT}:${EVOCODE_ARCHIVE_RELATIVE_PATH}`])
  const pointerMatch = pointer.match(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)$/u)
  if (!pointerMatch
    || pointerMatch[1] !== archiveSha256
    || Number(pointerMatch[2]) !== archiveBytes.length) {
    throw new Error('EvoCode archive does not match the Git LFS object at the frozen dataset commit')
  }
  const extracted = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-dataset-'))
  let archivedTask
  try {
    command('tar', ['-xf', archive, '-C', extracted, TASK_RELATIVE_PATH], {
      env: { ...process.env, PATH: `${dirname(zstd)}:${process.env.PATH ?? ''}` },
    })
    archivedTask = await realpath(join(extracted, TASK_RELATIVE_PATH))
    await assertTaskTreeMatchesArchive(task, archivedTask)
  } finally {
    await rm(extracted, { recursive: true, force: true })
  }
  const identity = await inspectTaskSnapshotIdentity(task)
  return {
    root: task,
    datasetRoot: checkout,
    datasetCommit: EVOCODE_DATASET_COMMIT,
    datasetTree,
    archivePointerBlob,
    archiveSha256,
    archiveBytes: archiveBytes.length,
    decompressorSha256: sha256(zstdBytes),
    decompressorVersion: V27_ZSTD_VERSION,
    ...identity,
  }
}

async function taskTreeRecords(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const records = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    const relative = path.slice(root.length + 1).split('\\').join('/')
    const metadata = await lstat(path)
    if (entry.isSymbolicLink()) throw new Error(`EvoCode task contains a symlink: ${relative}`)
    if (entry.isDirectory()) records.push(...await taskTreeRecords(root, path))
    else if (entry.isFile()) {
      records.push({
        path: relative,
        mode: metadata.mode & 0o777,
        bytes: metadata.size,
        sha256: sha256(await readFile(path)),
      })
    } else {
      throw new Error(`EvoCode task contains an unsupported filesystem entry: ${relative}`)
    }
  }
  return records
}

export async function inspectTaskSnapshotIdentity(taskRoot, inspector = inspectEvoCodeTask) {
  const root = await realpath(resolve(taskRoot))
  const [inspection, records] = await Promise.all([
    inspector(root),
    taskTreeRecords(root),
  ])
  const digests = {
    public: inspection.digests.public.sha256,
    hidden: inspection.digests.hidden.sha256,
    oracle: inspection.digests.oracle.sha256,
  }
  return {
    taskTreeSha256: sha256(records),
    taskFileCount: records.length,
    roundCount: inspection.roundCount,
    digests,
    assetSha256: sha256(digests),
  }
}

export async function assertTaskTreeMatchesArchive(taskRoot, archivedTaskRoot) {
  const [checkoutRecords, archiveRecords] = await Promise.all([
    taskTreeRecords(await realpath(resolve(taskRoot))),
    taskTreeRecords(await realpath(resolve(archivedTaskRoot))),
  ])
  if (canonicalJson(checkoutRecords) !== canonicalJson(archiveRecords)) {
    throw new Error('EvoCode task checkout differs from the authenticated dataset archive')
  }
  return { files: checkoutRecords.length, treeSha256: sha256(checkoutRecords) }
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
  assertV27CheckoutIntegrity({ root, commit: driverCommit })
  const status = git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...V27_DRIVER_OBJECT_PATHS])
  if (status !== '') throw new Error('V27 driver sources must be committed and clean before freeze')
  const objects = Object.fromEntries(V27_DRIVER_OBJECT_PATHS.map(path => [
    path,
    git(root, ['rev-parse', `${driverCommit}:${path}`]),
  ]))
  try {
    isolatedGit(root, ['merge-base', '--is-ancestor', CANDIDATE_COMMIT, driverCommit])
  } catch {
    throw new Error('candidate commit must precede the frozen V27 driver')
  }
  return {
    commit: driverCommit,
    tree: git(root, ['rev-parse', `${driverCommit}:eval/long-system/v27`]),
    sourceObjects: objects,
    sourceDigest: sha256(objects),
  }
}

export function buildV27Manifest({ runtime, candidate, task, image, driver, signing, trial }) {
  exactDigest(runtime?.sha256, 'runtime digest')
  exactDigest(runtime?.metadataSha256, 'runtime metadata digest')
  if (candidate?.sha256 !== CANDIDATE_TARBALL_SHA256) throw new Error('candidate package is not the fixed tarball')
  if (task?.datasetCommit !== EVOCODE_DATASET_COMMIT
    || task?.archiveSha256 !== EVOCODE_ARCHIVE_SHA256
    || !/^[0-9a-f]{40}$/u.test(task?.datasetTree ?? '')
    || !/^[0-9a-f]{40}$/u.test(task?.archivePointerBlob ?? '')
    || !Number.isSafeInteger(task?.archiveBytes)
    || task.archiveBytes < 1
    || !/^[0-9a-f]{64}$/u.test(task?.decompressorSha256 ?? '')
    || task?.decompressorVersion !== V27_ZSTD_VERSION
    || task?.decompressorSha256 !== V27_ZSTD_SHA256
    || !/^[0-9a-f]{64}$/u.test(task?.taskTreeSha256 ?? '')
    || !Number.isSafeInteger(task?.taskFileCount)
    || task.taskFileCount < 1
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
  if (!/^[a-z0-9][a-z0-9._-]{7,47}$/u.test(trial?.runId ?? '')) {
    throw new Error('V27 run ID must be frozen before manifest creation')
  }
  if (!isAbsolute(trial?.outputRoot ?? '') || resolve(trial.outputRoot) !== trial.outputRoot) {
    throw new Error('V27 output root must be a normalized absolute path frozen before execution')
  }
  const body = {
    schemaVersion: 3,
    protocolId: PROTOCOL_ID,
    status: 'preregistered-paired-comparison',
    executionAllowed: true,
    resultClaimsAllowed: false,
    candidateExecutionInitiallyAllowed: true,
    claimBoundary: 'V26 retained five Native outcomes below 90 but its preregistered spread gate prohibited the still-unseen Candidate. V27 treats Native variance as an outcome, freezes twelve contemporaneous AB/BA pairs before any Candidate execution, and permits release only through the disk-backed analyzer.',
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
      equalHardBudgetPerArm: true,
      realizedUsageIsDescriptive: true,
    },
    evidenceSigning: {
      schemaVersion: 3,
      algorithm: 'Ed25519',
      signedPayload: 'canonical-complete-attempt-envelope',
      publicKeyBase64: signing.publicKeyBase64,
      publicKeySha256: signing.publicKeySha256,
      privateKeyPathEnvironmentVariable: SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE,
    },
    priorObservation: V27_PRIOR_OBSERVATION,
    harness: {
      commit: HARNESS_COMMIT,
      tag: 'dsh-v0.1.0-rc.7',
      runtimeSha256: runtime.sha256,
      runtimeMetadataSha256: runtime.metadataSha256,
      platform: runtime.platform,
      architecture: runtime.architecture,
      node: runtime.node,
      runtimePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V27_HOST_RUNTIME',
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      tree: CANDIDATE_TREE,
      packageVersion: '0.4.0-rc.9',
      tarballSha256: candidate.sha256,
      packageManifestSha256: candidate.manifestSha256,
      sourceProvenance: candidate.sourceProvenance,
      sourceProvenanceSha256: candidate.sourceProvenanceSha256,
      packagePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V27_CANDIDATE_PACKAGE',
      mode: { activationMode: 'auto', clarificationPolicy: 'critical', controlCeiling: 'lattice' },
      evaluationWrapper: {
        strictBash: true,
        preconditionAdapter: 'workspace-shell-adapter',
        activationEvidence: 'one exclusive fsync-backed receipt per actual Harness process, bound to epoch digest, evaluator nonce, process PID, wrapper, candidate, config, and Bash adapter',
        publicDefaultEquivalent: false,
        claimScope: 'The candidate is the frozen Plan Lattice tarball installed through the disclosed DSH Bash adapter; the adapter is evaluation integration, not part of the candidate tarball.',
      },
    },
    driver,
    task: {
      id: 'theme_d1_w1_code_build_greenfield_implementation',
      datasetCommit: EVOCODE_DATASET_COMMIT,
      datasetRemote: EVOCODE_DATASET_REMOTE,
      datasetTree: task.datasetTree,
      archiveSha256: task.archiveSha256,
      archiveBytes: task.archiveBytes,
      archiveRelativePath: EVOCODE_ARCHIVE_RELATIVE_PATH,
      archivePointerBlob: task.archivePointerBlob,
      decompressorSha256: task.decompressorSha256,
      decompressorVersion: task.decompressorVersion,
      decompressorSourceArchiveSha256: V27_ZSTD_SOURCE_ARCHIVE_SHA256,
      decompressorReleaseUrl: V27_ZSTD_RELEASE_URL,
      decompressorPathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V27_ZSTD',
      taskTreeSha256: task.taskTreeSha256,
      taskFileCount: task.taskFileCount,
      relativePath: TASK_RELATIVE_PATH,
      assetSha256: task.assetSha256,
      rounds: task.roundCount,
      digests: task.digests,
      rootPathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V27_TASK_ROOT',
      datasetPathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V27_DATASET_ROOT',
      archivePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V27_DATASET_ARCHIVE',
    },
    image: { ...image, taskPublicSha256: task.digests.public },
    model: V27_MODEL,
    budgetPerAttempt: V27_ATTEMPT_BUDGET,
    executionSandbox: V27_EXECUTION_SANDBOX,
    comparison: {
      pairs: V27_THRESHOLDS.requiredPairs,
      attemptsPerArm: V27_THRESHOLDS.requiredAttemptsPerArm,
      order: V27_EXECUTION_PLAN,
      aggregation: 'median-of-twelve-per-arm-with-twelve-contemporaneous-pairs',
      releaseAuthority: 'eval/long-system/v27/report-verifier.mjs',
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
    thresholds: V27_THRESHOLDS,
    trial: {
      runId: trial.runId,
      outputRoot: trial.outputRoot,
      disclosurePolicy: {
        publicPrecommitRequired: true,
        accidentalDuplicatePrevention: 'exclusive-local-files',
        maliciousLocalDeletionDetection: false,
        claimScope: 'one publicly preregistered, operator-attested disclosed trial; absence of deleted local trials is not cryptographically proven',
      },
    },
    publicationAnchor: {
      schemaVersion: 1,
      manifestPath: V27_MANIFEST_RELATIVE_PATH,
      commitEnvironmentVariable: V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
      publicRemoteUrl: V27_PUBLIC_REMOTE_URL,
      publicRef: V27_PUBLIC_REF,
      requiredBeforePaidRequest: true,
      singleParentOfDriverCommit: true,
      exactRemoteRefRequired: true,
      currentExactTagEqualityRequired: true,
      tagHistoryAuthority: 'current-remote-equality-only; historical immutability is operator-attested',
    },
    outputPolicy: {
      rootEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V27_OUTPUT_ROOT',
      absoluteRoot: trial.outputRoot,
      exclusiveCreate: true,
      overwriteAllowed: false,
    },
    paidRuns: { native: 12, candidate: 12 },
  }
  return validateV27Manifest({ ...body, manifestDigest: sha256(body) })
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

export async function inspectV27OutputRoot(outputRoot, sourceRoot = repositoryRoot) {
  if (typeof outputRoot !== 'string' || !isAbsolute(outputRoot)) {
    throw new Error('V27 output root must be an absolute path')
  }
  const absolute = resolve(outputRoot)
  try {
    await lstat(absolute)
    throw new Error('V27 output root must not exist before manifest freeze')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const [canonicalParent, canonicalSource] = await Promise.all([
    realpath(dirname(absolute)),
    realpath(sourceRoot),
  ])
  const canonicalOutput = join(canonicalParent, basename(absolute))
  const relativePath = relative(canonicalSource, canonicalOutput)
  const insideSource = relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  if (insideSource) throw new Error('V27 output root must be outside the source repository')
  return canonicalOutput
}

export async function freezeV27({
  runtimePath,
  candidatePackagePath,
  taskRoot,
  datasetRoot,
  archivePath,
  zstdPath,
  dockerImage,
  driverCommit,
  signingPrivateKeyPath,
  outputRoot,
  runId,
}) {
  const [runtime, candidate, task, signing] = await Promise.all([
    inspectHarnessRuntime(runtimePath),
    inspectCandidatePackage(candidatePackagePath),
    inspectTaskCheckout({ taskRoot, datasetRoot, archivePath, zstdPath }),
    inspectSigningPrivateKey(signingPrivateKeyPath),
  ])
  const image = inspectDockerImage(dockerImage)
  const driver = inspectDriverCheckout(driverCommit)
  const absoluteOutputRoot = await inspectV27OutputRoot(outputRoot)
  return buildV27Manifest({
    runtime,
    candidate,
    task,
    image,
    driver,
    signing,
    trial: { runId, outputRoot: absoluteOutputRoot },
  })
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  if (!process.argv.includes('--write')) {
    process.stdout.write(`${(await readV27FrozenManifest()).manifestDigest}\n`)
    return
  }
  const manifest = await freezeV27({
    runtimePath: option('--host-runtime'),
    candidatePackagePath: option('--candidate-package'),
    taskRoot: option('--task-root'),
    datasetRoot: option('--dataset-root'),
    archivePath: option('--dataset-archive'),
    zstdPath: option('--zstd'),
    dockerImage: option('--docker-image'),
    driverCommit: option('--driver-commit'),
    signingPrivateKeyPath: option('--signing-private-key'),
    outputRoot: option('--output-root'),
    runId: option('--run-id'),
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
