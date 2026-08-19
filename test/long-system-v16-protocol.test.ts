import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildV16Manifest,
  CANDIDATE_COMMIT,
  HARNESS_COMMIT,
  verifyV16Manifest,
} from '../eval/long-system/v16/freeze.mjs'

const roots: string[] = []
const digest = (character: string) => character.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('V16 native-continuity protocol', () => {
  it('binds the full candidate revision, rc.7 host, default auto route, and lifecycle gates', async () => {
    const manifest = await buildV16Manifest(digest('a'))

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
    expect(manifest.thresholds).toMatchObject({
      minimumEachArmCompactionSummaries: 2,
      minimumEachArmProcessEpochs: 5,
      requireEachArmNativeChildLineage: true,
    })
    expect(manifest.predecessor).toMatchObject({
      protocolId: 'plan-lattice-rc7-native-long-system-v15',
      status: 'executed-negative',
      failureRecord: 'eval/long-system/v15/RESULT.md',
    })
  })

  it('uses DSH-owned compaction, restart, and child delivery instead of a substitute prompt or child session', async () => {
    const root = process.cwd()
    const support = await readFile(join(root, 'eval/long-system/v16/driver/support-plugin/index.js'), 'utf8')
    const runtime = await readFile(join(root, 'eval/long-system/v16/driver/runtime.mjs'), 'utf8')
    const candidate = await readFile(join(root, 'eval/long-system/v16/driver/candidate-wrapper/index.js'), 'utf8')
    const native = await readFile(join(root, 'eval/long-system/v16/driver/native-wrapper/index.js'), 'utf8')
    const run = await readFile(join(root, 'eval/long-system/v16/run-pair.mjs'), 'utf8')

    expect(support).toContain('compaction.compactNow(root')
    expect(support).toContain("subagents.start('spawn'")
    expect(support).toContain("prompt: [{ type: 'text', text: stage.message }]")
    expect(support).toContain('ctx.agents.resume')
    expect(runtime).toContain('native child stage produced no direct subagent session')
    expect(runtime).toContain('native child stage has no matching subagent/start evidence')
    expect(candidate).not.toMatch(/systemPrompt\.section|lattice_open with an empty object/i)
    expect(native).toContain('installLongSystemBoundary(ctx)')
    expect(run).toContain('native.lifecycle.valid && candidate.lifecycle.valid')
    expect(run).not.toMatch(/nativeMaxTokenContinuations|minimumCandidateNativeContinuations/)
  })

  it('rejects a synchronized-looking manifest rewrite when a committed source changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v16-manifest-'))
    roots.push(root)
    const path = join(root, 'frozen-manifest.json')
    const manifest = await buildV16Manifest(digest('b'))
    const tampered = structuredClone(manifest)
    tampered.sources.driverSourceDigest = digest('c')
    await writeFile(path, `${JSON.stringify(tampered)}\n`, 'utf8')

    await expect(verifyV16Manifest(path)).rejects.toThrow(/differs from the current frozen evaluation sources/i)
  })
})
