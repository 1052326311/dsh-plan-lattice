import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const v7 = join(root, 'eval/router-corpus/v7')
const emptyChain = {
  basisItem: '', invalidationEvent: '', laterMutation: '', staleAction: '', detectionAndConsequence: '',
}

function facts(overrides: Record<string, unknown> = {}) {
  return {
    episodeMode: 'mutating',
    decisionAuthority: 'supplied',
    classificationEvidence: 'sufficient-from-request',
    continuityHazard: 'none',
    protectedEffect: 'none',
    causalChain: emptyChain,
    ...overrides,
  }
}

describe('V7 observable authorization protocol', () => {
  it('derives control only from request-observable authorization facts', async () => {
    const { deriveLabel } = await import(`${pathToFileURL(join(v7, 'derive-label.mjs')).href}?t=${Date.now()}`)
    expect(deriveLabel(facts())).toEqual({ eligible: true, route: 'bypass', outcomeCritical: false })
    expect(deriveLabel(facts({ decisionAuthority: 'missing-user-choice' }))).toEqual({
      eligible: true, route: 'contract', outcomeCritical: true,
    })
    expect(deriveLabel(facts({ classificationEvidence: 'requires-repository-read' }))).toEqual({
      eligible: true, route: 'probe', outcomeCritical: false,
    })
    expect(deriveLabel(facts({
      continuityHazard: 'stage-feedback',
      causalChain: {
        basisItem: 'the accepted phase-one behavior',
        invalidationEvent: 'phase-one feedback changes that behavior',
        laterMutation: 'phase two edits the adapter',
        staleAction: 'the adapter follows the pre-feedback behavior',
        detectionAndConsequence: 'phase-two acceptance catches the mismatch',
      },
    }))).toEqual({ eligible: true, route: 'lattice', outcomeCritical: false })
  })

  it('does not treat ordinary source discovery as repository probe evidence', async () => {
    const { validateAnnotation } = await import(`${pathToFileURL(join(v7, 'annotation-schema.mjs')).href}?t=${Date.now()}`)
    expect(() => validateAnnotation({
      id: 'ordinary-bug',
      confidence: 'high',
      rationale: 'The request closes the observable defect; locating its implementation is ordinary execution work.',
      facts: facts({ classificationEvidence: 'requires-repository-read' }),
      evidence: {
        episodeQuote: 'The parser returns undefined; return an empty list instead.',
        decisionGapQuote: '',
        repositoryQuestion: 'Which file implements the parser?',
        repositoryAlternatives: ['parser.ts', 'reader.ts'],
        repositoryImpact: 'Only the target path differs.',
        continuityQuotes: [],
        protectedEffectQuote: '',
      },
    })).toThrow('at least two different route outcomes')
    const rubric = await readFile(join(v7, 'ANNOTATION_RUBRIC.md'), 'utf8')
    expect(rubric).toContain('"Which file implements this?" never qualifies')
    expect(rubric).toContain('route differently')
  })

  it('requires a complete chain for every continuity hazard', async () => {
    const { validateObservableFacts } = await import(`${pathToFileURL(join(v7, 'derive-label.mjs')).href}?t=${Date.now()}`)
    expect(() => validateObservableFacts(facts({
      continuityHazard: 'parallel-execution',
      causalChain: { ...emptyChain, basisItem: 'accepted plan' },
    }))).toThrow('requires a complete invalidation chain')
  })

  it('measures kappa, AC1, unanimous agreement, and pairwise confusion separately', async () => {
    const agreement = await import(`${pathToFileURL(join(v7, 'agreement.mjs')).href}?t=${Date.now()}`)
    const ratings = [
      ['bypass', 'bypass', 'bypass'],
      ['contract', 'contract', 'contract'],
      ['probe', 'probe', 'probe'],
      ['lattice', 'lattice', 'lattice'],
    ]
    expect(agreement.fleissKappaStats(ratings, agreement.routeCategories).kappa).toBe(1)
    expect(agreement.gwetAc1Stats(ratings, agreement.routeCategories).ac1).toBe(1)
  })

  it('keeps failed reliability evidence immutable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plan-lattice-v7-'))
    const candidatePath = join(directory, 'candidates.jsonl')
    const annotationPaths = [1, 2, 3].map(index => join(directory, `annotations-${index}.jsonl`))
    const outputPath = join(directory, 'agreement.json')
    await writeFile(candidatePath, `${JSON.stringify({ id: 'case-1', text: 'Fix the typo.' })}\n`)
    const annotation = {
      id: 'case-1', confidence: 'high',
      rationale: 'One bounded local text correction has a supplied outcome and no durable continuity hazard.',
      facts: facts(),
      evidence: {
        episodeQuote: 'Fix the typo.', decisionGapQuote: '', repositoryQuestion: '',
        repositoryAlternatives: [], repositoryImpact: '', continuityQuotes: [], protectedEffectQuote: '',
      },
    }
    await Promise.all(annotationPaths.map(path => writeFile(path, `${JSON.stringify(annotation)}\n`)))
    const { runAgreement } = await import(`${pathToFileURL(join(v7, 'agreement.mjs')).href}?t=${Date.now()}`)
    const report = await runAgreement(candidatePath, annotationPaths, outputPath)
    expect(report.gates.allPassed).toBe(true)
    await expect(runAgreement(candidatePath, annotationPaths, outputPath)).rejects.toThrow('refusing to overwrite evidence')
  })

  it('binds V7 calibration to the unchanged causal router runtime', async () => {
    const protocol = await import(`${pathToFileURL(join(v7, 'protocol.mjs')).href}?t=${Date.now()}`)
    const frozen = await protocol.assertFrozenRuntime()
    expect(frozen.exactCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(protocol.longTaskThreshold).toBe(8)
    expect(protocol.reliabilityGates).toEqual({
      routeKappaMin: 0.75,
      routeAc1Min: 0.75,
      routeUnanimousMin: 0.8,
      primitiveKappaMin: 0.7,
      primitiveAc1Min: 0.8,
      primitiveUnanimousMin: 0.85,
    })
  })

  it('marks V6-derived calibration as revealed development evidence only', async () => {
    const script = await readFile(join(v7, 'build-calibration.mjs'), 'utf8')
    expect(script).toContain("purpose: 'revealed-development-calibration-only'")
    expect(script).toContain('expected 72 unique calibration rows')
    expect(script).toContain("sourceVersion: 'v6'")
  })

  it('preserves the first V7 calibration failure instead of relaxing its gates', async () => {
    const report = JSON.parse(await readFile(join(v7, 'calibration-agreement-report.json'), 'utf8')) as {
      agreement: {
        route: { fleissKappa: { kappa: number }, gwetAc1: { ac1: number } }
        primitives: { protectedEffect: { fleissKappa: { kappa: number } } }
      }
      gates: { allPassed: boolean }
    }
    expect(report.gates.allPassed).toBe(false)
    expect(report.agreement.route.fleissKappa.kappa).toBeGreaterThanOrEqual(0.75)
    expect(report.agreement.route.gwetAc1.ac1).toBeGreaterThanOrEqual(0.75)
    expect(report.agreement.primitives.protectedEffect.fleissKappa.kappa).toBeLessThan(0.7)
  })

  it('adds a label-free balanced development supplement without changing the frozen thresholds', async () => {
    const rows = (await readFile(join(v7, 'calibration-supplement-candidates.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { id: string; language: string; text: string })
    expect(rows).toHaveLength(36)
    expect(new Set(rows.map(row => row.id)).size).toBe(36)
    expect(rows.filter(row => row.language === 'en')).toHaveLength(18)
    expect(rows.filter(row => row.language === 'zh')).toHaveLength(18)
    expect(rows.every(row => !('route' in row) && !('expected' in row))).toBe(true)
  })

  it('passes round-two development reliability without rewriting the failed first round', async () => {
    const report = JSON.parse(await readFile(join(v7, 'calibration-round2-agreement-report.json'), 'utf8')) as {
      agreement: {
        route: { fleissKappa: { kappa: number }, gwetAc1: { ac1: number }, unanimous: { rate: number } }
        primitives: Record<string, { fleissKappa: { kappa: number } }>
      }
      gates: { allPassed: boolean }
    }
    expect(report.gates.allPassed).toBe(true)
    expect(report.agreement.route.fleissKappa.kappa).toBeGreaterThanOrEqual(0.75)
    expect(report.agreement.route.gwetAc1.ac1).toBeGreaterThanOrEqual(0.75)
    expect(report.agreement.route.unanimous.rate).toBeGreaterThanOrEqual(0.8)
    expect(Object.values(report.agreement.primitives).every(value => value.fleissKappa.kappa >= 0.7)).toBe(true)
  })

  it('excludes every V1-V6 repository, URL, and prompt digest from future V7 blind sources', async () => {
    const isolation = await import(`${pathToFileURL(join(v7, 'source-isolation.mjs')).href}?t=${Date.now()}`)
    const inventory = await isolation.priorSourceInventory()
    expect(Object.keys(inventory.versions)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6'])
    expect(Object.values(inventory.versions).every((count: unknown) => Number(count) > 0)).toBe(true)
    expect(inventory.files.every((file: { path: string }) => !file.path.includes('/v7/'))).toBe(true)
    const source = JSON.parse((await readFile(join(root, 'eval/router-corpus/v6/sources.jsonl'), 'utf8')).split('\n')[0])
    expect(() => isolation.assertSourceDisjoint([source], inventory)).toThrow('V1-V6 repository')
  })

  it('requires route-neutral full-source V7 collection with reporter updates and base SHA binding', async () => {
    const collector = await readFile(join(v7, 'collect-candidates.mjs'), 'utf8')
    expect(collector).toContain("query leaks a route-shaped search hint")
    expect(collector).toContain('full pagination mismatch')
    expect(collector).toContain('reporterUpdates')
    expect(collector).toContain('collectionBaseSha')
    expect(collector).toContain('canonicalPromptDigest')
    expect(collector).toContain('maxPromptCharacters')
    expect(collector).not.toContain('.slice(0, limit)')
  })
})
