#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { budgetSnapshotWithinLimits, startPilotBudgetProxy } from './driver/budget-proxy.mjs'
import { digestTree, runHarnessTask } from './driver/lib/runtime.mjs'
import { verifyLongSystemManifest } from '../long-system/freeze.mjs'

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const workspaceRoot = dirname(repositoryRoot)
const harnessCommit = '47f943859bef60e4160492346772ded9b24f765a'
const candidateCommit = process.env.PLAN_LATTICE_PILOT_CANDIDATE_COMMIT
const hostRuntime = process.env.PLAN_LATTICE_PILOT_HOST_RUNTIME
const hostRuntimeSha256 = process.env.PLAN_LATTICE_PILOT_HOST_RUNTIME_SHA256
const apiKey = process.env.DEEPSEEK_API_KEY
const taskPath = join(repositoryRoot, 'eval/long-system/task.json')
const fixtureRoot = join(repositoryRoot, 'eval/long-system/fixture')
const graderPath = join(repositoryRoot, 'eval/long-system/grader.mjs')
const timeoutMs = 3_600_000
const budgetLimits = { maxAgentRequests: 60, maxInputTokens: 1_000_000, maxOutputTokens: 80_000 }
const artifactId = `rc7-long-system-${new Date().toISOString().replace(/[:.]/g, '-')}`
const artifactsRoot = resolve(process.env.PLAN_LATTICE_PILOT_ARTIFACTS_ROOT
  ?? join(workspaceRoot, '.plan-lattice-eval', 'long-system', artifactId))
const outputPath = resolve(process.env.PLAN_LATTICE_PILOT_OUTPUT
  ?? join(artifactsRoot, 'paired-report.json'))
const armCatalog = [
  {
    id: 'v0.4-lattice',
    plugin: 'v0.4.0-candidate',
    activationMode: 'always',
    clarificationPolicy: 'never',
    controlCeiling: 'lattice',
    shellAdapter: 'workspace-tree',
  },
  { id: 'native', plugin: 'none', shellAdapter: 'workspace-tree' },
]
const requestedArmIds = (process.env.PLAN_LATTICE_PILOT_ARMS ?? armCatalog.map(arm => arm.id).join(','))
  .split(',').map(value => value.trim()).filter(Boolean)
const selectedArms = requestedArmIds.map(id => {
  const arm = armCatalog.find(candidate => candidate.id === id)
  assert.ok(arm, `unknown long-system pilot arm ${id}`)
  return arm
})

if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')
if (!hostRuntime) throw new Error('PLAN_LATTICE_PILOT_HOST_RUNTIME is required')
assert.match(hostRuntimeSha256 ?? '', /^[0-9a-f]{64}$/, 'host runtime digest is required')
assert.match(candidateCommit ?? '', /^[0-9a-f]{40}$/, 'candidate commit must be exact')
assert.equal(new Set(requestedArmIds).size, requestedArmIds.length, 'pilot arm ids must be unique')

const driverCommitResult = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
assert.equal(driverCommitResult.status, 0, 'pilot driver commit is unavailable')
const driverCommit = driverCommitResult.stdout.trim()
assert.match(driverCommit, /^[0-9a-f]{40}$/, 'pilot driver commit must be exact')
const gitStatus = spawnSync('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
assert.equal(gitStatus.status, 0, 'pilot worktree status failed')
assert.equal(gitStatus.stdout.trim(), '', 'pilot must start from a clean committed worktree')
const candidateExists = spawnSync('git', ['-C', repositoryRoot, 'cat-file', '-e', `${candidateCommit}^{commit}`])
assert.equal(candidateExists.status, 0, 'candidate commit is unavailable in the pilot repository')
assert.notEqual(driverCommit, candidateCommit, 'pilot driver commit must follow the frozen candidate commit')
const candidateIsAncestor = spawnSync('git', [
  '-C', repositoryRoot, 'merge-base', '--is-ancestor', candidateCommit, driverCommit,
])
assert.equal(candidateIsAncestor.status, 0, 'candidate commit must be an ancestor of the pilot driver commit')
const frozenManifest = await verifyLongSystemManifest()
assert.equal(frozenManifest.candidateCommit, candidateCommit, 'pilot candidate does not match the frozen manifest')
assert.equal(frozenManifest.harnessCommit, harnessCommit, 'pilot Harness commit does not match the frozen manifest')
assert.deepEqual(frozenManifest.budget, budgetLimits, 'pilot budget does not match the frozen manifest')
for (const arm of armCatalog) assert.deepEqual(frozenManifest.arms[arm.id], Object.fromEntries(Object.entries(arm).filter(([key]) => key !== 'id')))

const { sha256 } = await import(new URL('../v0.4/lib/canonical.mjs', import.meta.url))
const { startModelProxy } = await import(new URL('../long-system/driver/model-proxy.mjs', import.meta.url))
assert.equal(sha256(await readFile(hostRuntime)), hostRuntimeSha256, 'host Harness runtime digest mismatch')
const task = JSON.parse(await readFile(taskPath, 'utf8'))
assert.equal(task.schemaVersion, 1)
assert.ok(Array.isArray(task.stages) && task.stages.length === 5)

function buildProtocol(rootSessionId) {
  const childSessionId = `${rootSessionId}-report-child`
  return {
    schemaVersion: 1,
    taskId: task.id,
    stages: task.stages.map(stage => ({
      ...stage,
      message: stage.message === '$INITIAL_PROMPT' ? task.initialPrompt : stage.message,
      sessionId: stage.actor === 'root' ? rootSessionId : childSessionId,
      ...(stage.actor === 'child' ? { parentSessionId: rootSessionId } : {}),
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
  if (value?.schemaVersion !== 1 || !Number.isFinite(value.score)) throw new Error('hidden grader returned invalid output')
  return value
}

async function activate(proxy, attemptId) {
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify({ attemptId }),
  })
  assert.equal(response.status, 200, `failed to activate ${attemptId}`)
}

await mkdir(artifactsRoot, { recursive: true })
const historicalArtifactRoots = (await readdir(dirname(artifactsRoot), { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && resolve(dirname(artifactsRoot), entry.name) !== artifactsRoot)
  .map(entry => resolve(dirname(artifactsRoot), entry.name))
const keys = generateKeyPairSync('ed25519')
const budgetProxy = await startPilotBudgetProxy({
  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  auditPath: join(artifactsRoot, 'budget-audit.jsonl'),
  limits: budgetLimits,
})
const proxy = await startModelProxy({
  apiKey: budgetProxy.token,
  baseURL: budgetProxy.hostBaseURL,
  auditPath: join(artifactsRoot, 'proxy-audit.jsonl'),
  signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  signingLedgerPath: join(artifactsRoot, 'signing-ledger.jsonl'),
  signingLedgerId: 'plan-lattice-rc7-long-system-exploratory-pilot',
  executionEnvelopeDigest: sha256(await readFile(taskPath)),
  host: '127.0.0.1',
})

const previous = Object.fromEntries([
  'PLAN_LATTICE_CREDENTIAL_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  'PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN',
].map(name => [name, process.env[name]]))
const attempts = []
const startedAt = new Date().toISOString()
try {
  process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
  process.env.DEEPSEEK_API_KEY = proxy.token
  process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL
  process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN = proxy.oracleToken

  for (const arm of selectedArms) {
    const attemptId = `long-system-${arm.id}-${Date.now()}`
    const attemptDir = join(artifactsRoot, arm.id)
    const workspace = join(attemptDir, 'workspace')
    await mkdir(attemptDir, { recursive: true })
    await cp(fixtureRoot, workspace, { recursive: true, force: true })
    const rootSessionId = `plan-lattice-long-system-${task.id}-${arm.id}`
    const stageProtocol = buildProtocol(rootSessionId)
    await activate(proxy, attemptId)
    await budgetProxy.activate(attemptId)
    process.stderr.write(`starting ${arm.id} on ${task.id}\n`)
    const result = await runHarnessTask({
      runtimeArtifacts: { hostHarness: { pathEnvironmentVariable: 'PLAN_LATTICE_PILOT_HOST_RUNTIME', sha256: hostRuntimeSha256 } },
      harnessCommit,
      attemptDir,
      workspace,
      prompt: task.initialPrompt,
      arm,
      pluginCommit: arm.plugin === 'none' ? undefined : candidateCommit,
      sessionId: rootSessionId,
      attemptId,
      forbiddenReadRoots: [
        ...historicalArtifactRoots,
        ...attempts.map(attempt => attempt.attemptDir),
      ],
      permissionMode: 'danger-full-access',
      timeoutMs,
      maxRecoveryEpochs: 1,
      stageProtocol,
    })
    const finalGrade = runGrader(workspace)
    const childStage = result.stages?.find(stage => stage.id === 'delegated-reporting')
    const childReportGrade = childStage?.snapshotPath === undefined
      ? undefined
      : runGrader(childStage.snapshotPath, 'report')
    const budget = budgetProxy.snapshot()
    const budgetWithinLimits = budgetSnapshotWithinLimits(budget)
    const childSessionId = stageProtocol.stages.find(stage => stage.actor === 'child').sessionId
    const childLineage = result.sessions?.find(session => session.id === childSessionId)
    attempts.push({
      attemptId,
      attemptDir,
      arm: arm.id,
      status: result.status === 0 && result.allStagesCompleted ? 'completed' : 'failed',
      budget,
      budgetWithinLimits,
      metrics: {
        score: finalGrade.score,
        hardRequirementsMissed: finalGrade.hardRequirementsMissed,
        staleRequirementsRetained: finalGrade.staleRequirementsRetained,
        affectedArtifactCoverage: finalGrade.affectedArtifactCoverage,
        childReportScore: childReportGrade?.score ?? null,
        finalReportScore: finalGrade.categories.reporting?.score ?? null,
        crossAgentReportRegression: childReportGrade === undefined
          ? null
          : Math.max(0, childReportGrade.score - (finalGrade.categories.reporting?.score ?? 0)),
        modelTurns: result.modelTurns,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        clarificationQuestions: result.clarificationQuestions,
        processEpochs: result.processEpochs,
        recoveryEpochs: result.recoveryEpochs,
        compactionSummaries: result.compactionSummaries,
        childLineageValid: childLineage?.parentSession === rootSessionId
          && childLineage.origin === 'subagent' && childLineage.delegationDepth === 1,
      },
      grade: finalGrade,
      childReportGrade,
      stages: result.stages,
      failure: result.status === 0 ? undefined : { terminalReason: result.terminalReason, sessionEvidenceError: result.sessionEvidenceError },
    })
    process.stderr.write(`finished ${arm.id}: score ${finalGrade.score}, budget ${budgetWithinLimits ? 'valid' : 'invalid'}\n`)
  }
} finally {
  await activate(proxy, null)
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await new Promise(resolveClose => proxy.server.close(resolveClose))
  await budgetProxy.close()
}

const native = attempts.find(attempt => attempt.arm === 'native')
const candidate = attempts.find(attempt => attempt.arm === 'v0.4-lattice')
const relativeScore = native?.metrics.score > 0 ? candidate?.metrics.score / native.metrics.score : null
const missReduction = native?.metrics.hardRequirementsMissed > 0
  ? (native.metrics.hardRequirementsMissed - candidate.metrics.hardRequirementsMissed) / native.metrics.hardRequirementsMissed
  : null
const thresholds = frozenManifest.thresholds
const positiveExploratorySignal = Boolean(native && candidate
  && native.status === 'completed' && candidate.status === 'completed'
  && native.budgetWithinLimits && candidate.budgetWithinLimits
  && candidate.metrics.score - native.metrics.score >= thresholds.minimumAbsoluteScoreGain
  && relativeScore !== null && relativeScore >= thresholds.minimumRelativeScore
  && missReduction !== null && missReduction >= thresholds.minimumHardRequirementMissReduction
  && Number(candidate.metrics.staleRequirementsRetained) <= thresholds.maximumCandidateStaleRequirementsRetained
  && candidate.metrics.crossAgentReportRegression <= thresholds.maximumCandidateCrossAgentReportRegression
  && candidate.metrics.compactionSummaries >= thresholds.minimumCandidateCompactionSummaries
  && candidate.metrics.childLineageValid === thresholds.requireCandidateChildLineage)

const report = {
  schemaVersion: 1,
  scope: 'preregistered exploratory long-system pair; insufficient for global ranking or stable uplift claim',
  startedAt,
  completedAt: new Date().toISOString(),
  artifactId,
  task: { id: task.id, taskSha256: sha256(await readFile(taskPath)), fixtureSha256: await digestTree(fixtureRoot), graderSha256: sha256(await readFile(graderPath)) },
  harnessCommit,
  candidateCommit,
  driverCommit,
  hostRuntimeSha256,
  frozenManifestDigest: frozenManifest.manifestDigest,
  model: 'deepseek-v4-flash',
  budgetLimits,
  order: attempts.map(attempt => attempt.arm),
  attempts,
  observedComparison: native && candidate ? {
    scoreDelta: candidate.metrics.score - native.metrics.score,
    relativeScore,
    hardRequirementMissReduction: missReduction,
    inputTokenDelta: candidate.metrics.inputTokens - native.metrics.inputTokens,
    durationDeltaMs: candidate.metrics.durationMs - native.metrics.durationMs,
  } : null,
  conclusions: {
    positiveExploratorySignal,
    statisticalUpliftEstablished: false,
    globalBestEstablished: false,
    stableReleaseAllowed: false,
  },
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (attempts.length !== selectedArms.length || attempts.some(attempt => attempt.status !== 'completed' || !attempt.budgetWithinLimits)) {
  process.exitCode = 1
}
