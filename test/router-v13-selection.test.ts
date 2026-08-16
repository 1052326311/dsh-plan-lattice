import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveSelectionRandomness,
  prepareBlindSelectionCapacity,
  selectBlindCorpus,
} from '../eval/router-corpus/v13/blind-selection.mjs'
import { solveExactSelectionFlow } from '../eval/router-corpus/v13/capacity-flow.mjs'
import {
  buildExternalVerificationAttestation,
  externalAttestationBytes,
  externalVerificationProtocol,
  verifyDrandBeacon,
} from '../eval/router-corpus/v13/selection-beacon.mjs'
import {
  agreementDigests,
  buildV13AgreementReport,
  resolveV13Adjudication,
} from '../eval/router-corpus/v13/annotation-pipeline.mjs'
import { loadSpec, sha256 } from '../eval/router-corpus/v13/protocol.mjs'
import { validateAnnotation } from '../eval/router-corpus/v7/annotation-schema.mjs'

const routeNames = ['bypass', 'contract', 'lattice', 'probe'] as const
const roundTime = Date.parse('2026-08-20T00:00:00Z')

function routeFacts(route: typeof routeNames[number]) {
  const emptyChain = {
    basisItem: '', invalidationEvent: '', laterMutation: '', staleAction: '', detectionAndConsequence: '',
  }
  if (route === 'bypass') {
    return {
      episodeMode: 'non-mutating',
      decisionAuthority: 'not-applicable',
      classificationEvidence: 'not-applicable',
      continuityHazard: 'none',
      protectedEffect: 'none',
      causalChain: emptyChain,
    }
  }
  return {
    episodeMode: 'mutating',
    decisionAuthority: route === 'contract' ? 'missing-user-choice' : 'supplied',
    classificationEvidence: route === 'probe' ? 'requires-repository-read' : 'sufficient-from-request',
    continuityHazard: route === 'lattice' ? 'stage-feedback' : 'none',
    protectedEffect: 'none',
    causalChain: route === 'lattice' ? {
      basisItem: 'The current accepted implementation contract.',
      invalidationEvent: 'Maintainer feedback changes that contract.',
      laterMutation: 'A later implementation stage edits production code.',
      staleAction: 'The stage continues from the superseded contract.',
      detectionAndConsequence: 'Review detects the stale edit and requires rework.',
    } : emptyChain,
  }
}

function annotation(id: string, route: typeof routeNames[number]) {
  return validateAnnotation({
    id,
    confidence: 'high',
    rationale: `The observable request evidence deterministically supports the ${route} control route for this exact item.`,
    facts: routeFacts(route),
    evidence: {
      episodeQuote: `Execute the ${route} scenario described in this request.`,
      decisionGapQuote: route === 'contract' ? 'The request leaves the irreversible choice to the user.' : '',
      repositoryQuestion: route === 'probe' ? 'Does the repository already define this behavior?' : '',
      repositoryAlternatives: route === 'probe' ? ['The behavior exists.', 'The behavior does not exist.'] : [],
      repositoryImpact: route === 'probe' ? 'An existing behavior means bypass; absence means contract.' : '',
      continuityQuotes: route === 'lattice' ? ['Continue after maintainer feedback changes the accepted basis.'] : [],
      protectedEffectQuote: '',
    },
  })
}

async function corpusFixture(perStratum = 40) {
  const { spec } = await loadSpec()
  const frame = (['en', 'zh'] as const).flatMap(language => routeNames.flatMap(route => (
    Array.from({ length: perStratum }, (_, index) => ({
      stableSourceId: `${language}-${route}-${index}`,
      sourceFamilyId: `github:${language}-org/${route}-${index}:issue:${index}`,
      repository: `${language}-org/${route}-${index}`,
      language,
      text: `${language} ${route} observable authorization task ${index}`,
    }))
  )))
  const candidates = frame.map(row => ({
    id: `v13-${sha256(row.stableSourceId).slice(0, 20)}`,
    language: row.language,
    text: row.text,
  })).sort((left, right) => left.id.localeCompare(right.id))
  const routeById = new Map(frame.map(row => [
    `v13-${sha256(row.stableSourceId).slice(0, 20)}`,
    row.stableSourceId.split('-').slice(1, -1).join('-') as typeof routeNames[number],
  ]))
  const annotationSets = Array.from({ length: 3 }, () => new Map(candidates.map(candidate => [
    candidate.id,
    annotation(candidate.id, routeById.get(candidate.id)!),
  ])))
  const agreementReport = buildV13AgreementReport(
    candidates,
    annotationSets,
    agreementDigests(candidates, annotationSets),
    spec.reliabilityGates,
  )
  const adjudicationPacket: never[] = []
  const adjudicationDecisions: never[] = []
  const adjudicated = resolveV13Adjudication({
    candidates,
    annotationSets,
    packet: adjudicationPacket,
    decisions: adjudicationDecisions,
  })
  return {
    spec, frame, candidates, annotationSets, agreementReport,
    adjudicationPacket, adjudicationDecisions, adjudicated,
  }
}

function signedBeacon(spec: Awaited<ReturnType<typeof loadSpec>>['spec']) {
  const signature = 'ab'.repeat(96)
  const responseBytes = Buffer.from(JSON.stringify({
    round: 6391766,
    randomness: sha256(Buffer.from(signature, 'hex')),
    signature,
    previous_signature: 'cd'.repeat(96),
  }))
  const chainInfoBytes = Buffer.from(JSON.stringify({
    public_key: '86'.repeat(48),
    period: 30,
    genesis_time: 1595431050,
    hash: '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce',
    groupHash: '17'.repeat(32),
    schemeID: 'pedersen-bls-chained',
    metadata: { beaconID: 'default' },
  }))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const attestation = buildExternalVerificationAttestation({
    responseBytes, chainInfoBytes, spec, verifierId: 'test-external-bls-verifier',
  })
  const signatureBase64 = sign(null, externalAttestationBytes(attestation), privateKey).toString('base64')
  return {
    trustedVerifierPublicKey: publicKey,
    bundle: {
      responseBytes,
      chainInfoBytes,
      externalVerification: { protocol: externalVerificationProtocol, attestation, signatureBase64 },
    },
  }
}

describe('V13 exact capacity and drand blind selection', () => {
  it('finds a feasible max flow where ordered greedy selection fails', () => {
    const rows = [
      { id: 'a-bypass-scarce', language: 'en', route: 'bypass', repository: 'shared/repo', sourceFamilyId: 'family-1' },
      { id: 'b-bypass-same-family', language: 'en', route: 'bypass', repository: 'shared/repo', sourceFamilyId: 'family-1' },
      { id: 'z-bypass-safe', language: 'en', route: 'bypass', repository: 'safe/repo', sourceFamilyId: 'family-2' },
      { id: 'contract-only', language: 'en', route: 'contract', repository: 'shared/repo', sourceFamilyId: 'family-3' },
      { id: 'lattice-only', language: 'en', route: 'lattice', repository: 'lattice/repo', sourceFamilyId: 'family-4' },
      { id: 'probe-only', language: 'en', route: 'probe', repository: 'probe/repo', sourceFamilyId: 'family-5' },
    ]
    const usedRepositories = new Set<string>()
    const greedy = routeNames.flatMap(route => {
      const row = rows.find(candidate => candidate.route === route && !usedRepositories.has(candidate.repository))
      if (row !== undefined) usedRepositories.add(row.repository)
      return row === undefined ? [] : [row]
    })
    expect(greedy).toHaveLength(3)

    const exact = solveExactSelectionFlow({
      rows,
      languages: ['en'],
      targetPerLanguage: { bypass: 1, contract: 1, lattice: 1, probe: 1 },
      maximumPerRepository: 1,
      maximumPerRoutePerRepository: 1,
    })
    expect(exact.feasible).toBe(true)
    expect(exact.witness.flowValue).toBe(4)
    expect(exact.witness.selectedCandidateIds).toContain('z-bypass-safe')
    expect(exact.witness.selectedCandidateIds).toContain('contract-only')
  })

  it('never accesses the beacon before complete reliable evidence and exact capacity pass', async () => {
    const fixture = await corpusFixture(39)
    const loadBeacon = vi.fn()
    await expect(selectBlindCorpus({
      ...fixture,
      archiveMerkleRoot: '11'.repeat(32),
      loadBeacon,
      trustedVerifierPublicKey: generateKeyPairSync('ed25519').publicKey,
      now: roundTime,
    })).rejects.toThrow('requires at least 40 before beacon access')
    expect(loadBeacon).not.toHaveBeenCalled()

    const complete = await corpusFixture()
    const forgedReport = structuredClone(complete.agreementReport)
    forgedReport.gates.allPassed = false
    await expect(selectBlindCorpus({
      ...complete,
      agreementReport: forgedReport,
      archiveMerkleRoot: '11'.repeat(32),
      loadBeacon,
      trustedVerifierPublicKey: generateKeyPairSync('ed25519').publicKey,
      now: roundTime,
    })).rejects.toThrow('agreement report')
    expect(loadBeacon).not.toHaveBeenCalled()
  })

  it('selects deterministically with exact quotas and stable frozen evidence statuses', async () => {
    const fixture = await corpusFixture()
    const beacon = signedBeacon(fixture.spec)
    const capacity = prepareBlindSelectionCapacity(fixture)
    expect(capacity.capacityManifest).toMatchObject({
      evidenceStatus: 'exact-capacity-proven', feasible: true,
      witnessDigest: capacity.capacityManifest.capacityWitness.witnessDigest,
    })
    const loadBeacon = vi.fn(async () => beacon.bundle)
    const input = {
      ...fixture,
      archiveMerkleRoot: '22'.repeat(32),
      loadBeacon,
      trustedVerifierPublicKey: beacon.trustedVerifierPublicKey,
      now: roundTime,
    }
    const first = await selectBlindCorpus(input)
    const second = await selectBlindCorpus(input)
    expect(first.prompts).toEqual(second.prompts)
    expect(first.selectionWitness).toEqual(second.selectionWitness)
    expect(first.beacon.evidenceStatus).toBe('verified-drand-beacon')
    expect(first.selectionManifest).toMatchObject({
      evidenceStatus: 'frozen-blind-selection',
      counts: {
        total: 120,
        byLanguageRoute: {
          'en/bypass': 30, 'en/contract': 12, 'en/lattice': 12, 'en/probe': 6,
          'zh/bypass': 30, 'zh/contract': 12, 'zh/lattice': 12, 'zh/probe': 6,
        },
      },
      caps: { maximumPerRepository: 8, maximumPerRoutePerRepository: 3, maximumPerSourceFamily: 1 },
    })
    expect(first.selectionManifest.derivedSeedDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(first).not.toHaveProperty('selectionRandomness')
    expect(Math.max(...Object.values(first.selectionWitness.repositoryCounts) as number[])).toBeLessThanOrEqual(8)
    expect(Math.max(...Object.values(first.selectionWitness.routeRepositoryCounts) as number[])).toBeLessThanOrEqual(3)
    expect(Math.max(...Object.values(first.selectionWitness.familyCounts) as number[])).toBe(1)
  })

  it('rejects tampered drand bytes, attestations, and derivation bindings', async () => {
    const { spec } = await loadSpec()
    const beacon = signedBeacon(spec)
    const parsed = JSON.parse(beacon.bundle.responseBytes.toString())
    const tamperedResponse = Buffer.from(JSON.stringify({ ...parsed, randomness: '00'.repeat(32) }))
    expect(() => verifyDrandBeacon({
      ...beacon.bundle,
      responseBytes: tamperedResponse,
      trustedVerifierPublicKey: beacon.trustedVerifierPublicKey,
      spec,
      now: roundTime,
    })).toThrow('signature/randomness consistency')

    const tamperedAttestation = structuredClone(beacon.bundle.externalVerification)
    tamperedAttestation.attestation.responseSha256 = '00'.repeat(32)
    expect(() => verifyDrandBeacon({
      ...beacon.bundle,
      externalVerification: tamperedAttestation,
      trustedVerifierPublicKey: beacon.trustedVerifierPublicKey,
      spec,
      now: roundTime,
    })).toThrow('not bound to the exact drand response')

    expect(() => deriveSelectionRandomness({
      protocol: spec.protocol,
      archiveMerkleRoot: '22'.repeat(32),
      capacityManifestDigest: 'not-a-digest',
      beaconRandomness: parsed.randomness,
    })).toThrow('capacity manifest digest')
  })
})
