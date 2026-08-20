#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { budgetSnapshotWithinLimits, startPilotBudgetProxy } from '../../pilots/driver/budget-proxy.mjs'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { classifyHarnessFailure, digestTree, runHarnessTask } from './driver/runtime.mjs'
import { auditPersistentNativeContinuity } from './session-audit.mjs'
import { HARNESS_COMMIT } from './manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workspaceRoot = dirname(repositoryRoot)
const hostRuntime = process.env.PLAN_LATTICE_LONG_SYSTEM_V22_HOST_RUNTIME
const apiKey = process.env.DEEPSEEK_API_KEY
const taskPath = join(repositoryRoot, 'eval/long-system/v22/task.json')
const fixtureRoot = join(repositoryRoot, 'eval/long-system/v22/fixture')
const graderPath = join(repositoryRoot, 'eval/long-system/v22/grader.mjs')
const artifactId = `rc7-native-boundary-long-system-v22-pilot-${new Date().toISOString().replace(/[:.]/g, '-')}`
const artifactsRoot = resolve(process.env.PLAN_LATTICE_LONG_SYSTEM_V22_PILOT_ROOT
  ?? join(workspaceRoot, '.plan-lattice-eval', 'long-system-v22-pilots', artifactId))
const outputPath = join(artifactsRoot, 'native-pilot-report.json')
const budgetLimits = { maxAgentRequests: 100, maxInputTokens: 4_000_000, maxOutputTokens: 500_000 }

if (!hostRuntime) throw new Error('PLAN_LATTICE_LONG_SYSTEM_V22_HOST_RUNTIME is required')
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')

const taskBytes = await readFile(taskPath)
const task = JSON.parse(taskBytes.toString('utf8'))
assert.equal(task.schemaVersion, 1)
assert.equal(task.stages.length, 5)
const hostRuntimeSha256 = sha256(await readFile(hostRuntime))
const driverHead = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
assert.equal(driverHead.status, 0)
const driverCommit = driverHead.stdout.trim()
assert.match(driverCommit, /^[0-9a-f]{40}$/)

function buildProtocol(rootSessionId) {
  return {
    schemaVersion: 1,
    taskId: task.id,
    stages: task.stages.map(stage => ({
      ...stage,
      message: stage.message === '$INITIAL_PROMPT' ? task.initialPrompt : stage.message,
      ...(stage.actor === 'root' ? { sessionId: rootSessionId } : { parentSessionId: rootSessionId }),
    })),
  }
}

function runGrader(workspace, phase = 'final') {
  const result = spawnSync(process.execPath, [graderPath, workspace, '--phase', phase], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`hidden grader failed: ${result.stderr || result.stdout}`)
  const value = JSON.parse(result.stdout)
  if (value?.schemaVersion !== 1 || !Number.isFinite(value.score)) {
    throw new Error('hidden grader returned invalid output')
  }
  return value
}

async function activate(proxy, attemptId) {
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify({ attemptId }),
  })
  assert.equal(response.status, 200, `failed to activate ${String(attemptId)}`)
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

await mkdir(artifactsRoot, { recursive: true })
const siblingRoot = dirname(artifactsRoot)
const historicalArtifactRoots = (await readdir(siblingRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && resolve(siblingRoot, entry.name) !== artifactsRoot)
  .map(entry => resolve(siblingRoot, entry.name))
const budgetProxy = await startPilotBudgetProxy({
  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  auditPath: join(artifactsRoot, 'budget-audit.jsonl'),
  limits: budgetLimits,
})
const keys = generateKeyPairSync('ed25519')
const proxy = await startModelProxy({
  apiKey: budgetProxy.token,
  baseURL: budgetProxy.hostBaseURL,
  auditPath: join(artifactsRoot, 'proxy-audit.jsonl'),
  signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  signingLedgerPath: join(artifactsRoot, 'signing-ledger.jsonl'),
  signingLedgerId: `${task.id}-native-pilot`,
  executionEnvelopeDigest: sha256({
    task: sha256(taskBytes),
    fixture: await digestTree(fixtureRoot),
    grader: sha256(await readFile(graderPath)),
    harness: HARNESS_COMMIT,
    runtime: hostRuntimeSha256,
  }),
  host: '127.0.0.1',
})

const previous = Object.fromEntries([
  'PLAN_LATTICE_CREDENTIAL_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
].map(name => [name, process.env[name]]))
const attemptId = `${task.id}-native-pilot-${Date.now()}`
const attemptDir = join(artifactsRoot, 'native')
const workspace = join(attemptDir, 'workspace')
const rootSessionId = `plan-lattice-v22-pilot-${task.id}-native`
let result
let budget
const startedAt = new Date().toISOString()
try {
  process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
  process.env.DEEPSEEK_API_KEY = proxy.token
  process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL
  await mkdir(attemptDir, { recursive: true })
  await cp(fixtureRoot, workspace, { recursive: true, force: true })
  await activate(proxy, attemptId)
  await budgetProxy.activate(attemptId)
  result = await runHarnessTask({
    runtimeArtifacts: {
      hostHarness: {
        pathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V22_HOST_RUNTIME',
        sha256: hostRuntimeSha256,
      },
    },
    harnessCommit: HARNESS_COMMIT,
    attemptDir,
    workspace,
    prompt: task.initialPrompt,
    arm: {
      id: 'native',
      plugin: 'none',
      shellAdapter: 'workspace-tree',
      delegation: 'model-facing-native-foreground-subagent-fork',
    },
    sessionId: rootSessionId,
    attemptId,
    forbiddenReadRoots: historicalArtifactRoots,
    permissionMode: 'danger-full-access',
    timeoutMs: 3_600_000,
    maxRecoveryEpochs: 1,
    stageProtocol: buildProtocol(rootSessionId),
  })
  budget = budgetProxy.snapshot()
} finally {
  try { await activate(proxy, null) } catch {}
  restoreEnvironment(previous)
  proxy.server.closeAllConnections?.()
  if (proxy.server.listening) await new Promise(resolveClose => proxy.server.close(resolveClose))
  await budgetProxy.close()
}

const grade = runGrader(workspace)
const delegatedStage = result.stages?.find(stage => stage.id === 'delegated-summary')
const childReportGrade = delegatedStage?.snapshotPath === undefined
  ? undefined
  : runGrader(delegatedStage.snapshotPath, 'report')
let continuity
try {
  continuity = await auditPersistentNativeContinuity(join(attemptDir, 'sessions'), {
    expectedSessionIds: [
      rootSessionId,
      ...new Set((result.foregroundDelegations ?? []).map(item => item.childSessionId)),
    ],
  })
} catch (error) {
  continuity = {
    valid: false,
    violations: [{ kind: 'persistent-session-audit-failed', detail: String(error?.message ?? error) }],
  }
}
const observedStageIds = result.stages?.map(stage => stage.id) ?? []
const expectedStageIds = task.stages.map(stage => stage.id)
const completeLifecycle = result.status === 0
  && result.allStagesCompleted === true
  && JSON.stringify(observedStageIds) === JSON.stringify(expectedStageIds)
  && result.foregroundDelegations?.length === 1
  && continuity.valid === true
const nonCeiling = grade.score < 100 && grade.score <= 90
const budgetValid = budgetSnapshotWithinLimits(budget)
const pilotSuitableForPairFreeze = completeLifecycle && nonCeiling && budgetValid
const reportBody = {
  schemaVersion: 1,
  protocolId: 'plan-lattice-rc7-native-boundary-long-system-v22-native-pilot',
  claimBoundary: 'Task-selection pilot only. It cannot support a plugin effect, release, ranking, or quality claim.',
  startedAt,
  completedAt: new Date().toISOString(),
  artifactId,
  task: {
    id: task.id,
    sha256: sha256(taskBytes),
    fixtureSha256: await digestTree(fixtureRoot),
    graderSha256: sha256(await readFile(graderPath)),
  },
  harnessCommit: HARNESS_COMMIT,
  hostRuntimeSha256,
  driverCommit,
  workingTreeDirty: spawnSync('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout.trim() !== '',
  budgetLimits,
  budget,
  budgetValid,
  completeLifecycle,
  nonCeiling,
  pilotSuitableForPairFreeze,
  result: {
    status: result.status,
    terminalReason: result.terminalReason,
    failure: completeLifecycle ? null : classifyHarnessFailure(result),
    observedStageIds,
    processEpochs: result.processEpochs,
    recoveryEpochs: result.recoveryEpochs,
    modelTurns: result.modelTurns,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    compactionSummaries: result.compactionSummaries,
    surfaceReplacements: result.surfaceReplacements,
    foregroundDelegations: result.foregroundDelegations?.length ?? 0,
  },
  continuity,
  grade,
  childReportGrade: childReportGrade ?? null,
}
const report = { ...reportBody, reportDigest: sha256(reportBody) }
await writeFile(outputPath, canonicalJson(report), { encoding: 'utf8', mode: 0o600 })
process.stdout.write(canonicalJson(report))
if (!pilotSuitableForPairFreeze) process.exitCode = 2
