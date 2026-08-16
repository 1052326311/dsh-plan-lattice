import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.cwd()
const v9 = join(root, 'eval/router-corpus/v9')

function facts(route: 'bypass' | 'contract' | 'lattice' | 'probe') {
  const chain = route === 'lattice'
    ? {
        basisItem: 'accepted stage-one behavior',
        invalidationEvent: 'stage-one evidence changes the required behavior',
        laterMutation: 'stage two changes the adapter',
        staleAction: 'the adapter follows the old behavior',
        detectionAndConsequence: 'final acceptance detects a regression',
      }
    : { basisItem: '', invalidationEvent: '', laterMutation: '', staleAction: '', detectionAndConsequence: '' }
  return {
    episodeMode: 'mutating',
    decisionAuthority: route === 'contract' ? 'missing-user-choice' : 'supplied',
    classificationEvidence: route === 'probe' ? 'requires-repository-read' : 'sufficient-from-request',
    continuityHazard: route === 'lattice' ? 'stage-feedback' : 'none',
    protectedEffect: 'none',
    causalChain: chain,
  }
}

describe('V9 preregistered protocol', () => {
  it('separates natural and challenge claims with frozen independent counts', async () => {
    const protocol = await import(`${pathToFileURL(join(v9, 'protocol.mjs')).href}?t=${Date.now()}`)
    expect(protocol.runtimeCommit).toBe('3d34a2e6fe71870caedb0bedecd53cfdb38195ef')
    expect(protocol.queueCounts).toEqual({
      naturalPerLanguage: 400,
      challengePerFamilyPerLanguage: 60,
      naturalTotal: 800,
      challengeTotal: 480,
      total: 1280,
    })
    expect(protocol.releaseGates).toMatchObject({
      bypassFalseActivationUpperMax: 0.05,
      latticeRecallLowerMin: 0.90,
      probeRecallLowerMin: 0.85,
    })
  })

  it('rejects leaked labels and post-cutoff source events', async () => {
    const protocol = await import(`${pathToFileURL(join(v9, 'protocol.mjs')).href}?t=${Date.now()}`)
    expect(() => protocol.assertCandidateShape({ id: 'v9-1', language: 'en', queue: 'natural', text: 'x'.repeat(100) })).not.toThrow()
    expect(() => protocol.assertCandidateShape({ id: 'v9-2', language: 'en', queue: 'challenge', text: 'x'.repeat(100), expected: 'lattice' })).toThrow('forbidden fields')
    expect(() => protocol.assertBeforeCutoff('2026-08-15T23:59:59Z', 'event')).not.toThrow()
    expect(() => protocol.assertBeforeCutoff('2026-08-16T00:00:00Z', 'event')).toThrow('later than the frozen cutoff')
  })

  it('requires language-specific rare-positive support instead of majority-class agreement', async () => {
    const { deriveLabel } = await import(`${pathToFileURL(join(v9, 'derive-label.mjs')).href}?t=${Date.now()}`)
    const agreement = await import(`${pathToFileURL(join(v9, 'agreement.mjs')).href}?t=${Date.now()}`)
    const candidates: Array<{ id: string; language: 'en' | 'zh' }> = []
    const maps = [new Map(), new Map(), new Map()]
    for (const language of ['en', 'zh'] as const) {
      for (const route of ['bypass', 'contract', 'lattice', 'probe'] as const) {
        for (let index = 0; index < 40; index += 1) {
          const id = `${language}-${route}-${index}`
          candidates.push({ id, language })
          const observable = facts(route)
          const annotation = { facts: observable, derived: deriveLabel(observable) }
          for (const map of maps) map.set(id, annotation)
        }
      }
    }
    const report = agreement.buildAgreementReport(candidates, maps, { fixture: true })
    expect(report.gates.allPassed).toBe(true)
    expect(report.agreement.rarePositive.en.lattice.minimumCount).toBe(40)

    maps[2].set('en-lattice-0', maps[2].get('en-bypass-0'))
    const changed = agreement.buildAgreementReport(candidates, maps, { fixture: true })
    expect(changed.agreement.rarePositive.en.lattice.minimumCount).toBe(39)
    expect(changed.gates.rarePositive.en.lattice.support).toBe(false)
    expect(changed.gates.allPassed).toBe(false)
  })

  it('validates a label-free source registry and cutoff-bound frame before selection', async () => {
    const protocol = await import(`${pathToFileURL(join(v9, 'protocol.mjs')).href}?t=${Date.now()}`)
    const isolation = await import(`${pathToFileURL(join(v9, 'source-isolation.mjs')).href}?t=${Date.now()}`)
    const assembly = await import(`${pathToFileURL(join(v9, 'assemble-candidates.mjs')).href}?t=${Date.now()}`)
    const sources = (['en', 'zh'] as const).flatMap(language => Array.from({ length: 36 }, (_, index) => ({
      platform: 'github',
      repository: `${language}-org-${index}/${language}-repo-${index}`,
      repositoryNodeId: `${language}-node-${index}`,
      networkRoot: `${language}-network-${index}`,
      organization: `${language}-org-${index}`,
      ecosystem: `ecosystem-${index % 8}`,
      nativeLanguage: language,
      objectTypes: ['issue', 'discussion', 'issue-comment-request', 'pull-review'],
      discussionCategoryIds: [],
    })))
    const registry = assembly.validateRegistry({
      schemaVersion: 1,
      protocol: protocol.protocolId,
      cutoff: protocol.cutoff,
      seedCommitment: protocol.collectionSeedCommitment,
      minimumNetworksPerLanguage: 36,
      platformApiVersions: { github: '2026-03-10' },
      sources,
    })
    const text = 'Implement the bounded source-backed correction and prove the exact observable behavior with its focused test.'
    const row = {
      stableSourceId: 'github:en-node-0:issue-1',
      queue: 'challenge',
      constructionFamily: 'bounded',
      language: 'en',
      text,
      platform: 'github',
      objectType: 'issue',
      repository: 'en-org-0/en-repo-0',
      repositoryNodeId: 'en-node-0',
      networkRoot: 'en-network-0',
      organization: 'en-org-0',
      ecosystem: 'ecosystem-0',
      authorId: 'author-1',
      url: 'https://github.com/en-org-0/en-repo-0/issues/1',
      nodeId: 'issue-node-1',
      createdAt: '2026-08-01T00:00:00Z',
      contentUpdatedAt: '2026-08-02T00:00:00Z',
      immutableAtCutoff: true,
      sourceContentDigest: 'a'.repeat(64),
      promptDigest: protocol.sha256(text),
      canonicalPromptDigest: protocol.sha256(isolation.canonicalPrompt(text)),
      relatedPullRequests: [],
      relatedCommits: [],
      duplicateChain: [],
      repositoryBaseCommit: null,
      sourceFamilyId: 'source-family-1',
    }
    expect(assembly.validateFrameRow(row, 0, registry)).toBe(row)
    expect(() => assembly.validateFrameRow({ ...row, contentUpdatedAt: '2026-08-16T00:00:00Z' }, 0, registry)).toThrow('later than the frozen cutoff')
    expect(() => assembly.validateRegistry({ ...registry, expected: 'lattice' })).toThrow('must contain exactly')
  })
})
