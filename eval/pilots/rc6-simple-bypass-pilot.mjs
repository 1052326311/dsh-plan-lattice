#!/usr/bin/env node

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const harnessCommit = '47f943859bef60e4160492346772ded9b24f765a'
const hostRuntime = process.env.PLAN_LATTICE_PILOT_HOST_RUNTIME
const pluginPackage = process.env.PLAN_LATTICE_PILOT_PLUGIN_PACKAGE
const outputPath = process.env.PLAN_LATTICE_PILOT_OUTPUT
  ?? join(root, 'eval/pilots/results/rc6-simple-bypass.json')
const apiKey = process.env.DEEPSEEK_API_KEY

if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')
if (!hostRuntime) throw new Error('PLAN_LATTICE_PILOT_HOST_RUNTIME is required')
if (!pluginPackage) throw new Error('PLAN_LATTICE_PILOT_PLUGIN_PACKAGE is required')

const canonical = await import(pathToFileURL(join(root, 'eval/v0.4/lib/canonical.mjs')).href)
const { startModelProxy } = await import(pathToFileURL(join(root, 'eval/v0.4/driver/model-proxy.mjs')).href)
const { runHarnessTask } = await import(pathToFileURL(join(root, 'eval/v0.4/driver/lib/runtime.mjs')).href)
const { gradeSimpleTask, materializeSimpleTask } = await import(pathToFileURL(join(root, 'eval/v0.4/driver/lib/simple-grader.mjs')).href)

const taskSuite = JSON.parse(await readFile(join(root, 'eval/v0.4/simple-tasks.json'), 'utf8'))
const task = taskSuite.tasks.find(item => item.id === 'simple-js-clamp')
assert.ok(task, 'simple-js-clamp task is missing')

const temporaryRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-rc6-simple-pilot-'))
const keys = generateKeyPairSync('ed25519')
const proxy = await startModelProxy({
  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  auditPath: join(temporaryRoot, 'proxy-audit.jsonl'),
  signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  signingLedgerPath: join(temporaryRoot, 'signing-ledger.jsonl'),
  signingLedgerId: 'plan-lattice-rc6-simple-bypass-pilot',
  executionEnvelopeDigest: '6'.repeat(64),
  host: '127.0.0.1',
})

async function activate(attemptId) {
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-plan-lattice-control': proxy.controlToken,
    },
    body: JSON.stringify({ attemptId }),
  })
  assert.equal(response.status, 200)
}

const previous = Object.fromEntries([
  'PLAN_LATTICE_CREDENTIAL_PROXY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'PLAN_LATTICE_PILOT_RUNTIME',
].map(name => [name, process.env[name]]))

let report
try {
  process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
  process.env.DEEPSEEK_API_KEY = proxy.token
  process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL
  process.env.PLAN_LATTICE_PILOT_RUNTIME = hostRuntime

  const pluginPackageBytes = await readFile(pluginPackage)
  const hostRuntimeBytes = await readFile(hostRuntime)
  const attempts = []
  for (const arm of [
    { id: 'native', plugin: 'none' },
    {
      id: 'v0.4-auto',
      plugin: 'v0.4.0-candidate',
      activationMode: 'auto',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
    },
  ]) {
    const attemptId = `rc6-simple-bypass-${arm.id}`
    const attemptDir = join(temporaryRoot, attemptId)
    const workspace = join(attemptDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    await materializeSimpleTask(task, workspace)
    await activate(attemptId)
    const harness = await runHarnessTask({
      attemptId,
      runtimeArtifacts: {
        hostHarness: {
          pathEnvironmentVariable: 'PLAN_LATTICE_PILOT_RUNTIME',
          sha256: canonical.sha256(hostRuntimeBytes),
        },
      },
      harnessCommit,
      attemptDir,
      workspace,
      prompt: task.prompt,
      arm,
      pluginPackagePath: arm.plugin === 'none' ? undefined : pluginPackage,
      pluginPackageDigest: arm.plugin === 'none' ? undefined : canonical.sha256(pluginPackageBytes),
      sessionId: `plan-lattice-rc6-simple-${arm.id}`,
      timeoutMs: 600_000,
    })
    const grade = await gradeSimpleTask(task, workspace)
    attempts.push({
      arm: arm.id,
      status: harness.status,
      score: grade.score,
      maxScore: grade.maxScore,
      modelTurns: harness.modelTurns,
      inputTokens: harness.inputTokens,
      outputTokens: harness.outputTokens,
      durationMs: harness.durationMs,
      clarificationQuestions: harness.clarificationQuestions,
      terminalReason: harness.terminalReason,
      checks: grade.checks,
    })
  }

  const native = attempts.find(item => item.arm === 'native')
  const candidate = attempts.find(item => item.arm === 'v0.4-auto')
  const reductionPercent = (baseline, observed) => Number(
    (((baseline - observed) / baseline) * 100).toFixed(1),
  )
  const checks = {
    bothCompleted: native?.status === 0 && candidate?.status === 0,
    nativeFullScore: native?.score === native?.maxScore,
    candidateFullScore: candidate?.score === candidate?.maxScore,
    scoreNonInferior: candidate?.score === native?.score,
    noAddedModelTurns: candidate?.modelTurns <= native?.modelTurns,
    zeroClarificationQuestions: candidate?.clarificationQuestions === 0,
  }
  report = {
    schemaVersion: 1,
    scope: 'paired real-DeepSeek simple-task infrastructure pilot; not statistical uplift evidence',
    generatedAt: new Date().toISOString(),
    harnessCommit,
    model: 'deepseek-v4-flash',
    taskId: task.id,
    pluginTarballSha256: canonical.sha256(pluginPackageBytes),
    hostRuntimeSha256: canonical.sha256(hostRuntimeBytes),
    attempts,
    observedComparison: {
      scoreDelta: candidate.score - native.score,
      modelTurnDelta: candidate.modelTurns - native.modelTurns,
      modelTurnReductionPercent: reductionPercent(native.modelTurns, candidate.modelTurns),
      inputTokenReductionPercent: reductionPercent(native.inputTokens, candidate.inputTokens),
      outputTokenReductionPercent: reductionPercent(native.outputTokens, candidate.outputTokens),
      durationReductionPercent: reductionPercent(native.durationMs, candidate.durationMs),
      attribution: 'Single paired pilot; resource differences are observations, not causal uplift estimates.',
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await new Promise(resolve => proxy.server.close(resolve))
  await rm(temporaryRoot, { recursive: true, force: true })
}
