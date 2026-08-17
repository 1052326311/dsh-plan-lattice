import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../eval/v0.4/lib/canonical.mjs'
import {
  buildExecutionEnvelope,
  buildRc4Preregistration,
  buildRouterEvidenceRecord,
  buildRuntimeArtifactsRecord,
  loadFrozenDesign,
} from '../prospective/model-rc4-study/design.mjs'
import {
  executeRun,
  RC4_DRIVER_PROTOCOL,
} from '../prospective/model-rc4-study/driver.mjs'
import {
  preflight,
  RC4_PREFLIGHT,
} from '../prospective/model-rc4-study/preflight.mjs'
import { loadStudySpec } from '../prospective/model-rc4-study/protocol.mjs'
import { buildRunSpec } from '../prospective/model-rc4-study/run-spec.mjs'

const temporaryRoots: string[] = []
const digest = (character: string) => character.repeat(64)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function signingPublicKey() {
  const { publicKey } = generateKeyPairSync('ed25519')
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
}

function v14Summary() {
  return {
    protocol: 'observable-authorization-v14-rc4-shared-v13-corpus',
    evidenceStatus: 'independently-verified-v14-reveal',
    candidateCommit: RC4_PREFLIGHT.candidateCommit,
    analysis: { releaseGatePassed: true, metrics: { exactAccuracy: 0.95 } },
    pairedV13Outcome: { outcomeSha256: digest('1') },
    revealAttemptSha256: digest('2'),
    revealResultSha256: digest('3'),
    recomputedRowsSha256: digest('4'),
  }
}

async function frozenFixture() {
  const { spec: studySpec } = await loadStudySpec()
  const frozen = loadFrozenDesign(studySpec)
  const runtimeArtifacts = buildRuntimeArtifactsRecord()
  const summary = v14Summary()
  const routerEvidence = buildRouterEvidenceRecord(summary)
  const preregistration = buildRc4Preregistration({
    studySpec,
    signingPublicKeySpkiBase64: signingPublicKey(),
  })
  const sourceDigest = digest('7')
  const studyCommit = '8'.repeat(40)
  const executionCommit = '9'.repeat(40)
  const envelope = buildExecutionEnvelope({
    studySpec,
    studyProtocolCommit: studyCommit,
    preregistration,
    runtimeArtifacts,
    routerEvidence,
    driverSourceDigest: sourceDigest,
    controllerSourceDigest: sourceDigest,
    signingLedgerId: 'plan-lattice-rc4-test-ledger',
  })
  const run = envelope.runManifest.infrastructureRuns[0]
  const endpointDigest = digest('a')
  const benchmarkRoots = Object.fromEntries(Object.keys(envelope.runManifest.sourceCommits).map(name => [name, `/bench/${name}`]))
  const expectedProvenance = {
      harnessCommit: envelope.runManifest.sourceCommits.harness,
      modelId: envelope.runManifest.model.modelId,
      modelConfigDigest: sha256(envelope.runManifest.model),
      runtimePolicyDigest: sha256(envelope.runManifest.runtimePolicy),
      endpointDigest,
      sourceLockDigest: envelope.runManifest.sourceLockDigest,
      runtimeArtifactsDigest: envelope.runManifest.runtimeArtifactsDigest,
      driverSourceDigest: sourceDigest,
      pluginCommit: null,
  }
  const spec = buildRunSpec({
    run,
    envelope,
    studySpec,
    executionFreezeCommit: executionCommit,
    benchmarkLock: frozen.benchmarkLock,
    simpleTasks: frozen.simpleTasks,
    benchmarkRoots,
    expectedProvenance,
    attemptDir: '/attempt',
  })
  const bytes = Buffer.from(canonicalJson(envelope))
  const deps = {
    loadStudySpec: async () => ({ spec: studySpec }),
    assertCandidateFreeze: () => ({ commit: studySpec.candidate.commit, tree: studySpec.candidate.tree }),
    assertStudyProtocolFreeze: () => ({ commit: studyCommit }),
    readExecutionEnvelopeFromTag: () => ({ commit: executionCommit, bytes, envelope }),
    verifyExecutionEnvelope: () => envelope,
    assertExecutionFreeze: () => ({ executionCommit }),
    loadAndVerifyBaseAssetsLock: async () => ({ lock: {} }),
    studySourceDigest: () => ({ commit: studyCommit, files: [], digest: sourceDigest }),
    buildRuntimeArtifactsRecord: () => runtimeArtifacts,
    loadFrozenDesign: () => frozen,
    verifyRuntimeAcquisition: async () => ({ candidateCommit: studySpec.candidate.commit }),
    verifyV14EvidenceBundle: async () => summary,
    buildRouterEvidenceRecord,
    validateBenchmarkRoots: async () => Object.keys(spec.benchmarkRoots),
    validateSuiteAssets: async () => spec.run.suite,
    validateToolchain: () => process.version,
    verifyCurrentRuntime: async () => ({ id: 'hostHarness' }),
    verifyHostPlugins: async () => ({ verified: true }),
    verifyPublicFreezeAttestation: async ({ kind }: { kind: string }) => ({
      kind,
      anchorSha256: digest(kind === 'study' ? 'e' : 'f'),
      sourceCommit: kind === 'study' ? studyCommit : executionCommit,
      attestations: 1,
      verifiedTimestamps: 1,
    }),
    requireProxyCapabilities: () => ({ hostBaseURL: 'http://127.0.0.1:41000' }),
  }
  return { deps, envelope, spec, studySpec }
}

describe('RC.4 dedicated preflight', () => {
  it('stops before runtime or V14 checks when the public execution tag is missing', async () => {
    const fixture = await frozenFixture()
    let externalChecks = 0
    const result = await preflight(fixture.spec, {
      ...fixture.deps,
      readExecutionEnvelopeFromTag: () => { throw new Error('execution tag missing') },
      verifyRuntimeAcquisition: async () => { externalChecks += 1 },
      verifyV14EvidenceBundle: async () => { externalChecks += 1 },
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'execution-envelope-tag', ok: false }))
    expect(externalChecks).toBe(0)
  })

  it('rejects an RC.3 run even when every surrounding dependency is available', async () => {
    const fixture = await frozenFixture()
    const legacy = {
      ...fixture.spec,
      candidateCommit: 'dc55716525987fcb7cb46579a9c957877cbd23c2',
      pluginCommits: {
        ...fixture.spec.pluginCommits,
        'v0.4.0Candidate': 'dc55716525987fcb7cb46579a9c957877cbd23c2',
      },
    }
    const result = await preflight(legacy, fixture.deps)
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'run-spec', ok: false }))
  })

  it('rejects a self-consistent run-spec rewrite of the prompt or hidden grader', async () => {
    const fixture = await frozenFixture()
    for (const mutate of [
      (spec: any) => { spec.simpleTask.prompt = 'Return a hard-coded answer.' },
      (spec: any) => { spec.simpleTask.graderAssertions = [] },
      (spec: any) => { spec.benchmarkLock.sources.harness.commit = '0'.repeat(40) },
    ]) {
      const changed = structuredClone(fixture.spec)
      mutate(changed)
      const result = await preflight(changed, fixture.deps)
      expect(result.ok).toBe(false)
      expect(result.checks).toContainEqual(expect.objectContaining({ name: 'run-spec', ok: false }))
    }
  })

  it('fails closed when independent V14 replay is unavailable', async () => {
    const fixture = await frozenFixture()
    const result = await preflight(fixture.spec, {
      ...fixture.deps,
      verifyV14EvidenceBundle: async () => { throw new Error('V14 reveal has not happened') },
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'v14-independent-replay',
      ok: false,
    }))
    expect(result.checks.some(check => check.name === 'v14-envelope-binding')).toBe(false)
  })

  it('accepts one coherent envelope, runtime acquisition, V14 replay, and run slot', async () => {
    const fixture = await frozenFixture()
    const result = await preflight(fixture.spec, fixture.deps)
    expect(result).toMatchObject({
      schemaVersion: 1,
      protocol: RC4_PREFLIGHT.resultProtocol,
      ok: true,
      candidateCommit: RC4_PREFLIGHT.candidateCommit,
      executionEnvelopeDigest: fixture.envelope.envelopeDigest,
    })
    expect(result.checks.map(check => check.name)).toEqual(expect.arrayContaining([
      'execution-envelope',
      'run-spec',
      'runtime-acquisition',
      'v14-independent-replay',
      'v14-envelope-binding',
      'frozen-source',
      'study-public-attestation',
      'execution-public-attestation',
    ]))
  })

  it('fails before expensive execution checks when either public attestation is unavailable', async () => {
    const fixture = await frozenFixture()
    let externalChecks = 0
    const result = await preflight(fixture.spec, {
      ...fixture.deps,
      verifyPublicFreezeAttestation: async ({ kind }: { kind: string }) => {
        if (kind === 'execution') throw new Error('execution provenance missing')
        return { kind, sourceCommit: '8'.repeat(40) }
      },
      verifyRuntimeAcquisition: async () => { externalChecks += 1 },
      verifyV14EvidenceBundle: async () => { externalChecks += 1 },
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'execution-public-attestation', ok: false }))
    expect(externalChecks).toBe(0)
  })
})

describe('RC.4 driver output protocol', () => {
  it('executes only after a passing preflight and preserves the envelope digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-rc4-driver-'))
    temporaryRoots.push(root)
    const attemptDir = join(root, 'attempt')
    const controllerDir = join(attemptDir, 'controller')
    await mkdir(controllerDir, { recursive: true })
    const specPath = join(controllerDir, 'run-spec.json')
    const fixture = await frozenFixture()
    const spec = { ...fixture.spec, attemptDir }
    await writeFile(specPath, JSON.stringify(spec), 'utf8')
    let calls = 0
    const suiteRunners = {
      simple: async () => {
        calls += 1
        return {
          status: 'completed',
          metrics: { score: 1, maxScore: 1, modelTurns: 1, inputTokens: 10, outputTokens: 2, durationMs: 20, clarificationQuestions: 0 },
          provenance: { graderDigest: digest('b'), taskDigest: digest('c') },
        }
      },
    }
    const passed = await executeRun(spec, specPath, {
      preflight: async () => ({ schemaVersion: 1, protocol: RC4_PREFLIGHT.resultProtocol, ok: true, checks: [] }),
      suiteRunners,
    })
    expect(passed).toMatchObject({
      protocol: RC4_DRIVER_PROTOCOL,
      status: 'completed',
      executionEnvelopeDigest: fixture.envelope.envelopeDigest,
    })
    const rejected = await executeRun(spec, specPath, {
      preflight: async () => ({ schemaVersion: 1, protocol: RC4_PREFLIGHT.resultProtocol, ok: false, checks: [{ name: 'v14', ok: false }] }),
      suiteRunners,
    })
    expect(rejected).toMatchObject({
      protocol: RC4_DRIVER_PROTOCOL,
      phase: 'preflight',
      status: 'failed',
      failure: { classification: 'infrastructure', code: 'rc4_preflight_failed_before_model_call' },
    })
    expect(calls).toBe(1)
  })
})
