#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { digestTree } from './driver/runtime.mjs'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const defaultManifestPath = join(repositoryRoot, 'eval/long-system/v17/frozen-manifest.json')
export const CANDIDATE_COMMIT = '68856eaec8741a30873b881d9bb6b3a7df072e0b'
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'

const sourceFiles = [
  'eval/long-system/v17/PREREGISTRATION.md',
  'eval/long-system/v17/freeze.mjs',
  'eval/long-system/v17/preflight.mjs',
  'eval/long-system/v17/run-pair.mjs',
  'eval/long-system/v17/smoke.mjs',
  'eval/long-system/v17/grader.mjs',
  'eval/long-system/v17/task.json',
  'eval/long-system/v16/RESULT.md',
  'eval/long-system/driver/model-proxy.mjs',
  'eval/pilots/driver/budget-proxy.mjs',
  'eval/long-system/v17/driver/runtime.mjs',
  'eval/long-system/v17/driver/session-metrics.mjs',
  'test/long-system-v17-protocol.test.ts',
]

const sourceTrees = [
  'eval/long-system/v17/fixture',
  'eval/long-system/v17/driver/candidate-wrapper',
  'eval/long-system/v17/driver/native-wrapper',
  'eval/long-system/v17/driver/support-plugin',
  'eval/v0.4/driver/lib',
]

function runtimeDigest(value) {
  if (!/^[0-9a-f]{64}$/.test(value ?? '')) throw new Error('host runtime SHA-256 must be a 64-character hexadecimal digest')
  return value
}

function candidateTree(commit) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', `${commit}^{tree}`], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`candidate ${commit} is unavailable in this repository`)
  return result.stdout.trim()
}

export async function buildV17Manifest(hostRuntimeSha256) {
  const task = JSON.parse(await readFile(join(repositoryRoot, 'eval/long-system/v17/task.json'), 'utf8'))
  if (task.schemaVersion !== 1 || !Array.isArray(task.stages) || task.stages.length !== 5) {
    throw new Error('V17 requires the complete five-stage long-system task')
  }
  const files = {}
  for (const path of sourceFiles) files[path] = sha256(await readFile(join(repositoryRoot, path)))
  const trees = {}
  for (const path of sourceTrees) trees[path] = await digestTree(join(repositoryRoot, path))
  const driverSourceDigest = sha256({ files, trees })
  const body = {
    schemaVersion: 1,
    protocolId: 'plan-lattice-rc7-native-long-system-v17',
    status: 'preregistered-unexecuted',
    claimBoundary: 'This targeted pair tests whether Plan Lattice preserves a written product authority across native DSH context replacement, process restart, child delegation, and a material human revision after both arms start from the same independently validated Foundation fixture. It cannot establish a broad ranking, general coding-quality uplift, or release eligibility by itself. Its arms share exactly the same boundary prompt, hidden tools, workspace Bash channel, task, grader, runtime, model, budget, fixture, and stage sequence; the sole intended treatment difference is installation of the candidate plugin.',
    predecessor: {
      protocolId: 'plan-lattice-rc7-native-long-system-v16',
      status: 'executed-negative',
      reason: 'Both V16 arms reached 2/5 stages before the frozen proxy rejected the real native child UUID. They scored equally while the candidate used substantially more input tokens. V17 keeps the task, fixture, grader, runtime, budgets, and thresholds, fixes the proxy gate, and evaluates the native-contract candidate that removes automatic graph control.',
      failureRecord: 'eval/long-system/v16/RESULT.md',
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      tree: candidateTree(CANDIDATE_COMMIT),
      branchPurpose: 'DSH-native continuity: preserve native Plan Mode, Todo, prompt assembly, compaction, Session recovery, scheduling, and child prompt delivery while anchoring exact current-task authority and gating only protected writes after real continuity boundaries',
    },
    harness: {
      commit: HARNESS_COMMIT,
      tag: 'dsh-v0.1.0-rc.7',
      hostRuntimeSha256: runtimeDigest(hostRuntimeSha256),
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
    order: ['native', 'v0.4-lattice'],
    arms: {
      native: { plugin: 'none', shellAdapter: 'workspace-tree' },
      'v0.4-lattice': {
        plugin: 'v0.4.0-candidate', activationMode: 'auto', clarificationPolicy: 'never',
        controlCeiling: 'lattice', shellAdapter: 'workspace-tree',
      },
    },
    task: {
      id: task.id,
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
      minimumAbsoluteScoreGain: 15,
      minimumRelativeScore: 1.3,
      minimumHardRequirementMissReduction: 0.5,
      maximumCandidateStaleRequirementsRetained: 0,
      maximumCandidateCrossAgentReportRegression: 0,
      minimumEachArmCompactionSummaries: 2,
      minimumEachArmProcessEpochs: 5,
      requireEachArmNativeChildLineage: true,
    },
    sources: { files, trees, driverSourceDigest },
  }
  return { ...body, manifestDigest: sha256(body) }
}

export async function verifyV17Manifest(path = defaultManifestPath) {
  const frozen = JSON.parse(await readFile(path, 'utf8'))
  const current = await buildV17Manifest(frozen?.harness?.hostRuntimeSha256)
  if (canonicalJson(current) !== canonicalJson(frozen)) {
    throw new Error('V17 long-system manifest differs from the current frozen evaluation sources')
  }
  return frozen
}

async function main() {
  const write = process.argv.includes('--write')
  const pathIndex = process.argv.indexOf('--manifest')
  const runtimeIndex = process.argv.indexOf('--host-runtime')
  const path = pathIndex === -1 ? defaultManifestPath : resolve(process.argv[pathIndex + 1] ?? '')
  if (write) {
    if (runtimeIndex === -1) throw new Error('--write requires --host-runtime <path>')
    const manifest = await buildV17Manifest(sha256(await readFile(resolve(process.argv[runtimeIndex + 1] ?? ''))))
    await writeFile(path, canonicalJson(manifest), 'utf8')
    process.stdout.write(`${manifest.manifestDigest}\n`)
    return
  }
  const manifest = await verifyV17Manifest(path)
  process.stdout.write(`${manifest.manifestDigest}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
