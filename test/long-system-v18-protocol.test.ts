import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildV18Manifest,
  CANDIDATE_COMMIT,
  HARNESS_COMMIT,
  verifyV18Manifest,
} from '../eval/long-system/v18/freeze.mjs'
import { parseSessionMetrics } from '../eval/long-system/v18/driver/session-metrics.mjs'

const roots: string[] = []
const digest = (character: string) => character.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('V18 native-continuity protocol', () => {
  it('binds the full candidate revision, rc.7 host, default auto route, and lifecycle gates', async () => {
    const manifest = await buildV18Manifest(digest('a'))

    expect(manifest.candidate.commit).toBe(CANDIDATE_COMMIT)
    expect(CANDIDATE_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.harness).toMatchObject({
      commit: HARNESS_COMMIT,
      tag: 'dsh-v0.1.0-rc.7',
      hostRuntimeSha256: digest('a'),
    })
    expect(manifest.order).toEqual(['native', 'v0.4-lattice'])
    expect(manifest.arms.native).toEqual({ plugin: 'none', shellAdapter: 'workspace-tree' })
    expect(manifest.arms['v0.4-lattice']).toEqual({
      plugin: 'v0.4.0-candidate', activationMode: 'auto', clarificationPolicy: 'never',
      controlCeiling: 'lattice', shellAdapter: 'workspace-tree',
    })
    expect(manifest.budget).toEqual({ maxAgentRequests: 100, maxInputTokens: 4_000_000, maxOutputTokens: 500_000 })
    expect(manifest.sources.files['eval/long-system/v18/task.json']).toBe('7a1b7fb9518ba01479d66af3b2900563d05213012ab15643463f33f8a5222a6e')
    expect(manifest.sources.files['eval/long-system/v18/grader.mjs']).toBe('f2bab54d39008c305bda8dcaa7252d6ae6569808bea3f782c4930f9c6c9f5676')
    expect(manifest.sources.trees['eval/long-system/v18/fixture']).toBe('051b4df2b9acee44b8599ee29f4bb0723b8bd3a21540c1d6e1f0c2110d2f1d13')
    expect(manifest.thresholds).toMatchObject({
      requiredCandidateScore: 100,
      maximumCandidateHardRequirementsMissed: 0,
      maximumCandidateInputTokensExclusive: 4_000_000,
      maximumCandidateForbiddenControlCalls: 0,
      minimumCandidateCompactionSummaries: 2,
      minimumCandidateSurfaceReplacements: 2,
      minimumCandidateProcessEpochs: 5,
      requireCandidateNativeChildLineage: true,
    })
    expect(manifest.predecessor).toMatchObject({
      protocolId: 'plan-lattice-rc7-native-long-system-v17',
      status: 'executed-negative',
      failureRecord: 'eval/long-system/v17/RESULT.md',
    })
  })

  it('uses DSH-owned compaction, restart, and child delivery instead of a substitute prompt or child session', async () => {
    const root = process.cwd()
    const support = await readFile(join(root, 'eval/long-system/v18/driver/support-plugin/index.js'), 'utf8')
    const runtime = await readFile(join(root, 'eval/long-system/v18/driver/runtime.mjs'), 'utf8')
    const candidate = await readFile(join(root, 'eval/long-system/v18/driver/candidate-wrapper/index.js'), 'utf8')
    const native = await readFile(join(root, 'eval/long-system/v18/driver/native-wrapper/index.js'), 'utf8')
    const run = await readFile(join(root, 'eval/long-system/v18/run-pair.mjs'), 'utf8')
    const smoke = await readFile(join(root, 'eval/long-system/v18/smoke.mjs'), 'utf8')

    expect(support).toContain('compaction.compactNow(root')
    expect(support).toContain("subagents.start('spawn'")
    expect(support).toContain("prompt: [{ type: 'text', text: stage.message }]")
    expect(support).toContain('ctx.agents.resume')
    expect(runtime).toContain('native child stage produced no direct subagent session')
    expect(runtime).toContain('native child stage has no matching subagent/start evidence')
    expect(candidate).not.toMatch(/systemPrompt\.section|lattice_open with an empty object/i)
    expect(native).toContain('installLongSystemBoundary(ctx)')
    expect(run).toContain('candidateGatePassed')
    expect(run).not.toContain("native.status === 'completed' && candidate.status === 'completed'")
    expect(run).not.toMatch(/nativeMaxTokenContinuations|minimumCandidateNativeContinuations/)
    expect(smoke).toContain('startModelProxy')
    expect(smoke).toContain('all five native lifecycle stages must be reachable')
    expect(smoke).toContain('child model request must pass the frozen proxy contract')
  })

  it('reads native surface replacements and forbidden restart controls from durable Session events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v18-session-'))
    roots.push(root)
    const sessionRoot = join(root, 'root-session')
    await mkdir(sessionRoot)
    const rows = [
      { type: 'session', version: 1, id: 'root-session' },
      { type: 'compaction/summary', seq: 0, time: 1, data: { usage: { inputTokens: 10, outputTokens: 2 } } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [] }, surfaceOp: { op: 'replace', start: 0, end: 0 } },
      { type: 'tool/call', seq: 2, time: 3, data: { name: 'lattice_route' } },
      { type: 'tool/call', seq: 3, time: 4, data: { name: 'lattice_refresh_context' } },
      { type: 'turn/end', seq: 4, time: 5, data: { reason: { kind: 'completed' } } },
    ]
    await writeFile(join(sessionRoot, 'session.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const metrics = await parseSessionMetrics(root, { expectedSessionId: 'root-session' })
    expect(metrics.compactionSummaries).toBe(1)
    expect(metrics.surfaceReplacements).toBe(1)
    expect(metrics.controlToolCalls.map(call => call.name)).toEqual(['lattice_route', 'lattice_refresh_context'])
    expect(metrics.forbiddenAutomaticControlCalls.map(call => call.name)).toEqual(['lattice_route'])
  })

  it('rejects a synchronized-looking manifest rewrite when a committed source changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v18-manifest-'))
    roots.push(root)
    const path = join(root, 'frozen-manifest.json')
    const manifest = await buildV18Manifest(digest('b'))
    const tampered = structuredClone(manifest)
    tampered.sources.driverSourceDigest = digest('c')
    await writeFile(path, `${JSON.stringify(tampered)}\n`, 'utf8')

    await expect(verifyV18Manifest(path)).rejects.toThrow(/differs from the current frozen evaluation sources/i)
  })
})
