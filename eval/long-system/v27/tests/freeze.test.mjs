import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import {
  buildV27Manifest,
  assertTaskTreeMatchesArchive,
  inspectDockerImage,
  inspectV27OutputRoot,
  inspectSigningPrivateKey,
  inspectTaskSnapshotIdentity,
  writeJsonExclusive,
} from '../freeze.mjs'
import {
  CANDIDATE_TARBALL_SHA256,
  CANDIDATE_SOURCE_PROVENANCE,
  EVOCODE_ARCHIVE_SHA256,
  EVOCODE_DATASET_COMMIT,
  FROZEN_EVIDENCE_PUBLIC_KEY_BASE64,
  FROZEN_EVIDENCE_PUBLIC_KEY_SHA256,
  PROTOCOL_ID,
  V27_DRIVER_OBJECT_PATHS,
  V27_ZSTD_RELEASE_URL,
  V27_ZSTD_SHA256,
  V27_ZSTD_SOURCE_ARCHIVE_SHA256,
  V27_ZSTD_VERSION,
  validateV27Manifest,
} from '../manifest.mjs'

const digest = character => character.repeat(64)
const object = character => character.repeat(40)

function identities() {
  const taskDigests = { public: digest('5'), hidden: digest('6'), oracle: digest('7') }
  const driverTree = object('b')
  const sourceObjects = Object.fromEntries(V27_DRIVER_OBJECT_PATHS.map((path, index) => [
    path,
    path === 'eval/long-system/v27' ? driverTree : object(String(index + 1)),
  ]))
  return {
    runtime: {
      sha256: digest('1'),
      metadataSha256: digest('2'),
      platform: 'darwin',
      architecture: 'arm64',
      node: 'v22.23.0',
    },
    candidate: {
      sha256: CANDIDATE_TARBALL_SHA256,
      manifestSha256: digest('3'),
      sourceProvenance: CANDIDATE_SOURCE_PROVENANCE,
      sourceProvenanceSha256: sha256(CANDIDATE_SOURCE_PROVENANCE),
    },
    task: {
      datasetCommit: EVOCODE_DATASET_COMMIT,
      datasetTree: object('d'),
      archivePointerBlob: object('e'),
      archiveSha256: EVOCODE_ARCHIVE_SHA256,
      archiveBytes: 1024,
      decompressorSha256: V27_ZSTD_SHA256,
      decompressorVersion: V27_ZSTD_VERSION,
      taskTreeSha256: digest('a'),
      taskFileCount: 42,
      roundCount: 9,
      digests: taskDigests,
      assetSha256: sha256(taskDigests),
    },
    image: {
      reference: `local/jobforge@sha256:${digest('8')}`,
      manifestSha256: digest('8'),
      configSha256: digest('9'),
    },
    driver: {
      commit: object('a'),
      tree: driverTree,
      sourceObjects,
      sourceDigest: sha256(sourceObjects),
    },
    signing: {
      publicKeyBase64: FROZEN_EVIDENCE_PUBLIC_KEY_BASE64,
      publicKeySha256: FROZEN_EVIDENCE_PUBLIC_KEY_SHA256,
    },
    trial: {
      runId: 'v27-frozen-fixture',
      outputRoot: '/private/tmp/plan-lattice-v27-frozen-fixture',
    },
  }
}

test('builds a self-authenticating manifest with every immutable identity', () => {
  const manifest = buildV27Manifest(identities())
  assert.equal(manifest.protocolId, PROTOCOL_ID)
  assert.equal(manifest.schemaVersion, 3)
  assert.equal(manifest.candidateExecutionInitiallyAllowed, true)
  assert.equal(manifest.comparison.pairs, 12)
  assert.equal(manifest.comparison.attemptsPerArm, 12)
  assert.equal(manifest.comparison.order.length, 24)
  assert.equal(manifest.outputPolicy.overwriteAllowed, false)
  assert.equal(manifest.outputPolicy.absoluteRoot, manifest.trial.outputRoot)
  assert.equal(manifest.task.decompressorSourceArchiveSha256, V27_ZSTD_SOURCE_ARCHIVE_SHA256)
  assert.equal(manifest.task.decompressorReleaseUrl, V27_ZSTD_RELEASE_URL)
  assert.equal(validateV27Manifest(manifest), manifest)

  const tampered = structuredClone(manifest)
  tampered.image.configSha256 = digest('e')
  assert.throws(() => validateV27Manifest(tampered), /digest mismatch/)

  const replacementKeys = generateKeyPairSync('ed25519')
  const replacementPublic = replacementKeys.publicKey.export({ format: 'der', type: 'spki' })
  const replacement = structuredClone(manifest)
  replacement.evidenceSigning.publicKeyBase64 = replacementPublic.toString('base64')
  replacement.evidenceSigning.publicKeySha256 = sha256(replacementPublic)
  const { manifestDigest: _oldDigest, ...replacementBody } = replacement
  replacement.manifestDigest = sha256(replacementBody)
  assert.throws(() => validateV27Manifest(replacement), /signer is not frozen/)

  for (const mutate of [
    value => { value.budgetPerAttempt.maxInputTokens += 1 },
    value => { value.model.timeoutMsPerEpoch += 1 },
    value => { value.model.upstreamBaseUrl = 'https://attacker.example' },
    value => { value.executionSandbox.modelBashPermissionMode = 'danger-full-access' },
    value => { value.paidRuns.native -= 1 },
    value => { value.comparison.pairs -= 1 },
    value => { value.trial.outputRoot = '/private/tmp/other-v27-root' },
  ]) {
    const changed = structuredClone(manifest)
    mutate(changed)
    const { manifestDigest: _digest, ...changedBody } = changed
    changed.manifestDigest = sha256(changedBody)
    assert.throws(() => validateV27Manifest(changed))
  }
})

test('requires an exact Docker manifest reference and matching local identity', () => {
  const manifestDigest = digest('1')
  const configDigest = digest('2')
  const reference = `registry.example/jobforge@sha256:${manifestDigest}`
  const image = inspectDockerImage(reference, () => JSON.stringify([{
    Id: `sha256:${configDigest}`,
    RepoDigests: [reference],
  }]))
  assert.deepEqual(image, { reference, manifestSha256: manifestDigest, configSha256: configDigest })
  assert.throws(() => inspectDockerImage('registry.example/jobforge:latest', () => '[]'), /exact/)
})

test('derives the frozen public anchor only from a private Ed25519 key with owner-only permissions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-signing-key-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const path = join(root, 'signing-key.pem')
  await writeFile(path, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const inspected = await inspectSigningPrivateKey(path)
  const expected = keys.publicKey.export({ format: 'der', type: 'spki' })
  assert.equal(inspected.publicKeyBase64, expected.toString('base64'))
  assert.equal(inspected.publicKeySha256, sha256(expected))

  await chmod(path, 0o644)
  await assert.rejects(inspectSigningPrivateKey(path), /group or others/)
})

test('writes frozen evidence once and refuses every overwrite', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-freeze-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'frozen.json')
  await writeJsonExclusive(path, { value: 1 })
  await assert.rejects(writeJsonExclusive(path, { value: 2 }), error => error?.code === 'EEXIST')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { value: 1 })
})

test('accepts only an absolute output root outside the source repository', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-output-root-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const external = join(root, 'external')
  await Promise.all([mkdir(source), mkdir(external)])
  const canonicalExternal = await realpath(external)
  await assert.rejects(inspectV27OutputRoot('relative-output', source), /absolute path/)
  await assert.rejects(inspectV27OutputRoot(source, source), /must not exist/)
  await assert.rejects(inspectV27OutputRoot(join(source, 'nested'), source), /outside the source repository/)
  assert.equal(await inspectV27OutputRoot(join(external, 'output'), source), join(canonicalExternal, 'output'))

  const outsideToSource = join(external, 'source-link')
  await symlink(source, outsideToSource)
  await assert.rejects(
    inspectV27OutputRoot(join(outsideToSource, 'output'), source),
    /outside the source repository/,
  )

  const sourceToOutside = join(source, 'external-link')
  await symlink(external, sourceToOutside)
  assert.equal(await inspectV27OutputRoot(join(sourceToOutside, 'output'), source), join(canonicalExternal, 'output'))

  const existingTarget = join(external, 'existing-output-link')
  await symlink(source, existingTarget)
  await assert.rejects(inspectV27OutputRoot(existingTarget, source), /must not exist/)
})

test('derives snapshot identity from the real task inspection shape and complete file tree', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-task-snapshot-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'environment'))
  await Promise.all([
    writeFile(join(root, 'environment', 'setup.sh'), '#!/bin/sh\n', { mode: 0o700 }),
    writeFile(join(root, 'task.toml'), 'task\n', { mode: 0o600 }),
  ])
  await Promise.all([
    chmod(join(root, 'environment', 'setup.sh'), 0o700),
    chmod(join(root, 'task.toml'), 0o600),
  ])
  const partitionDigests = {
    public: digest('1'),
    hidden: digest('2'),
    oracle: digest('3'),
  }
  const inspection = {
    schemaVersion: 1,
    root,
    roundCount: 9,
    steps: Array.from({ length: 9 }, (_, index) => `round-${index + 1}`),
    digests: Object.fromEntries(Object.entries(partitionDigests).map(([name, sha256]) => [
      name,
      { sha256, files: [] },
    ])),
  }
  const records = await Promise.all([
    ['environment/setup.sh', 0o700],
    ['task.toml', 0o600],
  ].map(async ([path, mode]) => {
    const bytes = await readFile(join(root, path))
    return { path, mode, bytes: bytes.length, sha256: sha256(bytes) }
  }))

  assert.deepEqual(await inspectTaskSnapshotIdentity(root, async () => inspection), {
    taskTreeSha256: sha256(records),
    taskFileCount: records.length,
    roundCount: 9,
    digests: partitionDigests,
    assetSha256: sha256(partitionDigests),
  })
})

test('rejects a modified task checkout even when the authenticated archive tree is intact', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-task-tree-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout')
  const archive = join(root, 'archive')
  await Promise.all([mkdir(checkout), mkdir(archive)])
  await Promise.all([
    writeFile(join(checkout, 'task.toml'), 'original\n', { mode: 0o600 }),
    writeFile(join(archive, 'task.toml'), 'original\n', { mode: 0o600 }),
  ])
  assert.equal((await assertTaskTreeMatchesArchive(checkout, archive)).files, 1)
  await writeFile(join(checkout, 'task.toml'), 'modified\n', { mode: 0o600 })
  await assert.rejects(
    assertTaskTreeMatchesArchive(checkout, archive),
    /differs from the authenticated dataset archive/,
  )
})
