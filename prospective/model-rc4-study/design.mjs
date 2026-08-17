import { createPublicKey } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import { validateManifest, validatePreregistration } from '../../eval/v0.4/lib/validation.mjs'
import { validateBaseAssetsLock } from './base-assets.mjs'
import { here, repositoryRoot, validateStudySpec } from './protocol.mjs'
import {
  RUNTIME_ACQUISITION_LOCK_SHA256,
  validateRuntimeAcquisitionLock,
} from './runtime-acquisition.mjs'

export const executionProtocolId = 'plan-lattice-rc4-model-execution-v1'

const runtimeEnvironment = Object.freeze({
  native: 'PLAN_LATTICE_LINUX_RUNTIME_NATIVE',
  'v0.4-contract': 'PLAN_LATTICE_LINUX_RUNTIME_V0_4_CONTRACT',
  'v0.4-lattice': 'PLAN_LATTICE_LINUX_RUNTIME_V0_4_LATTICE',
})

function localJson(name) {
  return JSON.parse(readFileSync(resolve(here, name), 'utf8'))
}

export function buildRuntimeArtifactsRecord() {
  const base = validateBaseAssetsLock(localJson('base-assets.lock.json'))
  const acquisition = validateRuntimeAcquisitionLock(localJson('runtime-acquisition.lock.json'))
  const image = acquisition.baseImage.match(/^(.*)@sha256:([a-f0-9]{64})$/u)
  if (!image) throw new Error('RC.4 runtime acquisition base image is invalid')
  return {
    schemaVersion: 1,
    status: 'frozen',
    builder: 'eval/v0.4/driver/build-linux-runtime.mjs',
    acquisition: {
      githubRunId: acquisition.workflow.runId,
      workflowCommit: acquisition.workflow.headCommit,
      lockSha256: RUNTIME_ACQUISITION_LOCK_SHA256,
    },
    baseImage: { reference: image[1], digest: image[2] },
    hostHarness: structuredClone(base.hostRuntimeIdentity),
    hostPlugins: {
      'v0.3.0': {
        pathEnvironmentVariable: 'PLAN_LATTICE_HOST_PLUGIN_V0_3',
        commit: 'fc55e593c03f99c0ef62ba5948d3e4f719059cdc',
        releaseTag: 'v0.3.0',
        releaseAssetId: 515444632,
        sha256: '22782f506264b93c177c10bb1eb0ec2c8b0939a1c8e8ebb157cc2a4aa7e4c2fc',
      },
      'v0.4.0-candidate': {
        pathEnvironmentVariable: 'PLAN_LATTICE_HOST_PLUGIN_RC4',
        commit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
        releaseTag: 'v0.4.0-rc.4',
        releaseAssetId: 517358151,
        sha256: '2619f2c750973dd868ae6467e2ea03f223041ac4ec043478d2e7760afcbb8c02',
      },
    },
    artifacts: Object.fromEntries(Object.entries(acquisition.artifacts).map(([id, artifact]) => [id, {
      pathEnvironmentVariable: runtimeEnvironment[id],
      sha256: artifact.archive.sha256,
      metadataDigest: artifact.runtimeMetadataDigest,
      pluginPackageDigest: artifact.pluginPackageDigest,
      pluginCommit: id === 'native' ? null : acquisition.candidateCommit,
      arm: structuredClone(artifact.arm),
    }])),
  }
}

function gitJson(commit, path) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'show', `${commit}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`frozen base asset is unavailable: ${path}`)
  return JSON.parse(result.stdout)
}

function exactPublicKey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value ?? '')) throw new Error('execution signing public key is invalid')
  const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('execution signing public key must be Ed25519')
  return value
}

function exactDigest(value, context) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) throw new Error(`${context} is invalid`)
  return value
}

function exactCommit(value, context) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) throw new Error(`${context} is invalid`)
  return value
}

export function loadFrozenDesign(studySpec) {
  validateStudySpec(studySpec)
  const commit = studySpec.evaluationBase.commit
  const preregistration = gitJson(commit, 'eval/v0.4/preregistration.json')
  const manifest = gitJson(commit, 'eval/v0.4/frozen-manifest.json')
  const benchmarkLock = gitJson(commit, 'eval/v0.4/benchmark-lock.json')
  const simpleTasks = gitJson(commit, 'eval/v0.4/simple-tasks.json')
  validatePreregistration(preregistration)
  validateManifest(manifest)
  return { preregistration, manifest, benchmarkLock, simpleTasks }
}

export function buildRc4Preregistration({ studySpec, signingPublicKeySpkiBase64 }) {
  const frozen = loadFrozenDesign(studySpec)
  const value = structuredClone(frozen.preregistration)
  value.protocolId = executionProtocolId
  value.status = 'preregistered-unexecuted'
  value.registeredAt = studySpec.registeredAt
  value.amendedAt = studySpec.registeredAt
  value.amendmentReason = 'RC.4 receives a new execution envelope; only the exact RC.3 task selection, run order, graders, and policies are reused.'
  value.claimPolicy = 'No RC.4 stable release or general uplift claim unless every frozen RC.4 gate passes.'
  value.pluginCommits['v0.4.0Candidate'] = studySpec.candidate.commit
  value.resultSigning.publicKeySpkiBase64 = exactPublicKey(signingPublicKeySpkiBase64)
  value.studyProtocol = {
    protocol: studySpec.protocol,
    publicRef: studySpec.studyProtocolFreeze.publicRef,
    candidateCommit: studySpec.candidate.commit,
    evaluationBaseCommit: studySpec.evaluationBase.commit,
  }
  validatePreregistration(value, { executionReady: true })
  return value
}

export function buildRouterEvidenceRecord(summary) {
  if (summary?.protocol !== 'observable-authorization-v14-rc4-shared-v13-corpus'
    || summary.evidenceStatus !== 'independently-verified-v14-reveal'
    || summary.analysis?.releaseGatePassed !== true
    || summary.candidateCommit !== '7cb3c77f9dab6ef193eb77318fb87389b877b526') {
    throw new Error('RC.4 execution requires a passing immutable V14 result')
  }
  return {
    schemaVersion: 1,
    protocol: summary.protocol,
    evidenceStatus: summary.evidenceStatus,
    candidateCommit: summary.candidateCommit,
    releaseGatePassed: true,
    metrics: summary.analysis.metrics,
    v13OutcomeSha256: exactDigest(summary.pairedV13Outcome?.outcomeSha256, 'V13 outcome digest'),
    v14AttemptSha256: exactDigest(summary.revealAttemptSha256, 'V14 attempt digest'),
    v14ResultSha256: exactDigest(summary.revealResultSha256, 'V14 result digest'),
    recomputedRowsSha256: exactDigest(summary.recomputedRowsSha256, 'V14 recomputed rows digest'),
  }
}

export function buildRc4RunManifest({ studySpec, preregistration, runtimeArtifacts, routerEvidence, driverSourceDigest }) {
  validateStudySpec(studySpec)
  validatePreregistration(preregistration, { executionReady: true })
  if (preregistration.pluginCommits['v0.4.0Candidate'] !== studySpec.candidate.commit) {
    throw new Error('RC.4 preregistration uses another candidate')
  }
  const expectedRuntimeArtifacts = buildRuntimeArtifactsRecord()
  if (sha256(runtimeArtifacts) !== sha256(expectedRuntimeArtifacts)) throw new Error('RC.4 runtime artifacts are not the locked first-run artifacts')
  exactDigest(driverSourceDigest, 'RC.4 driver source digest')
  const frozen = loadFrozenDesign(studySpec)
  const core = {
    schemaVersion: 1,
    protocolId: executionProtocolId,
    status: 'frozen-unexecuted',
    model: preregistration.model,
    runtimePolicy: preregistration.runtimePolicy,
    pluginCommits: preregistration.pluginCommits,
    sourceLockDigest: sha256(frozen.benchmarkLock),
    runtimeArtifacts,
    runtimeArtifactsDigest: sha256(runtimeArtifacts),
    routerBlindResultDigest: sha256(routerEvidence),
    driverSourceDigest,
    sourceCommits: frozen.manifest.sourceCommits,
    preregistrationDigest: sha256(preregistration),
    randomization: preregistration.randomization,
    infrastructureRuns: frozen.manifest.infrastructureRuns,
    statisticalRuns: frozen.manifest.statisticalRuns,
    counts: frozen.manifest.counts,
  }
  const manifest = { ...core, manifestDigest: sha256(core) }
  validateManifest(manifest)
  return manifest
}

export function buildExecutionEnvelope({
  studySpec,
  studyProtocolCommit,
  preregistration,
  runtimeArtifacts,
  routerEvidence,
  driverSourceDigest,
  controllerSourceDigest,
  signingLedgerId,
}) {
  validateStudySpec(studySpec)
  exactCommit(studyProtocolCommit, 'study protocol commit')
  exactDigest(controllerSourceDigest, 'controller source digest')
  if (driverSourceDigest !== controllerSourceDigest) throw new Error('controller and driver must use the same frozen study source')
  if (!/^[a-z0-9][a-z0-9._-]{15,127}$/u.test(signingLedgerId ?? '')) throw new Error('new execution signing ledger identity is invalid')
  const runManifest = buildRc4RunManifest({
    studySpec,
    preregistration,
    runtimeArtifacts,
    routerEvidence,
    driverSourceDigest,
  })
  const core = {
    schemaVersion: 1,
    protocol: executionProtocolId,
    evidenceStatus: 'frozen-before-first-model-call',
    studyProtocolCommit,
    candidateCommit: studySpec.candidate.commit,
    preregistration,
    runtimeArtifacts,
    routerEvidence,
    runManifest,
    controllerSourceDigest,
    driverSourceDigest,
    signingLedgerId,
  }
  return { ...core, envelopeDigest: sha256(core) }
}

export function verifyExecutionEnvelope(envelope, studySpec) {
  if (envelope?.schemaVersion !== 1
    || envelope.protocol !== executionProtocolId
    || envelope.evidenceStatus !== 'frozen-before-first-model-call') {
    throw new Error('invalid RC.4 execution envelope identity')
  }
  const expected = buildExecutionEnvelope({
    studySpec,
    studyProtocolCommit: envelope.studyProtocolCommit,
    preregistration: envelope.preregistration,
    runtimeArtifacts: envelope.runtimeArtifacts,
    routerEvidence: envelope.routerEvidence,
    driverSourceDigest: envelope.driverSourceDigest,
    controllerSourceDigest: envelope.controllerSourceDigest,
    signingLedgerId: envelope.signingLedgerId,
  })
  if (sha256(envelope) !== sha256(expected)) throw new Error('RC.4 execution envelope changed')
  return envelope
}
