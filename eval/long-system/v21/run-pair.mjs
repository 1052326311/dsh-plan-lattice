#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeV21Pair } from './analysis.mjs'
import { budgetSnapshotWithinLimits, startPilotBudgetProxy } from '../../pilots/driver/budget-proxy.mjs'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { classifyHarnessFailure, digestTree, packagePluginAtCommit, runHarnessTask } from './driver/runtime.mjs'
import { verifyV21Manifest } from './freeze.mjs'
import { auditPersistentNativeContinuity } from './session-audit.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workspaceRoot = dirname(repositoryRoot)
const hostRuntime = process.env.PLAN_LATTICE_LONG_SYSTEM_V21_HOST_RUNTIME
const apiKey = process.env.DEEPSEEK_API_KEY
const taskPath = join(repositoryRoot, 'eval/long-system/v21/task.json')
const fixtureRoot = join(repositoryRoot, 'eval/long-system/v21/fixture')
const graderPath = join(repositoryRoot, 'eval/long-system/v21/grader.mjs')
const artifactId = `rc7-native-boundary-long-system-v21-${new Date().toISOString().replace(/[:.]/g, '-')}`
const artifactsRoot = resolve(process.env.PLAN_LATTICE_LONG_SYSTEM_V21_ARTIFACTS_ROOT
  ?? join(workspaceRoot, '.plan-lattice-eval', 'long-system-v21', artifactId))
const outputPath = resolve(process.env.PLAN_LATTICE_LONG_SYSTEM_V21_OUTPUT
  ?? join(artifactsRoot, 'paired-report.json'))

if (!hostRuntime) throw new Error('PLAN_LATTICE_LONG_SYSTEM_V21_HOST_RUNTIME is required')

const preflight = spawnSync(process.execPath, [
  join(repositoryRoot, 'eval/long-system/v21/preflight.mjs'), '--require-credentials',
], { cwd: repositoryRoot, encoding: 'utf8' })
if (preflight.status !== 0) {
  throw new Error(`V21 preflight failed before any model call: ${(preflight.stderr || preflight.stdout).trim()}`)
}
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')

const manifest = await verifyV21Manifest()
const driverHead = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
assert.equal(driverHead.status, 0)
const driverCommit = driverHead.stdout.trim()
assert.match(driverCommit, /^[0-9a-f]{40}$/)
const driverStatus = spawnSync('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
assert.equal(driverStatus.status, 0)
assert.equal(driverStatus.stdout.trim(), '', 'V21 execution requires a clean committed checkout')
assert.equal(manifest.harness.runtimePathEnvironmentVariable, 'PLAN_LATTICE_LONG_SYSTEM_V21_HOST_RUNTIME')
assert.equal(sha256(await readFile(hostRuntime)), manifest.harness.hostRuntimeSha256)

const task = JSON.parse(await readFile(taskPath, 'utf8'))
assert.equal(task.schemaVersion, 1)
assert.equal(task.stages.length, 5)
assert.equal(sha256(await readFile(taskPath)), manifest.task.sha256)
assert.equal(await digestTree(fixtureRoot), manifest.task.fixtureSha256)
assert.equal(sha256(await readFile(graderPath)), manifest.task.graderSha256)

const armCatalog = [
  { id: 'native', plugin: 'none', shellAdapter: 'workspace-tree', delegation: 'model-facing-native-foreground-subagent-fork' },
  {
    id: 'v0.4-native-continuity',
    plugin: 'v0.4.0-candidate',
    activationMode: 'auto',
    clarificationPolicy: 'never',
    controlCeiling: 'lattice',
    shellAdapter: 'workspace-tree',
    delegation: 'model-facing-native-foreground-subagent-fork',
  },
]
assert.deepEqual(manifest.order, armCatalog.map(arm => arm.id))
for (const arm of armCatalog) {
  const configured = Object.fromEntries(Object.entries(arm).filter(([key]) => key !== 'id'))
  assert.deepEqual(manifest.arms[arm.id], configured)
}

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
const frozenCandidatePackage = await packagePluginAtCommit(
  manifest.candidate.commit,
  join(artifactsRoot, 'frozen-candidate-package'),
)
assert.equal(
  frozenCandidatePackage.digest,
  manifest.freeSmoke.candidatePackageSha256,
  'candidate package differs from the asset exercised by the frozen free smoke',
)
const siblingRoot = dirname(artifactsRoot)
const historicalArtifactRoots = (await readdir(siblingRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && resolve(siblingRoot, entry.name) !== artifactsRoot)
  .map(entry => resolve(siblingRoot, entry.name))
const budgetLimits = manifest.budget
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
  signingLedgerId: manifest.protocolId,
  executionEnvelopeDigest: manifest.manifestDigest,
  host: '127.0.0.1',
})

const previous = Object.fromEntries([
  'PLAN_LATTICE_CREDENTIAL_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
].map(name => [name, process.env[name]]))
const attempts = []
const startedAt = new Date().toISOString()
try {
  process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
  process.env.DEEPSEEK_API_KEY = proxy.token
  process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL

  for (const arm of armCatalog) {
    const attemptId = `${manifest.protocolId}-${arm.id}-${Date.now()}`
    const attemptDir = join(artifactsRoot, arm.id)
    const workspace = join(attemptDir, 'workspace')
    await mkdir(attemptDir, { recursive: true })
    await cp(fixtureRoot, workspace, { recursive: true, force: true })
    const rootSessionId = `plan-lattice-v21-${task.id}-${arm.id}`
    await activate(proxy, attemptId)
    await budgetProxy.activate(attemptId)
    process.stderr.write(`starting ${arm.id} on ${task.id}\n`)

    const result = await runHarnessTask({
      runtimeArtifacts: {
        hostHarness: {
          pathEnvironmentVariable: manifest.harness.runtimePathEnvironmentVariable,
          sha256: manifest.harness.hostRuntimeSha256,
        },
      },
      harnessCommit: manifest.harness.commit,
      attemptDir,
      workspace,
      prompt: task.initialPrompt,
      arm,
      pluginCommit: arm.plugin === 'none' ? undefined : manifest.candidate.commit,
      pluginPackagePath: arm.plugin === 'none' ? undefined : frozenCandidatePackage.path,
      pluginPackageDigest: arm.plugin === 'none' ? undefined : frozenCandidatePackage.digest,
      sessionId: rootSessionId,
      attemptId,
      forbiddenReadRoots: [
        ...historicalArtifactRoots,
        ...attempts.map(attempt => attempt.attemptDir),
      ],
      permissionMode: manifest.executionBoundary.dshPermissionMode,
      timeoutMs: manifest.model.timeoutMs,
      maxRecoveryEpochs: 1,
      stageProtocol: buildProtocol(rootSessionId),
    })

    const finalGrade = runGrader(workspace)
    const delegatedStage = result.stages?.find(stage => stage.id === 'delegated-summary')
    const childReportGrade = delegatedStage?.snapshotPath === undefined
      ? undefined
      : runGrader(delegatedStage.snapshotPath, 'report')
    const budget = budgetProxy.snapshot()
    const budgetWithinLimits = budgetSnapshotWithinLimits(budget)
    const delegation = result.foregroundDelegations?.[0]
    const childLineage = delegation === undefined
      ? undefined
      : result.sessions?.find(session => session.id === delegation.childSessionId)
    const expectedStageIds = task.stages.map(stage => stage.id)
    const observedStageIds = result.stages?.map(stage => stage.id) ?? []
    let continuity
    try {
      continuity = await auditPersistentNativeContinuity(join(attemptDir, 'sessions'), {
        expectedSessionIds: [
          rootSessionId,
          ...new Set((result.foregroundDelegations ?? []).map(item => item.childSessionId)),
        ],
        maxSnapshotBytes: manifest.thresholds.maximumRecoverySnapshotBytes,
      })
    } catch (error) {
      continuity = {
        valid: false,
        files: [],
        totalOwnReplacements: 0,
        totalSnapshots: 0,
        totalSnapshotBytes: 0,
        maximumObservedSnapshotBytes: 0,
        sessions: [],
        violations: [{ kind: 'persistent-session-audit-failed', detail: String(error?.message ?? error) }],
      }
    }
    const lifecycle = {
      allStagesCompleted: result.allStagesCompleted === true && observedStageIds.length === expectedStageIds.length,
      exactStageOrder: JSON.stringify(observedStageIds) === JSON.stringify(expectedStageIds),
      rootSessionContinuity: result.stages?.filter(stage => stage.actor === 'root')
        .every(stage => stage.sessionId === rootSessionId) === true,
      materialRevisionObserved: observedStageIds.includes('material-revision'),
      compactionSummaries: result.compactionSummaries >= manifest.thresholds.minimumCandidateCompactionSummaries,
      surfaceReplacements: result.surfaceReplacements >= manifest.thresholds.minimumCandidateSurfaceReplacements,
      processEpochs: result.processEpochs >= manifest.thresholds.minimumCandidateProcessEpochs,
      foregroundDelegationCount: result.foregroundDelegations?.length === manifest.thresholds.requiredForegroundDelegationsPerArm,
      nativeForegroundPair: delegation !== undefined
        && Number.isSafeInteger(delegation.callSeq)
        && Number.isSafeInteger(delegation.resultSeq)
        && delegation.resultSeq > delegation.callSeq,
      childLineage: childLineage?.parentSession === rootSessionId
        && childLineage.origin === 'subagent'
        && childLineage.delegationDepth === 1,
      childDescriptor: childLineage?.subagentDescriptor === true,
      childInitialPromptMatchesModelCall: childLineage?.initialUserTextSha256 === delegation?.promptSha256,
      childInitialPromptIsNativeUserMessage: childLineage?.initialUserSourceKind === 'user',
      childCompletedTurn: Number.isSafeInteger(delegation?.childTerminalSeq),
      childSnapshot: delegatedStage?.snapshotPath !== undefined,
      persistentNativeContinuity: continuity.valid === true,
      matchedSubagentToolSchema: false,
    }
    lifecycle.valid = Object.entries(lifecycle)
      .filter(([name]) => name !== 'matchedSubagentToolSchema')
      .every(([, value]) => value === true)

    const failure = result.status === 0 && result.allStagesCompleted
      ? undefined
      : {
          ...classifyHarnessFailure(result),
          terminalReason: result.terminalReason,
          sessionEvidenceError: result.sessionEvidenceError,
        }
    attempts.push({
      attemptId,
      attemptDir,
      arm: arm.id,
      status: result.status === 0 && result.allStagesCompleted ? 'completed' : 'failed',
      budget,
      budgetWithinLimits,
      pluginIdentity: result.pluginIdentity ?? null,
      metrics: {
        score: finalGrade.score,
        hardRequirementsMissed: finalGrade.hardRequirementsMissed,
        staleRequirementsRetained: finalGrade.staleRequirementsRetained,
        affectedArtifactCoverage: finalGrade.affectedArtifactCoverage,
        childReportCoverage: childReportGrade?.affectedArtifactCoverage ?? null,
        modelTurns: result.modelTurns,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        clarificationQuestions: result.clarificationQuestions,
        processEpochs: result.processEpochs,
        recoveryEpochs: result.recoveryEpochs,
        compactionSummaries: result.compactionSummaries,
        surfaceReplacements: result.surfaceReplacements,
        controlToolCalls: result.controlToolCalls,
        forbiddenAutomaticControlCalls: result.forbiddenAutomaticControlCalls,
        foregroundDelegations: result.foregroundDelegations?.length ?? 0,
        subagentToolSchemaSha256: delegation?.toolSchemaSha256 ?? null,
      },
      lifecycle,
      continuity,
      grade: finalGrade,
      childReportGrade: childReportGrade ?? null,
      stages: result.stages,
      failure: failure ?? null,
    })
    process.stderr.write(`finished ${arm.id}: score ${finalGrade.score}, budget ${budgetWithinLimits ? 'valid' : 'invalid'}\n`)
  }
} finally {
  try { await activate(proxy, null) } catch {}
  restoreEnvironment(previous)
  proxy.server.closeAllConnections?.()
  if (proxy.server.listening) await new Promise(resolveClose => proxy.server.close(resolveClose))
  await budgetProxy.close()
}

const native = attempts.find(attempt => attempt.arm === 'native')
const candidate = attempts.find(attempt => attempt.arm === 'v0.4-native-continuity')
const matchedSchema = typeof native?.metrics?.subagentToolSchemaSha256 === 'string'
  && native.metrics.subagentToolSchemaSha256 === candidate?.metrics?.subagentToolSchemaSha256
for (const attempt of attempts) {
  attempt.lifecycle.matchedSubagentToolSchema = matchedSchema
  attempt.lifecycle.valid = Object.values(attempt.lifecycle).every(value => value === true)
}

const analysis = analyzeV21Pair({ manifest, attempts })
const reportBody = {
  schemaVersion: 1,
  protocolId: manifest.protocolId,
  scope: analysis.scope,
  startedAt,
  completedAt: new Date().toISOString(),
  artifactId,
  task: {
    id: task.id,
    taskSha256: manifest.task.sha256,
    fixtureSha256: manifest.task.fixtureSha256,
    graderSha256: manifest.task.graderSha256,
  },
  harnessCommit: manifest.harness.commit,
  candidateCommit: manifest.candidate.commit,
  driverCommit,
  hostRuntimeSha256: manifest.harness.hostRuntimeSha256,
  frozenManifestDigest: manifest.manifestDigest,
  model: manifest.model,
  executionBoundary: manifest.executionBoundary,
  budgetLimits,
  order: attempts.map(attempt => attempt.arm),
  attempts,
  analysis,
}
const report = { ...reportBody, reportDigest: sha256(reportBody) }
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, canonicalJson(report), { encoding: 'utf8', mode: 0o600 })
process.stdout.write(canonicalJson(report))
if (!analysis.mechanismResultAllowed) process.exitCode = 1
