import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '../..')
export const protocolId = 'plan-lattice-rc4-model-study-v2'
export const studyProtectedPaths = Object.freeze([
  '.github/workflows/attest-rc4-freezes.yml',
  'prospective/model-rc4-study',
  ':(glob)test/model-rc4-*.test.ts',
  'eval/v0.4/driver',
  'eval/v0.4/lib',
  'eval/v0.4/schemas',
  'eval/v0.4/benchmark-lock.json',
  'eval/v0.4/simple-tasks.json',
  'eval/v0.4/frozen-manifest.json',
  'eval/v0.4/checksums.sha256',
])

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

function same(actual, expected, context) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`${context} changed`)
  }
}

function semanticDigest(value) {
  return sha256(`${JSON.stringify(canonical(value), null, 2)}\n`)
}

function exactDigest(value, length, context) {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value ?? '')) throw new Error(`${context} is invalid`)
  return value
}

function git(args, { binary = false } = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`)
  return result.stdout
}

function resolveCommit(ref, context) {
  return exactDigest(git(['rev-parse', `${ref}^{commit}`]).trim(), 40, context)
}

function resolveTree(commit, context) {
  return exactDigest(git(['rev-parse', `${commit}^{tree}`]).trim(), 40, context)
}

const expectedModel = {
  provider: 'DeepSeek',
  modelId: 'deepseek-v4-flash',
  temperature: 0,
  maxOutputTokens: 32768,
  timeoutMs: 3600000,
  budgetPolicy: 'identical endpoint, model, token ceiling, timeout, and tool permissions for every paired arm',
}

const expectedReleaseGates = {
  simple: {
    scoreNonInferiorityMarginPoints: 2,
    maximumAddedModelTurns: 0,
    medianTokenOverheadMaximum: 0.05,
    p95TokenOverheadMaximum: 0.1,
    medianDurationOverheadMaximum: 0.05,
    p95DurationOverheadMaximum: 0.1,
  },
  icae: {
    minimumRelativeHiddenFeatureScore: 1.5,
    minimumAbsoluteHiddenFeaturePointGain: 15,
    minimumCriticalRequirementMissReduction: 0.5,
    pairedBootstrapConfidence: 0.95,
    pairedBootstrapLowerBoundMustExceed: 0,
    bootstrapSamples: 20000,
  },
  evocode: {
    minimumHistoricalRequirementRegressionReduction: 0.5,
    cumulativeCaseScoreMustBeHigher: true,
    pairedBootstrapConfidence: 0.95,
    pairedBootstrapLowerBoundMustExceed: 0,
    bootstrapSamples: 20000,
    medianClarificationQuestionsMaximum: 3,
    perTaskClarificationQuestionsMaximum: 5,
  },
}

export function validateStudySpec(spec) {
  if (spec?.schemaVersion !== 1 || spec.protocol !== protocolId) throw new Error('invalid RC.4 model study identity')
  if (spec.registeredAt !== '2026-08-17T02:22:32Z') throw new Error('RC.4 model study registration time changed')
  same(spec.studyProtocolFreeze, {
    publicRef: 'refs/tags/model-rc4-study-protocol-freeze-v2',
    predecessorRef: 'refs/tags/model-rc4-study-protocol-freeze',
    predecessorStatus: 'retired-before-model-execution: unsupported ls-tree pathspec prevented public attestation',
    binding: 'the complete protected Git tree reached by the public tag',
    postFreezeChanges: 'retire-the-study-name',
  }, 'RC.4 study protocol freeze')
  same(spec.candidate, {
    publicRef: 'refs/tags/router-v14-rc4-candidate-freeze',
    commit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
    tree: '10970e580c45891ffd8bbfe395ac920401f65799',
    version: '0.4.0-rc.4',
    releaseTarballSha256: '2619f2c750973dd868ae6467e2ea03f223041ac4ec043478d2e7760afcbb8c02',
  }, 'RC.4 study candidate')
  const base = spec.evaluationBase
  if (base?.commit !== '0414dfa5035e6ca5cdc511964883b64be62ad44e'
    || base.tree !== '88fb3e67ac48f3659ee6b5f482ec080a8b63ae00'
    || base.fileCount !== 37
    || base.assetDigest !== 'dc6d61f10262106619f61e3fe858a84c4cb0773df938d5d32d5d2abe5be408f3'
    || base.driverSourceDigest !== '969bad524607f4063d8d1cedcdb98ca973ac93a4aaa09823d14a08bc5b74889b'
    || base.benchmarkLockDigest !== '30b0eca7547e13a798131f20e17e4162b0107e45a5ba1b47ef2ed00a09c0bfc8'
    || base.simpleTasksDigest !== '0559abb25b0b0815120c15572edf7db1d518a9c146789245fc08514d21183ed9'
    || base.matrixDigest !== 'fef6a99d8b80f709e936fa0528b4f159186f09a7b9ef583a28ba5ec0aa2fe6b5'
    || base.historicalProtocolChecksumsFileDigest !== '952ac852a8aa4ce74b63fb2451fafca2fbccc148d1ab48f6473f3642fcbf55e4') {
    throw new Error('RC.4 evaluation base changed')
  }
  same(base.assetRoots, [
    'eval/v0.4/driver',
    'eval/v0.4/lib',
    'eval/v0.4/schemas',
    'eval/v0.4/benchmark-lock.json',
    'eval/v0.4/simple-tasks.json',
    'eval/v0.4/frozen-manifest.json',
    'eval/v0.4/checksums.sha256',
  ], 'RC.4 evaluation asset roots')
  const runtime = spec.runtimeBuild
  if (runtime?.workflowPath !== '.github/workflows/freeze-eval-runtimes.yml'
    || runtime.workflowCommit !== 'e4d6af700de7ddf870bbba96f76e8f3b5d73fe8e'
    || runtime.workflowSha256 !== 'e19cb4b865214f6eaad85cb8298809869b2bf322690c597b71905d0217807ced'
    || runtime.githubRunId !== 31982987064
    || runtime.candidateInput !== spec.candidate.commit
    || runtime.harnessCommit !== '47f943859bef60e4160492346772ded9b24f765a'
    || runtime.requiredBaseImage !== 'node:22.23.0-bookworm@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a'
    || runtime.acceptOnlyThisFirstRun !== true) {
    throw new Error('RC.4 runtime build commitment changed')
  }
  same(runtime.expectedArtifactNames, [
    `plan-lattice-linux-native-arm64-${spec.candidate.commit}`,
    `plan-lattice-linux-v0.4-contract-arm64-${spec.candidate.commit}`,
    `plan-lattice-linux-v0.4-lattice-arm64-${spec.candidate.commit}`,
  ], 'RC.4 runtime artifact names')
  same(spec.routerGate, {
    protocol: 'observable-authorization-v14-rc4-shared-v13-corpus',
    protocolFreezeRef: 'refs/tags/router-v14-protocol-freeze',
    protocolFreezeCommit: '8f9bcab558609759ed978daa24f163606aad565f',
    candidateCommit: spec.candidate.commit,
    requiredEvidenceStatus: 'immutable-first-candidate-reveal',
    releaseGateMustPass: true,
    v13AndV14OutcomesMustRemainPublic: true,
  }, 'RC.4 router gate')
  same(spec.model, expectedModel, 'RC.4 study model')
  if (spec.design?.infrastructureRuns !== 6 || spec.design.statisticalRuns !== 90
    || spec.design.reuseExactFrozenTaskSelection !== true
    || spec.design.reuseExactFrozenRunOrder !== true
    || spec.design.noOutcomeDependentTaskOrGraderChanges !== true) {
    throw new Error('RC.4 study design changed')
  }
  same(spec.releaseGates, expectedReleaseGates, 'RC.4 release gates')
  if (spec.executionFreeze?.futurePublicRef !== 'refs/tags/model-rc4-execution-freeze'
    || spec.executionFreeze.evidencePath !== 'evidence/model-rc4-study/execution-envelope.json'
    || spec.executionFreeze.mayBeCreatedOnlyAfterV14Passes !== true
    || !Array.isArray(spec.executionFreeze.requiredBindings)
    || spec.executionFreeze.requiredBindings.length !== 5) {
    throw new Error('RC.4 execution freeze contract changed')
  }
  if (Object.values(spec.reportingPolicy ?? {}).some(value => value !== true)
    || Object.keys(spec.reportingPolicy ?? {}).length !== 5) {
    throw new Error('RC.4 reporting policy changed')
  }
  return spec
}

export async function loadStudySpec(path = resolve(here, 'study-spec.json')) {
  const bytes = await readFile(path)
  return { spec: validateStudySpec(JSON.parse(bytes)), bytes, path }
}

export function assertCandidateFreeze(spec) {
  const commit = resolveCommit(spec.candidate.publicRef, 'RC.4 candidate tag')
  const tree = resolveTree(commit, 'RC.4 candidate tree')
  if (commit !== spec.candidate.commit || tree !== spec.candidate.tree) throw new Error('RC.4 candidate tag changed')
  return { commit, tree }
}

export function assertEvaluationBase(spec) {
  const commit = resolveCommit(spec.evaluationBase.commit, 'RC.4 evaluation base')
  const tree = resolveTree(commit, 'RC.4 evaluation base tree')
  if (tree !== spec.evaluationBase.tree) throw new Error('RC.4 evaluation base tree changed')
  const names = git(['ls-tree', '-r', '--name-only', commit, '--', ...spec.evaluationBase.assetRoots])
    .trim().split('\n').filter(Boolean).sort()
  const records = names.map(path => `${path}\0${sha256(git(['show', `${commit}:${path}`], { binary: true }))}`)
  const assetDigest = sha256(`${records.join('\n')}\n`)
  if (names.length !== spec.evaluationBase.fileCount || assetDigest !== spec.evaluationBase.assetDigest) {
    throw new Error('RC.4 evaluation assets changed')
  }
  const benchmarkLock = JSON.parse(git(['show', `${commit}:eval/v0.4/benchmark-lock.json`]))
  const simpleTasks = JSON.parse(git(['show', `${commit}:eval/v0.4/simple-tasks.json`]))
  const frozen = JSON.parse(git(['show', `${commit}:eval/v0.4/frozen-manifest.json`]))
  const checksums = git(['show', `${commit}:eval/v0.4/checksums.sha256`], { binary: true })
  const matrixDigest = semanticDigest({
    infrastructureRuns: frozen.infrastructureRuns,
    statisticalRuns: frozen.statisticalRuns,
    counts: frozen.counts,
  })
  if (semanticDigest(benchmarkLock) !== spec.evaluationBase.benchmarkLockDigest
    || semanticDigest(simpleTasks) !== spec.evaluationBase.simpleTasksDigest
    || matrixDigest !== spec.evaluationBase.matrixDigest
    || sha256(checksums) !== spec.evaluationBase.historicalProtocolChecksumsFileDigest) {
    throw new Error('RC.4 evaluation semantic bindings changed')
  }
  return { commit, tree, fileCount: names.length, assetDigest, matrixDigest }
}

export function assertRuntimeWorkflowFreeze(spec) {
  const commit = resolveCommit(spec.runtimeBuild.workflowCommit, 'RC.4 runtime workflow commit')
  const body = git(['show', `${commit}:${spec.runtimeBuild.workflowPath}`], { binary: true })
  if (sha256(body) !== spec.runtimeBuild.workflowSha256) throw new Error('RC.4 runtime workflow changed')
  return { commit, sha256: spec.runtimeBuild.workflowSha256, runId: spec.runtimeBuild.githubRunId }
}

export function assertRouterProtocolFreeze(spec) {
  const commit = resolveCommit(spec.routerGate.protocolFreezeRef, 'RC.4 router protocol tag')
  if (commit !== spec.routerGate.protocolFreezeCommit) throw new Error('RC.4 router protocol tag changed')
  return { commit }
}

export function assertStudyProtocolFreeze(spec) {
  const commit = resolveCommit(spec.studyProtocolFreeze.publicRef, 'RC.4 model study protocol tag')
  const changed = spawnSync('git', ['-C', repositoryRoot, 'diff', '--quiet', commit, '--', ...studyProtectedPaths])
  if (changed.status !== 0) throw new Error('RC.4 model study changed after its public freeze')
  const untracked = spawnSync('git', ['-C', repositoryRoot, 'ls-files', '--others', '--exclude-standard', '--', ...studyProtectedPaths], { encoding: 'utf8' })
  if (untracked.status !== 0 || untracked.stdout.trim() !== '') throw new Error('RC.4 model study has untracked protected files')
  return { commit, ref: spec.studyProtocolFreeze.publicRef }
}
