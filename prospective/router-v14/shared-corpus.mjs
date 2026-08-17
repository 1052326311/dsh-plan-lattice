import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requiredFreezeArtifacts, verifyFreezeManifest as verifyV13FreezeManifest } from '../../eval/router-corpus/v13/freeze-reveal.mjs'
import { assertProtocolFreeze as assertV13ProtocolFreeze, loadSpec as loadV13Spec } from '../../eval/router-corpus/v13/protocol.mjs'
import { sha256 } from './protocol.mjs'

const v13Files = Object.freeze({
  spec: 'source-frame-spec.json',
  archiveManifest: 'archive-manifest.json',
  sourceManifest: 'source-frame.manifest.json',
  sourceFrame: 'source-frame.jsonl',
  sourceRejections: 'source-frame.rejections.json',
  annotationRubric: 'ANNOTATION_RUBRIC.md',
  annotationSchema: '../v10/annotation-schema.mjs',
  annotationCandidates: 'annotation-candidates.jsonl',
  annotationPacketManifest: 'annotation-packet-manifest.json',
  annotationPacketA: 'annotation-packet-a.jsonl',
  annotationPacketB: 'annotation-packet-b.jsonl',
  annotationPacketC: 'annotation-packet-c.jsonl',
  annotationMappings: 'annotation-mappings.json',
  annotationsA: 'annotations-a.jsonl',
  annotationsB: 'annotations-b.jsonl',
  annotationsC: 'annotations-c.jsonl',
  agreementReport: 'agreement-report.json',
  adjudicationPacket: 'adjudication-packet.jsonl',
  adjudicationDecisions: 'adjudication-decisions.jsonl',
  adjudicated: 'adjudicated.jsonl',
  capacityManifest: 'capacity-manifest.json',
  capacityWitness: 'capacity-witness.json',
  drandResponseRaw: 'drand-response.raw.json',
  drandChainInfoRaw: 'drand-chain-info.raw.json',
  drandExternalVerification: 'drand-external-verification.json',
  drandVerifierPublicKey: 'drand-verifier-public-key.pem',
  beaconResponse: 'beacon-response.json',
  selectionManifest: 'selection-manifest.json',
  selectionWitness: 'selection-witness.json',
  prompts: 'prompts.jsonl',
  labels: 'labels.jsonl',
  sources: 'sources.jsonl',
  runtimeManifest: 'runtime-artifact/manifest.json',
  statisticsSource: 'statistics.mjs',
})

function pathFor(root, name, sourceRoot) {
  const value = v13Files[name]
  if (value === undefined) throw new Error(`V14 does not know V13 artifact ${name}`)
  if (name === 'spec' || name === 'annotationRubric' || name === 'annotationSchema' || name === 'statisticsSource') {
    return resolve(sourceRoot, value)
  }
  return resolve(root, value)
}

async function revealState(root, freezeManifestSha256) {
  const paths = {
    attempt: resolve(root, 'reveal-attempt.json'),
    result: resolve(root, 'reveal-result.json'),
    failure: resolve(root, 'reveal-failure.json'),
  }
  const present = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [
    name,
    await access(path).then(() => true, () => false),
  ])))
  if (!present.attempt && !present.result && !present.failure) return { status: 'unrevealed', present }
  if (!present.attempt || Number(present.result) + Number(present.failure) !== 1) {
    throw new Error('V14 requires one complete, immutable V13 reveal outcome')
  }
  const attemptBytes = await readFile(paths.attempt)
  const outcomeName = present.result ? 'result' : 'failure'
  const outcomeBytes = await readFile(paths[outcomeName])
  const attempt = JSON.parse(attemptBytes)
  const outcome = JSON.parse(outcomeBytes)
  if (attempt.protocol !== 'observable-authorization-v13'
    || attempt.freezeManifestSha256 !== freezeManifestSha256
    || outcome.protocol !== 'observable-authorization-v13'
    || outcome.freezeManifestSha256 !== freezeManifestSha256) {
    throw new Error('V14 paired V13 reveal does not bind the shared freeze manifest')
  }
  return {
    status: outcomeName,
    attemptSha256: sha256(attemptBytes),
    outcomeSha256: sha256(outcomeBytes),
    evidenceStatus: outcome.evidenceStatus,
    ...(outcomeName === 'result' ? { releaseGatePassed: outcome.analysis?.releaseGatePassed === true } : {}),
  }
}

export async function loadSharedCorpus({ root, sourceRoot, spec, requireUnrevealed = false, requireRevealed = false }) {
  if (!root) throw new Error('PLAN_LATTICE_V13_DATA_DIR is required')
  const v13 = await loadV13Spec(resolve(sourceRoot, 'source-frame-spec.json'))
  if (sha256(v13.bytes) !== spec.sharedCorpus.specSha256) throw new Error('V14 shared V13 spec digest changed')
  const v13Freeze = assertV13ProtocolFreeze(v13.spec)
  if (v13Freeze.commit !== spec.sharedCorpus.protocolFreezeCommit) throw new Error('V14 shared V13 protocol commit changed')
  const artifacts = Object.fromEntries(await Promise.all(requiredFreezeArtifacts.map(async name => [
    name,
    await readFile(pathFor(root, name, sourceRoot)),
  ])))
  const manifestText = await readFile(resolve(root, 'freeze-manifest.json'), 'utf8')
  const digestLine = await readFile(resolve(root, 'freeze-manifest.sha256'), 'utf8')
  const expectedDigest = digestLine.trim().split(/\s+/u)[0]
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest) || sha256(manifestText) !== expectedDigest) {
    throw new Error('V14 shared V13 freeze manifest digest is invalid')
  }
  const manifest = JSON.parse(manifestText)
  verifyV13FreezeManifest(manifest, artifacts, v13.spec, v13Freeze.commit)
  if (requireUnrevealed && requireRevealed) throw new Error('V14 cannot require V13 to be both revealed and unrevealed')
  const v13Outcome = await revealState(root, expectedDigest)
  if (requireUnrevealed && v13Outcome.status !== 'unrevealed') {
    throw new Error('V14 candidate must freeze before the V13 reveal is consumed')
  }
  if (requireRevealed && v13Outcome.status === 'unrevealed') {
    throw new Error('V14 candidate reveal waits for the immutable V13 reveal outcome')
  }
  return {
    artifacts,
    manifest,
    v13Outcome,
    binding: {
      protocol: v13.spec.protocol,
      protocolFreezeCommit: v13Freeze.commit,
      specSha256: spec.sharedCorpus.specSha256,
      freezeManifestSha256: expectedDigest,
      rowCount: manifest.rowCount,
      archiveMerkleRoot: manifest.bindings.archiveMerkleRoot,
    },
  }
}
