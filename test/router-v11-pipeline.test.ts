import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAdjudicationPacket,
  createIsolatedAnnotationPackets,
  resolveAdjudication,
  restoreAnnotationSets,
} from '../eval/router-corpus/v11/annotation-pipeline.mjs'
import {
  createFreezeManifest,
  runOneReveal,
  writeFreezeManifest,
} from '../eval/router-corpus/v11/freeze-reveal.mjs'
import { runFailClosedStage, sha256 } from '../eval/router-corpus/v11/pipeline-common.mjs'
import { assembleDeterministicSelection } from '../eval/router-corpus/v11/selection.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function exposure() {
  const value = {
    schemaVersion: 1,
    protocol: 'observable-authorization-v10',
    evidenceStatus: 'complete-raw-search-exposure-registry',
    coverage: {
      complete: true,
      searchIds: ['search-a', 'search-b'],
      rawSearchCandidateCount: 3,
      uniqueFamilyCount: 2,
    },
    rawSearchCandidateFamilies: ['github:old/repo:issue:1', 'github:old/repo:pull:2'],
  }
  const text = `${JSON.stringify(value, null, 2)}\n`
  return { text, binding: { sha256: sha256(text), searchIds: ['search-b', 'search-a'] } }
}

function sourceRows() {
  return [
    { stableSourceId: 'old', sourceFamilyId: 'github:old/repo:issue:1', language: 'en', text: 'old exposed task', queue: 'natural', repository: 'old/repo', organization: 'old', authorId: 'old-author' },
    { stableSourceId: 'n1', sourceFamilyId: 'github:new/a:issue:1', language: 'en', text: 'first natural task', queue: 'natural', repository: 'new/a', organization: 'new', authorId: 'author-1' },
    { stableSourceId: 'n2', sourceFamilyId: 'github:new/b:issue:2', language: 'en', text: 'second natural task', queue: 'natural', repository: 'new/b', organization: 'new', authorId: 'author-2' },
    { stableSourceId: 'n3', sourceFamilyId: 'github:other/c:issue:3', language: 'en', text: 'third natural task', queue: 'natural', repository: 'other/c', organization: 'other', authorId: 'author-3' },
    { stableSourceId: 'c1', sourceFamilyId: 'github:complex/a:pull:1', language: 'zh', text: 'first challenge task', queue: 'challenge', repository: 'complex/a', organization: 'complex', authorId: 'author-4' },
    { stableSourceId: 'c2', sourceFamilyId: 'github:complex/b:pull:2', language: 'zh', text: 'second challenge task', queue: 'challenge', repository: 'complex/b', organization: 'complex', authorId: 'author-5' },
  ]
}

const strata = [
  { id: 'natural/en', count: 2, match: { queue: 'natural', language: 'en' }, caps: { repository: 1, authorId: 1 }, minimumDistinct: { repository: 2 } },
  { id: 'challenge/zh', count: 1, match: { queue: 'challenge', language: 'zh' }, caps: { repository: 1 }, minimumDistinct: { organization: 1 } },
]

describe('V11 protocol-parameterized selection', () => {
  it('binds complete V10 exposure and does not read the external seed before post-exposure capacity passes', async () => {
    const registry = exposure()
    const loadSelectionSeed = vi.fn(async () => 'selection-seed')
    await expect(assembleDeterministicSelection({
      rows: sourceRows().filter(row => row.stableSourceId !== 'n2' && row.stableSourceId !== 'n3'),
      strata,
      exposureRegistryText: registry.text,
      exposureRegistryBinding: registry.binding,
      selectionSeedCommitment: sha256('selection-seed'),
      loadSelectionSeed,
    })).rejects.toThrow('post-exposure rows')
    expect(loadSelectionSeed).not.toHaveBeenCalled()

    await expect(assembleDeterministicSelection({
      rows: sourceRows(),
      strata,
      exposureRegistryText: `${registry.text} `,
      exposureRegistryBinding: registry.binding,
      selectionSeedCommitment: sha256('selection-seed'),
      loadSelectionSeed,
    })).rejects.toThrow('digest mismatch')
    expect(loadSelectionSeed).not.toHaveBeenCalled()
  })

  it('selects exact strata deterministically under repository, organization, and author caps', async () => {
    const registry = exposure()
    const run = (rows: ReturnType<typeof sourceRows>) => assembleDeterministicSelection({
      rows,
      strata,
      globalCaps: { authorId: 1 },
      exposureRegistryText: registry.text,
      exposureRegistryBinding: registry.binding,
      selectionSeedCommitment: sha256('selection-seed'),
      loadSelectionSeed: async () => 'selection-seed',
    })
    const forward = await run(sourceRows())
    const reverse = await run(sourceRows().reverse())
    expect(forward.candidates).toEqual(reverse.candidates)
    expect(forward.counts).toEqual({ 'natural/en': 2, 'challenge/zh': 1 })
    expect(forward.ledger.find(row => row.stableSourceId === 'old')).toMatchObject({
      excludedByV10Exposure: true,
      selected: false,
    })
    expect(forward.sources.every(row => row.sourceFamilyId !== 'github:old/repo:issue:1')).toBe(true)
  })
})

function annotation(id: string, route: string) {
  return { id, facts: { route }, rationale: `A row-specific rationale of sufficient length for ${id} and ${route}.` }
}

describe('V11 isolated annotation and disagreement-only adjudication', () => {
  it('randomizes source-free packets and resolves only disagreements by whole-record choice', () => {
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      id: `candidate-${index}`,
      language: index % 2 === 0 ? 'en' : 'zh',
      text: `Task prompt ${index} with enough observable request content.`,
    }))
    const annotators = ['annotator-one', 'annotator-two', 'annotator-three']
    const exports = createIsolatedAnnotationPackets({ candidates, annotators, randomizationSeed: 'packet-seed' })
    for (const name of annotators) {
      expect(exports.packets[name]).toHaveLength(candidates.length)
      expect(exports.packets[name].every(row => Object.keys(row).sort().join(',') === 'id,language,text')).toBe(true)
      expect(JSON.stringify(exports.packets[name])).not.toContain('sourceFamily')
      expect(JSON.stringify(exports.packets[name])).not.toContain('repository')
    }
    expect(exports.packets['annotator-one'].map(row => row.id))
      .not.toEqual(exports.packets['annotator-two'].map(row => row.id))

    const annotations = Object.fromEntries(annotators.map((name, annotatorIndex) => [
      name,
      exports.mappings[name].map(mapping => annotation(
        mapping.packetId,
        mapping.candidateId === 'candidate-2' && annotatorIndex === 2 ? 'lattice' : 'bypass',
      )),
    ]))
    const sets = restoreAnnotationSets({
      candidates,
      annotators,
      mappings: exports.mappings,
      annotations,
      validateAnnotation: row => ({ ...row, derived: { route: row.facts.route } }),
    })
    const buildAgreementReport = (_candidates: unknown, _sets: unknown, digests: unknown) => ({
      gates: { allPassed: true },
      digests,
    })
    const agreementReport = {
      gates: { allPassed: true },
      digests: {
        candidates: sha256(`${candidates.map(row => JSON.stringify(row)).join('\n')}\n`),
        annotations: sets.map((set, index) => ({
          annotator: index + 1,
          sha256: sha256(`${candidates.map(candidate => {
            const { derived: _derived, ...whole } = set.get(candidate.id)
            return JSON.stringify(whole)
          }).join('\n')}\n`),
        })),
      },
    }
    const packet = createAdjudicationPacket({
      candidates,
      annotationSets: sets,
      agreementReport,
      buildAgreementReport,
      optionRandomizationSeed: 'option-seed',
    })
    expect(packet).toHaveLength(1)
    expect(packet[0].id).toBe('candidate-2')
    expect(packet[0]).not.toHaveProperty('source')
    expect(packet[0].options.every(option => !['a', 'b', 'c'].includes(option.id))).toBe(true)

    const latticeOption = packet[0].options.find(option => option.annotation.facts.route === 'lattice')
    const resolved = resolveAdjudication({
      candidates,
      annotationSets: sets,
      packet,
      decisions: [{
        id: 'candidate-2',
        selectedOption: latticeOption?.id,
        rationale: 'The third complete record best matches the observable continuity evidence.',
      }],
      deriveLabel: facts => ({ eligible: true, route: facts.route, outcomeCritical: false }),
    })
    expect(resolved.find(row => row.id === 'candidate-2')?.derived.route).toBe('lattice')
    expect(resolved.filter(row => row.resolution !== 'unanimous')).toHaveLength(1)
    expect(() => createAdjudicationPacket({
      candidates,
      annotationSets: sets,
      agreementReport: { gates: { allPassed: false }, digests: agreementReport.digests },
      buildAgreementReport: (_candidates: unknown, _sets: unknown, digests: unknown) => ({
        gates: { allPassed: false },
        digests,
      }),
      optionRandomizationSeed: 'option-seed',
    })).toThrow('reliability gates failed')

    const synthesized = structuredClone(packet)
    synthesized[0].options[0].annotation.facts.route = 'contract'
    expect(() => resolveAdjudication({
      candidates,
      annotationSets: sets,
      packet: synthesized,
      decisions: [{
        id: 'candidate-2',
        selectedOption: synthesized[0].options[0].id,
        rationale: 'This option is intentionally forged to prove that synthesis is rejected.',
      }],
      deriveLabel: facts => ({ eligible: true, route: facts.route, outcomeCritical: false }),
    })).toThrow('synthesized annotation record')
  })
})

function frozenArtifacts() {
  return {
    router: 'frozen router artifact',
    runtime: 'frozen runtime manifest',
    sources: '{"candidateId":"one","repository":"owner/repo"}\n',
    labels: '{"id":"one","expected":"bypass"}\n',
    prompts: '{"id":"one","language":"en","text":"fix it"}\n',
    annotations: 'three frozen annotation sets',
    agreement: 'frozen agreement report',
    adjudication: 'frozen disagreement decisions',
  }
}

describe('V11 freeze, immutable failure, and one reveal', () => {
  it('binds exact router/runtime/source/label digests and consumes reveal before prediction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v11-'))
    temporaryRoots.push(root)
    const artifacts = frozenArtifacts()
    const manifest = createFreezeManifest({
      protocol: 'observable-authorization-v11-fixture',
      routerCommit: 'a'.repeat(40),
      exposureRegistryDigest: sha256('v10 exposure registry'),
      artifacts,
      expectedArtifactDigests: { router: sha256(artifacts.router), runtime: sha256(artifacts.runtime) },
      configuration: { activationMode: 'auto' },
    })
    expect(manifest.artifacts.sources.sha256).toBe(sha256(artifacts.sources))
    expect(manifest.artifacts.labels.sha256).toBe(sha256(artifacts.labels))
    const frozen = await writeFreezeManifest(join(root, 'freeze.json'), manifest)
    const predict = vi.fn(async () => [{ id: 'one', actual: 'bypass' }])
    const score = vi.fn(async ({ predictions }) => ({ passed: predictions[0].actual === 'bypass' }))
    const result = await runOneReveal({
      manifestText: frozen.body,
      expectedManifestDigest: frozen.sha256,
      artifacts,
      attemptPath: join(root, 'attempt.json'),
      resultPath: join(root, 'result.json'),
      failurePath: join(root, 'failure.json'),
      predict,
      score,
    })
    expect(result.evidenceStatus).toBe('immutable-first-reveal')
    expect(result.analysis).toEqual({ passed: true })
    expect(predict).toHaveBeenCalledTimes(1)
    await expect(runOneReveal({
      manifestText: frozen.body,
      expectedManifestDigest: frozen.sha256,
      artifacts,
      attemptPath: join(root, 'attempt.json'),
      resultPath: join(root, 'result.json'),
      failurePath: join(root, 'failure.json'),
      predict,
      score,
    })).rejects.toThrow('already exists')
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('retires before router execution when the freeze manifest digest changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v11-tamper-'))
    temporaryRoots.push(root)
    const artifacts = frozenArtifacts()
    const manifest = createFreezeManifest({
      protocol: 'observable-authorization-v11-fixture',
      routerCommit: 'b'.repeat(40),
      exposureRegistryDigest: sha256('v10 exposure registry'),
      artifacts,
      expectedArtifactDigests: { router: sha256(artifacts.router), runtime: sha256(artifacts.runtime) },
      configuration: { activationMode: 'auto' },
    })
    const frozen = await writeFreezeManifest(join(root, 'freeze.json'), manifest)
    const predict = vi.fn(async () => [])
    const failurePath = join(root, 'failure.json')
    await expect(runOneReveal({
      manifestText: frozen.body.replace('"auto"', '"always"'),
      expectedManifestDigest: frozen.sha256,
      artifacts,
      attemptPath: join(root, 'attempt.json'),
      resultPath: join(root, 'result.json'),
      failurePath,
      predict,
      score: async () => ({}),
    })).rejects.toThrow('preregistered digest')
    expect(predict).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(failurePath, 'utf8'))).toMatchObject({
      evidenceStatus: 'retired-before-router-reveal',
      stage: 'pre-reveal-freeze-verification',
    })
    await expect(readFile(join(root, 'attempt.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes a failure manifest once and never overwrites retired evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v11-failure-'))
    temporaryRoots.push(root)
    const failurePath = join(root, 'failure.json')
    await expect(runFailClosedStage({
      protocol: 'observable-authorization-v11-fixture',
      stage: 'selection',
      failurePath,
      bindings: { exposureRegistrySha256: sha256('registry') },
    }, async () => {
      throw new Error('frozen capacity failed')
    })).rejects.toThrow('frozen capacity failed')
    const first = await readFile(failurePath, 'utf8')
    expect(JSON.parse(first)).toMatchObject({
      evidenceStatus: 'retired-before-router-reveal',
      stage: 'selection',
    })
    await expect(runFailClosedStage({
      protocol: 'observable-authorization-v11-fixture',
      stage: 'selection',
      failurePath,
    }, async () => 'must not run')).rejects.toThrow('already exists')
    expect(await readFile(failurePath, 'utf8')).toBe(first)
  })
})
