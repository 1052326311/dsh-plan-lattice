#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJson, sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import { runEvoCode } from '../../eval/v0.4/driver/lib/evocode.mjs'
import {
  classifyHarnessFailure,
  digestTree,
  runHarnessTask,
  sanitized,
} from '../../eval/v0.4/driver/lib/runtime.mjs'
import {
  gradeSimpleTask,
  materializeSimpleTask,
} from '../../eval/v0.4/driver/lib/simple-grader.mjs'
import { preflight, RC4_PREFLIGHT } from './preflight.mjs'

const moduleRoot = dirname(fileURLToPath(import.meta.url))
const legacyDriverRoot = resolve(moduleRoot, '..', '..', 'eval', 'v0.4', 'driver')

export const RC4_DRIVER_PROTOCOL = 'plan-lattice-rc4-driver-result-v1'

function provenance(spec, graderDigest, taskDigest) {
  return {
    graderDigest,
    taskDigest,
    candidateCommit: RC4_PREFLIGHT.candidateCommit,
    ...spec.expectedProvenance,
  }
}

export function zeroMetrics(spec) {
  return {
    score: 0,
    maxScore: 1,
    modelTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    clarificationQuestions: 0,
    ...(spec.run.suite === 'icae' ? { hiddenFeatureScore: 0, criticalRequirementsMissed: 0 } : {}),
    ...(spec.run.suite === 'evocode' ? { historicalRequirementRegressions: 0, cumulativeCaseScore: 0 } : {}),
  }
}

function envelope(spec, payload, phase = 'execution') {
  return {
    schemaVersion: 1,
    protocol: RC4_DRIVER_PROTOCOL,
    phase,
    runId: spec.run?.runId,
    candidateCommit: RC4_PREFLIGHT.candidateCommit,
    executionEnvelopeDigest: spec.executionEnvelopeDigest,
    ...payload,
  }
}

function failedBeforeExecution(spec, readiness) {
  return envelope(spec, {
    status: 'failed',
    failure: {
      classification: 'infrastructure',
      code: 'rc4_preflight_failed_before_model_call',
      message: `RC.4 frozen prerequisites failed; no model call was made: ${sha256(readiness.checks.filter(check => !check.ok))}`,
    },
  }, 'preflight')
}

function pluginCommit(spec) {
  if (spec.run.arm.plugin === 'none') return undefined
  if (spec.run.arm.plugin === 'v0.3.0') return spec.pluginCommits['v0.3.0']
  return spec.pluginCommits['v0.4.0Candidate']
}

function pluginPackage(spec) {
  if (spec.run.arm.plugin === 'none') return {}
  const key = spec.run.arm.plugin === 'v0.3.0' ? 'v0.3.0' : 'v0.4.0-candidate'
  const artifact = spec.runtimeArtifacts.hostPlugins[key]
  return {
    pluginPackagePath: process.env[artifact.pathEnvironmentVariable],
    pluginPackageDigest: artifact.sha256,
  }
}

async function runSimple(spec, _specPath, attemptDir) {
  const workspace = join(attemptDir, 'workspace')
  await mkdir(workspace, { recursive: true })
  await materializeSimpleTask(spec.simpleTask, workspace)
  const harness = await runHarnessTask({
    runtimeArtifacts: spec.runtimeArtifacts,
    harnessCommit: spec.sourceCommits.harness,
    attemptDir,
    workspace,
    prompt: spec.simpleTask.prompt,
    arm: spec.run.arm,
    pluginCommit: pluginCommit(spec),
    ...pluginPackage(spec),
    sessionId: `plan-lattice-rc4-simple-${spec.run.runId}`,
    forbiddenReadRoots: [join(attemptDir, 'controller')],
    timeoutMs: spec.model.timeoutMs,
  })
  const grade = await gradeSimpleTask(spec.simpleTask, workspace)
  await writeFile(join(attemptDir, 'simple-grade.json'), `${JSON.stringify(grade, null, 2)}\n`, 'utf8')
  const taskDigest = sha256({
    id: spec.simpleTask.id,
    prompt: spec.simpleTask.prompt,
    initialFiles: spec.simpleTask.initialFiles,
    graderAssertions: spec.simpleTask.graderAssertions,
  })
  const result = {
    status: harness.status === 0 ? 'completed' : 'failed',
    metrics: {
      score: grade.score,
      maxScore: grade.maxScore,
      modelTurns: harness.modelTurns,
      inputTokens: harness.inputTokens,
      outputTokens: harness.outputTokens,
      durationMs: harness.durationMs,
      clarificationQuestions: harness.clarificationQuestions,
    },
    provenance: provenance(spec, grade.graderDigest, taskDigest),
  }
  if (harness.status !== 0) result.failure = classifyHarnessFailure(harness)
  return result
}

async function icaeDigests(spec) {
  const root = resolve(spec.benchmarkRoots.icae)
  const aliasMap = JSON.parse(await readFile(join(root, 'repo_alias.json'), 'utf8'))
  const repositoryKey = spec.run.taskLocator.repositoryKey
  const alias = Object.entries(aliasMap).find(([, record]) => record.key === repositoryKey)?.[0]
  if (!alias) throw new Error(`ICAE alias is missing for ${repositoryKey}`)
  const prd = join(root, 'fuzzy_prds', alias, 'start.md')
  const golden = join(root, 'realcode_repos', repositoryKey)
  const tests = join(root, 'rcb_tests_repos', repositoryKey, 'rcb_tests')
  return {
    taskDigest: sha256({
      locator: spec.run.taskLocator,
      aliasRecord: aliasMap[alias],
      prd: sha256(await readFile(prd)),
      golden: await digestTree(golden),
    }),
    graderDigest: sha256({
      tests: await digestTree(tests),
      evaluate: sha256(await readFile(join(root, 'harness', 'evaluate.py'))),
      orchestrator: sha256(await readFile(join(root, 'harness', 'orchestrator.py'))),
    }),
  }
}

async function runIcae(spec, specPath, attemptDir) {
  const digests = await icaeDigests(spec)
  const child = spawnSync('python3', [join(legacyDriverRoot, 'icae_adapter.py'), specPath], {
    cwd: spec.benchmarkRoots.icae,
    encoding: 'utf8',
    timeout: spec.model.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PLAN_LATTICE_NODE: process.execPath, PYTHONDONTWRITEBYTECODE: '1' },
  })
  await writeFile(join(attemptDir, 'icae.stdout.log'), sanitized(child.stdout), 'utf8')
  await writeFile(join(attemptDir, 'icae.stderr.log'), sanitized(child.stderr), 'utf8')
  if (child.error?.code === 'ETIMEDOUT') {
    return {
      status: 'failed',
      failure: { classification: 'task', code: 'model_timeout', message: 'ICAE exceeded the frozen run timeout' },
      metrics: zeroMetrics(spec),
      provenance: provenance(spec, digests.graderDigest, digests.taskDigest),
    }
  }
  if (child.error) throw child.error
  const lines = (child.stdout ?? '').split(/\r?\n/).filter(Boolean)
  let adapter
  try {
    adapter = JSON.parse(lines.at(-1))
  } catch {
    adapter = undefined
  }
  if (child.status !== 0 || !adapter?.metrics) {
    if (adapter?.failure?.classification === 'infrastructure') {
      return {
        status: 'failed',
        failure: adapter.failure,
        metrics: zeroMetrics(spec),
        provenance: provenance(spec, digests.graderDigest, digests.taskDigest),
      }
    }
    return {
      status: 'failed',
      failure: { classification: 'task', code: 'benchmark_or_agent_error', message: 'ICAE or its agent run failed; retained logs contain the details' },
      metrics: zeroMetrics(spec),
      provenance: provenance(spec, digests.graderDigest, digests.taskDigest),
    }
  }
  return {
    status: 'completed',
    metrics: adapter.metrics,
    provenance: provenance(spec, digests.graderDigest, digests.taskDigest),
  }
}

async function runEvo(spec, _specPath, attemptDir) {
  const result = await runEvoCode({ spec, attemptDir })
  if (result.failure) {
    return {
      status: 'failed',
      failure: result.failure,
      metrics: zeroMetrics(spec),
      provenance: provenance(
        spec,
        result.provenance?.graderDigest ?? sha256(result.failure),
        result.provenance?.taskDigest ?? sha256(spec.run.taskLocator),
      ),
    }
  }
  return {
    status: 'completed',
    metrics: result.metrics,
    provenance: provenance(spec, result.provenance.graderDigest, result.provenance.taskDigest),
  }
}

const realSuiteRunners = Object.freeze({ simple: runSimple, icae: runIcae, evocode: runEvo })

function validateSuiteResult(result) {
  if (!result || !['completed', 'failed'].includes(result.status)) throw new Error('suite runner returned an invalid status')
  if (!result.metrics || !result.provenance) throw new Error('suite runner omitted metrics or provenance')
  if (result.status === 'completed' && result.metrics.modelTurns < 1) {
    throw new Error('completed suite result has no durable model turn')
  }
  return result
}

export async function executeRun(spec, specPath, options = {}) {
  if (typeof spec.attemptDir !== 'string' || !isAbsolute(spec.attemptDir)) {
    throw new Error('run spec must bind an absolute attempt directory')
  }
  const absoluteSpecPath = resolve(specPath)
  const attemptDir = resolve(spec.attemptDir)
  if (resolve(dirname(absoluteSpecPath), '..') !== attemptDir) {
    throw new Error('run spec must live in its attempt controller directory')
  }
  await mkdir(attemptDir, { recursive: true })
  const runPreflight = options.preflight ?? preflight
  const readiness = await runPreflight(spec, options.preflightOptions)
  await writeFile(join(attemptDir, 'preflight.json'), `${JSON.stringify(readiness, null, 2)}\n`, 'utf8')
  if (readiness?.protocol !== RC4_PREFLIGHT.resultProtocol || readiness.ok !== true) {
    return failedBeforeExecution(spec, readiness ?? { checks: [{ name: 'preflight-output', ok: false }] })
  }
  const runner = options.suiteRunners?.[spec.run.suite] ?? realSuiteRunners[spec.run.suite]
  if (typeof runner !== 'function') throw new Error(`unsupported suite ${spec.run.suite}`)
  const result = validateSuiteResult(await runner(spec, absoluteSpecPath, attemptDir))
  return envelope(spec, result)
}

export async function runDriverCli(argv = process.argv.slice(2), options = {}) {
  const preflightOnly = argv[0] === '--preflight'
  const specArgument = preflightOnly ? argv[1] : argv[0]
  if (!specArgument) throw new Error('usage: driver.mjs [--preflight] <run-spec.json>')
  const specPath = resolve(specArgument)
  const spec = await (options.readJson ?? readJson)(specPath)
  try {
    if (preflightOnly) return await (options.preflight ?? preflight)(spec, options.preflightOptions)
    return await executeRun(spec, specPath, options)
  } catch (error) {
    return envelope(spec, {
      status: 'failed',
      failure: {
        classification: 'task',
        code: 'driver_or_grader_error_after_execution_start',
        message: `${String(error?.message ?? error)}: ${sha256(String(error?.stack ?? error))}`,
      },
    })
  }
}

function isMain() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
}

if (isMain()) {
  const output = await runDriverCli()
  process.stdout.write(`${JSON.stringify(output)}\n`)
}
