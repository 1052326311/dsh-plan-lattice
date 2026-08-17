import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256 } from '../eval/v0.4/lib/canonical.mjs'
import {
  executeRun,
  RC4_DRIVER_PROTOCOL,
} from '../prospective/model-rc4-study/driver.mjs'
import {
  preflight,
  RC4_PREFLIGHT,
} from '../prospective/model-rc4-study/preflight.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function bytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function frozenFixture() {
  const sourceCommits = { harness: '1'.repeat(40) }
  const benchmarkRoots = { harness: '/bench/harness' }
  const run = {
    suite: 'simple',
    runId: 'infra-simple-simple-js-clamp-native-r0',
    taskId: 'simple-js-clamp',
    phase: 'infrastructure',
    includedInStatistics: false,
    order: 1,
    repetition: 0,
    taskLocator: { id: 'simple-js-clamp', registry: 'simple-tasks.json' },
    arm: { id: 'native', plugin: 'none' },
  }
  const runtimeArtifacts = {
    schemaVersion: 1,
    status: 'frozen',
    hostHarness: {
      pathEnvironmentVariable: 'PLAN_LATTICE_HOST_HARNESS_RUNTIME',
      sha256: '2'.repeat(64),
    },
    artifacts: {
      native: { pathEnvironmentVariable: 'RUNTIME_NATIVE', sha256: '3'.repeat(64), metadataDigest: '4'.repeat(64) },
      'v0.4-contract': { pathEnvironmentVariable: 'RUNTIME_CONTRACT', sha256: '5'.repeat(64), metadataDigest: '6'.repeat(64) },
      'v0.4-lattice': { pathEnvironmentVariable: 'RUNTIME_LATTICE', sha256: '7'.repeat(64), metadataDigest: '8'.repeat(64) },
    },
  }
  const baseAssets = {
    schemaVersion: 1,
    protocol: RC4_PREFLIGHT.baseAssetsProtocol,
    sourceCommits,
    pluginCommits: { 'v0.3.0': '9'.repeat(40) },
    matrixDigest: 'a'.repeat(64),
  }
  const runtimeAcquisition = {
    schemaVersion: 1,
    protocol: RC4_PREFLIGHT.runtimeAcquisitionProtocol,
    candidateCommit: RC4_PREFLIGHT.candidateCommit,
    githubRunId: RC4_PREFLIGHT.runtimeRunId,
    runtimeArtifactsDigest: sha256(runtimeArtifacts),
    hostHarness: { sha256: runtimeArtifacts.hostHarness.sha256 },
    artifacts: {
      native: { ...runtimeArtifacts.artifacts.native, pluginCommit: null },
      'v0.4-contract': { ...runtimeArtifacts.artifacts['v0.4-contract'], pluginCommit: RC4_PREFLIGHT.candidateCommit },
      'v0.4-lattice': { ...runtimeArtifacts.artifacts['v0.4-lattice'], pluginCommit: RC4_PREFLIGHT.candidateCommit },
    },
  }
  const v14Evidence = {
    schemaVersion: 1,
    candidateCommit: RC4_PREFLIGHT.candidateCommit,
    releaseGatePassed: true,
  }
  const sourceBytes = {
    controller: Buffer.from('controller-v1'),
    driver: Buffer.from('driver-v1'),
    preflight: Buffer.from('preflight-v1'),
  }
  const sourceDigests = Object.fromEntries(
    Object.entries(sourceBytes).map(([name, value]) => [name, sha256(value)]),
  ) as Record<'controller' | 'driver' | 'preflight', string>
  const baseBytes = bytes(baseAssets)
  const runtimeBytes = bytes(runtimeAcquisition)
  const v14Bytes = bytes(v14Evidence)
  const executionCommit = 'b'.repeat(40)
  const studyCommit = 'c'.repeat(40)
  const manifest = {
    schemaVersion: 1,
    protocol: RC4_PREFLIGHT.executionManifestProtocol,
    candidateCommit: RC4_PREFLIGHT.candidateCommit,
    studyProtocolFreeze: { ref: RC4_PREFLIGHT.studyProtocolRef, commit: studyCommit },
    executionFreeze: { ref: RC4_PREFLIGHT.executionFreezeRef, commit: executionCommit },
    bindings: {
      baseAssetsLockSha256: sha256(baseBytes),
      runtimeAcquisitionLockSha256: sha256(runtimeBytes),
      v14EvidenceSha256: sha256(v14Bytes),
    },
    sourceBindings: Object.fromEntries(Object.entries(RC4_PREFLIGHT.sourcePaths).map(([name, path]) => [
      name,
      { path, sha256: sourceDigests[name as keyof typeof sourceDigests] },
    ])),
    sourceBundleDigest: sha256(sourceDigests),
    sourceCommits,
    benchmarkRoots,
    runtimeArtifacts,
    runs: [run, ...Array.from({ length: 95 }, (_, index) => ({ ...run, runId: `unused-${index}` }))],
  }
  const manifestBytes = bytes(manifest)
  const artifacts = new Map([
    [RC4_PREFLIGHT.paths.baseAssetsLock, { value: baseAssets, bytes: baseBytes }],
    [RC4_PREFLIGHT.paths.runtimeAcquisitionLock, { value: runtimeAcquisition, bytes: runtimeBytes }],
    [RC4_PREFLIGHT.paths.executionManifest, { value: manifest, bytes: manifestBytes }],
    [RC4_PREFLIGHT.paths.v14Evidence, { value: v14Evidence, bytes: v14Bytes }],
  ])
  const expectedProvenance = {
    baseAssetsLockDigest: sha256(baseBytes),
    runtimeAcquisitionLockDigest: sha256(runtimeBytes),
    executionManifestDigest: sha256(manifestBytes),
    v14EvidenceDigest: sha256(v14Bytes),
    controllerSourceDigest: sourceDigests.controller,
    driverSourceDigest: sourceDigests.driver,
    preflightSourceDigest: sourceDigests.preflight,
    sourceBundleDigest: sha256(sourceDigests),
    runtimeArtifactsDigest: sha256(runtimeArtifacts),
  }
  const spec = {
    protocol: RC4_PREFLIGHT.runProtocol,
    candidateCommit: RC4_PREFLIGHT.candidateCommit,
    run,
    sourceCommits,
    benchmarkRoots,
    pluginCommits: { 'v0.3.0': '9'.repeat(40), 'v0.4.0Candidate': RC4_PREFLIGHT.candidateCommit },
    runtimeArtifacts,
    expectedProvenance,
    rc4Bindings: {
      baseAssetsLock: { path: RC4_PREFLIGHT.paths.baseAssetsLock, sha256: sha256(baseBytes) },
      runtimeAcquisitionLock: { path: RC4_PREFLIGHT.paths.runtimeAcquisitionLock, sha256: sha256(runtimeBytes) },
      executionManifest: { path: RC4_PREFLIGHT.paths.executionManifest, sha256: sha256(manifestBytes) },
      v14Evidence: { path: RC4_PREFLIGHT.paths.v14Evidence, sha256: sha256(v14Bytes) },
      executionFreezeRef: RC4_PREFLIGHT.executionFreezeRef,
      executionFreezeCommit: executionCommit,
    },
    model: { modelId: 'deepseek-v4-flash', timeoutMs: 3_600_000 },
    simpleTask: {
      id: 'simple-js-clamp',
      language: 'JavaScript',
      prompt: 'Implement clamp.',
      initialFiles: {},
      graderAssertions: [],
    },
    attemptDir: '/attempt',
  }
  const deps = {
    platform: 'darwin',
    env: {},
    loadArtifact: async (path: string) => {
      const artifact = artifacts.get(path)
      if (!artifact) throw new Error(`missing artifact ${path}`)
      return artifact
    },
    readSource: async (path: string) => {
      const name = Object.entries(RC4_PREFLIGHT.sourcePaths).find(([, expected]) => expected === path)?.[0]
      if (!name) throw new Error(`unexpected source ${path}`)
      return sourceBytes[name as keyof typeof sourceBytes]
    },
    resolveRef: (ref: string) => ({
      [RC4_PREFLIGHT.candidateRef]: RC4_PREFLIGHT.candidateCommit,
      [RC4_PREFLIGHT.studyProtocolRef]: studyCommit,
      [RC4_PREFLIGHT.executionFreezeRef]: executionCommit,
    })[ref] ?? (() => { throw new Error(`unexpected ref ${ref}`) })(),
    readTaggedFile: (commit: string, path: string) => {
      if (commit === executionCommit && path === RC4_PREFLIGHT.paths.executionManifest) return manifestBytes
      if (commit === studyCommit && path === RC4_PREFLIGHT.paths.baseAssetsLock) return baseBytes
      if (commit === studyCommit && path === RC4_PREFLIGHT.paths.runtimeAcquisitionLock) return runtimeBytes
      if (commit === executionCommit) {
        const name = Object.entries(RC4_PREFLIGHT.sourcePaths).find(([, expected]) => expected === path)?.[0]
        if (name) return sourceBytes[name as keyof typeof sourceBytes]
      }
      throw new Error(`unexpected tagged file ${commit}:${path}`)
    },
    verifyV14EvidenceBundle: async () => ({
      candidateCommit: RC4_PREFLIGHT.candidateCommit,
      releaseGatePassed: true,
      immutable: true,
    }),
    verifyCurrentRuntimeArtifact: async () => ({ id: 'hostHarness', digest: runtimeArtifacts.hostHarness.sha256 }),
    assertExactCheckout: () => undefined,
    requireProxyCapabilities: () => ({ hostBaseURL: 'http://127.0.0.1:41000' }),
    realpath: async (path: string) => path,
    exists: async () => true,
    executable: () => true,
  }
  return { spec, deps, artifacts }
}

describe('RC.4 dedicated preflight', () => {
  it('rejects an RC.3 run before loading any evidence', async () => {
    const { spec, deps } = frozenFixture()
    let loads = 0
    const legacy = {
      ...spec,
      candidateCommit: 'dc55716525987fcb7cb46579a9c957877cbd23c2',
      routerBlindResultDigest: 'd'.repeat(64),
      pluginCommits: { ...spec.pluginCommits, 'v0.4.0Candidate': 'dc55716525987fcb7cb46579a9c957877cbd23c2' },
    }
    const result = await preflight(legacy, {
      ...deps,
      loadArtifact: async () => {
        loads += 1
        throw new Error('must not load RC.3 evidence')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'rc4-run-spec', ok: false }),
    ])
    expect(loads).toBe(0)
  })

  it('fails closed when the V14 evidence bundle is missing', async () => {
    const { spec, deps } = frozenFixture()
    const result = await preflight(spec, {
      ...deps,
      loadArtifact: async (path: string) => {
        if (path === RC4_PREFLIGHT.paths.v14Evidence) throw new Error('V14 reveal has not happened')
        return deps.loadArtifact(path)
      },
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'v14-evidence-bytes', ok: false }))
    expect(result.checks.some(check => check.name === 'v14-evidence-release-gate')).toBe(false)
  })

  it('accepts only a fully bound RC.4 execution environment', async () => {
    const { spec, deps } = frozenFixture()
    const result = await preflight(spec, deps)
    expect(result).toMatchObject({
      schemaVersion: 1,
      protocol: RC4_PREFLIGHT.resultProtocol,
      ok: true,
      candidateCommit: RC4_PREFLIGHT.candidateCommit,
      executionManifestDigest: spec.rc4Bindings.executionManifest.sha256,
    })
    expect(result.checks.every(check => check.ok)).toBe(true)
    expect(result.checks.map(check => check.name)).toEqual(expect.arrayContaining([
      'execution-freeze-tag',
      'v14-evidence-release-gate',
      'controller-driver-source-binding',
      'exact-benchmark-roots',
      'current-runtime-artifact-identity',
      'credential-proxy',
    ]))
  })
})

describe('RC.4 driver output protocol', () => {
  it('emits a bound result envelope after preflight and never runs a suite when preflight fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-rc4-driver-'))
    temporaryRoots.push(root)
    const attemptDir = join(root, 'attempt')
    const controllerDir = join(attemptDir, 'controller')
    await mkdir(controllerDir, { recursive: true })
    const specPath = join(controllerDir, 'run-spec.json')
    const { spec: fixture } = frozenFixture()
    const spec = { ...fixture, attemptDir }
    await writeFile(specPath, JSON.stringify(spec), 'utf8')
    let calls = 0
    const suiteRunners = {
      simple: async () => {
        calls += 1
        return {
          status: 'completed',
          metrics: { score: 1, maxScore: 1, modelTurns: 1, inputTokens: 10, outputTokens: 2, durationMs: 20, clarificationQuestions: 0 },
          provenance: { graderDigest: 'e'.repeat(64), taskDigest: 'f'.repeat(64) },
        }
      },
    }
    const passed = await executeRun(spec, specPath, {
      preflight: async () => ({ schemaVersion: 1, protocol: RC4_PREFLIGHT.resultProtocol, ok: true, checks: [] }),
      suiteRunners,
    })
    expect(passed).toMatchObject({
      schemaVersion: 1,
      protocol: RC4_DRIVER_PROTOCOL,
      phase: 'execution',
      status: 'completed',
      runId: spec.run.runId,
      candidateCommit: RC4_PREFLIGHT.candidateCommit,
      executionManifestDigest: spec.rc4Bindings.executionManifest.sha256,
    })
    expect(calls).toBe(1)
    expect(JSON.parse(await readFile(join(attemptDir, 'preflight.json'), 'utf8')).ok).toBe(true)

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
