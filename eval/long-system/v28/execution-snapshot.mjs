import { copyFile, cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import {
  inspectCandidatePackage,
  inspectHarnessRuntime,
  inspectTaskSnapshotIdentity,
  repositoryRoot,
} from './freeze.mjs'
import { isolatedGit } from './git-safety.mjs'
import { V28_DRIVER_OBJECT_PATHS } from './manifest.mjs'
import { immutableTreeSha256 } from './driver/runtime.mjs'

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function requiredPath(env, name) {
  const value = env[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is not set`)
  return resolve(value)
}

function assertSnapshotIdentity(identity, manifest) {
  if (identity?.schemaVersion !== 1
    || identity.driver?.commit !== manifest.driver.commit
    || !/^[0-9a-f]{64}$/u.test(identity.driver?.treeSha256 ?? '')
    || identity.harness?.sha256 !== manifest.harness.runtimeSha256
    || identity.harness?.metadataSha256 !== manifest.harness.runtimeMetadataSha256
    || identity.candidate?.sha256 !== manifest.candidate.tarballSha256
    || identity.candidate?.manifestSha256 !== manifest.candidate.packageManifestSha256
    || identity.candidate?.sourceProvenanceSha256 !== manifest.candidate.sourceProvenanceSha256
    || identity.task?.assetSha256 !== manifest.task.assetSha256
    || identity.task?.taskTreeSha256 !== manifest.task.taskTreeSha256
    || identity.task?.taskFileCount !== manifest.task.taskFileCount
    || !same(identity.task?.digests, manifest.task.digests)) {
    throw new Error('V28 execution snapshot differs from the frozen manifest')
  }
}

export async function materializeDriverSourceSnapshot({
  destination,
  commit,
  sourceRoot = repositoryRoot,
}) {
  await mkdir(destination, { recursive: false, mode: 0o700 })
  const archiveRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-driver-archive-'))
  try {
    const archive = join(archiveRoot, 'driver.tar')
    isolatedGit(sourceRoot, [
      'archive', '--format=tar', `--output=${archive}`, commit, '--', ...V28_DRIVER_OBJECT_PATHS,
    ])
    const extracted = spawnSync('/usr/bin/tar', ['-xf', archive, '-C', destination], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    if (extracted.error) throw extracted.error
    if (extracted.status !== 0) {
      throw new Error((extracted.stderr || extracted.stdout || 'driver archive extraction failed').trim())
    }
    return {
      root: destination,
      commit,
      treeSha256: await immutableTreeSha256(destination),
    }
  } finally {
    await rm(archiveRoot, { recursive: true, force: true })
  }
}

export async function inspectV28ExecutionSnapshot(root, manifest, {
  verifyDriverCommit = true,
  sourceRoot = repositoryRoot,
  inspectors = {},
} = {}) {
  const absolute = await realpath(resolve(root))
  const paths = {
    root: absolute,
    repository: join(absolute, 'driver-repository'),
    driver: join(absolute, 'driver-repository', 'eval', 'long-system', 'v28', 'driver'),
    harness: join(absolute, 'harness-runtime.tgz'),
    candidate: join(absolute, 'candidate-package.tgz'),
    task: join(absolute, 'task'),
  }
  const inspectRuntime = inspectors.runtime ?? inspectHarnessRuntime
  const inspectCandidate = inspectors.candidate ?? inspectCandidatePackage
  const inspectTree = inspectors.tree ?? immutableTreeSha256
  const [runtime, candidate, task, retainedDriverTree] = await Promise.all([
    inspectRuntime(paths.harness),
    inspectCandidate(paths.candidate),
    inspectTaskSnapshotIdentity(paths.task, inspectors.task),
    inspectTree(paths.repository),
  ])
  if (verifyDriverCommit) {
    const expectedRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-expected-driver-'))
    try {
      const expected = await materializeDriverSourceSnapshot({
        destination: join(expectedRoot, 'repository'),
        commit: manifest.driver.commit,
        sourceRoot,
      })
      const expectedTree = inspectors.tree === undefined
        ? expected.treeSha256
        : await inspectTree(expected.root)
      if (expectedTree !== retainedDriverTree) {
        throw new Error('V28 retained driver snapshot differs from the frozen commit')
      }
    } finally {
      await rm(expectedRoot, { recursive: true, force: true })
    }
  }
  const identity = {
    schemaVersion: 1,
    driver: { commit: manifest.driver.commit, treeSha256: retainedDriverTree },
    harness: { sha256: runtime.sha256, metadataSha256: runtime.metadataSha256 },
    candidate: {
      sha256: candidate.sha256,
      manifestSha256: candidate.manifestSha256,
      sourceProvenanceSha256: candidate.sourceProvenanceSha256,
    },
    task: {
      assetSha256: task.assetSha256,
      taskTreeSha256: task.taskTreeSha256,
      taskFileCount: task.taskFileCount,
      digests: task.digests,
    },
  }
  assertSnapshotIdentity(identity, manifest)
  return { paths, identity, identityDigest: sha256(identity) }
}

export async function materializeV28ExecutionSnapshot({
  root,
  manifest,
  env = process.env,
  sourceRoot = repositoryRoot,
  inspectors = {},
}) {
  const absolute = resolve(root)
  await materializeDriverSourceSnapshot({
    destination: join(absolute, 'driver-repository'),
    commit: manifest.driver.commit,
    sourceRoot,
  })
  await Promise.all([
    copyFile(requiredPath(env, manifest.harness.runtimePathEnvironmentVariable), join(absolute, 'harness-runtime.tgz')),
    copyFile(requiredPath(env, manifest.candidate.packagePathEnvironmentVariable), join(absolute, 'candidate-package.tgz')),
    cp(requiredPath(env, manifest.task.rootPathEnvironmentVariable), join(absolute, 'task'), {
      recursive: true,
      force: false,
      errorOnExist: true,
    }),
  ])
  return inspectV28ExecutionSnapshot(absolute, manifest, {
    verifyDriverCommit: false,
    sourceRoot,
    inspectors,
  })
}

export async function assertV28ExecutionSnapshotIdentity(root, manifest, expectedIdentity) {
  const observed = await inspectV28ExecutionSnapshot(root, manifest)
  if (!same(observed.identity, expectedIdentity) || observed.identityDigest !== sha256(expectedIdentity)) {
    throw new Error('V28 execution snapshot identity changed after trial start')
  }
  return observed
}
