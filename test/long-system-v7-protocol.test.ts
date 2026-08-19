import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildV7Manifest,
  CANDIDATE_COMMIT,
  HARNESS_COMMIT,
  verifyV7Manifest,
} from '../eval/long-system/v7/freeze.mjs'

const roots: string[] = []
const digest = (character: string) => character.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('V7 fair native long-system protocol', () => {
  it('binds the native candidate, official Harness, and byte-identical staged task', async () => {
    const manifest = await buildV7Manifest(digest('a'))

    expect(manifest.candidate.commit).toBe(CANDIDATE_COMMIT)
    expect(manifest.harness).toMatchObject({
      commit: HARNESS_COMMIT,
      tag: 'dsh-v0.1.0-rc.7',
      hostRuntimeSha256: digest('a'),
    })
    expect(manifest.order).toEqual(['native', 'v0.4-lattice'])
    expect(manifest.arms.native).toEqual({ plugin: 'none', shellAdapter: 'workspace-tree' })

    const root = process.cwd()
    await expect(readFile(join(root, 'eval/long-system/v6/task.json')))
      .resolves.toEqual(await readFile(join(root, 'eval/long-system/v7/task.json')))
    await expect(readFile(join(root, 'eval/long-system/v6/grader.mjs')))
      .resolves.toEqual(await readFile(join(root, 'eval/long-system/v7/grader.mjs')))
  })

  it('contains no candidate-only task execution coaching', async () => {
    const root = process.cwd()
    const candidate = await readFile(join(root, 'eval/long-system/v7/driver/candidate-wrapper/index.js'), 'utf8')
    const native = await readFile(join(root, 'eval/long-system/v7/driver/native-wrapper/index.js'), 'utf8')
    const commonCandidate = await readFile(join(root, 'eval/long-system/v7/driver/candidate-wrapper/common-prompt.js'), 'utf8')
    const runtime = await readFile(join(root, 'eval/long-system/v7/driver/runtime.mjs'), 'utf8')

    expect(candidate).not.toMatch(/long-system-protocol|lattice_open with an empty object|Never batch refresh and Bash/i)
    expect(candidate).not.toMatch(/systemPrompt\.section/)
    expect(native).toContain('installLongSystemBoundary(ctx)')
    expect(commonCandidate).toContain('Long-system matched execution boundary')
    expect(runtime).toContain("join(driverRoot, 'candidate-wrapper', name), join(destination, name)")
  })

  it('uses DSH native spawn rather than synthesizing a child session', async () => {
    const root = process.cwd()
    const support = await readFile(join(root, 'eval/long-system/v7/driver/support-plugin/index.js'), 'utf8')
    const runtime = await readFile(join(root, 'eval/long-system/v7/driver/runtime.mjs'), 'utf8')
    const metrics = await readFile(join(root, 'eval/long-system/v7/driver/session-metrics.mjs'), 'utf8')

    expect(support).toContain("subagents.start('spawn'")
    expect(support).toContain('runNativeChildStage(ctx.sessions, ctx.subagents, root, selection, staged.stage)')
    expect(support).toContain('await sessions.flush(run.localAgent.session)')
    expect(support).toContain("prompt: [{ type: 'text', text: stage.message }]")
    expect(support).toContain("ctx.on('subagent/start'")
    expect(support).not.toMatch(/sessionId:\s*stage\.sessionId,[\s\S]{0,400}parentSession/)
    expect(metrics).toContain("subagentDescriptor: session.events.some(event => event.type === 'subagent/descriptor')")
    expect(runtime).toContain('native child stage produced no direct subagent session')
    expect(runtime).toContain('native child stage has no matching subagent/start evidence')
  })

  it('rejects a synchronized-looking manifest rewrite when a source commitment changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v7-manifest-'))
    roots.push(root)
    const path = join(root, 'frozen-manifest.json')
    const manifest = await buildV7Manifest(digest('b'))
    const tampered = structuredClone(manifest)
    tampered.sources.driverSourceDigest = digest('c')
    await writeFile(path, `${JSON.stringify(tampered)}\n`, 'utf8')

    await expect(verifyV7Manifest(path)).rejects.toThrow(/differs from the current frozen evaluation sources/i)
  })
})
