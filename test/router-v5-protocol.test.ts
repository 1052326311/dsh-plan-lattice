import { execFileSync, spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('source-disjoint V5 router protocol scaffold', () => {
  const root = process.cwd()
  const v5 = join(root, 'eval/router-corpus/v5')
  const frozenCommit = '80692e10fc5404f42feb2a9cdc670be45a01c824'

  it('binds the protocol to the frozen router runtime', async () => {
    const protocol = await readFile(join(v5, 'protocol.mjs'), 'utf8')
    expect(protocol).toContain(`codeFreezeCommit = '${frozenCommit}'`)
    expect(execFileSync('git', ['rev-parse', frozenCommit], { cwd: root, encoding: 'utf8' }).trim()).toBe(frozenCommit)
    for (const path of ['src/router.ts', 'src/task-invariants.ts', 'src/router-classifier.ts', 'src/router-features.ts', 'src/router-model.ts']) {
      const frozen = execFileSync('git', ['show', `${frozenCommit}:${path}`], { cwd: root })
      const current = await readFile(join(root, path))
      expect(current.equals(frozen), `${path} changed after the V5 code freeze`).toBe(true)
    }
  })

  it('discovers every V1-V4 source file and excludes V5 itself', () => {
    const inventory = JSON.parse(execFileSync('node', [join(v5, 'source-isolation.mjs')], {
      cwd: root,
      encoding: 'utf8',
    })) as {
      files: Array<{ path: string; version: string; digest: string }>
      versions: Record<string, number>
      repositories: string[]
      urls: string[]
    }
    expect(Object.keys(inventory.versions)).toEqual(['v1', 'v2', 'v3', 'v4'])
    expect(Object.values(inventory.versions).every(count => count > 0)).toBe(true)
    expect(inventory.files.every(file => /source/i.test(file.path) && /\.jsonl?$/.test(file.path))).toBe(true)
    expect(inventory.files.every(file => !file.path.includes('/v5/'))).toBe(true)
    expect(new Set(inventory.files.map(file => file.path)).size).toBe(inventory.files.length)
    expect(inventory.repositories.length).toBeGreaterThan(0)
    expect(inventory.urls.length).toBeGreaterThan(0)
  })

  it('defines the authoritative mutation basis and a three-label 120-row freeze', async () => {
    const [rubric, freeze] = await Promise.all([
      readFile(join(v5, 'ANNOTATION_RUBRIC.md'), 'utf8'),
      readFile(join(v5, 'freeze-blind.mjs'), 'utf8'),
    ])
    expect(rubric).toContain('basisCompleteness')
    expect(rubric).toContain('expiryExposure')
    expect(rubric).toContain('staleImpact')
    expect(rubric).toContain('`probe` is not an annotation label')
    expect(freeze).toContain("targetPerLanguage")
    expect(freeze).toContain("probe is prediction-only")

    const protocol = await readFile(join(v5, 'protocol.mjs'), 'utf8')
    expect(protocol).toContain("targetPerLanguage = { bypass: 30, contract: 18, lattice: 12 }")
    expect(protocol).toContain('total: 120')
    expect(protocol).toContain('english: 60')
    expect(protocol).toContain('chinese: 60')
    expect(protocol).toContain('bypass: 60')
    expect(protocol).toContain('contract: 36')
    expect(protocol).toContain('lattice: 24')
  })

  it('makes evaluation a one-time immutable first reveal', async () => {
    const [evaluate, freeze] = await Promise.all([
      readFile(join(v5, 'evaluate-blind.mjs'), 'utf8'),
      readFile(join(v5, 'freeze-blind.mjs'), 'utf8'),
    ])
    expect(evaluate).toContain("evidenceStatus: 'immutable-first-reveal'")
    expect(evaluate).toContain('writeExclusive(resultPath')
    expect(evaluate).toContain('refusing to overwrite the immutable V5 first reveal')
    expect(freeze).toContain("predictionDomain: [...routes, 'probe']")
  })

  it('ships no V5 candidates, annotations, labels, manifests, or results yet', async () => {
    const files = await readdir(v5)
    expect(files.sort()).toEqual([
      'ANNOTATION_RUBRIC.md',
      'collect-candidates.mjs',
      'evaluate-blind.mjs',
      'freeze-blind.mjs',
      'protocol.mjs',
      'source-isolation.mjs',
    ])
  })

  it('requires an external unrevealed source config before collection', () => {
    const run = spawnSync('node', [join(v5, 'collect-candidates.mjs')], { cwd: root, encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(`${run.stdout}\n${run.stderr}`).toContain('--config <unrevealed-source-config.json>')
  })
})
