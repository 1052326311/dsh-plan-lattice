import { spawnSync } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import { verifyPublicFreezeAttestation } from './attestation.mjs'
import { resolveRuntimeArtifact } from '../../eval/v0.4/driver/lib/evocode.mjs'
import { requireProxyCapabilities } from '../../eval/v0.4/driver/lib/proxy-capability.mjs'
import { assertExactCheckout } from '../../eval/v0.4/driver/lib/runtime.mjs'
import { loadAndVerifyBaseAssetsLock } from './base-assets.mjs'
import {
  buildRouterEvidenceRecord,
  buildRuntimeArtifactsRecord,
  executionProtocolId,
  loadFrozenDesign,
  verifyExecutionEnvelope,
} from './design.mjs'
import { assertExecutionFreeze, studySourceDigest } from './integrity.mjs'
import {
  assertCandidateFreeze,
  assertStudyProtocolFreeze,
  loadStudySpec,
  repositoryRoot,
} from './protocol.mjs'
import {
  loadRuntimeAcquisitionLock,
  verifyRuntimeAcquisition,
} from './runtime-acquisition.mjs'
import { verifyV14EvidenceBundle } from './v14-evidence.mjs'

export const RC4_PREFLIGHT = Object.freeze({
  candidateCommit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
  runProtocol: executionProtocolId,
  resultProtocol: 'plan-lattice-rc4-preflight-v1',
})

function message(error) {
  return String(error?.message ?? error)
}

function same(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} changed`)
}

function git(args, { binary = false } = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed during RC.4 preflight`)
  return result.stdout
}

function readExecutionEnvelopeFromTag(studySpec) {
  const commit = git(['rev-parse', `${studySpec.executionFreeze.futurePublicRef}^{commit}`]).trim()
  const bytes = git(['show', `${commit}:${studySpec.executionFreeze.evidencePath}`], { binary: true })
  return { commit, bytes, envelope: JSON.parse(bytes.toString('utf8')) }
}

function executable(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return result.status === 0
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function validateRunSpec(spec, envelope, studySpec, executionFreezeCommit, frozenDesign) {
  if (spec?.schemaVersion !== 1 || spec.protocolId !== executionProtocolId) throw new Error('run spec is not RC.4')
  if (spec.candidateCommit !== studySpec.candidate.commit
    || spec.pluginCommits?.['v0.4.0Candidate'] !== studySpec.candidate.commit) {
    throw new Error('run spec does not use the frozen RC.4 candidate')
  }
  if (spec.manifestDigest !== envelope.runManifest.manifestDigest
    || spec.executionEnvelopeDigest !== envelope.envelopeDigest
    || spec.studyProtocolCommit !== envelope.studyProtocolCommit
    || spec.executionFreezeCommit !== executionFreezeCommit) {
    throw new Error('run spec does not match the public execution envelope')
  }
  same(spec.model, envelope.runManifest.model, 'run model')
  same(spec.runtimePolicy, envelope.runManifest.runtimePolicy, 'run runtime policy')
  same(spec.pluginCommits, envelope.runManifest.pluginCommits, 'run plugin commits')
  same(spec.sourceCommits, envelope.runManifest.sourceCommits, 'run source commits')
  same(spec.runtimeArtifacts, envelope.runtimeArtifacts, 'run runtime artifacts')
  same(spec.routerEvidence, envelope.routerEvidence, 'run V14 evidence')
  same(spec.benchmarkLock, frozenDesign.benchmarkLock, 'frozen benchmark lock')
  if (spec.sourceLockDigest !== envelope.runManifest.sourceLockDigest
    || spec.controllerSourceDigest !== envelope.controllerSourceDigest) {
    throw new Error('run spec source binding changed')
  }
  const allRuns = [...envelope.runManifest.infrastructureRuns, ...envelope.runManifest.statisticalRuns]
  const expectedRun = allRuns.find(run => run.runId === spec.run?.runId)
  if (!expectedRun) throw new Error('run ID is absent from the frozen 96-slot matrix')
  same(spec.run, expectedRun, 'run slot')
  if (expectedRun.suite === 'simple') {
    const expectedTask = frozenDesign.simpleTasks.tasks.find(task => task.id === expectedRun.taskId)
    same(spec.simpleTask, expectedTask, 'simple task prompt, fixture, and grader')
  } else if (spec.simpleTask !== undefined) {
    throw new Error('non-simple run must not carry a simple-task definition')
  }
  return expectedRun
}

async function validateBenchmarkRoots(spec) {
  const names = Object.keys(spec.sourceCommits).sort()
  if (canonicalJson(Object.keys(spec.benchmarkRoots ?? {}).sort()) !== canonicalJson(names)) {
    throw new Error('benchmark roots do not exactly cover the frozen source set')
  }
  for (const name of names) {
    const root = spec.benchmarkRoots[name]
    if (!isAbsolute(root ?? '')) throw new Error(`${name} benchmark root is not absolute`)
    const canonical = await realpath(root)
    if (canonical !== resolve(root)) throw new Error(`${name} benchmark root is a symlink or alias`)
    assertExactCheckout(canonical, spec.sourceCommits[name], name)
  }
  return names
}

async function validateSuiteAssets(spec) {
  if (spec.run.suite === 'icae') {
    const root = resolve(spec.benchmarkRoots.icae)
    for (const path of ['repo_alias.json', 'fuzzy_prds', 'rcb_tests_repos', 'realcode_repos', 'docker_lang_official']) {
      if (!(await exists(join(root, path)))) throw new Error(`ICAE asset is unavailable: ${path}`)
    }
  }
  if (spec.run.suite === 'evocode') {
    const task = join(spec.benchmarkRoots.evocode, 'data', 'EvoCodeBench', spec.run.taskLocator.harborTaskId, 'task.toml')
    if (!(await exists(task))) throw new Error(`EvoCode task is unavailable: ${task}`)
  }
  return spec.run.suite
}

function validateToolchain(spec) {
  for (const [name, command, args] of [
    ['node', process.execPath, ['--version']],
    ['pnpm', 'pnpm', ['--version']],
    ['git', 'git', ['--version']],
  ]) if (!executable(command, args)) throw new Error(`${name} is unavailable`)
  if (spec.run.suite !== 'simple' && !executable('docker')) throw new Error('docker is unavailable')
  if (spec.run.suite === 'evocode' && !executable('uv')) throw new Error('uv is unavailable')
  if (spec.run.suite === 'simple' && spec.simpleTask?.language === 'Go' && !executable('go', ['version'])) throw new Error('go is unavailable')
  if (spec.run.suite === 'simple' && spec.simpleTask?.language === 'Python' && !executable('python3')) throw new Error('python3 is unavailable')
  if ((spec.run.suite === 'simple' || spec.run.suite === 'icae')
    && (process.platform !== 'darwin'
      || !executable('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', process.execPath, '--version']))) {
    throw new Error('the frozen host Harness requires a working Darwin sandbox')
  }
  return process.version
}

async function verifyCurrentRuntime(spec, runtimeRoot) {
  if (spec.run.suite === 'simple' || spec.run.suite === 'icae') {
    const artifact = spec.runtimeArtifacts.hostHarness
    const path = process.env[artifact.pathEnvironmentVariable]
    if (!path || !(await exists(path))) throw new Error('frozen host Harness runtime is unavailable')
    if (sha256(await readFile(path)) !== artifact.sha256) throw new Error('frozen host Harness runtime digest changed')
    return { id: 'hostHarness', sha256: artifact.sha256 }
  }
  const runtime = await resolveRuntimeArtifact(spec)
  const { lock } = await loadRuntimeAcquisitionLock()
  const record = lock.artifacts[runtime.id]
  const expectedPath = resolve(runtimeRoot, record.directory, record.archive.file)
  const configuredPath = process.env[spec.runtimeArtifacts.artifacts[runtime.id].pathEnvironmentVariable]
  if (!configuredPath || await realpath(configuredPath) !== await realpath(expectedPath)) {
    throw new Error('configured Linux runtime is not the verified GitHub artifact')
  }
  return { id: runtime.id, sha256: runtime.digest, metadataDigest: sha256(runtime.metadata) }
}

async function verifyHostPlugins(runtimeArtifacts) {
  const verified = {}
  for (const [id, artifact] of Object.entries(runtimeArtifacts.hostPlugins)) {
    const path = process.env[artifact.pathEnvironmentVariable]
    if (!path || !(await exists(path))) throw new Error(`frozen host plugin is unavailable: ${id}`)
    if (await realpath(path) !== resolve(path)) throw new Error(`frozen host plugin path is a symlink or alias: ${id}`)
    const actual = sha256(await readFile(path))
    if (actual !== artifact.sha256) throw new Error(`frozen host plugin digest changed: ${id}`)
    verified[id] = actual
  }
  return verified
}

function productionDependencies(overrides = {}) {
  return {
    loadStudySpec,
    assertCandidateFreeze,
    assertStudyProtocolFreeze,
    readExecutionEnvelopeFromTag,
    verifyExecutionEnvelope,
    assertExecutionFreeze,
    loadAndVerifyBaseAssetsLock,
    verifyRuntimeAcquisition,
    verifyV14EvidenceBundle,
    buildRouterEvidenceRecord,
    buildRuntimeArtifactsRecord,
    loadFrozenDesign,
    studySourceDigest,
    validateBenchmarkRoots,
    validateSuiteAssets,
    validateToolchain,
    verifyCurrentRuntime,
    verifyHostPlugins,
    verifyPublicFreezeAttestation,
    requireProxyCapabilities,
    ...overrides,
  }
}

export async function preflight(spec, overrides = {}) {
  const deps = productionDependencies(overrides)
  const checks = []
  const check = async (name, operation) => {
    try {
      const detail = await operation()
      checks.push({ name, ok: true, detail: typeof detail === 'string' ? detail : sha256(detail) })
      return detail
    } catch (error) {
      checks.push({ name, ok: false, detail: message(error) })
      return undefined
    }
  }

  const loaded = await check('study-spec', () => deps.loadStudySpec())
  if (!loaded) return { schemaVersion: 1, protocol: RC4_PREFLIGHT.resultProtocol, ok: false, checks }
  const studySpec = loaded.spec
  const candidate = await check('candidate-freeze', () => deps.assertCandidateFreeze(studySpec))
  const studyFreeze = await check('study-protocol-freeze', () => deps.assertStudyProtocolFreeze(studySpec))
  const tagged = await check('execution-envelope-tag', () => deps.readExecutionEnvelopeFromTag(studySpec))
  const envelope = tagged && await check('execution-envelope', () => {
    deps.verifyExecutionEnvelope(tagged.envelope, studySpec)
    deps.assertExecutionFreeze(tagged.envelope, studySpec)
    if (canonicalJson(tagged.envelope) !== tagged.bytes.toString('utf8')) {
      throw new Error('execution envelope bytes are not canonical')
    }
    return tagged.envelope
  })
  const studyAttestation = studyFreeze && await check('study-public-attestation', () => deps.verifyPublicFreezeAttestation({
    kind: 'study',
    anchorPath: process.env.PLAN_LATTICE_RC4_STUDY_ANCHOR,
    bundlePath: process.env.PLAN_LATTICE_RC4_STUDY_ATTESTATION_BUNDLE,
  }))
  const executionAttestation = envelope && await check('execution-public-attestation', () => deps.verifyPublicFreezeAttestation({
    kind: 'execution',
    anchorPath: process.env.PLAN_LATTICE_RC4_EXECUTION_ANCHOR,
    bundlePath: process.env.PLAN_LATTICE_RC4_EXECUTION_ATTESTATION_BUNDLE,
  }))
  if (!candidate || !studyFreeze || !envelope || !studyAttestation || !executionAttestation) {
    return { schemaVersion: 1, protocol: RC4_PREFLIGHT.resultProtocol, ok: false, checks }
  }

  const frozenDesign = await check('frozen-task-and-grader-design', () => deps.loadFrozenDesign(studySpec))
  if (frozenDesign) await check('run-spec', () => validateRunSpec(spec, envelope, studySpec, tagged.commit, frozenDesign))
  await check('base-assets', () => deps.loadAndVerifyBaseAssetsLock())
  const source = await check('frozen-source', () => {
    const value = deps.studySourceDigest(studyFreeze.commit)
    if (value.digest !== envelope.controllerSourceDigest || value.digest !== envelope.driverSourceDigest) {
      throw new Error('study source differs from the execution envelope')
    }
    return value
  })
  const expectedRuntime = await check('runtime-lock', () => {
    const value = deps.buildRuntimeArtifactsRecord()
    same(value, envelope.runtimeArtifacts, 'runtime artifact record')
    return value
  })
  const runtimeRoot = process.env.PLAN_LATTICE_RC4_RUNTIME_ACQUISITION_ROOT
  const acquired = expectedRuntime && await check('runtime-acquisition', () => deps.verifyRuntimeAcquisition(runtimeRoot))
  if (expectedRuntime) await check('host-plugin-releases', () => deps.verifyHostPlugins(expectedRuntime))
  const v14Summary = await check('v14-independent-replay', () => deps.verifyV14EvidenceBundle({
    dataRoot: process.env.PLAN_LATTICE_V14_DATA_DIR,
    v13DataRoot: process.env.PLAN_LATTICE_V13_DATA_DIR,
    v13SourceRoot: process.env.PLAN_LATTICE_V13_SOURCE_ROOT,
    runtimeArtifactRoot: process.env.PLAN_LATTICE_V14_RUNTIME_ARTIFACT_ROOT,
  }))
  if (v14Summary) await check('v14-envelope-binding', () => {
    const record = deps.buildRouterEvidenceRecord(v14Summary)
    same(record, envelope.routerEvidence, 'V14 evidence record')
    return record
  })
  await check('benchmark-roots', () => deps.validateBenchmarkRoots(spec))
  await check('suite-assets', () => deps.validateSuiteAssets(spec))
  await check('toolchain', () => deps.validateToolchain(spec))
  if (acquired && runtimeRoot) await check('current-runtime', () => deps.verifyCurrentRuntime(spec, runtimeRoot))
  await check('credential-proxy', () => deps.requireProxyCapabilities(process.env, {
    oracle: spec.run.suite === 'icae',
    docker: spec.run.suite === 'evocode',
  }))
  if (!source) checks.push({ name: 'source-required', ok: false, detail: 'frozen source was unavailable' })

  return {
    schemaVersion: 1,
    protocol: RC4_PREFLIGHT.resultProtocol,
    ok: checks.every(entry => entry.ok),
    candidateCommit: studySpec.candidate.commit,
    executionEnvelopeDigest: envelope.envelopeDigest,
    checks,
  }
}
