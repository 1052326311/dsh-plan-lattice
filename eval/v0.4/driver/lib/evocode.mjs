import { spawnSync } from 'node:child_process'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../lib/canonical.mjs'
import { withoutEvaluationCapabilities } from './environment.mjs'
import { requireProxyCapabilities } from './proxy-capability.mjs'
import { digestTree, sanitized } from './runtime.mjs'

const driverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CASE_RE = /CASE_RESULT\s+case_id=(\S+)\s+origin_step=(\S+)\s+requirement_ref=(\S+)\s+case_type=(\S+)\s+status=(\S+)/g
const SUMMARY_RE = /^CASE_SUMMARY total_cases=(\d+) success_count=(\d+) fail_count=(\d+)/m

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function walk(root, directory = root) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(root, path))
    else files.push({ path, relative: relative(root, path) })
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function roundNumber(path) {
  const match = path.match(/(?:^|\/)steps\/round-(\d+)\//)
  return match ? Number(match[1]) : undefined
}

function readRuntimeEntry(archive, path) {
  const result = spawnSync('tar', ['-xOzf', archive, path], { maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Linux runtime is missing ${path}`)
  return result.stdout
}

export function parseEvoVerifierOutput(text, round) {
  const cases = []
  for (const match of text.matchAll(CASE_RE)) {
    cases.push({
      caseId: match[1],
      originStep: Number(String(match[2]).replace(/^round-/, '')),
      requirementRef: match[3],
      caseType: match[4],
      status: match[5],
      round,
    })
  }
  const summary = text.match(SUMMARY_RE)
  const successes = summary
    ? Number(summary[2])
    : cases.filter((entry) => entry.status === 'success').length
  const failures = summary
    ? Number(summary[3])
    : cases.filter((entry) => entry.status === 'fail').length
  return {
    round,
    total: summary ? Number(summary[1]) : successes + failures,
    successes,
    failures,
    cases,
  }
}

export function summarizeEvoRounds(rounds) {
  const ordered = [...rounds].sort((left, right) => left.round - right.round)
  if (ordered.length === 0 || ordered.some((entry) => entry.cases.length === 0)) {
    throw new Error('official EvoCode verifier output is missing CASE_RESULT identities')
  }
  const lastStatus = new Map()
  const regressedCases = new Set()
  for (const round of ordered) {
    for (const entry of round.cases) {
      const previous = lastStatus.get(entry.caseId)
      if (
        previous === 'success'
        && entry.status === 'fail'
        && Number.isInteger(entry.originStep)
        && entry.originStep < round.round
      ) {
        regressedCases.add(entry.caseId)
      }
      lastStatus.set(entry.caseId, entry.status)
    }
  }
  const perRound = ordered.map((entry) => entry.total > 0 ? 100 * entry.successes / entry.total : 0)
  return {
    historicalRequirementRegressions: regressedCases.size,
    cumulativeCaseScore: perRound.reduce((sum, value) => sum + value, 0) / perRound.length,
    rounds: ordered.length,
  }
}

export async function parseHarborJob(jobRoot) {
  const files = await walk(jobRoot)
  const verifierFiles = files.filter((entry) => basename(entry.path) === 'test-stdout.txt' && roundNumber(entry.relative))
  const byRound = new Map()
  for (const entry of verifierFiles) {
    const round = roundNumber(entry.relative)
    if (byRound.has(round)) throw new Error(`multiple verifier outputs found for EvoCode round ${round}`)
    byRound.set(round, parseEvoVerifierOutput(await readFile(entry.path, 'utf8'), round))
  }
  const rounds = [...byRound.values()].sort((left, right) => left.round - right.round)
  const summary = summarizeEvoRounds(rounds)
  const rewards = []
  for (const entry of files.filter((file) => basename(file.path) === 'reward.txt' && roundNumber(file.relative))) {
    const value = Number((await readFile(entry.path, 'utf8')).trim())
    if (!Number.isFinite(value)) throw new Error(`invalid reward in ${entry.relative}`)
    rewards.push({ round: roundNumber(entry.relative), value })
  }
  rewards.sort((left, right) => left.round - right.round)
  if (rewards.length !== rounds.length) throw new Error('official EvoCode reward count does not match verifier rounds')

  const metricFiles = files.filter((entry) => basename(entry.path) === 'dsh-metrics.json')
  const candidates = []
  for (const entry of metricFiles) {
    try {
      const metrics = JSON.parse(await readFile(entry.path, 'utf8'))
      if (Number.isFinite(metrics.modelTurns)) candidates.push(metrics)
    } catch {}
  }
  const session = candidates.sort((left, right) => right.modelTurns - left.modelTurns)[0]
  if (!session) throw new Error('Harbor Agent did not export cumulative DSH session metrics')
  return {
    metrics: {
      score: rewards.reduce((sum, entry) => sum + entry.value, 0),
      maxScore: rewards.length,
      historicalRequirementRegressions: summary.historicalRequirementRegressions,
      cumulativeCaseScore: summary.cumulativeCaseScore,
      modelTurns: session.modelTurns,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      clarificationQuestions: session.clarificationQuestions,
      durationMs: session.transcriptDurationMs,
    },
    rounds,
    rewards,
  }
}

export async function resolveRuntimeArtifact(spec) {
  const artifactId = spec.run.arm.id === 'native' ? 'native' : spec.run.arm.id
  const record = spec.runtimeArtifacts?.artifacts?.[artifactId]
  if (!record) throw new Error(`no frozen Linux runtime is configured for arm ${spec.run.arm.id}`)
  if (!/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error(`Linux runtime ${artifactId} is not frozen`)
  const path = process.env[record.pathEnvironmentVariable]
  if (!path) throw new Error(`${record.pathEnvironmentVariable} is not configured`)
  const absolute = resolve(path)
  const actual = sha256(await readFile(absolute))
  if (actual !== record.sha256) throw new Error(`Linux runtime digest mismatch for ${artifactId}`)
  let metadata
  try {
    metadata = JSON.parse(readRuntimeEntry(absolute, 'installed-agent/runtime/runtime.json').toString('utf8'))
  } catch {
    throw new Error(`Linux runtime ${artifactId} identity metadata is invalid`)
  }
  const expectedPluginCommit = spec.run.arm.plugin === 'none'
    ? null
    : spec.run.arm.plugin === 'v0.3.0'
      ? spec.pluginCommits['v0.3.0']
      : spec.pluginCommits['v0.4.0Candidate']
  if (metadata.schemaVersion !== 1
    || metadata.armDigest !== sha256(spec.run.arm)
    || metadata.harnessCommit !== spec.sourceCommits.harness
    || (metadata.pluginCommit ?? null) !== expectedPluginCommit
    || metadata.baseImage !== `${spec.runtimeArtifacts.baseImage.reference}@sha256:${spec.runtimeArtifacts.baseImage.digest}`
    || sha256(metadata) !== record.metadataDigest) {
    throw new Error(`Linux runtime ${artifactId} identity does not match its frozen arm`)
  }
  const supportDigest = sha256({
    package: readRuntimeEntry(absolute, 'installed-agent/runtime/packages/support/package.json').toString('utf8'),
    patch: readRuntimeEntry(absolute, 'installed-agent/runtime/packages/support/cordis.patch.yml').toString('utf8'),
    source: readRuntimeEntry(absolute, 'installed-agent/runtime/packages/support/index.js').toString('utf8'),
  })
  const profilePatchDigest = sha256(readRuntimeEntry(
    absolute,
    'installed-agent/runtime/home/profiles/headless/cordis.patch.yml',
  ).toString('utf8'))
  if (supportDigest !== metadata.supportDigest || profilePatchDigest !== metadata.profilePatchDigest) {
    throw new Error(`Linux runtime ${artifactId} installed support or profile bytes do not match its identity`)
  }
  const closureText = readRuntimeEntry(absolute, 'installed-agent/runtime/dsh/package.json').toString('utf8')
  const closureManifest = JSON.parse(closureText)
  if (sha256(closureText) !== metadata.runtimeClosure?.sha256
    || Object.keys(closureManifest.dependencies ?? {}).length !== metadata.runtimeClosure?.dependencyCount
    || closureManifest.planLatticeRuntimeClosure?.reachableWorkspacePackages !== metadata.runtimeClosure?.reachableWorkspacePackages) {
    throw new Error(`Linux runtime ${artifactId} closure does not match its identity`)
  }
  if (expectedPluginCommit === null) {
    const listing = spawnSync('tar', ['-tzf', absolute], { encoding: 'utf8' })
    if (listing.status !== 0) throw new Error(`Linux runtime ${artifactId} could not be listed`)
    if (listing.stdout.split(/\r?\n/).includes('installed-agent/runtime/packages/plugin.tgz')) {
      throw new Error(`Linux runtime ${artifactId} unexpectedly contains a Plan Lattice package`)
    }
    if (metadata.pluginPackageDigest !== null) throw new Error(`Linux runtime ${artifactId} native identity contains a plugin digest`)
  } else {
    const installedPluginDigest = sha256(readRuntimeEntry(absolute, 'installed-agent/runtime/packages/plugin.tgz'))
    if (installedPluginDigest !== metadata.pluginPackageDigest) {
      throw new Error(`Linux runtime ${artifactId} installed plugin bytes do not match its identity`)
    }
  }
  return { id: artifactId, path: absolute, digest: actual, metadata }
}

export async function runEvoCode({ spec, attemptDir }) {
  const proxy = requireProxyCapabilities(process.env, { docker: true })
  if (!spec.benchmarkRoots.harbor || !/^[0-9a-f]{40}$/.test(spec.sourceCommits.harbor ?? '')) {
    throw new Error('EvoCode execution requires an exact pinned Harbor checkout')
  }
  const harborRoot = resolve(spec.benchmarkRoots.harbor)
  const evocodeRoot = resolve(spec.benchmarkRoots.evocode)
  const taskRoot = join(evocodeRoot, 'data', 'EvoCodeBench', spec.run.taskLocator.harborTaskId)
  if (!(await exists(join(taskRoot, 'task.toml')))) throw new Error(`EvoCode task assets are missing at ${taskRoot}`)
  const graderDigest = await digestTree(taskRoot, (path, entry) => entry.isDirectory() || path.includes('/verifier/') || path.endsWith('/verifier'))
  const taskDigest = await digestTree(taskRoot, (path) => path !== 'harbor_jobs' && !path.startsWith('harbor_jobs/'))
  const taskProvenance = { graderDigest, taskDigest }
  const runtime = await resolveRuntimeArtifact(spec)
  const jobsRoot = join(attemptDir, 'harbor-jobs')
  const jobName = spec.run.runId.replace(/[^A-Za-z0-9_.-]/g, '_')
  const args = [
    'run', '--frozen', '--offline', '--project', harborRoot,
    'harbor', 'run',
    '--path', taskRoot,
    '--agent', 'harbor_plan_lattice_agent:PlanLatticeHarnessAgent',
    '--model', spec.model.modelId,
    '--agent-kwarg', `runtime_tar=${runtime.path}`,
    '--agent-include-logs', 'dsh-metrics.json',
    '--agent-include-logs', 'dsh-session.tar.gz',
    '--resume-trajectory',
    '--jobs-dir', jobsRoot,
    '--job-name', jobName,
    '--n-attempts', '1',
    '--n-concurrent', '1',
    '--max-retries', '0',
    '--yes', '--quiet',
  ]
  const env = {
    ...withoutEvaluationCapabilities(),
    DEEPSEEK_API_KEY: proxy.agentCapability,
    DEEPSEEK_BASE_URL: proxy.dockerBaseURL,
    PYTHONPATH: [driverRoot, join(harborRoot, 'src'), process.env.PYTHONPATH].filter(Boolean).join(':'),
    HARBOR_TELEMETRY_ENABLED: 'false',
  }
  const result = spawnSync('uv', args, {
    cwd: harborRoot,
    env,
    encoding: 'utf8',
    timeout: spec.model.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  await writeFile(join(attemptDir, 'harbor.stdout.log'), sanitized(result.stdout), 'utf8')
  await writeFile(join(attemptDir, 'harbor.stderr.log'), sanitized(result.stderr), 'utf8')
  if (result.error?.code === 'ETIMEDOUT') {
    return { failure: { classification: 'task', code: 'model_timeout', message: 'Harbor exceeded the frozen run timeout' }, provenance: taskProvenance }
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    return {
      failure: { classification: 'task', code: 'agent_error', message: 'Harbor execution began but did not produce a completed EvoCode result; retained logs contain the details' },
      provenance: taskProvenance,
    }
  }
  const parsed = await parseHarborJob(join(jobsRoot, jobName))
  return {
    metrics: parsed.metrics,
    provenance: { ...taskProvenance, runtimeDigest: runtime.digest },
  }
}
