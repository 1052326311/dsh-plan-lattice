#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sha256 } from '../lib/canonical.mjs'
import { runEvoCode } from './lib/evocode.mjs'
import { preflight } from './lib/preflight.mjs'
import { classifyHarnessFailure, digestTree, runHarnessTask, sanitized } from './lib/runtime.mjs'
import { gradeSimpleTask, materializeSimpleTask } from './lib/simple-grader.mjs'

const driverRoot = dirname(fileURLToPath(import.meta.url))

function provenance(spec, graderDigest, taskDigest) {
  return {
    graderDigest,
    taskDigest,
    ...spec.expectedProvenance,
  }
}

function zeroMetrics(spec) {
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

function failedBeforeExecution(spec, code, message, details) {
  return {
    status: 'failed',
    failure: { classification: 'infrastructure', code, message: `${message}: ${sha256(details)}` },
  }
}

async function runSimple(spec, attemptDir) {
  const workspace = join(attemptDir, 'workspace')
  await mkdir(workspace, { recursive: true })
  await materializeSimpleTask(spec.simpleTask, workspace)
  const pluginCommit = spec.run.arm.plugin === 'none'
    ? undefined
    : spec.run.arm.plugin === 'v0.3.0'
      ? spec.pluginCommits['v0.3.0']
      : spec.pluginCommits['v0.4.0Candidate']
  const harness = await runHarnessTask({
    runtimeArtifacts: spec.runtimeArtifacts,
    harnessCommit: spec.sourceCommits.harness,
    attemptDir,
    workspace,
    prompt: spec.simpleTask.prompt,
    arm: spec.run.arm,
    pluginCommit,
    sessionId: `plan-lattice-simple-${spec.run.runId}`,
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
  const taskDigest = sha256({
    locator: spec.run.taskLocator,
    aliasRecord: aliasMap[alias],
    prd: sha256(await readFile(prd)),
    golden: await digestTree(golden),
  })
  const graderDigest = sha256({
    tests: await digestTree(tests),
    evaluate: sha256(await readFile(join(root, 'harness', 'evaluate.py'))),
    orchestrator: sha256(await readFile(join(root, 'harness', 'orchestrator.py'))),
  })
  return { taskDigest, graderDigest }
}

async function runIcae(spec, specPath, attemptDir) {
  const digests = await icaeDigests(spec)
  const child = spawnSync('python3', [join(driverRoot, 'icae_adapter.py'), specPath], {
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
      return { status: 'failed', failure: adapter.failure }
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

async function execute(spec, specPath) {
  if (typeof spec.attemptDir !== 'string' || !isAbsolute(spec.attemptDir)) {
    throw new Error('run spec must bind an absolute attempt directory')
  }
  const attemptDir = resolve(spec.attemptDir)
  if (resolve(dirname(specPath), '..') !== attemptDir) {
    throw new Error('run spec must live in its attempt controller directory')
  }
  await mkdir(attemptDir, { recursive: true })
  const readiness = await preflight(spec)
  await writeFile(join(attemptDir, 'preflight.json'), `${JSON.stringify(readiness, null, 2)}\n`, 'utf8')
  if (!readiness.ok) {
    return failedBeforeExecution(
      spec,
      'runner_crash_before_model_call',
      'Frozen evaluation prerequisites are not satisfied; no model call was made',
      readiness.checks.filter((check) => !check.ok),
    )
  }
  if (spec.run.suite === 'simple') return runSimple(spec, attemptDir)
  if (spec.run.suite === 'icae') return runIcae(spec, specPath, attemptDir)
  if (spec.run.suite === 'evocode') {
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
  throw new Error(`unsupported suite ${spec.run.suite}`)
}

const args = process.argv.slice(2)
const preflightOnly = args[0] === '--preflight'
const specArgument = preflightOnly ? args[1] : args[0]
if (!specArgument) throw new Error('usage: dsh-driver.mjs [--preflight] <run-spec.json>')
const specPath = resolve(specArgument)
const spec = await readJson(specPath)
let output
try {
  output = preflightOnly ? await preflight(spec) : await execute(spec, specPath)
} catch (error) {
  output = {
    status: 'failed',
    failure: {
      classification: 'task',
      code: 'driver_or_grader_error_after_execution_start',
      message: `${String(error?.message ?? error)}: ${sha256(String(error?.stack ?? error))}`,
    },
  }
}
process.stdout.write(`${JSON.stringify(output)}\n`)
