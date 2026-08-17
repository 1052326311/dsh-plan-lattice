import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildExecutionEnvelope,
  buildRc4Preregistration,
  buildRc4RunManifest,
  buildRouterEvidenceRecord,
  buildRuntimeArtifactsRecord,
  loadFrozenDesign,
  verifyExecutionEnvelope,
} from '../prospective/model-rc4-study/design.mjs'
import { loadStudySpec } from '../prospective/model-rc4-study/protocol.mjs'

const digest = (character: string) => character.repeat(64)

function signingPublicKey() {
  const { publicKey } = generateKeyPairSync('ed25519')
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
}

function routerEvidence() {
  return buildRouterEvidenceRecord({
    protocol: 'observable-authorization-v14-rc4-shared-v13-corpus',
    evidenceStatus: 'independently-verified-v14-reveal',
    candidateCommit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
    analysis: { releaseGatePassed: true, metrics: { exactAccuracy: 0.95 } },
    pairedV13Outcome: { outcomeSha256: digest('1') },
    revealAttemptSha256: digest('2'),
    revealResultSha256: digest('3'),
    recomputedRowsSha256: digest('4'),
  })
}

function runtimeArtifacts() {
  return buildRuntimeArtifactsRecord()
}

describe('RC.4 execution design', () => {
  it('reuses all 96 frozen slots while replacing the candidate and evidence', async () => {
    const { spec } = await loadStudySpec()
    const frozen = loadFrozenDesign(spec)
    expect(frozen.manifest.infrastructureRuns).toHaveLength(6)
    expect(frozen.manifest.statisticalRuns).toHaveLength(90)
    const preregistration = buildRc4Preregistration({ studySpec: spec, signingPublicKeySpkiBase64: signingPublicKey() })
    const manifest = buildRc4RunManifest({
      studySpec: spec,
      preregistration,
      runtimeArtifacts: runtimeArtifacts(),
      routerEvidence: routerEvidence(),
      driverSourceDigest: digest('7'),
    })
    expect(manifest.pluginCommits['v0.4.0Candidate']).toBe(spec.candidate.commit)
    expect(manifest.infrastructureRuns).toEqual(frozen.manifest.infrastructureRuns)
    expect(manifest.statisticalRuns).toEqual(frozen.manifest.statisticalRuns)
    expect(manifest.manifestDigest).not.toBe(frozen.manifest.manifestDigest)
    const swapped = structuredClone(runtimeArtifacts())
    swapped.artifacts.native = structuredClone(swapped.artifacts['v0.4-lattice'])
    expect(() => buildRc4RunManifest({
      studySpec: spec,
      preregistration,
      runtimeArtifacts: swapped,
      routerEvidence: routerEvidence(),
      driverSourceDigest: digest('7'),
    })).toThrow('locked first-run artifacts')
  })

  it('round-trips a new execution envelope and rejects RC.3 evidence', async () => {
    const { spec } = await loadStudySpec()
    const preregistration = buildRc4Preregistration({ studySpec: spec, signingPublicKeySpkiBase64: signingPublicKey() })
    const envelope = buildExecutionEnvelope({
      studySpec: spec,
      studyProtocolCommit: '1'.repeat(40),
      preregistration,
      runtimeArtifacts: runtimeArtifacts(),
      routerEvidence: routerEvidence(),
      driverSourceDigest: digest('7'),
      controllerSourceDigest: digest('7'),
      signingLedgerId: 'plan-lattice-rc4-ledger-v1',
    })
    expect(verifyExecutionEnvelope(envelope, spec)).toEqual(envelope)
    const tampered = structuredClone(envelope)
    tampered.candidateCommit = 'dc55716525987fcb7cb46579a9c957877cbd23c2'
    expect(() => verifyExecutionEnvelope(tampered, spec)).toThrow()
    expect(() => buildRouterEvidenceRecord({
      ...routerEvidence(),
      candidateCommit: 'dc55716525987fcb7cb46579a9c957877cbd23c2',
    })).toThrow()
  })
})
