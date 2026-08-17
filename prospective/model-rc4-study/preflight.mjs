import { spawnSync } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import { resolveRuntimeArtifact } from '../../eval/v0.4/driver/lib/evocode.mjs'
import { requireProxyCapabilities } from '../../eval/v0.4/driver/lib/proxy-capability.mjs'
import { assertExactCheckout } from '../../eval/v0.4/driver/lib/runtime.mjs'

const moduleRoot = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(moduleRoot, '..', '..')

export const RC4_PREFLIGHT = Object.freeze({
  candidateCommit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
  candidateRef: 'refs/tags/router-v14-rc4-candidate-freeze',
  studyProtocolRef: 'refs/tags/model-rc4-study-protocol-freeze',
  executionFreezeRef: 'refs/tags/model-rc4-execution-freeze',
  runtimeRunId: 31982987064,
  runProtocol: 'plan-lattice-rc4-run-v1',
  resultProtocol: 'plan-lattice-rc4-preflight-v1',
  baseAssetsProtocol: 'plan-lattice-rc4-base-assets-lock-v1',
  runtimeAcquisitionProtocol: 'plan-lattice-rc4-runtime-acquisition-lock-v1',
  executionManifestProtocol: 'plan-lattice-rc4-execution-manifest-v1',
  paths: Object.freeze({
    baseAssetsLock: 'prospective/model-rc4-study/base-assets.lock.json',
    runtimeAcquisitionLock: 'prospective/model-rc4-study/runtime-acquisition.lock.json',
    executionManifest: 'evidence/model-rc4-study/execution-manifest.json',
    v14Evidence: 'evidence/model-rc4-study/v14-evidence-lock.json',
  }),
  sourcePaths: Object.freeze({
    controller: 'prospective/model-rc4-study/controller.mjs',
    driver: 'prospective/model-rc4-study/driver.mjs',
    preflight: 'prospective/model-rc4-study/preflight.mjs',
  }),
})

const HEX_40 = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-f]{64}$/
const LEGACY_CANDIDATE = 'dc55716525987fcb7cb46579a9c957877cbd23c2'
const LEGACY_KEYS = new Set(['routerBlindResultDigest', 'preregistrationDigest'])
const LEGACY_PATHS = [
  'eval/v0.4/preregistration.json',
  'eval/v0.4/frozen-manifest.json',
  'eval/v0.4/runtime-artifacts.json',
  'eval/router-corpus/blind-real-results.json',
]

function message(error) {
  return String(error?.message ?? error)
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function exactString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function exactDigest(value, label) {
  if (!HEX_64.test(value ?? '')) throw new Error(`${label} must be an exact SHA256 digest`)
  return value
}

function same(left, right, label) {
  if (sha256(left) !== sha256(right)) throw new Error(`${label} does not match the RC.4 execution freeze`)
}

function scanLegacy(value, path = '$') {
  if (typeof value === 'string') {
    if (value === LEGACY_CANDIDATE) throw new Error(`${path} binds the retired RC.3 candidate`)
    if (LEGACY_PATHS.some(fragment => value.includes(fragment))) {
      throw new Error(`${path} points at a retired RC.3 evidence input`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanLegacy(entry, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (LEGACY_KEYS.has(key)) throw new Error(`${path}.${key} is a retired RC.3 field`)
    scanLegacy(entry, `${path}.${key}`)
  }
}

function validateRunSpec(spec) {
  exactObject(spec, 'run spec')
  scanLegacy(spec)
  if (spec.protocol !== RC4_PREFLIGHT.runProtocol) throw new Error('run spec is not the RC.4 study protocol')
  if (spec.candidateCommit !== RC4_PREFLIGHT.candidateCommit) throw new Error('run spec does not bind the frozen RC.4 candidate')
  if (spec.pluginCommits?.['v0.4.0Candidate'] !== RC4_PREFLIGHT.candidateCommit) {
    throw new Error('run spec plugin identity is not RC.4')
  }
  if (!['simple', 'icae', 'evocode'].includes(spec.run?.suite)) throw new Error('run spec suite is unsupported')
  exactString(spec.run?.runId, 'run id')
  exactObject(spec.rc4Bindings, 'RC.4 evidence bindings')
  for (const [name, path] of Object.entries(RC4_PREFLIGHT.paths)) {
    const binding = exactObject(spec.rc4Bindings[name], `${name} binding`)
    if (binding.path !== path) throw new Error(`${name} must use the dedicated RC.4 evidence path`)
    exactDigest(binding.sha256, `${name} binding`)
  }
  if (spec.rc4Bindings.executionFreezeRef !== RC4_PREFLIGHT.executionFreezeRef) {
    throw new Error('run spec does not bind the RC.4 execution freeze ref')
  }
  if (!HEX_40.test(spec.rc4Bindings.executionFreezeCommit ?? '')) {
    throw new Error('run spec does not bind an exact RC.4 execution freeze commit')
  }
  return spec
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function executable(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return result.status === 0
}

function git(args, options = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: options.binary ? undefined : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`)
  return result.stdout
}

function resolveRef(ref) {
  return String(git(['rev-parse', '--verify', `${ref}^{commit}`])).trim()
}

function readTaggedFile(commit, path) {
  return git(['show', `${commit}:${path}`], { binary: true })
}

async function defaultLoadArtifact(path) {
  const absolute = resolve(repositoryRoot, path)
  if (relative(repositoryRoot, absolute).startsWith('..')) throw new Error('RC.4 artifact path escapes the repository')
  const bytes = await readFile(absolute)
  return { bytes, value: JSON.parse(bytes.toString('utf8')) }
}

async function defaultReadSource(path) {
  return readFile(resolve(repositoryRoot, path))
}

async function defaultVerifyV14EvidenceBundle(bundle, context) {
  let verifier
  try {
    verifier = await import('./v14-evidence.mjs')
  } catch (error) {
    throw new Error(`RC.4 V14 evidence verifier is unavailable: ${message(error)}`)
  }
  if (typeof verifier.verifyV14EvidenceBundle !== 'function') {
    throw new Error('RC.4 V14 evidence verifier does not export verifyV14EvidenceBundle')
  }
  return verifier.verifyV14EvidenceBundle(bundle, context)
}

async function defaultVerifyCurrentRuntimeArtifact({ spec, env }) {
  if (spec.run.suite === 'simple' || spec.run.suite === 'icae') {
    const artifact = spec.runtimeArtifacts?.hostHarness
    const variable = artifact?.pathEnvironmentVariable
    const path = variable ? env[variable] : undefined
    if (!path || !(await fileExists(resolve(path)))) throw new Error('frozen host Harness runtime is unavailable')
    const digest = sha256(await readFile(resolve(path)))
    if (digest !== artifact.sha256) throw new Error('host Harness runtime digest does not match the RC.4 acquisition lock')
    return { id: 'hostHarness', digest }
  }
  // The reused EvoCode identity verifier intentionally reads process.env. The
  // production driver passes that exact object; tests inject the verifier.
  if (env !== process.env) throw new Error('EvoCode runtime identity requires the real isolated process environment')
  const runtime = await resolveRuntimeArtifact(spec)
  return { id: runtime.id, digest: runtime.digest, metadataDigest: sha256(runtime.metadata) }
}

function normalizeArtifactPayload(payload, label) {
  exactObject(payload, `${label} payload`)
  const bytes = Buffer.isBuffer(payload.bytes) ? payload.bytes : Buffer.from(payload.bytes ?? '')
  if (bytes.length === 0) throw new Error(`${label} loader returned no exact bytes`)
  return { bytes, value: payload.value ?? JSON.parse(bytes.toString('utf8')) }
}

async function loadBoundArtifact(spec, name, deps) {
  const binding = spec.rc4Bindings[name]
  const payload = normalizeArtifactPayload(await deps.loadArtifact(binding.path), name)
  if (sha256(payload.bytes) !== binding.sha256) throw new Error(`${name} bytes do not match the run spec`)
  return payload
}

function validateBaseAssetsLock(lock) {
  exactObject(lock, 'base-assets lock')
  scanLegacy(lock)
  if (lock.schemaVersion !== 1 || lock.protocol !== RC4_PREFLIGHT.baseAssetsProtocol) {
    throw new Error('base-assets lock is not the RC.4 protocol')
  }
  exactObject(lock.sourceCommits, 'base-assets source commits')
  for (const [name, commit] of Object.entries(lock.sourceCommits)) {
    if (!HEX_40.test(commit)) throw new Error(`base-assets ${name} commit is not exact`)
  }
  if (!HEX_40.test(lock.pluginCommits?.['v0.3.0'] ?? '')) throw new Error('base-assets lock omits the v0.3 comparison commit')
  exactDigest(lock.matrixDigest, 'base-assets matrix digest')
  return lock
}

function validateRuntimeAcquisitionLock(lock) {
  exactObject(lock, 'runtime acquisition lock')
  scanLegacy(lock)
  if (lock.schemaVersion !== 1 || lock.protocol !== RC4_PREFLIGHT.runtimeAcquisitionProtocol) {
    throw new Error('runtime acquisition lock is not the RC.4 protocol')
  }
  if (lock.candidateCommit !== RC4_PREFLIGHT.candidateCommit || lock.githubRunId !== RC4_PREFLIGHT.runtimeRunId) {
    throw new Error('runtime acquisition lock does not bind the first RC.4 build')
  }
  exactDigest(lock.runtimeArtifactsDigest, 'runtime acquisition artifact digest')
  const artifacts = exactObject(lock.artifacts, 'runtime acquisition artifacts')
  for (const id of ['native', 'v0.4-contract', 'v0.4-lattice']) {
    const artifact = exactObject(artifacts[id], `runtime artifact ${id}`)
    exactDigest(artifact.sha256, `${id} archive`)
    exactDigest(artifact.metadataDigest, `${id} metadata`)
    const expectedPlugin = id === 'native' ? null : RC4_PREFLIGHT.candidateCommit
    if ((artifact.pluginCommit ?? null) !== expectedPlugin) throw new Error(`${id} runtime has the wrong plugin identity`)
  }
  const host = exactObject(lock.hostHarness, 'host Harness runtime')
  exactDigest(host.sha256, 'host Harness runtime')
  return lock
}

function validateExecutionManifest(manifest) {
  exactObject(manifest, 'execution manifest')
  scanLegacy(manifest)
  if (manifest.schemaVersion !== 1 || manifest.protocol !== RC4_PREFLIGHT.executionManifestProtocol) {
    throw new Error('execution manifest is not the RC.4 protocol')
  }
  if (manifest.candidateCommit !== RC4_PREFLIGHT.candidateCommit) throw new Error('execution manifest candidate is not RC.4')
  if (manifest.executionFreeze?.ref !== RC4_PREFLIGHT.executionFreezeRef || !HEX_40.test(manifest.executionFreeze?.commit ?? '')) {
    throw new Error('execution manifest does not bind the public execution freeze')
  }
  if (manifest.studyProtocolFreeze?.ref !== RC4_PREFLIGHT.studyProtocolRef || !HEX_40.test(manifest.studyProtocolFreeze?.commit ?? '')) {
    throw new Error('execution manifest does not bind the public study protocol freeze')
  }
  exactObject(manifest.bindings, 'execution manifest bindings')
  exactObject(manifest.sourceBindings, 'execution manifest source bindings')
  exactObject(manifest.benchmarkRoots, 'execution manifest benchmark roots')
  exactObject(manifest.sourceCommits, 'execution manifest source commits')
  exactObject(manifest.runtimeArtifacts, 'execution manifest runtime artifacts')
  if (!Array.isArray(manifest.runs) || manifest.runs.length !== 96) throw new Error('execution manifest must bind all 96 frozen slots')
  return manifest
}

function assertArtifactLockMatchesRuntime(lock, runtimeArtifacts) {
  if (runtimeArtifacts?.status !== 'frozen') throw new Error('RC.4 runtime artifacts are not frozen')
  if (sha256(runtimeArtifacts) !== lock.runtimeArtifactsDigest) throw new Error('runtime artifacts do not match the acquisition lock')
  if (runtimeArtifacts.hostHarness?.sha256 !== lock.hostHarness.sha256) throw new Error('host Harness identity changed after acquisition')
  for (const id of ['native', 'v0.4-contract', 'v0.4-lattice']) {
    const left = runtimeArtifacts.artifacts?.[id]
    const right = lock.artifacts[id]
    if (left?.sha256 !== right.sha256 || left?.metadataDigest !== right.metadataDigest) {
      throw new Error(`${id} runtime identity changed after acquisition`)
    }
  }
}

async function validateSourceBindings(spec, manifest, deps) {
  const actual = {}
  for (const [name, path] of Object.entries(RC4_PREFLIGHT.sourcePaths)) {
    const binding = exactObject(manifest.sourceBindings[name], `${name} source binding`)
    if (binding.path !== path) throw new Error(`${name} source path changed after execution freeze`)
    exactDigest(binding.sha256, `${name} source`)
    const bytes = await deps.readSource(path)
    const digest = sha256(bytes)
    if (digest !== binding.sha256) throw new Error(`${name} source bytes changed after execution freeze`)
    const taggedDigest = sha256(deps.readTaggedFile(manifest.executionFreeze.commit, path))
    if (taggedDigest !== digest) throw new Error(`${name} source is not contained in the execution freeze tag`)
    if (spec.expectedProvenance?.[`${name}SourceDigest`] !== digest) {
      throw new Error(`${name} source is not bound by the run spec`)
    }
    actual[name] = digest
  }
  const bundleDigest = sha256(actual)
  if (manifest.sourceBundleDigest !== bundleDigest || spec.expectedProvenance?.sourceBundleDigest !== bundleDigest) {
    throw new Error('controller and driver source bundle is not bound by the execution freeze')
  }
  return { ...actual, bundleDigest }
}

async function validateBenchmarkRoots(spec, baseAssets, manifest, deps) {
  same(spec.sourceCommits, baseAssets.sourceCommits, 'run source commits')
  same(manifest.sourceCommits, baseAssets.sourceCommits, 'execution source commits')
  same(spec.benchmarkRoots, manifest.benchmarkRoots, 'benchmark roots')
  const names = Object.keys(baseAssets.sourceCommits).sort()
  if (sha256(Object.keys(spec.benchmarkRoots ?? {}).sort()) !== sha256(names)) {
    throw new Error('benchmark roots do not exactly cover the frozen source set')
  }
  for (const name of names) {
    const root = spec.benchmarkRoots[name]
    if (!isAbsolute(root)) throw new Error(`${name} benchmark root is not absolute`)
    const canonical = await deps.realpath(root)
    if (canonical !== resolve(root)) throw new Error(`${name} benchmark root is a symlink or alias`)
    deps.assertExactCheckout(canonical, baseAssets.sourceCommits[name], name)
  }
  return names
}

async function validateSuiteAssets(spec, deps) {
  if (spec.run.suite === 'icae') {
    const root = resolve(spec.benchmarkRoots.icae)
    for (const path of ['repo_alias.json', 'fuzzy_prds', 'rcb_tests_repos', 'realcode_repos', 'docker_lang_official']) {
      if (!(await deps.exists(join(root, path)))) throw new Error(`ICAE asset is unavailable: ${path}`)
    }
  }
  if (spec.run.suite === 'evocode') {
    const task = join(resolve(spec.benchmarkRoots.evocode), 'data', 'EvoCodeBench', spec.run.taskLocator.harborTaskId, 'task.toml')
    if (!(await deps.exists(task))) throw new Error('EvoCode task assets are unavailable')
  }
}

function validateToolchain(spec, deps) {
  for (const [name, command, args] of [
    ['node', process.execPath, ['--version']],
    ['pnpm', 'pnpm', ['--version']],
    ['git', 'git', ['--version']],
  ]) {
    if (!deps.executable(command, args)) throw new Error(`${name} is unavailable`)
  }
  if (spec.run.suite !== 'simple' && !deps.executable('docker')) throw new Error('docker is unavailable')
  if (spec.run.suite === 'evocode' && !deps.executable('uv')) throw new Error('uv is unavailable')
  if (spec.run.suite === 'simple' && spec.simpleTask?.language === 'Go' && !deps.executable('go', ['version'])) throw new Error('go is unavailable')
  if (spec.run.suite === 'simple' && spec.simpleTask?.language === 'Python' && !deps.executable('python3')) throw new Error('python3 is unavailable')
  if ((spec.run.suite === 'simple' || spec.run.suite === 'icae')
    && (deps.platform !== 'darwin' || !deps.executable('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', process.execPath, '--version']))) {
    throw new Error('the frozen host Harness requires a working Darwin sandbox')
  }
}

function dependencies(options = {}) {
  return {
    repositoryRoot,
    platform: process.platform,
    env: process.env,
    loadArtifact: defaultLoadArtifact,
    readSource: defaultReadSource,
    resolveRef,
    readTaggedFile,
    verifyV14EvidenceBundle: defaultVerifyV14EvidenceBundle,
    verifyCurrentRuntimeArtifact: defaultVerifyCurrentRuntimeArtifact,
    assertExactCheckout,
    requireProxyCapabilities,
    realpath,
    exists: fileExists,
    executable,
    ...options,
  }
}

export async function preflight(spec, options = {}) {
  const deps = dependencies(options)
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const check = async (name, operation) => {
    try {
      const detail = await operation()
      add(name, true, detail ?? 'verified')
      return detail
    } catch (error) {
      add(name, false, message(error))
      return undefined
    }
  }

  const validated = await check('rc4-run-spec', () => validateRunSpec(spec))
  if (!validated) return { schemaVersion: 1, protocol: RC4_PREFLIGHT.resultProtocol, ok: false, checks }

  const candidate = await check('rc4-candidate-freeze', () => {
    const commit = deps.resolveRef(RC4_PREFLIGHT.candidateRef)
    if (commit !== RC4_PREFLIGHT.candidateCommit) throw new Error('RC.4 candidate ref moved')
    return commit
  })

  const basePayload = await check('base-assets-lock-bytes', () => loadBoundArtifact(spec, 'baseAssetsLock', deps))
  const runtimePayload = await check('runtime-acquisition-lock-bytes', () => loadBoundArtifact(spec, 'runtimeAcquisitionLock', deps))
  const manifestPayload = await check('execution-manifest-bytes', () => loadBoundArtifact(spec, 'executionManifest', deps))
  const v14Payload = await check('v14-evidence-bytes', () => loadBoundArtifact(spec, 'v14Evidence', deps))

  const baseAssets = basePayload && await check('base-assets-lock', () => validateBaseAssetsLock(basePayload.value))
  const runtimeLock = runtimePayload && await check('runtime-acquisition-lock', () => validateRuntimeAcquisitionLock(runtimePayload.value))
  const manifest = manifestPayload && await check('execution-manifest', () => validateExecutionManifest(manifestPayload.value))

  if (manifest) {
    await check('study-protocol-freeze', () => {
      const commit = deps.resolveRef(RC4_PREFLIGHT.studyProtocolRef)
      if (commit !== manifest.studyProtocolFreeze.commit) throw new Error('study protocol freeze ref moved')
      for (const name of ['baseAssetsLock', 'runtimeAcquisitionLock']) {
        const taggedBytes = deps.readTaggedFile(commit, RC4_PREFLIGHT.paths[name])
        if (sha256(taggedBytes) !== spec.rc4Bindings[name].sha256) {
          throw new Error(`${name} is not contained in the study protocol freeze tag`)
        }
      }
      return commit
    })
    await check('execution-freeze-tag', () => {
      const commit = deps.resolveRef(RC4_PREFLIGHT.executionFreezeRef)
      if (commit !== manifest.executionFreeze.commit || commit !== spec.rc4Bindings.executionFreezeCommit) {
        throw new Error('execution freeze ref does not match the run spec and manifest')
      }
      const taggedBytes = deps.readTaggedFile(commit, RC4_PREFLIGHT.paths.executionManifest)
      if (sha256(taggedBytes) !== spec.rc4Bindings.executionManifest.sha256) {
        throw new Error('execution tag does not contain the exact execution manifest')
      }
      return commit
    })
  }

  if (manifest && basePayload && runtimePayload && v14Payload) {
    await check('execution-evidence-bindings', () => {
      const expected = {
        baseAssetsLockSha256: basePayload && sha256(basePayload.bytes),
        runtimeAcquisitionLockSha256: runtimePayload && sha256(runtimePayload.bytes),
        v14EvidenceSha256: v14Payload && sha256(v14Payload.bytes),
      }
      same(manifest.bindings, expected, 'execution evidence bindings')
      same(spec.expectedProvenance, {
        ...spec.expectedProvenance,
        baseAssetsLockDigest: expected.baseAssetsLockSha256,
        runtimeAcquisitionLockDigest: expected.runtimeAcquisitionLockSha256,
        executionManifestDigest: sha256(manifestPayload.bytes),
        v14EvidenceDigest: expected.v14EvidenceSha256,
      }, 'run evidence provenance')
      for (const [name, digest] of Object.entries({
        baseAssetsLockDigest: expected.baseAssetsLockSha256,
        runtimeAcquisitionLockDigest: expected.runtimeAcquisitionLockSha256,
        executionManifestDigest: sha256(manifestPayload.bytes),
        v14EvidenceDigest: expected.v14EvidenceSha256,
      })) {
        if (spec.expectedProvenance?.[name] !== digest) throw new Error(`${name} is not bound by the run spec`)
      }
      return expected
    })
  }

  if (v14Payload && manifest) {
    await check('v14-evidence-release-gate', async () => {
      const result = await deps.verifyV14EvidenceBundle(v14Payload.value, {
        candidateCommit: RC4_PREFLIGHT.candidateCommit,
        executionManifest: manifest,
      })
      if (result?.candidateCommit !== RC4_PREFLIGHT.candidateCommit
        || result.releaseGatePassed !== true
        || result.immutable !== true) {
        throw new Error('V14 evidence is missing, mutable, or did not pass its preregistered gate')
      }
      return `${result.candidateCommit}:${result.releaseGatePassed}`
    })
  }

  if (manifest) {
    await check('run-slot-binding', () => {
      const slot = manifest.runs.find(run => run.runId === spec.run.runId)
      if (!slot) throw new Error('run ID is absent from the 96-slot execution manifest')
      same(spec.run, slot, 'run slot')
      return spec.run.runId
    })
    await check('controller-driver-source-binding', () => validateSourceBindings(spec, manifest, deps))
  }

  if (baseAssets && manifest) {
    await check('exact-benchmark-roots', () => validateBenchmarkRoots(spec, baseAssets, manifest, deps))
  }

  if (runtimeLock && manifest) {
    await check('runtime-artifact-lock-binding', () => {
      same(spec.runtimeArtifacts, manifest.runtimeArtifacts, 'run runtime artifacts')
      assertArtifactLockMatchesRuntime(runtimeLock, spec.runtimeArtifacts)
      if (spec.expectedProvenance?.runtimeArtifactsDigest !== runtimeLock.runtimeArtifactsDigest) {
        throw new Error('runtime artifact lock is not bound by the run spec')
      }
      return runtimeLock.runtimeArtifactsDigest
    })
    await check('current-runtime-artifact-identity', () => deps.verifyCurrentRuntimeArtifact({ spec, runtimeLock, env: deps.env }))
  }

  await check('toolchain', () => validateToolchain(spec, deps))
  await check('suite-assets', () => validateSuiteAssets(spec, deps))
  await check('credential-proxy', () => {
    const proxy = deps.requireProxyCapabilities(deps.env, {
      oracle: spec.run.suite === 'icae',
      docker: spec.run.suite === 'evocode',
    })
    return proxy.hostBaseURL
  })

  return {
    schemaVersion: 1,
    protocol: RC4_PREFLIGHT.resultProtocol,
    ok: checks.every(entry => entry.ok),
    candidateCommit: candidate,
    executionManifestDigest: spec.rc4Bindings.executionManifest.sha256,
    checks,
  }
}
