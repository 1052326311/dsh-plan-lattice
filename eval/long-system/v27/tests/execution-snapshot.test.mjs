import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import {
  inspectV27ExecutionSnapshot,
  materializeDriverSourceSnapshot,
  materializeV27ExecutionSnapshot,
} from '../execution-snapshot.mjs'
import { immutableTreeSha256 } from '../driver/runtime.mjs'
import { V27_DRIVER_OBJECT_PATHS } from '../manifest.mjs'

function git(root, args) {
  const result = spawnSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'V27 Fixture',
      GIT_AUTHOR_EMAIL: 'v27@example.invalid',
      GIT_COMMITTER_NAME: 'V27 Fixture',
      GIT_COMMITTER_EMAIL: 'v27@example.invalid',
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

async function makeRepository(root) {
  git(root, ['init', '--quiet'])
  for (const path of V27_DRIVER_OBJECT_PATHS) {
    const file = path.endsWith('.mjs') ? path : join(path, 'fixture.txt')
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), `frozen:${file}\n`)
  }
  const executable = join(root, 'eval/long-system/v27/driver/executable.sh')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await chmod(executable, 0o755)
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'frozen driver'])
  return git(root, ['rev-parse', 'HEAD'])
}

async function fakeIdentity(path) {
  return sha256(await readFile(path))
}

async function inspectTaskLikeEvoCode(path) {
  const bytes = await readFile(join(path, 'task.toml'))
  const publicFiles = [{ path: 'task.toml', bytes: bytes.length, sha256: sha256(bytes) }]
  const emptyFiles = []
  return {
    schemaVersion: 1,
    root: path,
    roundCount: 9,
    steps: Array.from({ length: 9 }, (_, index) => `round-${index + 1}`),
    digests: {
      public: { sha256: sha256(JSON.stringify(publicFiles)), files: publicFiles },
      hidden: { sha256: sha256(JSON.stringify(emptyFiles)), files: emptyFiles },
      oracle: { sha256: sha256(JSON.stringify(emptyFiles)), files: emptyFiles },
    },
  }
}

test('materializes one frozen driver identity across umasks while binding bytes and executable bits', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-driver-umask-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repository')
  await mkdir(repository)
  const commit = await makeRepository(repository)
  const originalUmask = process.umask()
  let under022
  let under077
  try {
    process.umask(0o022)
    under022 = await materializeDriverSourceSnapshot({
      destination: join(root, 'snapshot-022'),
      commit,
      sourceRoot: repository,
    })
    process.umask(0o077)
    under077 = await materializeDriverSourceSnapshot({
      destination: join(root, 'snapshot-077'),
      commit,
      sourceRoot: repository,
    })
  } finally {
    process.umask(originalUmask)
  }

  assert.equal(under022.treeSha256, under077.treeSha256)
  const directory022 = join(under022.root, 'eval/long-system/v27/driver')
  const directory077 = join(under077.root, 'eval/long-system/v27/driver')
  const regular022 = join(under022.root, 'eval/long-system/v27/fixture.txt')
  const regular077 = join(under077.root, 'eval/long-system/v27/fixture.txt')
  await Promise.all([
    chmod(directory022, 0o755),
    chmod(directory077, 0o700),
    chmod(regular022, 0o644),
    chmod(regular077, 0o600),
  ])
  assert.equal(await immutableTreeSha256(under022.root), under022.treeSha256)
  assert.equal(await immutableTreeSha256(under077.root), under077.treeSha256)
  const executable = join(under077.root, 'eval/long-system/v27/driver/executable.sh')
  await chmod(executable, 0o600)
  assert.notEqual(await immutableTreeSha256(under077.root), under077.treeSha256)
  await chmod(executable, 0o700)
  assert.equal(await immutableTreeSha256(under077.root), under077.treeSha256)
  await writeFile(executable, '#!/bin/sh\nexit 1\n')
  assert.notEqual(await immutableTreeSha256(under077.root), under077.treeSha256)
})

test('executes from copied assets and a commit-owned driver after sources change', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-execution-snapshot-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repository')
  const source = join(root, 'source')
  const snapshotRoot = join(root, 'snapshot')
  await Promise.all([mkdir(repository), mkdir(source), mkdir(snapshotRoot)])
  const driverCommit = await makeRepository(repository)
  const runtime = join(source, 'runtime.tgz')
  const candidate = join(source, 'candidate.tgz')
  const task = join(source, 'task')
  await mkdir(task)
  await Promise.all([
    writeFile(runtime, 'runtime-v1'),
    writeFile(candidate, 'candidate-v1'),
    writeFile(join(task, 'task.toml'), 'task-v1'),
    writeFile(join(task, 'unpartitioned.txt'), 'tree-v1'),
  ])
  await Promise.all([
    chmod(join(task, 'task.toml'), 0o600),
    chmod(join(task, 'unpartitioned.txt'), 0o600),
  ])

  const runtimeDigest = await fakeIdentity(runtime)
  const candidateDigest = await fakeIdentity(candidate)
  const taskInspection = await inspectTaskLikeEvoCode(task)
  const taskDigests = Object.fromEntries(
    Object.entries(taskInspection.digests).map(([name, value]) => [name, value.sha256]),
  )
  const taskRecords = await Promise.all(['task.toml', 'unpartitioned.txt'].map(async path => {
    const bytes = await readFile(join(task, path))
    return { path, mode: 0o600, bytes: bytes.length, sha256: sha256(bytes) }
  }))
  const inspectors = {
    async runtime(path) {
      return { sha256: await fakeIdentity(path), metadataSha256: sha256('runtime-metadata') }
    },
    async candidate(path) {
      return {
        sha256: await fakeIdentity(path),
        manifestSha256: sha256('candidate-manifest'),
        sourceProvenanceSha256: sha256('candidate-source-provenance'),
      }
    },
    task: inspectTaskLikeEvoCode,
  }
  const manifest = {
    driver: { commit: driverCommit },
    harness: {
      runtimePathEnvironmentVariable: 'V27_RUNTIME',
      runtimeSha256: runtimeDigest,
      runtimeMetadataSha256: sha256('runtime-metadata'),
    },
    candidate: {
      packagePathEnvironmentVariable: 'V27_CANDIDATE',
      tarballSha256: candidateDigest,
      packageManifestSha256: sha256('candidate-manifest'),
      sourceProvenanceSha256: sha256('candidate-source-provenance'),
    },
    task: {
      rootPathEnvironmentVariable: 'V27_TASK',
      assetSha256: sha256(taskDigests),
      taskTreeSha256: sha256(taskRecords),
      taskFileCount: taskRecords.length,
      digests: taskDigests,
    },
  }
  const frozen = await materializeV27ExecutionSnapshot({
    root: snapshotRoot,
    manifest,
    env: { V27_RUNTIME: runtime, V27_CANDIDATE: candidate, V27_TASK: task },
    sourceRoot: repository,
    inspectors,
  })

  await Promise.all([
    writeFile(runtime, 'runtime-v2'),
    writeFile(candidate, 'candidate-v2'),
    writeFile(join(task, 'unpartitioned.txt'), 'tree-v2'),
    writeFile(join(repository, 'eval/long-system/v27/fixture.txt'), 'dirty driver bytes'),
  ])
  const retained = await inspectV27ExecutionSnapshot(snapshotRoot, manifest, {
    sourceRoot: repository,
    inspectors,
  })
  assert.deepEqual(retained.identity, frozen.identity)

  await writeFile(join(snapshotRoot, 'task', 'unpartitioned.txt'), 'tampered snapshot')
  await assert.rejects(
    inspectV27ExecutionSnapshot(snapshotRoot, manifest, { sourceRoot: repository, inspectors }),
    /differs from the frozen manifest/,
  )
})
