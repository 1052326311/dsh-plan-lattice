import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildExecutionEnvelope,
  buildRc4Preregistration,
  buildRouterEvidenceRecord,
  buildRuntimeArtifactsRecord,
} from '../prospective/model-rc4-study/design.mjs'
import {
  prepareExecutionEnvelope,
  verifyFrozenExecutionAttestations,
} from '../prospective/model-rc4-study/prepare-execution.mjs'
import { loadStudySpec } from '../prospective/model-rc4-study/protocol.mjs'

const roots: string[] = []
const digest = (character: string) => character.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function publicKey() {
  const { publicKey } = generateKeyPairSync('ed25519')
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
}

function v14Summary(releaseGatePassed = true) {
  return {
    protocol: 'observable-authorization-v14-rc4-shared-v13-corpus',
    evidenceStatus: 'independently-verified-v14-reveal',
    candidateCommit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
    analysis: { releaseGatePassed, metrics: { exactAccuracy: 0.95 } },
    pairedV13Outcome: { outcomeSha256: digest('1') },
    revealAttemptSha256: digest('2'),
    revealResultSha256: digest('3'),
    recomputedRowsSha256: digest('4'),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-prepare-execution-'))
  roots.push(root)
  const ledger = join(root, 'ledger.jsonl')
  await writeFile(ledger, '')
  const { spec } = await loadStudySpec()
  const studyCommit = '8'.repeat(40)
  const options = {
    runtimeRoot: join(root, 'runtime'),
    v14DataRoot: join(root, 'v14'),
    v13DataRoot: join(root, 'v13'),
    v13SourceRoot: join(root, 'v13-source'),
    v14RuntimeRoot: join(root, 'v14-runtime'),
    signingPublicKeySpkiBase64: publicKey(),
    signingLedgerPath: ledger,
    signingLedgerId: 'plan-lattice-rc4-test-ledger',
    studyAnchorPath: join(root, 'study-anchor.json'),
    studyBundlePath: join(root, 'study-bundle.jsonl'),
    executionAnchorPath: join(root, 'execution-anchor.json'),
    executionBundlePath: join(root, 'execution-bundle.jsonl'),
    write: false,
  }
  const dependencies = {
    loadStudySpec: async () => ({ spec }),
    assertCandidateFreeze: () => ({ commit: spec.candidate.commit }),
    assertEvaluationBase: () => ({ commit: spec.evaluationBase.commit }),
    assertRouterProtocolFreeze: () => ({ commit: spec.routerGate.protocolFreezeCommit }),
    assertRuntimeWorkflowFreeze: () => ({ commit: spec.runtimeBuild.workflowCommit }),
    assertStudyProtocolFreeze: () => ({ commit: studyCommit }),
    assertExecutionRefMissing: () => undefined,
    loadAndVerifyBaseAssetsLock: async () => ({ lock: {} }),
    verifyRuntimeAcquisition: async () => ({ candidateCommit: spec.candidate.commit }),
    verifyV14EvidenceBundle: async () => v14Summary(),
    buildRuntimeArtifactsRecord,
    buildRouterEvidenceRecord,
    buildRc4Preregistration,
    buildExecutionEnvelope,
    studySourceDigest: () => ({ commit: studyCommit, files: [], digest: digest('7') }),
    verifyPublicFreezeAttestation: async ({ kind }: { kind: string }) => ({
      kind,
      sourceCommit: kind === 'study' ? studyCommit : '9'.repeat(40),
      anchorSha256: digest(kind === 'study' ? 'a' : 'b'),
      attestations: 1,
      verifiedTimestamps: 1,
    }),
  }
  return { dependencies, options, spec }
}

describe('RC.4 execution-envelope preparation', () => {
  it('constructs all 6+90 slots only after every external gate succeeds', async () => {
    const current = await fixture()
    const result = await prepareExecutionEnvelope(current.options, current.dependencies)
    expect(result.outputPath).toBeNull()
    expect(result.envelope.studyProtocolCommit).toBe('8'.repeat(40))
    expect(result.envelope.candidateCommit).toBe(current.spec.candidate.commit)
    expect(result.envelope.runManifest.infrastructureRuns).toHaveLength(6)
    expect(result.envelope.runManifest.statisticalRuns).toHaveLength(90)
    expect(result.envelope.routerEvidence.releaseGatePassed).toBe(true)
    expect(result.envelopeSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.studyAttestation.sourceCommit).toBe('8'.repeat(40))
  })

  it('does not produce an envelope from a failing V14 result or unverified runtime', async () => {
    const v14 = await fixture()
    await expect(prepareExecutionEnvelope(v14.options, {
      ...v14.dependencies,
      verifyV14EvidenceBundle: async () => v14Summary(false),
    })).rejects.toThrow('passing immutable V14 result')

    const runtime = await fixture()
    await expect(prepareExecutionEnvelope(runtime.options, {
      ...runtime.dependencies,
      verifyRuntimeAcquisition: async () => { throw new Error('runtime bytes changed') },
    })).rejects.toThrow('runtime bytes changed')
  })

  it('refuses to replace an existing public execution freeze', async () => {
    const current = await fixture()
    await expect(prepareExecutionEnvelope(current.options, {
      ...current.dependencies,
      assertExecutionRefMissing: () => { throw new Error('execution freeze already exists') },
    })).rejects.toThrow('execution freeze already exists')
  })

  it('requires the study attestation before preparing and verifies both anchors after the execution freeze', async () => {
    const missing = await fixture()
    await expect(prepareExecutionEnvelope(missing.options, {
      ...missing.dependencies,
      verifyPublicFreezeAttestation: async () => { throw new Error('study provenance missing') },
    })).rejects.toThrow('study provenance missing')

    const frozen = await fixture()
    const verified = await verifyFrozenExecutionAttestations(frozen.options, frozen.dependencies)
    expect(verified.study.sourceCommit).toBe('8'.repeat(40))
    expect(verified.execution.sourceCommit).toBe('9'.repeat(40))
  })
})
