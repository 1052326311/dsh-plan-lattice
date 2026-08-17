import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '../..')

export const BASE_COMMIT = '0414dfa5035e6ca5cdc511964883b64be62ad44e'
export const BASE_TREE = '88fb3e67ac48f3659ee6b5f482ec080a8b63ae00'
export const RC4_CANDIDATE_COMMIT = '7cb3c77f9dab6ef193eb77318fb87389b877b526'
export const RC3_CANDIDATE_COMMIT = 'dc55716525987fcb7cb46579a9c957877cbd23c2'
export const V03_COMMIT = 'fc55e593c03f99c0ef62ba5948d3e4f719059cdc'

const LOCK_ID = 'plan-lattice-rc4-base-assets-v1'
const derivedLockCache = new Map()
const FROZEN_MANIFEST_PATH = 'eval/v0.4/frozen-manifest.json'
const PREREGISTRATION_PATH = 'eval/v0.4/preregistration.json'
const RUNTIME_ARTIFACTS_PATH = 'eval/v0.4/runtime-artifacts.json'
const CHECKSUMS_PATH = 'eval/v0.4/checksums.sha256'

export const REUSABLE_ASSET_ROOTS = Object.freeze([
  'eval/v0.4/driver',
  'eval/v0.4/lib',
  'eval/v0.4/schemas',
  'eval/v0.4/benchmark-lock.json',
  'eval/v0.4/simple-tasks.json',
  FROZEN_MANIFEST_PATH,
  CHECKSUMS_PATH,
])

export const EXPECTED_ARMS = Object.freeze({
  simple: [
    { id: 'native', plugin: 'none' },
    { id: 'v0.3-always', plugin: 'v0.3.0', activationMode: 'always' },
    { id: 'v0.4-auto', plugin: 'v0.4.0-candidate', activationMode: 'auto' },
  ],
  icae: [
    { id: 'native', plugin: 'none' },
    {
      id: 'v0.4-never',
      plugin: 'v0.4.0-candidate',
      activationMode: 'auto',
      clarificationPolicy: 'never',
    },
    {
      id: 'v0.4-critical',
      plugin: 'v0.4.0-candidate',
      activationMode: 'auto',
      clarificationPolicy: 'critical',
    },
  ],
  evocode: [
    { id: 'native', plugin: 'none' },
    {
      id: 'v0.4-contract',
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
      clarificationPolicy: 'critical',
      controlCeiling: 'contract',
    },
    {
      id: 'v0.4-lattice',
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
    },
  ],
})

const EXPECTED_COUNTS = Object.freeze({
  evocode: 18,
  icae: 36,
  infrastructure: 6,
  simple: 36,
  statistical: 90,
})

const EXPECTED_RANDOMIZATION = Object.freeze({
  algorithm: 'Fisher-Yates with repository-owned mulberry32-compatible seeded PRNG',
  seed: 'plan-lattice-v0.4-blind-90-2026-08-15',
})

const EXPECTED_RETRY_POLICY = Object.freeze({
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

const EXPECTED_RELEASE_GATES = Object.freeze({
  integrity: {
    all90StatisticalSlotsResolved: true,
    samePinnedModelEndpointBudgetAndHarness: true,
    noUnauthorizedReruns: true,
    allAttemptsRetained: true,
  },
  simple: {
    comparison: 'v0.4-auto minus native, paired by task and repetition',
    scoreNonInferiorityMarginPoints: 2,
    maximumAddedModelTurns: 0,
    medianTokenOverheadMaximum: 0.05,
    p95TokenOverheadMaximum: 0.1,
    medianDurationOverheadMaximum: 0.05,
    p95DurationOverheadMaximum: 0.1,
  },
  icae: {
    comparison: 'v0.4-critical versus native, paired by task and repetition; bootstrap after averaging repetitions within task',
    bootstrapUnit: '6 independent tasks',
    minimumRelativeHiddenFeatureScore: 1.5,
    minimumAbsoluteHiddenFeaturePointGain: 15,
    minimumCriticalRequirementMissReduction: 0.5,
    pairedBootstrapConfidence: 0.95,
    pairedBootstrapLowerBoundMustExceed: 0,
    bootstrapSamples: 20000,
  },
  evocode: {
    comparison: 'v0.4-lattice versus native, paired by task and repetition; bootstrap after averaging repetitions within task',
    bootstrapUnit: '3 independent tasks',
    minimumHistoricalRequirementRegressionReduction: 0.5,
    cumulativeCaseScoreMustBeHigher: true,
    pairedBootstrapConfidence: 0.95,
    pairedBootstrapLowerBoundMustExceed: 0,
    bootstrapSamples: 20000,
    medianClarificationQuestionsMaximum: 3,
    perTaskClarificationQuestionsMaximum: 5,
  },
})

const EXPECTED_MODEL = Object.freeze({
  provider: 'DeepSeek',
  modelId: 'deepseek-v4-flash',
  apiKeyEnvironmentVariable: 'DEEPSEEK_API_KEY',
  baseUrlEnvironmentVariable: 'DEEPSEEK_BASE_URL',
  temperature: 0,
  maxOutputTokens: 32768,
  timeoutMs: 3600000,
  budgetPolicy: 'Identical model, endpoint, token ceiling, wall timeout, and tool permissions for every paired arm.',
})

const EXPECTED_RUNTIME_POLICY = Object.freeze({
  profile: 'headless',
  workspaceIsolation: 'fresh workspace per attempt',
  concurrencyPerRun: 1,
  permissions: 'identical benchmark-defined permissions for paired arms',
  network: 'only model endpoint and benchmark-required local services',
  driver: 'exact executable content frozen before statistical execution',
})

const EXPECTED_SOURCE_COMMITS = Object.freeze({
  evocode: 'f8fcfaa1c9ad1c5b0bbc433323b587e4ddea2f32',
  harbor: 'a27e9c2ae10a31c40b2dcef33ef5486bce36e185',
  harness: '47f943859bef60e4160492346772ded9b24f765a',
  icae: 'b33fe657bc813b0744def61d1fca9f5f3f9a1e9d',
})

const EXPECTED_HOST_RUNTIME = Object.freeze({
  builder: 'eval/v0.4/driver/build-host-harness-runtime.mjs',
  pathEnvironmentVariable: 'PLAN_LATTICE_HOST_HARNESS_RUNTIME',
  sha256: '532fc29dae09f8ac0ac4fe20cfd08cf016506a04120b2f0ce3fbf7d2ad2f8319',
  platform: 'darwin',
  architecture: 'arm64',
  node: 'v22.23.0',
  harnessCommit: EXPECTED_SOURCE_COMMITS.harness,
})

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

export function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)
  return createHash('sha256').update(bytes).digest('hex')
}

function same(actual, expected, context) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${context} changed`)
}

function git(args, { cwd = repositoryRoot, binary = false } = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr
    throw new Error(`git ${args.join(' ')} failed${detail?.trim() ? `: ${detail.trim()}` : ''}`)
  }
  return result.stdout
}

function gitBytes(path, cwd) {
  return git(['show', `${BASE_COMMIT}:${path}`], { cwd, binary: true })
}

function gitJson(path, cwd) {
  return JSON.parse(gitBytes(path, cwd).toString('utf8'))
}

function parseTreeRecords(bytes) {
  return bytes.toString('utf8').split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t')
    const [mode, type, oid] = line.slice(0, tab).split(' ')
    return { path: line.slice(tab + 1), mode, type, oid }
  })
}

function listTreeRecords(paths, cwd) {
  const records = parseTreeRecords(git(['ls-tree', '-r', '-z', BASE_COMMIT, '--', ...paths], { cwd, binary: true }))
  return records.sort((left, right) => left.path.localeCompare(right.path))
}

function recordWithDigest(record, cwd) {
  if (record.type !== 'blob') throw new Error(`base asset is not a blob: ${record.path}`)
  return { ...record, sha256: sha256(gitBytes(record.path, cwd)) }
}

function recordForPath(path, cwd) {
  const records = listTreeRecords([path], cwd)
  if (records.length !== 1 || records[0].path !== path) throw new Error(`missing exact base asset: ${path}`)
  return recordWithDigest(records[0], cwd)
}

function seededRandom(seed) {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function deterministicShuffle(values, seed) {
  const result = [...values]
  const random = seededRandom(seed)
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

function locatorFor(suite, task) {
  if (suite === 'simple') return { registry: 'simple-tasks.json', id: task.id }
  if (suite === 'icae') {
    return {
      repository: task.repoId,
      repositoryKey: task.repositoryKey,
      language: task.language,
      aliasResolution: 'ICAE repo_alias.json at the pinned commit',
    }
  }
  return { harborTaskId: task.id }
}

function makeRun({ phase, suite, task, arm, repetition }) {
  return {
    runId: `${phase === 'infrastructure' ? 'infra' : 'stat'}-${suite}-${task.id}-${arm.id}-r${repetition}`,
    phase,
    includedInStatistics: phase === 'statistical',
    suite,
    taskId: task.id,
    taskLocator: locatorFor(suite, task),
    arm,
    repetition,
  }
}

function buildExpectedRuns(preregistration, benchmarkLock, simpleTasks) {
  const tasks = {
    simple: simpleTasks.tasks,
    icae: benchmarkLock.sources.icae.selectedTasks,
    evocode: benchmarkLock.sources.evocode.selectedTasks,
  }
  const infrastructureRuns = [
    makeRun({ phase: 'infrastructure', suite: 'simple', task: tasks.simple[0], arm: EXPECTED_ARMS.simple[0], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'simple', task: tasks.simple[0], arm: EXPECTED_ARMS.simple[2], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'icae', task: tasks.icae[0], arm: EXPECTED_ARMS.icae[0], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'icae', task: tasks.icae[0], arm: EXPECTED_ARMS.icae[2], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'evocode', task: tasks.evocode[0], arm: EXPECTED_ARMS.evocode[0], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'evocode', task: tasks.evocode[0], arm: EXPECTED_ARMS.evocode[2], repetition: 0 }),
  ].map((run, index) => ({ ...run, order: index + 1 }))

  const unshuffled = []
  for (const suite of ['simple', 'icae', 'evocode']) {
    for (const task of tasks[suite]) {
      for (const arm of EXPECTED_ARMS[suite]) {
        for (const repetition of [1, 2]) {
          unshuffled.push(makeRun({ phase: 'statistical', suite, task, arm, repetition }))
        }
      }
    }
  }
  const statisticalRuns = deterministicShuffle(unshuffled, preregistration.randomization.seed)
    .map((run, index) => ({ ...run, order: index + 1 }))
  return { tasks, infrastructureRuns, statisticalRuns }
}

function statisticalCells(runs) {
  const cells = new Map()
  for (const run of runs) {
    const key = `${run.suite}\0${run.taskId}\0${run.arm.id}`
    const cell = cells.get(key) ?? { suite: run.suite, taskId: run.taskId, armId: run.arm.id, repetitions: [] }
    cell.repetitions.push(run.repetition)
    cells.set(key, cell)
  }
  return [...cells.values()]
    .map(cell => ({ ...cell, repetitions: [...cell.repetitions].sort((left, right) => left - right) }))
    .sort((left, right) => `${left.suite}\0${left.taskId}\0${left.armId}`.localeCompare(`${right.suite}\0${right.taskId}\0${right.armId}`))
}

function assertUniqueRunIds(infrastructureRuns, statisticalRuns) {
  const all = [...infrastructureRuns, ...statisticalRuns]
  if (new Set(all.map(run => run.runId)).size !== all.length) throw new Error('base matrix runId values are not unique')
}

function assertMatrix(frozen, preregistration, benchmarkLock, simpleTasks) {
  if (frozen.schemaVersion !== 1 || frozen.status !== 'frozen-unexecuted') throw new Error('historical matrix source is not frozen')
  same(frozen.counts, EXPECTED_COUNTS, 'historical matrix counts')
  same(preregistration.randomization, EXPECTED_RANDOMIZATION, 'historical randomization')
  const expected = buildExpectedRuns(preregistration, benchmarkLock, simpleTasks)
  same(frozen.infrastructureRuns, expected.infrastructureRuns, 'historical infrastructure order')
  same(frozen.statisticalRuns, expected.statisticalRuns, 'historical statistical order')
  assertUniqueRunIds(frozen.infrastructureRuns, frozen.statisticalRuns)

  const cells = statisticalCells(frozen.statisticalRuns)
  if (cells.length !== 45) throw new Error(`expected 45 statistical cells, found ${cells.length}`)
  for (const cell of cells) {
    if (canonicalJson(cell.repetitions) !== canonicalJson([1, 2])) {
      throw new Error(`statistical cell does not have exactly two repetitions: ${cell.suite}/${cell.taskId}/${cell.armId}`)
    }
  }

  const suiteCounts = Object.fromEntries(['simple', 'icae', 'evocode'].map(suite => [suite, {
    tasks: new Set(frozen.statisticalRuns.filter(run => run.suite === suite).map(run => run.taskId)).size,
    runs: frozen.statisticalRuns.filter(run => run.suite === suite).length,
    arms: EXPECTED_ARMS[suite].map(arm => arm.id),
  }]))
  same(suiteCounts, {
    simple: { tasks: 6, runs: 36, arms: ['native', 'v0.3-always', 'v0.4-auto'] },
    icae: { tasks: 6, runs: 36, arms: ['native', 'v0.4-never', 'v0.4-critical'] },
    evocode: { tasks: 3, runs: 18, arms: ['native', 'v0.4-contract', 'v0.4-lattice'] },
  }, 'historical suite matrix')
  return { ...expected, cells, suiteCounts }
}

function driverSourceDigest(records) {
  const prefix = 'eval/v0.4/driver/'
  return sha256(records.filter(record => record.path.startsWith(prefix)).map(record => ({
    path: record.path.slice(prefix.length),
    digest: record.sha256,
  })))
}

function assertHistoricalSources({ preregistration, benchmarkLock, frozen, runtimeArtifacts }) {
  same(preregistration.retryPolicy, EXPECTED_RETRY_POLICY, 'historical retry policy')
  same(preregistration.releaseGates, EXPECTED_RELEASE_GATES, 'historical release gates')
  same(preregistration.model, EXPECTED_MODEL, 'historical model')
  same(preregistration.runtimePolicy, EXPECTED_RUNTIME_POLICY, 'historical runtime policy')
  same(preregistration.pluginCommits, {
    'v0.3.0': V03_COMMIT,
    'v0.4.0Candidate': RC3_CANDIDATE_COMMIT,
  }, 'historical plugin commits')
  const sourceCommits = Object.fromEntries(Object.entries(benchmarkLock.sources).map(([name, source]) => [name, source.commit]))
  same(sourceCommits, EXPECTED_SOURCE_COMMITS, 'historical source commits')
  same(frozen.sourceCommits, EXPECTED_SOURCE_COMMITS, 'historical manifest source commits')
  if (frozen.pluginCommits['v0.3.0'] !== V03_COMMIT || frozen.pluginCommits['v0.4.0Candidate'] !== RC3_CANDIDATE_COMMIT) {
    throw new Error('historical manifest plugin identity changed')
  }
  const hostRuntimeIdentity = { ...runtimeArtifacts.hostHarness, harnessCommit: sourceCommits.harness }
  same(hostRuntimeIdentity, EXPECTED_HOST_RUNTIME, 'historical host runtime identity')
  return { sourceCommits, hostRuntimeIdentity }
}

function assertKnownDigests(derived) {
  const expected = {
    reusableAssetCount: 37,
    reusableAssetsDigest: 'dc6d61f10262106619f61e3fe858a84c4cb0773df938d5d32d5d2abe5be408f3',
    driverSourceDigest: '969bad524607f4063d8d1cedcdb98ca973ac93a4aaa09823d14a08bc5b74889b',
    benchmarkLockDigest: '30b0eca7547e13a798131f20e17e4162b0107e45a5ba1b47ef2ed00a09c0bfc8',
    simpleTasksDigest: '0559abb25b0b0815120c15572edf7db1d518a9c146789245fc08514d21183ed9',
    matrixDigest: 'fef6a99d8b80f709e936fa0528b4f159186f09a7b9ef583a28ba5ec0aa2fe6b5',
    checksumsFileSha256: '952ac852a8aa4ce74b63fb2451fafca2fbccc148d1ab48f6473f3642fcbf55e4',
    manifestDigest: '94fb0fce13dba54f06a3b36f93167c4acd46a6953f7a66daae8567889a1d5426',
  }
  same({
    reusableAssetCount: derived.reusableAssets.fileCount,
    reusableAssetsDigest: derived.reusableAssets.pathContentDigest,
    driverSourceDigest: derived.reusableAssets.driverSourceDigest,
    benchmarkLockDigest: derived.semanticBindings.benchmarkLockSha256,
    simpleTasksDigest: derived.semanticBindings.simpleTasksSha256,
    matrixDigest: derived.matrix.fullRunsSha256,
    checksumsFileSha256: derived.reusableAssets.checksumsFileSha256,
    manifestDigest: derived.matrix.historicalManifestDigest,
  }, expected, 'known RC.3 base asset digests')
}

export function deriveBaseAssetsLock({ cwd = repositoryRoot } = {}) {
  const commit = git(['rev-parse', `${BASE_COMMIT}^{commit}`], { cwd }).trim()
  const tree = git(['rev-parse', `${BASE_COMMIT}^{tree}`], { cwd }).trim()
  if (commit !== BASE_COMMIT || tree !== BASE_TREE) throw new Error('exact RC.3 evaluation Git object is unavailable or changed')

  const reusableRecords = listTreeRecords(REUSABLE_ASSET_ROOTS, cwd).map(record => recordWithDigest(record, cwd))
  const preregistrationRecord = recordForPath(PREREGISTRATION_PATH, cwd)
  const runtimeArtifactsRecord = recordForPath(RUNTIME_ARTIFACTS_PATH, cwd)
  const benchmarkLock = gitJson('eval/v0.4/benchmark-lock.json', cwd)
  const simpleTasks = gitJson('eval/v0.4/simple-tasks.json', cwd)
  const preregistration = gitJson(PREREGISTRATION_PATH, cwd)
  const frozen = gitJson(FROZEN_MANIFEST_PATH, cwd)
  const runtimeArtifacts = gitJson(RUNTIME_ARTIFACTS_PATH, cwd)
  const matrix = assertMatrix(frozen, preregistration, benchmarkLock, simpleTasks)
  const historical = assertHistoricalSources({ preregistration, benchmarkLock, frozen, runtimeArtifacts })

  const manifestCore = structuredClone(frozen)
  delete manifestCore.manifestDigest
  if (sha256(manifestCore) !== frozen.manifestDigest) throw new Error('historical manifest self-digest is invalid')

  const lock = {
    schemaVersion: 1,
    lockId: LOCK_ID,
    source: {
      commit,
      tree,
      evaluationRoot: 'eval/v0.4',
      historicalManifestPath: FROZEN_MANIFEST_PATH,
      historicalManifestRole: 'matrix-source-only',
      explicitlyNotAnRc4ExecutionManifest: true,
    },
    reusableAssets: {
      roots: [...REUSABLE_ASSET_ROOTS],
      fileCount: reusableRecords.length,
      records: reusableRecords,
      pathContentDigest: sha256(`${reusableRecords.map(record => `${record.path}\0${record.sha256}`).join('\n')}\n`),
      recordsCanonicalSha256: sha256(reusableRecords),
      driverSourceDigest: driverSourceDigest(reusableRecords),
      checksumsFileSha256: recordForPath(CHECKSUMS_PATH, cwd).sha256,
    },
    policySources: {
      preregistration: preregistrationRecord,
      historicalRuntimeArtifacts: runtimeArtifactsRecord,
    },
    semanticBindings: {
      benchmarkLockSha256: sha256(benchmarkLock),
      simpleTasksSha256: sha256(simpleTasks),
      preregistrationSha256: sha256(preregistration),
      historicalRuntimeArtifactsSha256: sha256(runtimeArtifacts),
    },
    matrix: {
      counts: structuredClone(frozen.counts),
      randomization: structuredClone(preregistration.randomization),
      infrastructureRunIds: frozen.infrastructureRuns.map(run => run.runId),
      statisticalRunIds: frozen.statisticalRuns.map(run => run.runId),
      fullRunsSha256: sha256({
        infrastructureRuns: frozen.infrastructureRuns,
        statisticalRuns: frozen.statisticalRuns,
        counts: frozen.counts,
      }),
      historicalManifestDigest: frozen.manifestDigest,
      statisticalCellCount: matrix.cells.length,
      repetitionsPerStatisticalCell: [1, 2],
      suites: matrix.suiteCounts,
    },
    model: structuredClone(preregistration.model),
    runtimePolicy: structuredClone(preregistration.runtimePolicy),
    retryPolicy: structuredClone(preregistration.retryPolicy),
    releaseGates: structuredClone(preregistration.releaseGates),
    sourceCommits: historical.sourceCommits,
    pluginBindings: {
      'v0.3': {
        selector: 'v0.3.0',
        commit: V03_COMMIT,
        disposition: 'reuse-exact-commit',
      },
      'historicalV0.4Candidate': {
        selector: 'v0.4.0-candidate',
        commit: RC3_CANDIDATE_COMMIT,
        disposition: 'provenance-only-never-execute-for-rc4',
      },
      rc4Candidate: {
        selector: 'v0.4.0-candidate',
        commit: RC4_CANDIDATE_COMMIT,
        disposition: 'replace-every-controlled-arm-at-rc4-execution-freeze',
      },
    },
    candidateReplacement: {
      preserveExactly: ['phase', 'suite', 'taskId', 'taskLocator', 'arm.id', 'arm configuration', 'repetition', 'order', 'runId'],
      rules: [
        { pluginSelector: 'none', executionIdentity: 'native' },
        { pluginSelector: 'v0.3.0', executionIdentity: V03_COMMIT },
        { pluginSelector: 'v0.4.0-candidate', executionIdentity: RC4_CANDIDATE_COMMIT },
      ],
      forbiddenExecutionIdentity: RC3_CANDIDATE_COMMIT,
      executionManifestRequirement: 'construct a new RC.4 execution manifest after V14 passes; never execute frozen-manifest.json directly',
    },
    hostRuntimeIdentity: historical.hostRuntimeIdentity,
    reuseBoundary: {
      reusable: [
        'the exact 37 content-addressed driver, grader, library, schema, task, matrix, and checksum assets',
        'the exact 6+90 slot design and fixed randomized order',
        'the exact model, runtime, retry, integrity, simple, ICAE, and EvoCode policies',
        'the exact v0.3 baseline and benchmark source commits',
        'the host Harness runtime only when its bytes and identity match this lock',
      ],
      forbidden: [
        'using the RC.3 frozen manifest as the RC.4 execution manifest',
        'executing the RC.3 v0.4 candidate in any controlled RC.4 arm',
        'reusing RC.3 controlled runtime archives or their metadata as RC.4 artifacts',
        'reusing an RC.3 result ledger, attempt chain, result signature, or outcome',
        'changing tasks, graders, order, retries, gates, model, endpoint policy, or source commits after outcomes are visible',
      ],
    },
  }
  assertKnownDigests(lock)
  return lock
}

export function validateBaseAssetsLock(lock, { cwd = repositoryRoot } = {}) {
  if (lock?.schemaVersion !== 1 || lock.lockId !== LOCK_ID) throw new Error('invalid RC.4 base-assets lock identity')
  const cacheKey = resolve(cwd)
  let expected = derivedLockCache.get(cacheKey)
  if (!expected) {
    expected = deriveBaseAssetsLock({ cwd: cacheKey })
    derivedLockCache.set(cacheKey, expected)
  }
  same(lock, expected, 'RC.4 base-assets lock')
  return structuredClone(expected)
}

export async function loadAndVerifyBaseAssetsLock(
  path = resolve(here, 'base-assets.lock.json'),
  options = {},
) {
  const bytes = await readFile(path)
  const lock = JSON.parse(bytes)
  return { lock: validateBaseAssetsLock(lock, options), bytes, path }
}
