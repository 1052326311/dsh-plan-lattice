import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createCandidateFreezeManifest,
  runCandidateReveal,
  verifyCandidateFreezeManifest,
} from '../prospective/router-v14/candidate-reveal.mjs'
import { assertCandidateFreeze, loadSpec, sha256, validateSpec } from '../prospective/router-v14/protocol.mjs'

function runtimeManifest(spec: any) {
  return {
    schemaVersion: 2,
    kind: 'dsh-plan-lattice-v14-frozen-router-runtime',
    exactCommit: spec.candidateFreeze.commit,
    exactTree: spec.candidateFreeze.tree,
    digests: { sourceSha256: spec.candidateFreeze.runtimeArtifact.sourceSha256 },
    artifactSha256: 'a'.repeat(64),
  }
}

function sharedCorpus() {
  const rows = [
    { id: 'bypass', language: 'en', expected: 'bypass', outcomeCritical: false },
    { id: 'contract', language: 'en', expected: 'contract', outcomeCritical: true },
    { id: 'lattice', language: 'zh', expected: 'lattice', outcomeCritical: true },
    { id: 'probe', language: 'zh', expected: 'probe', outcomeCritical: false },
  ]
  return {
    binding: {
      protocol: 'observable-authorization-v13',
      protocolFreezeCommit: 'b'.repeat(40),
      specSha256: 'c'.repeat(64),
      freezeManifestSha256: 'd'.repeat(64),
      rowCount: rows.length,
      archiveMerkleRoot: 'e'.repeat(64),
    },
    artifacts: {
      prompts: `${rows.map(row => JSON.stringify({
        id: row.id,
        language: row.language,
        text: `route:${row.expected}`,
      })).join('\n')}\n`,
      labels: `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    },
  }
}

describe('V14 RC.4 candidate identity', () => {
  it('binds the public pre-corpus candidate tag and rejects spec drift', async () => {
    const { spec } = await loadSpec()
    await expect(assertCandidateFreeze(spec)).resolves.toMatchObject({
      commit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
      tree: '10970e580c45891ffd8bbfe395ac920401f65799',
    })
    expect(() => validateSpec({ ...spec, releaseGates: { ...spec.releaseGates, exactAccuracyMin: 0.7 } }))
      .toThrow('release gates changed')
    expect(() => validateSpec({
      ...spec,
      sharedCorpus: { ...spec.sharedCorpus, protocolFreezeCommit: 'f'.repeat(40) },
    })).toThrow('shared V13 corpus identity changed')
  })
})

describe('V14 candidate freeze and one reveal', () => {
  it('binds the candidate and shared corpus and consumes execution before import', async () => {
    const { spec } = await loadSpec()
    const shared = sharedCorpus()
    const runtime = runtimeManifest(spec)
    const protocolFreezeCommit = '1'.repeat(40)
    const manifest = createCandidateFreezeManifest({ spec, protocolFreezeCommit, shared, runtimeManifest: runtime })
    expect(verifyCandidateFreezeManifest(manifest, {
      spec,
      protocolFreezeCommit,
      shared,
      runtimeManifest: runtime,
    })).toBe(manifest)
    expect(() => verifyCandidateFreezeManifest(manifest, {
      spec,
      protocolFreezeCommit,
      shared: { ...shared, binding: { ...shared.binding, freezeManifestSha256: '2'.repeat(64) } },
      runtimeManifest: runtime,
    })).toThrow('freeze manifest changed')

    const root = await mkdtemp(join(tmpdir(), 'router-v14-reveal-'))
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const paths = {
      attemptPath: join(root, 'attempt.json'),
      resultPath: join(root, 'result.json'),
      failurePath: join(root, 'failure.json'),
    }
    const input = {
      manifestText,
      expectedManifestDigest: sha256(manifestText),
      protocolFreezeCommit,
      shared,
      spec,
      runtimeManifest: runtime,
      runtimeArtifactRoot: root,
      ...paths,
    }
    try {
      const result = await runCandidateReveal({
        ...input,
        importRouter: async () => ({
          routeRequest(text: string) {
            if (text.startsWith('route:')) return { phase: text.slice('route:'.length), reasons: [] }
            return { phase: 'contract', reasons: [] }
          },
        }),
      })
      expect(result.knownCounterexamples).toMatchObject({ allPassed: true })
      expect(result.analysis.releaseGatePassed).toBe(true)
      expect(JSON.parse(await readFile(paths.attemptPath, 'utf8')).evidenceStatus)
        .toBe('candidate-reveal-consumed-before-router-execution')
      await expect(runCandidateReveal({
        ...input,
        importRouter: async () => { throw new Error('must not run') },
      })).rejects.toThrow('artifact already exists')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains an importer failure after consuming the one reveal', async () => {
    const { spec } = await loadSpec()
    const shared = sharedCorpus()
    const runtime = runtimeManifest(spec)
    const protocolFreezeCommit = '3'.repeat(40)
    const manifest = createCandidateFreezeManifest({ spec, protocolFreezeCommit, shared, runtimeManifest: runtime })
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const root = await mkdtemp(join(tmpdir(), 'router-v14-failure-'))
    const paths = {
      attemptPath: join(root, 'attempt.json'),
      resultPath: join(root, 'result.json'),
      failurePath: join(root, 'failure.json'),
    }
    try {
      await expect(runCandidateReveal({
        manifestText,
        expectedManifestDigest: sha256(manifestText),
        protocolFreezeCommit,
        shared,
        spec,
        runtimeManifest: runtime,
        runtimeArtifactRoot: root,
        ...paths,
        importRouter: async () => { throw new Error('synthetic importer crash') },
      })).rejects.toThrow('synthetic importer crash')
      expect(JSON.parse(await readFile(paths.attemptPath, 'utf8')).evidenceStatus)
        .toBe('candidate-reveal-consumed-before-router-execution')
      expect(JSON.parse(await readFile(paths.failurePath, 'utf8')).evidenceStatus)
        .toBe('immutable-candidate-reveal-failure')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
