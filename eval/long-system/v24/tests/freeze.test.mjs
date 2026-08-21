import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import { buildV24Manifest, inspectDockerImage, writeJsonExclusive } from '../freeze.mjs'
import {
  CANDIDATE_TARBALL_SHA256,
  EVOCODE_ARCHIVE_SHA256,
  EVOCODE_DATASET_COMMIT,
  PROTOCOL_ID,
  validateV24Manifest,
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
      sourceObjects: { 'eval/long-system/v24': object('c') },
      sourceDigest: sha256({ 'eval/long-system/v24': object('c') }),
    },
  }
}

test('builds a self-authenticating manifest with every immutable identity', () => {
  const manifest = buildV24Manifest(identities())
  assert.equal(manifest.protocolId, PROTOCOL_ID)
  assert.equal(manifest.candidateExecutionInitiallyAllowed, false)
  assert.equal(manifest.calibration.nativeRuns, 5)
  assert.equal(manifest.outputPolicy.overwriteAllowed, false)
  assert.equal(validateV24Manifest(manifest), manifest)

  const tampered = structuredClone(manifest)
  tampered.image.configSha256 = digest('e')
  assert.throws(() => validateV24Manifest(tampered), /digest mismatch/)
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

test('writes frozen evidence once and refuses every overwrite', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v24-freeze-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'frozen.json')
  await writeJsonExclusive(path, { value: 1 })
  await assert.rejects(writeJsonExclusive(path, { value: 2 }), error => error?.code === 'EEXIST')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { value: 1 })
})
