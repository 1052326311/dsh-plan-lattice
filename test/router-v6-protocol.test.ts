import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('source-disjoint V6 causal protocol', () => {
  const root = process.cwd()
  const v6 = join(root, 'eval/router-corpus/v6')
  const codeFreeze = '3d34a2e'
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  const jsonLines = (value: string) => value.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

  it('binds collection to the exact post-V5 causal runtime', async () => {
    const protocol = await import(`${pathToFileURL(join(v6, 'protocol.mjs')).href}?test=${Date.now()}`)
    const exact = execFileSync('git', ['rev-parse', codeFreeze], { cwd: root, encoding: 'utf8' }).trim()
    expect(protocol.resolvedCodeFreezeCommit()).toBe(exact)
    const frozen = await protocol.assertFrozenRuntime()
    expect(frozen.exactCommit).toBe(exact)
    expect(frozen.runtimeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(protocol.runtimeFiles).toEqual(['src/router.ts', 'src/task-invariants.ts'])
  })

  it('derives routes from primitive facts rather than accepting route votes', async () => {
    const { deriveLabel } = await import(`${pathToFileURL(join(v6, 'derive-label.mjs')).href}?test=${Date.now()}`)
    const base = {
      episodeEligibility: 'eligible',
      mutationAuthorization: 'write',
      basisClosure: 'closed',
      authorizationEpochs: 'one',
      invalidationDriver: 'none',
      verificationHorizon: 'immediate',
      staleActionLoss: 'low',
      recovery: 'direct',
      causalChain: {
        basisItem: '', invalidationEvent: '', laterMutation: '', staleAction: '', detectionAndConsequence: '',
      },
    }
    expect(deriveLabel(base)).toEqual({ eligible: true, route: 'bypass', outcomeCritical: false })
    expect(deriveLabel({ ...base, basisClosure: 'user-decision-gap' })).toEqual({
      eligible: true, route: 'contract', outcomeCritical: true,
    })
    expect(deriveLabel({ ...base, basisClosure: 'repository-evidence-gap' })).toEqual({
      eligible: true, route: 'probe', outcomeCritical: false,
    })
    expect(deriveLabel({ ...base, staleActionLoss: 'irreversible' })).toEqual({
      eligible: true, route: 'contract', outcomeCritical: true,
    })
    expect(deriveLabel({
      ...base,
      authorizationEpochs: 'many',
      invalidationDriver: 'context-replacement',
      causalChain: {
        basisItem: 'accepted compatibility contract',
        invalidationEvent: 'context compaction replaces visible history',
        laterMutation: 'the agent edits the final compatibility adapter',
        staleAction: 'the adapter follows the obsolete contract',
        detectionAndConsequence: 'integration proof detects a compatibility regression',
      },
    })).toEqual({ eligible: true, route: 'lattice', outcomeCritical: false })
  })

  it('rejects a lattice-shaped label without the complete invalidation chain', async () => {
    const { validateCausalFacts } = await import(`${pathToFileURL(join(v6, 'derive-label.mjs')).href}?test=${Date.now()}`)
    expect(() => validateCausalFacts({
      episodeEligibility: 'eligible',
      mutationAuthorization: 'write',
      basisClosure: 'closed',
      authorizationEpochs: 'many',
      invalidationDriver: 'context-replacement',
      verificationHorizon: 'staged',
      staleActionLoss: 'material',
      recovery: 'planned',
      causalChain: {
        basisItem: 'the plan', invalidationEvent: '', laterMutation: '', staleAction: '', detectionAndConsequence: '',
      },
    })).toThrow('requires a complete chain')
  })

  it('validates one coherent annotation with no route or outcome field', async () => {
    const { validateAnnotation } = await import(`${pathToFileURL(join(v6, 'annotation-schema.mjs')).href}?test=${Date.now()}`)
    const annotation = validateAnnotation({
      id: 'v6-example',
      confidence: 'high',
      rationale: 'One local typo authorizes one reversible write whose rendered page immediately verifies the accepted text.',
      facts: {
        episodeEligibility: 'eligible',
        mutationAuthorization: 'write',
        basisClosure: 'closed',
        authorizationEpochs: 'one',
        invalidationDriver: 'none',
        verificationHorizon: 'immediate',
        staleActionLoss: 'low',
        recovery: 'direct',
        causalChain: {
          basisItem: '', invalidationEvent: '', laterMutation: '', staleAction: '', detectionAndConsequence: '',
        },
      },
      nuisance: {
        reportedIssueSeverity: 'low', implementationScope: 'bounded', runtimeDynamism: 'static',
      },
    })
    expect(annotation.derived).toEqual({ eligible: true, route: 'bypass', outcomeCritical: false })
    expect(annotation).not.toHaveProperty('route')
    expect(annotation).not.toHaveProperty('outcomeCritical')
  })

  it('preregisters four derived strata and strict annotation reliability gates', async () => {
    const protocol = await import(`${pathToFileURL(join(v6, 'protocol.mjs')).href}?test=${Date.now()}`)
    expect(protocol.routes).toEqual(['bypass', 'contract', 'lattice', 'probe'])
    expect(protocol.expectedCounts).toEqual({
      total: 120, english: 60, chinese: 60, bypass: 60, contract: 24, lattice: 24, probe: 12,
    })
    expect(protocol.annotationGates).toEqual({
      routeKappaMin: 0.75, outcomeCriticalKappaMin: 0.75, ordinalWeightedKappaMin: 0.7,
    })
  })

  it('defines the fixed execution envelope and rejects severity shortcuts', async () => {
    const rubric = await readFile(join(v6, 'ANNOTATION_RUBRIC.md'), 'utf8')
    expect(rubric).toContain('clean checkout')
    expect(rubric).toContain('does not operate a production system')
    expect(rubric).toContain('choose `bypass`, `contract`, `lattice`, `probe`')
    expect(rubric).toContain('staleActionLoss')
    expect(rubric).toContain('This is not the severity of the original bug')
    expect(rubric).toContain('Three annotators label every candidate independently')
    expect(rubric).toContain('Fields are never combined by independent majority votes')
  })

  it('discovers all V1-V5 sources while excluding the unrevealed V6 directory', () => {
    const inventory = JSON.parse(execFileSync('node', [join(v6, 'source-isolation.mjs')], {
      cwd: root,
      encoding: 'utf8',
    })) as {
      files: Array<{ path: string; version: string }>
      versions: Record<string, number>
      repositories: string[]
      urls: string[]
    }
    expect(Object.keys(inventory.versions)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5'])
    expect(Object.values(inventory.versions).every(count => count > 0)).toBe(true)
    expect(inventory.files.every(file => !file.path.includes('/v6/'))).toBe(true)
    expect(new Set(inventory.repositories).size).toBe(inventory.repositories.length)
    expect(new Set(inventory.urls).size).toBe(inventory.urls.length)
  })

  it('requires an external unrevealed source config before collection', () => {
    expect(() => execFileSync('node', [join(v6, 'collect-candidates.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow('usage: collect-candidates.mjs')
  })

  it('freezes a source-disjoint bilingual candidate pool before annotation', async () => {
    const protocol = await import(`${pathToFileURL(join(v6, 'protocol.mjs')).href}?test=${Date.now()}`)
    const isolation = await import(`${pathToFileURL(join(v6, 'source-isolation.mjs')).href}?test=${Date.now()}`)
    const candidateText = await readFile(join(v6, 'candidates.jsonl'), 'utf8')
    const sourceText = await readFile(join(v6, 'sources.jsonl'), 'utf8')
    const sourceConfig = await readFile(join(v6, 'source-config.archive.json'), 'utf8')
    const manifest = JSON.parse(await readFile(join(v6, 'candidate-manifest.json'), 'utf8')) as {
      codeFreezeCommit: string
      runtimeDigest: string
      counts: { total: number; english: number; chinese: number }
      digests: Record<string, string>
    }
    const candidates = jsonLines(candidateText)
    const sources = jsonLines(sourceText)

    expect(manifest.counts).toEqual({ total: 360, english: 180, chinese: 180 })
    expect(manifest.codeFreezeCommit).toBe(execFileSync('git', ['rev-parse', codeFreeze], {
      cwd: root, encoding: 'utf8',
    }).trim())
    expect(manifest.runtimeDigest).toBe(protocol.runtimeDigestAtCommit())
    expect(candidates).toHaveLength(360)
    expect(sources).toHaveLength(360)
    expect(candidates.filter(row => row.language === 'en')).toHaveLength(180)
    expect(candidates.filter(row => row.language === 'zh')).toHaveLength(180)
    expect(new Set(candidates.map(row => row.id)).size).toBe(360)
    expect(new Set(candidates.map(row => row.text)).size).toBe(360)
    expect(new Set(sources.map(row => row.url)).size).toBe(360)
    expect(candidates.every(row => typeof row.text === 'string'
      && row.text.trim().length > 0
      && !/^_?no response_?$/i.test(row.text.trim()))).toBe(true)
    expect(sources.every((row, index) => row.id === candidates[index].id
      && row.promptDigest === sha256(String(candidates[index].text)))).toBe(true)

    const prior = await isolation.priorSourceInventory()
    expect(() => isolation.assertSourceDisjoint(sources, prior)).not.toThrow()
    expect(manifest.digests.candidates).toBe(sha256(candidateText))
    expect(manifest.digests.sources).toBe(sha256(sourceText))
    expect(manifest.digests.sourceConfig).toBe(sha256(sourceConfig))
    for (const name of [
      'ANNOTATION_RUBRIC.md', 'annotation-schema.mjs', 'derive-label.mjs', 'protocol.mjs',
      'collect-candidates.mjs', 'source-isolation.mjs',
    ]) {
      expect(manifest.digests[name]).toBe(sha256(await readFile(join(v6, name), 'utf8')))
    }
  })

  it('ships candidates but no annotations or revealed evidence before annotation completes', async () => {
    const files = await readdir(v6)
    expect(files.sort()).toEqual([
      'ANNOTATION_RUBRIC.md',
      'annotation-schema.mjs',
      'candidate-manifest.json',
      'candidates.jsonl',
      'collect-candidates.mjs',
      'derive-label.mjs',
      'protocol.mjs',
      'source-config.archive.json',
      'source-isolation.mjs',
      'sources.jsonl',
    ])
  })
})
