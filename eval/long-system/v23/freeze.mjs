#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { digestTree } from './driver/runtime.mjs'
import {
  CANDIDATE_COMMIT,
  CANDIDATE_TARBALL_SHA256,
  FREE_SMOKE_REPORT_PATH,
  FROZEN_MANIFEST_PATH,
  HARNESS_COMMIT,
  NATIVE_PILOT_REPORT_PATH,
  PROTOCOL_ID,
} from './manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const sourceFiles = [
  'package.json',
  'eval/long-system/v22/RESULT.md',
  'eval/long-system/v23/DSH_SOURCE_MAP.md',
  'eval/long-system/v23/NATIVE_PILOT.json',
  'eval/long-system/v23/PILOT_HISTORY.md',
  'eval/long-system/v23/PREREGISTRATION.md',
  'eval/long-system/v23/freeze.mjs',
  'eval/long-system/v23/manifest.mjs',
  'eval/long-system/v23/manifest.unfrozen.json',
  'eval/long-system/v23/preflight.mjs',
  'eval/long-system/v23/pilot-native.mjs',
  'eval/long-system/v23/analyze.mjs',
  'eval/long-system/v23/analysis.mjs',
  'eval/long-system/v23/continuity-metrics.mjs',
  'eval/long-system/v23/run-pair.mjs',
  'eval/long-system/v23/session-audit.mjs',
  'eval/long-system/v23/smoke.mjs',
  'eval/long-system/v23/grader.mjs',
  'eval/long-system/v23/task.json',
  'eval/long-system/v23/driver/foreground-lifecycle.mjs',
  'eval/long-system/v23/driver/free-foreground-smoke.mjs',
  'eval/long-system/v23/driver/shell-probe.mjs',
  'eval/long-system/v23/driver/runtime.mjs',
  'eval/long-system/v23/driver/session-metrics.mjs',
  'eval/long-system/driver/model-proxy.mjs',
  'eval/pilots/driver/budget-proxy.mjs',
  'eval/v0.4/driver/build-host-harness-runtime.mjs',
  'eval/v0.4/driver/lib/environment.mjs',
  'eval/v0.4/driver/lib/profile.mjs',
  'eval/long-system/v23/tests/foreground-lifecycle.test.mjs',
  'eval/long-system/v23/tests/native-pilot.test.mjs',
  'eval/long-system/v23/tests/package-source.test.mjs',
  'eval/long-system/v23/tests/session-metrics.test.mjs',
  'eval/long-system/v23/tests/analysis.test.mjs',
  'eval/long-system/v23/tests/continuity-metrics.test.mjs',
  'eval/long-system/v23/tests/session-audit.test.mjs',
  'eval/long-system/v23/tests/shell-probe.test.mjs',
]

const sourceTrees = [
  'eval/long-system/v23/fixture',
  'eval/long-system/v23/driver/candidate-wrapper',
  'eval/long-system/v23/driver/native-wrapper',
  'eval/long-system/v23/driver/support-plugin',
  'eval/v0.4/driver/lib',
]

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

function exactCommitId(value, field) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`${field} must be an exact Git commit`)
  return value
}

function exactLocalCommit(value, field) {
  exactCommitId(value, field)
  run('git', ['cat-file', '-e', `${value}^{commit}`])
  return value
}

function exactDigest(value, field) {
  if (!/^[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${field} must be an exact SHA-256 digest`)
  return value
}

function treeAt(commit) {
  return run('git', ['rev-parse', `${commit}^{tree}`])
}

async function readFreeSmoke(path = FREE_SMOKE_REPORT_PATH) {
  const bytes = await readFile(path)
  const report = JSON.parse(bytes.toString('utf8'))
  if (report.schemaVersion !== 1
    || report.protocolId !== PROTOCOL_ID
    || report.status !== 'passed'
    || report.paidModelCalls !== 0
    || report.candidateCommit !== CANDIDATE_COMMIT
    || report.harnessCommit !== HARNESS_COMMIT
    || !/^[0-9a-f]{40}$/.test(report.driverCommit ?? '')
    || !/^[0-9a-f]{64}$/.test(report.hostRuntimeSha256 ?? '')
    || report.installation !== 'passed'
    || report.fiveStageProxyLifecycle !== 'passed'
    || report.foregroundChildDurability !== 'passed'
    || report.matchedSubagentToolSchema !== 'passed'
    || report.realBashMutationAndNodeTest !== 'passed'
    || report.outerSandboxReadDenial !== 'passed'
    || report.dshPermissionMode !== 'danger-full-access-inside-outer-evaluator-sandbox'
    || report.candidateAutomaticControlCalls !== 0
    || report.candidateWorkspaceDshFiles !== 0
    || !Array.isArray(report.arms)
    || report.arms.length !== 2
    || JSON.stringify(report.arms.map(arm => arm.id)) !== JSON.stringify(['native', 'v0.4-native-continuity'])
    || report.arms.some(arm => arm.stageCount !== 5 || arm.processEpochs !== 5
      || arm.foregroundDelegations !== 1 || arm.compactionSummaries < 3
      || arm.surfaceReplacements < 3 || arm.controlToolCalls !== 0
      || arm.todoWrites < 15 || arm.completedTodoWrites < 5 || arm.invalidTodoWrites !== 0
      || arm.workspaceDshFiles !== 0
      || arm.shellProbe?.mutation !== 'passed'
      || arm.shellProbe?.nodeTest !== 'passed'
      || arm.shellProbe?.outerSandboxReadDenial !== 'passed'
      || !/^[0-9a-f]{64}$/.test(arm.shellProbe?.testSourceSha256 ?? '')
      || !/^[0-9a-f]{64}$/.test(arm.subagentToolSchemaSha256 ?? ''))) {
    throw new Error('V23 free CLI smoke report is incomplete or malformed')
  }
  if (report.arms[0].subagentToolSchemaSha256 !== report.arms[1].subagentToolSchemaSha256) {
    throw new Error('V23 free CLI smoke arms exposed different subagent tool schemas')
  }
  if (report.arms[0].workflowSnapshots !== 0
    || report.arms[0].delegatedCapsules !== 0
    || report.arms[1].workflowSnapshots < 5
    || report.arms[1].delegatedCapsules !== 1
    || report.arms[1].maximumContextSnapshotBytes > 65_536) {
    throw new Error('V23 free CLI smoke did not exercise the bounded native-workflow projection')
  }
  if (report.arms[0].shellProbe.testSourceSha256 !== report.arms[1].shellProbe.testSourceSha256) {
    throw new Error('V23 free CLI smoke arms executed different Bash probe sources')
  }
  return { report, digest: sha256(bytes) }
}

export async function readNativePilot({ task, taskBytes, hostRuntimeSha256, driverCommit }, path = NATIVE_PILOT_REPORT_PATH) {
  const bytes = await readFile(path)
  const report = JSON.parse(bytes.toString('utf8'))
  const { reportDigest, ...body } = report
  const expectedStages = task.stages.map(stage => stage.id)
  const rootSession = report.continuity?.sessions?.find(session => session.parentSession === null)
  const childSessions = report.continuity?.sessions?.filter(session => session.parentSession !== null) ?? []
  const limits = { maxAgentRequests: 100, maxInputTokens: 4_000_000, maxOutputTokens: 500_000 }
  if (reportDigest !== sha256(body)
    || report.schemaVersion !== 1
    || report.protocolId !== 'plan-lattice-rc7-native-boundary-long-system-v23-native-pilot'
    || report.claimBoundary !== 'Task-selection pilot only. It cannot support a plugin effect, release, ranking, or quality claim.'
    || !/^rc7-native-boundary-long-system-v23-pilot-/.test(report.artifactId ?? '')
    || report.pilotSuitableForPairFreeze !== true
    || report.completeLifecycle !== true
    || report.nonCeiling !== true
    || report.budgetValid !== true
    || report.workingTreeDirty !== false
    || report.harnessCommit !== HARNESS_COMMIT
    || report.hostRuntimeSha256 !== hostRuntimeSha256
    || report.task?.id !== task.id
    || report.task?.sha256 !== sha256(taskBytes)
    || report.task?.fixtureSha256 !== await digestTree(join(repositoryRoot, 'eval/long-system/v23/fixture'))
    || report.task?.graderSha256 !== sha256(await readFile(join(repositoryRoot, 'eval/long-system/v23/grader.mjs')))
    || JSON.stringify(report.budgetLimits) !== JSON.stringify(limits)
    || JSON.stringify(report.budget?.limits) !== JSON.stringify(limits)
    || !Number.isSafeInteger(report.budget?.agentRequests)
    || !Number.isSafeInteger(report.budget?.inputTokens)
    || !Number.isSafeInteger(report.budget?.outputTokens)
    || report.budget?.missingUsageResponses !== 0
    || report.budget?.budgetRejections !== 0
    || report.budget?.agentRequests !== report.result?.modelTurns
    || report.budget?.inputTokens !== report.result?.inputTokens
    || report.budget?.outputTokens !== report.result?.outputTokens
    || report.budget?.agentRequests > limits.maxAgentRequests
    || report.budget?.inputTokens >= limits.maxInputTokens
    || report.budget?.outputTokens > limits.maxOutputTokens
    || report.result?.status !== 0
    || report.result?.terminalReason?.kind !== 'completed'
    || report.result?.failure !== null
    || JSON.stringify(report.result?.observedStageIds) !== JSON.stringify(expectedStages)
    || report.result?.processEpochs !== 5
    || report.result?.recoveryEpochs !== 0
    || report.result?.compactionSummaries < 3
    || report.result?.surfaceReplacements !== 3
    || report.result?.foregroundDelegations !== 1
    || !(report.result?.durationMs > 0)
    || report.continuity?.valid !== true
    || report.continuity?.totalOwnReplacements !== 3
    || report.continuity?.totalSnapshots !== 0
    || report.continuity?.totalSnapshotBytes !== 0
    || report.continuity?.maximumObservedSnapshotBytes !== 0
    || report.continuity?.violations?.length !== 0
    || report.continuity?.sessions?.length !== 2
    || rootSession?.seedLength !== 0
    || rootSession?.firstOwnUserSource !== 'user'
    || rootSession?.ownReplacements?.length !== 3
    || rootSession?.ownReplacements?.some((seq, index, values) => !Number.isSafeInteger(seq)
      || (index > 0 && seq <= values[index - 1]))
    || rootSession?.workflowSnapshots?.length !== 0
    || rootSession?.delegatedCapsules?.length !== 0
    || rootSession?.boundaryRecoveries?.length !== 0
    || childSessions.length !== 1
    || childSessions[0]?.parentSession !== rootSession?.sessionId
    || !(childSessions[0]?.seedLength > 0)
    || childSessions[0]?.firstOwnUserSource !== 'user'
    || childSessions[0]?.ownReplacements?.length !== 0
    || childSessions[0]?.workflowSnapshots?.length !== 0
    || childSessions[0]?.delegatedCapsules?.length !== 0
    || childSessions[0]?.boundaryRecoveries?.length !== 0
    || !(Number.isFinite(report.grade?.score) && report.grade.score < 100 && report.grade.score <= 90)
    || !(report.grade?.hardRequirementsMissed > 0)
    || report.grade?.staleRequirementsRetained !== 0
    || report.grade?.affectedArtifactCoverage !== 1
    || report.childReportGrade?.score !== 100
    || report.childReportGrade?.hardRequirementsMissed !== 0) {
    throw new Error('V23 native task-selection pilot is incomplete, inconsistent, or no longer non-ceiling')
  }
  exactLocalCommit(report.driverCommit, 'native pilot driver commit')
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', report.driverCommit, driverCommit], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  if (ancestor.status !== 0) throw new Error('native pilot driver must precede the frozen V23 driver commit')
  return { report, digest: sha256(bytes) }
}

export async function buildV23Manifest({ hostRuntimeSha256, driverCommit, smokePath = FREE_SMOKE_REPORT_PATH }) {
  exactLocalCommit(CANDIDATE_COMMIT, 'candidate commit')
  // The Harness commit belongs to the separately frozen DSH repository. Its
  // runtime metadata and tarball digest prove the checkout; this repository can
  // validate only the exact immutable identifier.
  exactCommitId(HARNESS_COMMIT, 'Harness commit')
  exactLocalCommit(driverCommit, 'driver commit')
  exactDigest(hostRuntimeSha256, 'host runtime digest')
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', CANDIDATE_COMMIT, driverCommit], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  if (ancestor.status !== 0) throw new Error('candidate commit must precede the V23 driver commit')

  const taskBytes = await readFile(join(repositoryRoot, 'eval/long-system/v23/task.json'))
  const task = JSON.parse(taskBytes.toString('utf8'))
  if (task.schemaVersion !== 1 || !Array.isArray(task.stages) || task.stages.length !== 5) {
    throw new Error('V23 requires the complete five-stage long-system task')
  }
  const sourcePaths = [...sourceFiles, ...sourceTrees]
  const sourceDiff = spawnSync('git', ['diff', '--quiet', driverCommit, '--', ...sourcePaths], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  if (sourceDiff.status !== 0) throw new Error('V23 source differs from the requested frozen driver commit')
  const files = {}
  for (const path of sourceFiles) files[path] = sha256(await readFile(join(repositoryRoot, path)))
  const trees = {}
  for (const path of sourceTrees) trees[path] = await digestTree(join(repositoryRoot, path))
  const driverSourceDigest = sha256({ files, trees })
  const smoke = await readFreeSmoke(smokePath)
  if (smoke.report.driverCommit !== driverCommit) throw new Error('free CLI smoke was not run from the frozen driver commit')
  if (smoke.report.hostRuntimeSha256 !== hostRuntimeSha256) throw new Error('free CLI smoke used a different Harness runtime')
  const nativePilot = await readNativePilot({ task, taskBytes, hostRuntimeSha256, driverCommit })

  const body = {
    schemaVersion: 1,
    protocolId: PROTOCOL_ID,
    status: 'preregistered-unexecuted',
    executionAllowed: true,
    resultClaimsAllowed: false,
    claimBoundary: 'One preregistered paired execution on a complete five-stage system task. It tests preservation of written authority through three native context replacements, five process epochs, one model-authored foreground child, and one material human revision. It can support only this targeted paired result, not a global ranking or general coding-quality claim.',
    predecessor: {
      protocolId: 'plan-lattice-rc7-native-boundary-long-system-v22',
      status: 'executed-negative-zero-quality-delta',
      failureRecord: 'eval/long-system/v22/RESULT.md',
      identityReusable: false,
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      tree: treeAt(CANDIDATE_COMMIT),
      packageVersion: '0.4.0-rc.9',
      verifiedTarballSha256: CANDIDATE_TARBALL_SHA256,
      mode: { activationMode: 'auto', clarificationPolicy: 'never', controlCeiling: 'lattice' },
    },
    driver: {
      commit: driverCommit,
      tree: treeAt(driverCommit),
      sourceDigest: driverSourceDigest,
    },
    harness: {
      commit: HARNESS_COMMIT,
      tag: 'dsh-v0.1.0-rc.7',
      hostRuntimeSha256,
      runtimePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V23_HOST_RUNTIME',
    },
    model: {
      provider: 'DeepSeek',
      id: 'deepseek-v4-flash',
      temperature: 0,
      agentMaxOutputTokens: 32768,
      compactionMaxOutputTokens: 8192,
      timeoutMs: 3_600_000,
    },
    budget: { maxAgentRequests: 100, maxInputTokens: 4_000_000, maxOutputTokens: 500_000 },
    order: ['native', 'v0.4-native-continuity'],
    arms: {
      native: { plugin: 'none', shellAdapter: 'workspace-tree', delegation: 'model-facing-native-foreground-subagent-fork' },
      'v0.4-native-continuity': {
        plugin: 'v0.4.0-candidate',
        activationMode: 'auto',
        clarificationPolicy: 'never',
        controlCeiling: 'lattice',
        shellAdapter: 'workspace-tree',
        delegation: 'model-facing-native-foreground-subagent-fork',
      },
    },
    executionBoundary: {
      outerIsolation: 'darwin-sandbox-exec-denies-repository-and-sibling-artifacts',
      dshPermissionMode: 'danger-full-access',
      rationale: 'DSH runs inside the evaluator sandbox; disabling its nested workspace-write sandbox preserves the outer boundary and keeps Bash executable on Darwin.',
      freeGate: 'real-bash-workspace-mutation-node-test-and-outer-read-denial',
    },
    task: {
      id: task.id,
      sha256: sha256(taskBytes),
      fixtureSha256: await digestTree(join(repositoryRoot, 'eval/long-system/v23/fixture')),
      graderSha256: sha256(await readFile(join(repositoryRoot, 'eval/long-system/v23/grader.mjs'))),
      stages: task.stages.map((stage, index) => ({
        index,
        id: stage.id,
        actor: stage.actor,
        source: stage.source,
        compactBefore: stage.compactBefore === true,
        snapshotAfter: stage.snapshotAfter === true,
        messageSha256: sha256(stage.message === '$INITIAL_PROMPT' ? task.initialPrompt : stage.message),
      })),
    },
    thresholds: {
      requiredCandidateScore: 100,
      minimumPairedScoreDelta: 15,
      maximumCandidateHardRequirementsMissed: 0,
      maximumCandidateStaleRequirementsRetained: 0,
      minimumCandidateAffectedArtifactCoverage: 1,
      maximumCandidateInputTokensExclusive: 4_000_000,
      maximumCandidateInputTokenRatio: 1.1,
      maximumCandidateForbiddenControlCalls: 0,
      maximumCandidateClarificationQuestions: 0,
      minimumCandidateCompactionSummaries: 3,
      minimumCandidateSurfaceReplacements: 3,
      minimumCandidateWorkflowSnapshots: 5,
      requiredCandidateDelegatedCapsules: 1,
      minimumCandidateTodoWrites: 10,
      minimumCandidateCompletedTodoWrites: 5,
      maximumContextSnapshotBytes: 65_536,
      minimumCandidateProcessEpochs: 5,
      requiredForegroundDelegationsPerArm: 1,
      requireExactMatchedSubagentToolSchema: true,
      requireDurableCompletedChildTurn: true,
    },
    freeSmoke: {
      path: 'eval/long-system/v23/FREE_SMOKE.json',
      sha256: smoke.digest,
      driverCommit: smoke.report.driverCommit,
      candidatePackageSha256: smoke.report.candidatePackageSha256,
      subagentToolSchemaSha256: smoke.report.arms[0].subagentToolSchemaSha256,
      shellProbeTestSourceSha256: smoke.report.arms[0].shellProbe.testSourceSha256,
    },
    nativePilot: {
      path: 'eval/long-system/v23/NATIVE_PILOT.json',
      sha256: nativePilot.digest,
      reportDigest: nativePilot.report.reportDigest,
      artifactId: nativePilot.report.artifactId,
      driverCommit: nativePilot.report.driverCommit,
      score: nativePilot.report.grade.score,
      hardRequirementsMissed: nativePilot.report.grade.hardRequirementsMissed,
      inputTokens: nativePilot.report.result.inputTokens,
      outputTokens: nativePilot.report.result.outputTokens,
      modelTurns: nativePilot.report.result.modelTurns,
      processEpochs: nativePilot.report.result.processEpochs,
      surfaceReplacements: nativePilot.report.result.surfaceReplacements,
      foregroundDelegations: nativePilot.report.result.foregroundDelegations,
      persistentSessionAudit: nativePilot.report.continuity.valid,
    },
    sources: { files, trees, driverSourceDigest },
    paidRuns: 0,
  }
  return { ...body, manifestDigest: sha256(body) }
}

export async function verifyV23Manifest(path = FROZEN_MANIFEST_PATH) {
  const frozen = JSON.parse(await readFile(path, 'utf8'))
  const current = await buildV23Manifest({
    hostRuntimeSha256: frozen?.harness?.hostRuntimeSha256,
    driverCommit: frozen?.driver?.commit,
    smokePath: join(repositoryRoot, frozen?.freeSmoke?.path ?? ''),
  })
  if (canonicalJson(current) !== canonicalJson(frozen)) {
    throw new Error('V23 manifest differs from the frozen candidate, driver, runtime, smoke, task, grader, or thresholds')
  }
  return frozen
}

async function main() {
  const write = process.argv.includes('--write')
  const runtimeIndex = process.argv.indexOf('--host-runtime')
  const driverIndex = process.argv.indexOf('--driver-commit')
  if (write) {
    if (runtimeIndex === -1 || driverIndex === -1) {
      throw new Error('--write requires --host-runtime <path> and --driver-commit <commit>')
    }
    const runtimePath = resolve(process.argv[runtimeIndex + 1] ?? '')
    const manifest = await buildV23Manifest({
      hostRuntimeSha256: sha256(await readFile(runtimePath)),
      driverCommit: process.argv[driverIndex + 1],
    })
    await writeFile(FROZEN_MANIFEST_PATH, canonicalJson(manifest), 'utf8')
    process.stdout.write(`${manifest.manifestDigest}\n`)
    return
  }
  const manifest = await verifyV23Manifest()
  process.stdout.write(`${manifest.manifestDigest}\n`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
