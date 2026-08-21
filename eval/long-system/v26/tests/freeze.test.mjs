import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import {
  buildV26Manifest,
  inspectDockerImage,
  inspectSigningPrivateKey,
  writeJsonExclusive,
} from '../freeze.mjs'
import {
  CANDIDATE_TARBALL_SHA256,
  EVOCODE_ARCHIVE_SHA256,
  EVOCODE_DATASET_COMMIT,
  FROZEN_EVIDENCE_PUBLIC_KEY_BASE64,
  FROZEN_EVIDENCE_PUBLIC_KEY_SHA256,
  PROTOCOL_ID,
  validateV26Manifest,
} from '../manifest.mjs'

const digest = character => character.repeat(64)
const object = character => character.repeat(40)

function identities() {
  const taskDigests = { public: digest('5'), hidden: digest('6'), oracle: digest('7') }
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
    },
    task: {
      datasetCommit: EVOCODE_DATASET_COMMIT,
      archiveSha256: EVOCODE_ARCHIVE_SHA256,
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
      tree: object('b'),
      sourceObjects: { 'eval/long-system/v26': object('c') },
      sourceDigest: sha256({ 'eval/long-system/v26': object('c') }),
    },
    signing: {
      publicKeyBase64: FROZEN_EVIDENCE_PUBLIC_KEY_BASE64,
      publicKeySha256: FROZEN_EVIDENCE_PUBLIC_KEY_SHA256,
    },
  }
}

test('builds a self-authenticating manifest with every immutable identity', () => {
  const manifest = buildV26Manifest(identities())
  assert.equal(manifest.protocolId, PROTOCOL_ID)
  assert.equal(manifest.candidateExecutionInitiallyAllowed, false)
  assert.equal(manifest.calibration.nativeRuns, 5)
  assert.equal(manifest.outputPolicy.overwriteAllowed, false)
  assert.equal(validateV26Manifest(manifest), manifest)

  const tampered = structuredClone(manifest)
  tampered.image.configSha256 = digest('e')
  assert.throws(() => validateV26Manifest(tampered), /digest mismatch/)

  const replacementKeys = generateKeyPairSync('ed25519')
  const replacementPublic = replacementKeys.publicKey.export({ format: 'der', type: 'spki' })
  const replacement = structuredClone(manifest)
  replacement.evidenceSigning.publicKeyBase64 = replacementPublic.toString('base64')
  replacement.evidenceSigning.publicKeySha256 = sha256(replacementPublic)
  const { manifestDigest: _oldDigest, ...replacementBody } = replacement
  replacement.manifestDigest = sha256(replacementBody)
  assert.throws(() => validateV26Manifest(replacement), /signer is not frozen/)
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
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v26-signing-key-'))
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
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v26-freeze-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'frozen.json')
  await writeJsonExclusive(path, { value: 1 })
  await assert.rejects(writeJsonExclusive(path, { value: 2 }), error => error?.code === 'EEXIST')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { value: 1 })
})
