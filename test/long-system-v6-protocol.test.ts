import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildV6Manifest,
  CANDIDATE_COMMIT,
  HARNESS_COMMIT,
  verifyV6Manifest,
} from '../eval/long-system/v6/freeze.mjs'

const roots: string[] = []
const digest = (character: string) => character.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('V6 rc.7 native long-system protocol', () => {
  it('binds the native candidate, official Harness, fixed arm order, and byte-identical V5 task', async () => {
    const manifest = await buildV6Manifest(digest('a'))

    expect(manifest.candidate.commit).toBe(CANDIDATE_COMMIT)
    expect(manifest.harness).toMatchObject({
      commit: HARNESS_COMMIT,
      tag: 'dsh-v0.1.0-rc.7',
      hostRuntimeSha256: digest('a'),
    })
    expect(manifest.order).toEqual(['native', 'v0.4-lattice'])
    expect(manifest.arms.native).toEqual({ plugin: 'none', shellAdapter: 'workspace-tree' })
    expect(manifest.budget).toEqual({
      maxAgentRequests: 60,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 80_000,
    })

    const root = process.cwd()
    await expect(readFile(join(root, 'eval/long-system/task.json')))
      .resolves.toEqual(await readFile(join(root, 'eval/long-system/v6/task.json')))
    await expect(readFile(join(root, 'eval/long-system/grader.mjs')))
      .resolves.toEqual(await readFile(join(root, 'eval/long-system/v6/grader.mjs')))
  })

  it('rejects a synchronized-looking manifest rewrite when a source commitment changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v6-manifest-'))
    roots.push(root)
    const path = join(root, 'frozen-manifest.json')
    const manifest = await buildV6Manifest(digest('b'))
    const tampered = structuredClone(manifest)
    tampered.sources.driverSourceDigest = digest('c')
    await writeFile(path, `${JSON.stringify(tampered)}\n`, 'utf8')

    await expect(verifyV6Manifest(path)).rejects.toThrow(/differs from the current frozen evaluation sources/i)
  })
})
