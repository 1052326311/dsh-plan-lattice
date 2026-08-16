import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('source-disjoint V6 causal protocol', () => {
  const root = process.cwd()
  const v6 = join(root, 'eval/router-corpus/v6')
  const codeFreeze = '3d34a2e'

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

  it('ships no V6 candidates or revealed evidence before the protocol is complete', async () => {
    const files = await readdir(v6)
    expect(files.sort()).toEqual([
      'ANNOTATION_RUBRIC.md',
      'annotation-schema.mjs',
      'derive-label.mjs',
      'protocol.mjs',
    ])
  })
})
