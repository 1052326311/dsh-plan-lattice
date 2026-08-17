import { describe, expect, it } from 'vitest'
import {
  BASE_COMMIT,
  BASE_TREE,
  RC3_CANDIDATE_COMMIT,
  RC4_CANDIDATE_COMMIT,
  V03_COMMIT,
  deriveBaseAssetsLock,
  loadAndVerifyBaseAssetsLock,
  validateBaseAssetsLock,
} from '../prospective/model-rc4-study/base-assets.mjs'

function changed(lock: any, mutate: (copy: any) => void) {
  const copy = structuredClone(lock)
  mutate(copy)
  return copy
}

describe('RC.4 strict model evaluation base-assets lock', () => {
  it('recomputes every reusable asset from the exact historical Git object', async () => {
    const { lock } = await loadAndVerifyBaseAssetsLock()

    expect(lock.source).toMatchObject({
      commit: BASE_COMMIT,
      tree: BASE_TREE,
      historicalManifestRole: 'matrix-source-only',
      explicitlyNotAnRc4ExecutionManifest: true,
    })
    expect(lock.reusableAssets.records).toHaveLength(37)
    expect(new Set(lock.reusableAssets.records.map((record: any) => record.path)).size).toBe(37)
    expect(lock.reusableAssets.records.every((record: any) => (
      record.type === 'blob'
      && /^[a-f0-9]{40}$/u.test(record.oid)
      && /^[a-f0-9]{64}$/u.test(record.sha256)
    ))).toBe(true)
    expect(lock.reusableAssets.records.map((record: any) => record.path)).toEqual(expect.arrayContaining([
      'eval/v0.4/driver/dsh-driver.mjs',
      'eval/v0.4/driver/lib/runtime.mjs',
      'eval/v0.4/driver/lib/simple-grader.mjs',
      'eval/v0.4/lib/analysis.mjs',
      'eval/v0.4/lib/attempt-integrity.mjs',
      'eval/v0.4/schemas/driver-result.schema.json',
      'eval/v0.4/schemas/manifest.schema.json',
      'eval/v0.4/schemas/run-result.schema.json',
      'eval/v0.4/benchmark-lock.json',
      'eval/v0.4/simple-tasks.json',
      'eval/v0.4/frozen-manifest.json',
      'eval/v0.4/checksums.sha256',
    ]))
    expect(lock.reusableAssets).toMatchObject({
      pathContentDigest: 'dc6d61f10262106619f61e3fe858a84c4cb0773df938d5d32d5d2abe5be408f3',
      driverSourceDigest: '969bad524607f4063d8d1cedcdb98ca973ac93a4aaa09823d14a08bc5b74889b',
      checksumsFileSha256: '952ac852a8aa4ce74b63fb2451fafca2fbccc148d1ab48f6473f3642fcbf55e4',
    })
    expect(lock.policySources.preregistration.oid).toBe('8141f5da766c47186f688a3f0f74035fa62cba66')
    expect(lock.policySources.historicalRuntimeArtifacts.oid).toBe('508fb759eb29ee412011e5aba44fc1895e848fb4')
  })

  it('locks all 6 infrastructure and 90 ordered statistical slots with exact cells and arms', async () => {
    const { lock } = await loadAndVerifyBaseAssetsLock()
    const allRunIds = [...lock.matrix.infrastructureRunIds, ...lock.matrix.statisticalRunIds]

    expect(lock.matrix.counts).toEqual({
      evocode: 18,
      icae: 36,
      infrastructure: 6,
      simple: 36,
      statistical: 90,
    })
    expect(lock.matrix.infrastructureRunIds).toHaveLength(6)
    expect(lock.matrix.statisticalRunIds).toHaveLength(90)
    expect(new Set(allRunIds).size).toBe(96)
    expect(lock.matrix.statisticalCellCount).toBe(45)
    expect(lock.matrix.repetitionsPerStatisticalCell).toEqual([1, 2])
    expect(lock.matrix.statisticalRunIds).toHaveLength(lock.matrix.statisticalCellCount * 2)
    expect(lock.matrix.suites).toEqual({
      simple: { tasks: 6, runs: 36, arms: ['native', 'v0.3-always', 'v0.4-auto'] },
      icae: { tasks: 6, runs: 36, arms: ['native', 'v0.4-never', 'v0.4-critical'] },
      evocode: { tasks: 3, runs: 18, arms: ['native', 'v0.4-contract', 'v0.4-lattice'] },
    })
    expect(lock.matrix.randomization).toEqual({
      algorithm: 'Fisher-Yates with repository-owned mulberry32-compatible seeded PRNG',
      seed: 'plan-lattice-v0.4-blind-90-2026-08-15',
    })
    expect(lock.matrix.fullRunsSha256).toBe('fef6a99d8b80f709e936fa0528b4f159186f09a7b9ef583a28ba5ec0aa2fe6b5')
    expect(lock.matrix.statisticalRunIds.slice(0, 3)).toEqual([
      'stat-simple-simple-python-whitespace-v0.3-always-r1',
      'stat-simple-simple-go-dedupe-v0.4-auto-r1',
      'stat-simple-simple-ts-slugify-v0.3-always-r1',
    ])
    expect(lock.matrix.statisticalRunIds.at(-1)).toBe('stat-icae-icae-python-02-native-r1')
  })

  it('preserves complete retry and release gates rather than a summary of them', async () => {
    const { lock } = await loadAndVerifyBaseAssetsLock()

    expect(lock.retryPolicy).toEqual({
      preserveEveryAttempt: true,
      allowedOnlyForFailureClass: 'infrastructure',
      allowedInfrastructureCodes: [
        'benchmark_service_unavailable',
        'container_runtime_failure',
        'filesystem_capacity',
        'host_network_outage',
        'oracle_service_unavailable',
        'runner_crash_before_model_call',
      ],
      disallowedExamples: [
        'agent_error',
        'grader_failure_caused_by_submission',
        'model_timeout',
        'requirement_miss',
        'tool_error_caused_by_agent',
      ],
    })
    expect(lock.releaseGates.integrity).toEqual({
      all90StatisticalSlotsResolved: true,
      samePinnedModelEndpointBudgetAndHarness: true,
      noUnauthorizedReruns: true,
      allAttemptsRetained: true,
    })
    expect(lock.releaseGates.simple.comparison).toContain('paired by task and repetition')
    expect(lock.releaseGates.icae).toMatchObject({
      bootstrapUnit: '6 independent tasks',
      minimumRelativeHiddenFeatureScore: 1.5,
      minimumAbsoluteHiddenFeaturePointGain: 15,
      minimumCriticalRequirementMissReduction: 0.5,
      bootstrapSamples: 20000,
    })
    expect(lock.releaseGates.evocode).toMatchObject({
      bootstrapUnit: '3 independent tasks',
      minimumHistoricalRequirementRegressionReduction: 0.5,
      cumulativeCaseScoreMustBeHigher: true,
      medianClarificationQuestionsMaximum: 3,
      perTaskClarificationQuestionsMaximum: 5,
    })
  })

  it('binds source, host runtime, v0.3 baseline, and the one-way RC.4 candidate replacement', async () => {
    const { lock } = await loadAndVerifyBaseAssetsLock()

    expect(lock.sourceCommits).toEqual({
      evocode: 'f8fcfaa1c9ad1c5b0bbc433323b587e4ddea2f32',
      harbor: 'a27e9c2ae10a31c40b2dcef33ef5486bce36e185',
      harness: '47f943859bef60e4160492346772ded9b24f765a',
      icae: 'b33fe657bc813b0744def61d1fca9f5f3f9a1e9d',
    })
    expect(lock.hostRuntimeIdentity).toEqual({
      builder: 'eval/v0.4/driver/build-host-harness-runtime.mjs',
      pathEnvironmentVariable: 'PLAN_LATTICE_HOST_HARNESS_RUNTIME',
      sha256: '532fc29dae09f8ac0ac4fe20cfd08cf016506a04120b2f0ce3fbf7d2ad2f8319',
      platform: 'darwin',
      architecture: 'arm64',
      node: 'v22.23.0',
      harnessCommit: lock.sourceCommits.harness,
    })
    expect(lock.pluginBindings['v0.3'].commit).toBe(V03_COMMIT)
    expect(lock.pluginBindings['historicalV0.4Candidate'].commit).toBe(RC3_CANDIDATE_COMMIT)
    expect(lock.pluginBindings.rc4Candidate.commit).toBe(RC4_CANDIDATE_COMMIT)
    expect(lock.candidateReplacement.rules).toEqual([
      { pluginSelector: 'none', executionIdentity: 'native' },
      { pluginSelector: 'v0.3.0', executionIdentity: V03_COMMIT },
      { pluginSelector: 'v0.4.0-candidate', executionIdentity: RC4_CANDIDATE_COMMIT },
    ])
    expect(lock.candidateReplacement.forbiddenExecutionIdentity).toBe(RC3_CANDIDATE_COMMIT)
    expect(lock.candidateReplacement.executionManifestRequirement).toContain('never execute frozen-manifest.json directly')
    expect(lock.reuseBoundary.forbidden).toContain('using the RC.3 frozen manifest as the RC.4 execution manifest')
  })

  it('rejects lock tampering even when the lock claims a replacement digest', async () => {
    const trusted = deriveBaseAssetsLock()
    const mutations: Array<(copy: any) => void> = [
      copy => { copy.source.commit = '0'.repeat(40) },
      copy => { copy.source.historicalManifestRole = 'rc4-execution-manifest' },
      copy => { copy.reusableAssets.records[0].oid = '0'.repeat(40) },
      copy => {
        copy.reusableAssets.records[0].sha256 = '1'.repeat(64)
        copy.reusableAssets.recordsCanonicalSha256 = '2'.repeat(64)
        copy.reusableAssets.pathContentDigest = '3'.repeat(64)
      },
      copy => { copy.matrix.infrastructureRunIds.pop() },
      copy => { copy.matrix.statisticalRunIds[1] = copy.matrix.statisticalRunIds[0] },
      copy => {
        ;[copy.matrix.statisticalRunIds[0], copy.matrix.statisticalRunIds[1]] = [
          copy.matrix.statisticalRunIds[1],
          copy.matrix.statisticalRunIds[0],
        ]
        copy.matrix.fullRunsSha256 = '4'.repeat(64)
      },
      copy => { copy.matrix.randomization.seed = 'post-outcome-seed' },
      copy => { copy.matrix.statisticalCellCount = 44 },
      copy => { copy.matrix.repetitionsPerStatisticalCell = [1, 1] },
      copy => { copy.matrix.suites.icae.arms = ['native', 'v0.4-critical'] },
      copy => { copy.retryPolicy.allowedInfrastructureCodes.push('model_timeout') },
      copy => { copy.releaseGates.integrity.noUnauthorizedReruns = false },
      copy => { copy.releaseGates.simple.maximumAddedModelTurns = 1 },
      copy => { copy.releaseGates.icae.minimumAbsoluteHiddenFeaturePointGain = 1 },
      copy => { copy.releaseGates.evocode.perTaskClarificationQuestionsMaximum = 50 },
      copy => { copy.pluginBindings['v0.3'].commit = '5'.repeat(40) },
      copy => { copy.pluginBindings.rc4Candidate.commit = RC3_CANDIDATE_COMMIT },
      copy => { copy.candidateReplacement.rules[2].executionIdentity = RC3_CANDIDATE_COMMIT },
      copy => { copy.sourceCommits.harness = '6'.repeat(40) },
      copy => { copy.hostRuntimeIdentity.sha256 = '7'.repeat(64) },
    ]

    for (const mutate of mutations) {
      expect(() => validateBaseAssetsLock(changed(trusted, mutate))).toThrow(/base-assets lock|identity/u)
    }
  }, 30_000)
})
