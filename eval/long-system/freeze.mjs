#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { digestTree } from '../pilots/driver/lib/runtime.mjs'
import { canonicalJson, sha256 } from '../v0.4/lib/canonical.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultManifestPath = join(repositoryRoot, 'eval/long-system/frozen-manifest.json')
const harnessCommit = '47f943859bef60e4160492346772ded9b24f765a'

const sourceFiles = [
  'eval/long-system/PREREGISTRATION.md',
  'eval/long-system/freeze.mjs',
  'eval/long-system/grader.mjs',
  'eval/long-system/task.json',
  'eval/long-system/driver/model-proxy.mjs',
  'eval/long-system/frozen-manifest-v1.json',
  'eval/long-system/frozen-manifest-v2.json',
  'eval/long-system/frozen-manifest-v3.json',
  'eval/long-system/frozen-manifest-v4.json',
  'eval/long-system/frozen-manifest-v5.json',
  'eval/pilots/driver/budget-proxy.mjs',
  'eval/pilots/driver/lib/runtime.mjs',
  'eval/pilots/driver/lib/session-metrics.mjs',
  'eval/pilots/driver/support-plugin/index.js',
  'eval/pilots/driver/support-plugin/package.json',
  'eval/pilots/rc7-long-system-pilot.mjs',
  'eval/long-system/results/v1-infrastructure-failure.json',
  'eval/long-system/results/v2-budget-failure.json',
  'eval/long-system/results/v3-control-friction-failure.json',
  'eval/long-system/results/v4-max-token-planning-failure.json',
  'eval/long-system/results/v5-history-amplification-failure.json',
  'eval/v0.4/driver/lib/profile.mjs',
]

const sourceTrees = [
  'eval/long-system/fixture',
  'eval/pilots/driver/long-system-candidate-wrapper',
  'eval/pilots/driver/long-system-native-wrapper',
]

export async function buildLongSystemManifest(candidateCommit) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit ?? '')) throw new Error('candidate commit must be an exact Git SHA')
  const task = JSON.parse(await readFile(join(repositoryRoot, 'eval/long-system/task.json'), 'utf8'))
  const files = {}
  for (const path of sourceFiles) files[path] = sha256(await readFile(join(repositoryRoot, path)))
  const trees = {}
  for (const path of sourceTrees) trees[path] = await digestTree(join(repositoryRoot, path))
  const driverSourceDigest = sha256({ files, trees })
  const body = {
    schemaVersion: 1,
    protocolId: 'plan-lattice-rc7-long-system-exploratory-v6',
    status: 'preregistered-unexecuted',
    claimBoundary: 'One targeted exploratory pair cannot establish statistical uplift, a stable release, or a global ranking.',
    predecessor: {
      protocolId: 'plan-lattice-rc7-long-system-exploratory-v5',
      manifestDigest: '411e8d5e0333c7f07a9e181260683a95ba37c31124b368fbf1fbdc968b7c4405',
      driverCommit: 'd545a8a54de4610bcce72b24a11ffe29b4758644',
      status: 'valid-negative-result',
      reason: 'Neither arm completed stage one and both scored 5/100. The v5 candidate used 29 requests and 1,017,437 input tokens because repeated refresh/checkpoint turns and raw tool history amplified its execution payload; native used three requests and 16,774 input tokens.',
      failureRecord: 'eval/long-system/results/v5-history-amplification-failure.json',
    },
    candidateCommit,
    harnessCommit,
    model: {
      provider: 'DeepSeek',
      id: 'deepseek-v4-flash',
      temperature: 0,
      agentMaxOutputTokens: 32768,
      compactionMaxOutputTokens: 8192,
      timeoutMs: 3_600_000,
    },
    budget: { maxAgentRequests: 60, maxInputTokens: 1_000_000, maxOutputTokens: 80_000 },
    order: ['v0.4-lattice', 'native'],
    arms: {
      'v0.4-lattice': {
        plugin: 'v0.4.0-candidate', activationMode: 'always', clarificationPolicy: 'never',
        controlCeiling: 'lattice', shellAdapter: 'workspace-tree',
      },
      native: { plugin: 'none', shellAdapter: 'workspace-tree' },
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
      minimumCandidateCompactionSummaries: 2,
      requireCandidateChildLineage: true,
    },
    sources: { files, trees, driverSourceDigest },
  }
  return { ...body, manifestDigest: sha256(body) }
}

export async function verifyLongSystemManifest(path = defaultManifestPath) {
  const frozen = JSON.parse(await readFile(path, 'utf8'))
  const current = await buildLongSystemManifest(frozen.candidateCommit)
  if (canonicalJson(current) !== canonicalJson(frozen)) {
    throw new Error('long-system frozen manifest does not match the current evaluation sources')
  }
  return frozen
}

async function main() {
  const write = process.argv.includes('--write')
  const candidateIndex = process.argv.indexOf('--candidate-commit')
  const pathIndex = process.argv.indexOf('--manifest')
  const path = pathIndex === -1 ? defaultManifestPath : resolve(process.argv[pathIndex + 1])
  if (write) {
    const candidateCommit = candidateIndex === -1 ? undefined : process.argv[candidateIndex + 1]
    const manifest = await buildLongSystemManifest(candidateCommit)
    await writeFile(path, canonicalJson(manifest), 'utf8')
    process.stdout.write(`${manifest.manifestDigest}\n`)
    return
  }
  const manifest = await verifyLongSystemManifest(path)
  process.stdout.write(`${manifest.manifestDigest}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
