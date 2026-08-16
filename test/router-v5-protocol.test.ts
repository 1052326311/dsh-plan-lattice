import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('source-disjoint V5 router protocol scaffold', () => {
  const root = process.cwd()
  const v5 = join(root, 'eval/router-corpus/v5')
  const frozenCommit = 'e5020a07f6e059a4bae9c1f972569e6c484475df'
  const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

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
    const [rubric, freeze, annotationSchema] = await Promise.all([
      readFile(join(v5, 'ANNOTATION_RUBRIC.md'), 'utf8'),
      readFile(join(v5, 'freeze-blind.mjs'), 'utf8'),
      readFile(join(v5, 'annotation-schema.mjs'), 'utf8'),
    ])
    expect(rubric).toContain('basisCompleteness')
    expect(rubric).toContain('expiryExposure')
    expect(rubric).toContain('staleImpact')
    expect(rubric).toContain('`probe` is not an annotation label')
    expect(freeze).toContain("targetPerLanguage")
    expect(annotationSchema).toContain('probe is prediction-only')

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

  it('uses exclusive creation for collection, freeze, and first reveal artifacts', async () => {
    const [collect, freeze, evaluate] = await Promise.all([
      readFile(join(v5, 'collect-candidates.mjs'), 'utf8'),
      readFile(join(v5, 'freeze-blind.mjs'), 'utf8'),
      readFile(join(v5, 'evaluate-blind.mjs'), 'utf8'),
    ])
    for (const name of ['candidates.jsonl', 'sources.jsonl', 'candidate-manifest.json', 'source-config.archive.json']) {
      expect(collect).toContain(name)
    }
    expect(collect).toContain("assertArtifactsAbsent(Object.values(outputPaths), 'V5 collection')")
    expect(collect.match(/writeExclusive\(outputPaths\./g)).toHaveLength(4)
    for (const name of ['blind-v5.prompts.jsonl', 'blind-v5.labels.jsonl', 'blind-v5.sources.jsonl', 'blind-v5.manifest.json']) {
      expect(freeze).toContain(name)
    }
    expect(freeze).toContain("assertArtifactsAbsent(Object.values(outputPaths), 'V5 freeze')")
    expect(freeze.match(/writeExclusive\(outputPaths\./g)).toHaveLength(4)
    expect(evaluate).toContain('writeExclusive(resultPath')
    expect(collect).toContain('isUsefulIssue')
    expect(collect).toContain('collector: sha256(collectorText)')
    expect(freeze).toContain('V5 collector changed after candidate collection')
  })

  it('rejects overwrite attempts without changing the first artifact', async () => {
    const protocol = await import(pathToFileURL(join(v5, 'protocol.mjs')).href)
    const directory = await mkdtemp(join(tmpdir(), 'plan-lattice-v5-'))
    const artifact = join(directory, 'immutable.json')
    try {
      await protocol.assertArtifactsAbsent([artifact], 'test stage')
      await protocol.writeExclusive(artifact, 'first')
      await expect(protocol.writeExclusive(artifact, 'second')).rejects.toThrow('first reveal is immutable')
      await expect(protocol.assertArtifactsAbsent([artifact], 'test stage')).rejects.toThrow('refusing to overwrite immutable evidence')
      expect(await readFile(artifact, 'utf8')).toBe('first')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('strictly validates complete primary annotations and all three causal axes', async () => {
    const schema = await import(pathToFileURL(join(v5, 'annotation-schema.mjs')).href)
    const candidates = [{ id: 'v5-001' }, { id: 'v5-002' }]
    const valid = (id: string, route: string, outcomeCritical: boolean) => ({
      id,
      route,
      outcomeCritical,
      confidence: 'high',
      authoritativeMutationBasis: {
        basisCompleteness: route === 'bypass' ? 'complete' : 'partial',
        expiryExposure: 'low',
        staleImpact: route === 'bypass' ? 'low' : 'medium',
      },
      rationale: 'Causal basis assessment.',
    })
    const rows = [valid('v5-001', 'bypass', false), valid('v5-002', 'contract', true)]
    expect(schema.validateAnnotationSet(candidates, rows, ['bypass', 'contract', 'lattice'], 'A').size).toBe(2)
    expect(() => schema.validateAnnotationSet(candidates, rows.slice(0, 1), ['bypass', 'contract', 'lattice'], 'A')).toThrow('missing v5-002')
    expect(() => schema.validateAnnotationSet(candidates, [rows[0], { ...rows[1], route: 'probe' }], ['bypass', 'contract', 'lattice'], 'A')).toThrow('probe is prediction-only')
    expect(() => schema.validateAnnotationSet(candidates, [rows[0], { ...rows[1], route: 'bypass' }], ['bypass', 'contract', 'lattice'], 'A')).toThrow('outcomeCritical=true with bypass')
    const invalidAxis = {
      ...rows[1],
      authoritativeMutationBasis: { ...rows[1].authoritativeMutationBasis, expiryExposure: 'extreme' },
    }
    expect(() => schema.validateAnnotationSet(candidates, [rows[0], invalidAxis], ['bypass', 'contract', 'lattice'], 'A')).toThrow('expiryExposure must be low, medium, high')
  })

  it('builds only a disagreement packet and an immutable agreement report', async () => {
    const [adjudication, packageText] = await Promise.all([
      readFile(join(v5, 'build-adjudication.mjs'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
    ])
    expect(adjudication).toContain("filter(candidate => disagreementSet.has(candidate.id))")
    expect(adjudication).toContain('id: candidate.id')
    expect(adjudication).toContain('language: candidate.language')
    expect(adjudication).toContain('text: candidate.text')
    expect(adjudication).not.toContain('annotationA:')
    expect(adjudication).not.toContain('annotationB:')
    expect(adjudication).toContain("assertArtifactsAbsent(Object.values(outputPaths), 'V5 adjudication')")
    expect(adjudication.match(/writeExclusive\(outputPaths\./g)).toHaveLength(2)
    expect(packageText).toContain('"router:v5:adjudication": "node eval/router-corpus/v5/build-adjudication.mjs"')
  })

  it('keeps third-annotator packets blind to primary labels, rationales, and axes', async () => {
    const adjudication = await readFile(join(v5, 'build-adjudication.mjs'), 'utf8')
    const packetExpression = adjudication.slice(
      adjudication.indexOf('const packet ='),
      adjudication.indexOf('const axisDisagreements ='),
    )
    expect(packetExpression).not.toMatch(/left\.get|right\.get|route|outcomeCritical/)
    expect(packetExpression).not.toMatch(/rationale|authoritativeMutationBasis|basisCompleteness|expiryExposure|staleImpact/)
    const rubric = await readFile(join(v5, 'ANNOTATION_RUBRIC.md'), 'utf8')
    expect(rubric).toContain('candidate `id`, `language`, and `text`')
    expect(rubric).toContain('never reveals either primary annotation')
  })

  it('preserves the balanced source-disjoint candidate and blind pools', async () => {
    const files = await readdir(v5)
    for (const name of ['candidates.jsonl', 'sources.jsonl', 'source-config.archive.json', 'candidate-manifest.json']) {
      expect(files).toContain(name)
    }
    for (const name of [
      'blind-v5.prompts.jsonl', 'blind-v5.labels.jsonl', 'blind-v5.sources.jsonl',
      'blind-v5.manifest.json', 'blind-v5-results.json',
    ]) expect(files).toContain(name)

    const [candidateText, sourceText, configText, manifestText] = await Promise.all([
      readFile(join(v5, 'candidates.jsonl'), 'utf8'),
      readFile(join(v5, 'sources.jsonl'), 'utf8'),
      readFile(join(v5, 'source-config.archive.json'), 'utf8'),
      readFile(join(v5, 'candidate-manifest.json'), 'utf8'),
    ])
    const manifest = JSON.parse(manifestText)
    expect(manifest.codeFreezeCommit).toBe(frozenCommit)
    expect(manifest.counts).toEqual({ total: 360, english: 180, chinese: 180 })
    expect(manifest.sourceIsolation.overlappingRepositories).toEqual([])
    expect(manifest.sourceIsolation.overlappingUrls).toEqual([])
    expect(manifest.digests.candidates).toBe(sha256(candidateText))
    expect(manifest.digests.sources).toBe(sha256(sourceText))
    expect(manifest.digests.sourceConfig).toBe(sha256(configText))
  })

  it('preserves the immutable V5 first reveal as failed evidence', async () => {
    const [promptText, labelText, sourceText, manifestText, resultText] = await Promise.all([
      readFile(join(v5, 'blind-v5.prompts.jsonl'), 'utf8'),
      readFile(join(v5, 'blind-v5.labels.jsonl'), 'utf8'),
      readFile(join(v5, 'blind-v5.sources.jsonl'), 'utf8'),
      readFile(join(v5, 'blind-v5.manifest.json'), 'utf8'),
      readFile(join(v5, 'blind-v5-results.json'), 'utf8'),
    ])
    const manifest = JSON.parse(manifestText)
    const result = JSON.parse(resultText)
    expect(manifest.codeFreezeCommit).toBe(frozenCommit)
    expect(manifest.counts).toMatchObject({
      total: 120, english: 60, chinese: 60, bypass: 60, contract: 36, lattice: 24,
    })
    expect(manifest.digests).toMatchObject({
      prompts: sha256(promptText), labels: sha256(labelText), sources: sha256(sourceText),
    })
    expect(result.evidenceStatus).toBe('immutable-first-reveal')
    expect(result.manifestDigest).toBe(sha256(manifestText))
    expect(result.releaseGatePassed).toBe(false)
    expect(result.metrics).toMatchObject({
      exactAccuracy: 64 / 120,
      simpleFalseActivationRate: 8 / 60,
      complexCriticalRecall: 27 / 60,
      outcomeCriticalBypass: 22,
      latticeRecall: 3 / 24,
      probeRate: 0,
    })
    expect(Object.values(result.checks).filter(Boolean)).toEqual([true])
    expect(result.failures).toHaveLength(56)
  })

  it('requires an external unrevealed source config before collection', () => {
    const run = spawnSync('node', [join(v5, 'collect-candidates.mjs')], { cwd: root, encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(`${run.stdout}\n${run.stderr}`).toContain('--config <unrevealed-source-config.json>')
  })
})
