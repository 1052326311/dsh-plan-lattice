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
  PROTOCOL_ID,
} from './manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const sourceFiles = [
  'package.json',
  'eval/long-system/v20/RESULT.md',
  'eval/long-system/v21/DSH_SOURCE_MAP.md',
  'eval/long-system/v21/PREREGISTRATION.md',
  'eval/long-system/v21/freeze.mjs',
  'eval/long-system/v21/manifest.mjs',
  'eval/long-system/v21/manifest.unfrozen.json',
  'eval/long-system/v21/preflight.mjs',
  'eval/long-system/v21/analyze.mjs',
  'eval/long-system/v21/analysis.mjs',
  'eval/long-system/v21/continuity-metrics.mjs',
  'eval/long-system/v21/run-pair.mjs',
  'eval/long-system/v21/session-audit.mjs',
  'eval/long-system/v21/smoke.mjs',
  'eval/long-system/v21/grader.mjs',
  'eval/long-system/v21/task.json',
  'eval/long-system/v21/driver/foreground-lifecycle.mjs',
  'eval/long-system/v21/driver/free-foreground-smoke.mjs',
  'eval/long-system/v21/driver/shell-probe.mjs',
  'eval/long-system/v21/driver/runtime.mjs',
  'eval/long-system/v21/driver/session-metrics.mjs',
  'eval/long-system/driver/model-proxy.mjs',
  'eval/pilots/driver/budget-proxy.mjs',
  'eval/v0.4/driver/build-host-harness-runtime.mjs',
  'eval/v0.4/driver/lib/environment.mjs',
  'eval/v0.4/driver/lib/profile.mjs',
  'eval/long-system/v21/tests/foreground-lifecycle.test.mjs',
  'eval/long-system/v21/tests/session-metrics.test.mjs',
  'eval/long-system/v21/tests/analysis.test.mjs',
  'eval/long-system/v21/tests/continuity-metrics.test.mjs',
  'eval/long-system/v21/tests/session-audit.test.mjs',
  'eval/long-system/v21/tests/shell-probe.test.mjs',
]

const sourceTrees = [
  'eval/long-system/v21/fixture',
  'eval/long-system/v21/driver/candidate-wrapper',
  'eval/long-system/v21/driver/native-wrapper',
  'eval/long-system/v21/driver/support-plugin',
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
      || arm.foregroundDelegations !== 1 || arm.compactionSummaries < 2
      || arm.surfaceReplacements < 2 || arm.controlToolCalls !== 0
      || arm.workspaceDshFiles !== 0
      || arm.shellProbe?.mutation !== 'passed'
      || arm.shellProbe?.nodeTest !== 'passed'
      || arm.shellProbe?.outerSandboxReadDenial !== 'passed'
      || !/^[0-9a-f]{64}$/.test(arm.shellProbe?.testSourceSha256 ?? '')
      || !/^[0-9a-f]{64}$/.test(arm.subagentToolSchemaSha256 ?? ''))) {
    throw new Error('V21 free CLI smoke report is incomplete or malformed')
  }
  if (report.arms[0].subagentToolSchemaSha256 !== report.arms[1].subagentToolSchemaSha256) {
    throw new Error('V21 free CLI smoke arms exposed different subagent tool schemas')
  }
  if (report.arms[0].shellProbe.testSourceSha256 !== report.arms[1].shellProbe.testSourceSha256) {
    throw new Error('V21 free CLI smoke arms executed different Bash probe sources')
  }
  return { report, digest: sha256(bytes) }
}

export async function buildV21Manifest({ hostRuntimeSha256, driverCommit, smokePath = FREE_SMOKE_REPORT_PATH }) {
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
  if (ancestor.status !== 0) throw new Error('candidate commit must precede the V21 driver commit')

  const taskBytes = await readFile(join(repositoryRoot, 'eval/long-system/v21/task.json'))
  const task = JSON.parse(taskBytes.toString('utf8'))
  if (task.schemaVersion !== 1 || !Array.isArray(task.stages) || task.stages.length !== 5) {
    throw new Error('V21 requires the complete five-stage long-system task')
  }
  const files = {}
  for (const path of sourceFiles) files[path] = sha256(await readFile(join(repositoryRoot, path)))
  const trees = {}
  for (const path of sourceTrees) trees[path] = await digestTree(join(repositoryRoot, path))
  const driverSourceDigest = sha256({ files, trees })
  const smoke = await readFreeSmoke(smokePath)
  if (smoke.report.driverCommit !== driverCommit) throw new Error('free CLI smoke was not run from the frozen driver commit')
  if (smoke.report.hostRuntimeSha256 !== hostRuntimeSha256) throw new Error('free CLI smoke used a different Harness runtime')

  const body = {
    schemaVersion: 1,
    protocolId: PROTOCOL_ID,
    status: 'preregistered-unexecuted',
    executionAllowed: true,
    resultClaimsAllowed: false,
    claimBoundary: 'One preregistered paired execution on a complete five-stage system task. It tests preservation of written authority through two native context replacements, five process epochs, one model-authored foreground child, and one material human revision. It can support only this targeted paired result, not a global ranking or general coding-quality claim.',
    predecessor: {
      protocolId: 'plan-lattice-rc7-native-foreground-long-system-v20',
      status: 'executed-negative-ceiling-and-input-budget-failure',
      failureRecord: 'eval/long-system/v20/RESULT.md',
      identityReusable: false,
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      tree: treeAt(CANDIDATE_COMMIT),
      packageVersion: '0.4.0-rc.8',
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
      runtimePathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V21_HOST_RUNTIME',
    },
    model: {
      provider: 'DeepSeek',
      id: 'deepseek-v4-flash',
      temperature: 0,
      agentMaxOutputTokens: 32768,
      compactionMaxOutputTokens: 1024,
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
      fixtureSha256: await digestTree(join(repositoryRoot, 'eval/long-system/v21/fixture')),
      graderSha256: sha256(await readFile(join(repositoryRoot, 'eval/long-system/v21/grader.mjs'))),
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
      minimumCandidateCompactionSummaries: 2,
      minimumCandidateSurfaceReplacements: 2,
      minimumCandidateRecoverySnapshots: 2,
      maximumRecoverySnapshotBytes: 65_536,
      minimumCandidateProcessEpochs: 5,
      requiredForegroundDelegationsPerArm: 1,
      requireExactMatchedSubagentToolSchema: true,
      requireDurableCompletedChildTurn: true,
    },
    freeSmoke: {
      path: 'eval/long-system/v21/FREE_SMOKE.json',
      sha256: smoke.digest,
      driverCommit: smoke.report.driverCommit,
      candidatePackageSha256: smoke.report.candidatePackageSha256,
      subagentToolSchemaSha256: smoke.report.arms[0].subagentToolSchemaSha256,
      shellProbeTestSourceSha256: smoke.report.arms[0].shellProbe.testSourceSha256,
    },
    sources: { files, trees, driverSourceDigest },
    paidRuns: 0,
  }
  return { ...body, manifestDigest: sha256(body) }
}

export async function verifyV21Manifest(path = FROZEN_MANIFEST_PATH) {
  const frozen = JSON.parse(await readFile(path, 'utf8'))
  const current = await buildV21Manifest({
    hostRuntimeSha256: frozen?.harness?.hostRuntimeSha256,
    driverCommit: frozen?.driver?.commit,
    smokePath: join(repositoryRoot, frozen?.freeSmoke?.path ?? ''),
  })
  if (canonicalJson(current) !== canonicalJson(frozen)) {
    throw new Error('V21 manifest differs from the frozen candidate, driver, runtime, smoke, task, grader, or thresholds')
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
    const manifest = await buildV21Manifest({
      hostRuntimeSha256: sha256(await readFile(runtimePath)),
      driverCommit: process.argv[driverIndex + 1],
    })
    await writeFile(FROZEN_MANIFEST_PATH, canonicalJson(manifest), 'utf8')
    process.stdout.write(`${manifest.manifestDigest}\n`)
    return
  }
  const manifest = await verifyV21Manifest()
  process.stdout.write(`${manifest.manifestDigest}\n`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
