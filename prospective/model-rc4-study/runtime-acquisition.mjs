import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RUNTIME_ACQUISITION_LOCK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'runtime-acquisition.lock.json',
)

export const RUNTIME_ACQUISITION_LOCK_SHA256 = 'b54e71f2f24487e593fe0755ae8b35358cd2b1bc0671ecca585de2ee39b5f201'

const CANDIDATE_COMMIT = '7cb3c77f9dab6ef193eb77318fb87389b877b526'
const HARNESS_COMMIT = '47f943859bef60e4160492346772ded9b24f765a'
const WORKFLOW_COMMIT = 'e4d6af700de7ddf870bbba96f76e8f3b5d73fe8e'
const BASE_IMAGE = 'node:22.23.0-bookworm@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a'
const INNER_RUNTIME_PATH = 'installed-agent/runtime/runtime.json'
const INNER_PLUGIN_PATH = 'installed-agent/runtime/packages/plugin.tgz'

const expectedArtifacts = {
  native: {
    github: {
      id: 9272949306,
      name: `plan-lattice-linux-native-arm64-${CANDIDATE_COMMIT}`,
      archiveDigest: 'sha256:c34d98f67e13b371cd2666245d44ce418e94ed25186a92b4c2d8115e75a57a48',
      sizeInBytes: 100103264,
    },
    archive: {
      file: 'plan-lattice-linux-native-arm64.tgz',
      sha256: '4a7305b506dd36c11d16f55ddd7a3223d4495c1b6113ea6c5ade7c77a4062acc',
      buildOutputPath: '/tmp/dsh-plan-lattice-runtime-output/native/plan-lattice-linux-native-arm64.tgz',
    },
    runtimeMetadataDigest: '9c39c12b8ce872d5795088ac59bc83c1fe1074524db6e183c8922bd79860c2e1',
    pluginPackageDigest: null,
    arm: { id: 'native', plugin: 'none' },
  },
  'v0.4-contract': {
    github: {
      id: 9272954825,
      name: `plan-lattice-linux-v0.4-contract-arm64-${CANDIDATE_COMMIT}`,
      archiveDigest: 'sha256:c1e4aa5031b524446095fd380b7d51a5857c2685e5c7dcafd4aa8443acb87c8e',
      sizeInBytes: 100656286,
    },
    archive: {
      file: 'plan-lattice-linux-v0.4-contract-arm64.tgz',
      sha256: '015981892520299896cea4cf1be8eac24ac4f396b3f8e89c4f9aada514c5f623',
      buildOutputPath: '/tmp/dsh-plan-lattice-runtime-output/v0.4-contract/plan-lattice-linux-v0.4-contract-arm64.tgz',
    },
    runtimeMetadataDigest: '110291e604edafb233a42d8ab9ef1db39568c05edccb6cfc16aa4eb1cd84012b',
    pluginPackageDigest: 'adcf51cea9672fe21fc3e832fefec0412c558dfaeaa0d761b4d415d8dd2087d5',
    arm: {
      id: 'v0.4-contract',
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
      clarificationPolicy: 'critical',
      controlCeiling: 'contract',
    },
  },
  'v0.4-lattice': {
    github: {
      id: 9272955682,
      name: `plan-lattice-linux-v0.4-lattice-arm64-${CANDIDATE_COMMIT}`,
      archiveDigest: 'sha256:95665562ebeb6b60152045c67f9f21258b722f0355d8edf83de5cf0618dde599',
      sizeInBytes: 100671492,
    },
    archive: {
      file: 'plan-lattice-linux-v0.4-lattice-arm64.tgz',
      sha256: '5b72eefd7dc9e4614bc3547a7f67de7c7c279bf729bc5bdb64f8b44b3dc84ba4',
      buildOutputPath: '/tmp/dsh-plan-lattice-runtime-output/v0.4-lattice/plan-lattice-linux-v0.4-lattice-arm64.tgz',
    },
    runtimeMetadataDigest: '747d39727e1a7a6de4b8b97f8ca1af200f4716277d08109bb5dbcd1fba90074a',
    pluginPackageDigest: 'adcf51cea9672fe21fc3e832fefec0412c558dfaeaa0d761b4d415d8dd2087d5',
    arm: {
      id: 'v0.4-lattice',
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
    },
  },
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

function digest(value) {
  const bytes = Buffer.isBuffer(value) || typeof value === 'string' ? value : canonicalJson(value)
  return createHash('sha256').update(bytes).digest('hex')
}

async function digestFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys changed: expected ${expected.join(', ')}, got ${actual.join(', ')}`)
  }
}

function same(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} changed`)
}

function sha256String(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest`)
}

export function validateRuntimeAcquisitionLock(lock) {
  exactKeys(lock, [
    'schemaVersion', 'kind', 'repository', 'workflow', 'candidateCommit', 'harnessCommit',
    'baseImage', 'rootPolicy', 'artifacts',
  ], 'runtime acquisition lock')
  if (lock.schemaVersion !== 1 || lock.kind !== 'dsh-plan-lattice-model-rc4-runtime-acquisition-lock') {
    throw new Error('runtime acquisition lock identity changed')
  }
  same(lock.repository, { owner: '1052326311', name: 'dsh-plan-lattice', id: 1334504487 }, 'repository identity')
  same(lock.workflow, {
    runId: 31982987064,
    headBranch: 'main',
    headCommit: WORKFLOW_COMMIT,
    acceptOnlyThisRun: true,
  }, 'workflow identity')
  if (lock.candidateCommit !== CANDIDATE_COMMIT) throw new Error('RC.4 candidate commit changed')
  if (lock.harnessCommit !== HARNESS_COMMIT) throw new Error('Harness commit changed')
  if (lock.baseImage !== BASE_IMAGE) throw new Error('base image changed')
  same(lock.rootPolicy, {
    environmentVariable: 'PLAN_LATTICE_RC4_RUNTIME_ACQUISITION_ROOT',
    exactArtifactDirectorySet: true,
    exactArtifactFileSet: true,
    regularFilesAndDirectoriesOnly: true,
  }, 'runtime root policy')

  exactKeys(lock.artifacts, Object.keys(expectedArtifacts), 'runtime artifacts')
  for (const [id, expected] of Object.entries(expectedArtifacts)) {
    const record = lock.artifacts[id]
    exactKeys(record, [
      'github', 'directory', 'archive', 'runtimeMetadataDigest', 'pluginPackageDigest', 'arm', 'files',
    ], `${id} artifact`)
    same(record.github, expected.github, `${id} GitHub artifact identity`)
    if (record.directory !== expected.github.name) throw new Error(`${id} artifact directory changed`)
    same(record.archive, expected.archive, `${id} runtime archive`)
    if (record.runtimeMetadataDigest !== expected.runtimeMetadataDigest) throw new Error(`${id} metadata digest changed`)
    if (record.pluginPackageDigest !== expected.pluginPackageDigest) throw new Error(`${id} plugin package digest changed`)
    same(record.arm, expected.arm, `${id} arm identity`)
    exactKeys(record.files, ['archive.sha256', 'base-image.txt', 'build-result.json', record.archive.file, 'runtime.json'], `${id} file closure`)
    for (const [name, fileDigest] of Object.entries(record.files)) sha256String(fileDigest, `${id}/${name}`)
    if (record.files[record.archive.file] !== record.archive.sha256) throw new Error(`${id} archive and file digests disagree`)
  }
  return lock
}

export async function loadRuntimeAcquisitionLock(path = RUNTIME_ACQUISITION_LOCK_PATH) {
  const bytes = await readFile(path)
  const actualDigest = digest(bytes)
  if (actualDigest !== RUNTIME_ACQUISITION_LOCK_SHA256) {
    throw new Error(`runtime acquisition lock digest mismatch: expected ${RUNTIME_ACQUISITION_LOCK_SHA256}, got ${actualDigest}`)
  }
  let lock
  try {
    lock = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('runtime acquisition lock is not valid JSON')
  }
  return { lock: validateRuntimeAcquisitionLock(lock), path: resolve(path), sha256: actualDigest }
}

async function exactDirectory(path, expectedNames, expectedKind, label) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`)
  }
  const actualNames = entries.map(entry => entry.name).sort()
  const expected = [...expectedNames].sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
    throw new Error(`${label} entry set changed: expected ${expected.join(', ')}, got ${actualNames.join(', ')}`)
  }
  for (const entry of entries) {
    const valid = expectedKind === 'directory' ? entry.isDirectory() : entry.isFile()
    if (!valid) throw new Error(`${label}/${entry.name} must be a regular ${expectedKind}`)
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function listArchive(archive) {
  const output = runTar(['-tzf'], archive, 'runtime archive listing', 'utf8')
  return output.split(/\r?\n/u).filter(Boolean)
}

function readArchiveEntry(archive, entry) {
  return runTar(['-xOzf'], archive, `runtime archive entry ${entry}`, null, entry)
}

function runTar(args, archive, label, encoding = null, entry) {
  const command = [...args, archive]
  if (entry) command.push(entry)
  const result = spawnSync('tar', command, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`)
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr
    throw new Error(`${label} failed: ${(stderr || '').trim()}`)
  }
  return result.stdout
}

function verifyRuntimeMetadata(metadata, record, lock, id) {
  exactKeys(metadata, [
    'schemaVersion', 'arm', 'armDigest', 'harnessCommit', 'pluginCommit', 'pluginPackageDigest',
    'baseImage', 'pnpm', 'runtimeClosure', 'supportDigest', 'profilePatchDigest',
  ], `${id} runtime metadata`)
  exactKeys(metadata.runtimeClosure, ['dependencyCount', 'reachableWorkspacePackages', 'sha256'], `${id} runtime closure`)
  same(metadata.arm, record.arm, `${id} embedded arm identity`)
  if (metadata.schemaVersion !== 1 || metadata.armDigest !== digest(record.arm)) throw new Error(`${id} arm digest mismatch`)
  if (metadata.harnessCommit !== lock.harnessCommit) throw new Error(`${id} Harness commit mismatch`)
  const expectedPluginCommit = id === 'native' ? null : lock.candidateCommit
  if (metadata.pluginCommit !== expectedPluginCommit) throw new Error(`${id} plugin commit mismatch`)
  if (metadata.pluginPackageDigest !== record.pluginPackageDigest) throw new Error(`${id} plugin package identity mismatch`)
  if (metadata.baseImage !== lock.baseImage) throw new Error(`${id} base image mismatch`)
  if (digest(metadata) !== record.runtimeMetadataDigest) throw new Error(`${id} runtime metadata digest mismatch`)
  for (const [name, value] of [
    ['supportDigest', metadata.supportDigest],
    ['profilePatchDigest', metadata.profilePatchDigest],
    ['runtimeClosure.sha256', metadata.runtimeClosure.sha256],
  ]) sha256String(value, `${id} ${name}`)
  if (!Number.isInteger(metadata.runtimeClosure.dependencyCount)
    || !Number.isInteger(metadata.runtimeClosure.reachableWorkspacePackages)
    || metadata.runtimeClosure.dependencyCount < 1
    || metadata.runtimeClosure.reachableWorkspacePackages < 1) {
    throw new Error(`${id} runtime closure counts are invalid`)
  }
}

async function verifyArtifact(root, lock, id, record) {
  const artifactRoot = join(root, record.directory)
  const fileNames = Object.keys(record.files)
  await exactDirectory(artifactRoot, fileNames, 'file', `${id} downloaded artifact`)
  const validationOrder = [...fileNames.filter(name => name !== record.archive.file), record.archive.file]
  for (const name of validationOrder) {
    const actual = await digestFile(join(artifactRoot, name))
    if (actual !== record.files[name]) throw new Error(`${id}/${name} digest mismatch`)
  }

  const baseImageBytes = await readFile(join(artifactRoot, 'base-image.txt'))
  if (baseImageBytes.toString('utf8') !== `${lock.baseImage}\n`) throw new Error(`${id} base-image.txt changed`)
  const archiveChecksum = await readFile(join(artifactRoot, 'archive.sha256'), 'utf8')
  const expectedChecksum = `${record.archive.sha256}  ${record.archive.buildOutputPath}\n`
  if (archiveChecksum !== expectedChecksum) throw new Error(`${id} archive.sha256 changed`)

  const runtimeBytes = await readFile(join(artifactRoot, 'runtime.json'))
  const metadata = parseJson(runtimeBytes, `${id}/runtime.json`)
  verifyRuntimeMetadata(metadata, record, lock, id)

  const buildResult = parseJson(await readFile(join(artifactRoot, 'build-result.json')), `${id}/build-result.json`)
  exactKeys(buildResult, [
    'path', 'sha256', 'image', 'harnessCommit', 'runtimeMetadata', 'runtimeMetadataDigest', 'supportDigest', 'arm',
  ], `${id} build result`)
  if (buildResult.path !== record.archive.buildOutputPath
    || buildResult.sha256 !== record.archive.sha256
    || buildResult.image !== lock.baseImage
    || buildResult.harnessCommit !== lock.harnessCommit
    || buildResult.runtimeMetadataDigest !== record.runtimeMetadataDigest
    || buildResult.supportDigest !== metadata.supportDigest) {
    throw new Error(`${id} build result identity mismatch`)
  }
  same(buildResult.arm, record.arm, `${id} build-result arm`)
  same(buildResult.runtimeMetadata, metadata, `${id} build-result runtime metadata`)

  const archive = join(artifactRoot, record.archive.file)
  const members = listArchive(archive)
  if (members.filter(member => member === INNER_RUNTIME_PATH).length !== 1) {
    throw new Error(`${id} archive must contain exactly one ${INNER_RUNTIME_PATH}`)
  }
  const innerRuntimeBytes = readArchiveEntry(archive, INNER_RUNTIME_PATH)
  if (!Buffer.isBuffer(innerRuntimeBytes) || !innerRuntimeBytes.equals(runtimeBytes)) {
    throw new Error(`${id} archive runtime.json differs from the downloaded identity file`)
  }
  const pluginEntries = members.filter(member => member === INNER_PLUGIN_PATH)
  if (id === 'native') {
    if (pluginEntries.length !== 0 || metadata.pluginPackageDigest !== null) {
      throw new Error('native runtime unexpectedly contains a Plan Lattice package')
    }
  } else {
    if (pluginEntries.length !== 1) throw new Error(`${id} archive must contain exactly one Plan Lattice package`)
    const pluginBytes = readArchiveEntry(archive, INNER_PLUGIN_PATH)
    if (!Buffer.isBuffer(pluginBytes) || digest(pluginBytes) !== record.pluginPackageDigest) {
      throw new Error(`${id} embedded plugin package digest mismatch`)
    }
  }

  return {
    id,
    githubArtifactId: record.github.id,
    githubArtifactName: record.github.name,
    githubArchiveDigest: record.github.archiveDigest,
    directory: artifactRoot,
    archiveSha256: record.archive.sha256,
    runtimeMetadataDigest: record.runtimeMetadataDigest,
    pluginPackageDigest: record.pluginPackageDigest,
    arm: record.arm,
  }
}

export async function verifyRuntimeAcquisition(root = process.env.PLAN_LATTICE_RC4_RUNTIME_ACQUISITION_ROOT, options = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('runtime acquisition root is required (or set PLAN_LATTICE_RC4_RUNTIME_ACQUISITION_ROOT)')
  }
  const { lock, path, sha256 } = await loadRuntimeAcquisitionLock(options.lockPath)
  const absoluteRoot = resolve(root)
  const artifactRecords = Object.entries(lock.artifacts)
  await exactDirectory(absoluteRoot, artifactRecords.map(([, record]) => record.directory), 'directory', 'runtime acquisition root')
  const artifacts = []
  for (const [id, record] of artifactRecords) artifacts.push(await verifyArtifact(absoluteRoot, lock, id, record))
  return {
    schemaVersion: 1,
    kind: 'verified-dsh-plan-lattice-model-rc4-runtime-acquisition',
    root: absoluteRoot,
    lockPath: path,
    lockSha256: sha256,
    workflowRunId: lock.workflow.runId,
    workflowCommit: lock.workflow.headCommit,
    candidateCommit: lock.candidateCommit,
    harnessCommit: lock.harnessCommit,
    baseImage: lock.baseImage,
    artifacts,
  }
}
