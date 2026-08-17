import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCandidateFreezeManifest, runCandidateReveal } from '../prospective/router-v14/candidate-reveal.mjs'
import { loadSpec, sha256 } from '../prospective/router-v14/protocol.mjs'
import { verifyV14EvidenceBundle } from '../prospective/model-rc4-study/v14-evidence.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

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

function routeRows() {
  return [
    { id: 'bypass', language: 'en', expected: 'bypass', outcomeCritical: false },
    { id: 'contract', language: 'en', expected: 'contract', outcomeCritical: true },
    { id: 'lattice', language: 'zh', expected: 'lattice', outcomeCritical: true },
    { id: 'probe', language: 'zh', expected: 'probe', outcomeCritical: false },
  ]
}

function router() {
  return {
    routeRequest(text: string) {
      if (text.startsWith('route:')) return { phase: text.slice('route:'.length), reasons: [] }
      return { phase: 'contract', reasons: [] }
    },
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'model-rc4-v14-evidence-'))
  roots.push(root)
  const { spec } = await loadSpec()
  const runtime = runtimeManifest(spec)
  const rows = routeRows()
  const shared = {
    binding: {
      protocol: 'observable-authorization-v13',
      protocolFreezeCommit: spec.sharedCorpus.protocolFreezeCommit,
      specSha256: spec.sharedCorpus.specSha256,
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
    v13Outcome: {
      status: 'result',
      attemptSha256: '1'.repeat(64),
      outcomeSha256: '2'.repeat(64),
      evidenceStatus: 'immutable-first-reveal',
      releaseGatePassed: true,
    },
  }
  const protocolFreezeCommit = '8f9bcab558609759ed978daa24f163606aad565f'
  const manifest = createCandidateFreezeManifest({
    spec,
    protocolFreezeCommit,
    shared,
    runtimeManifest: runtime,
  })
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(root, 'candidate-freeze-manifest.json'), manifestText)
  await writeFile(
    join(root, 'candidate-freeze-manifest.sha256'),
    `${sha256(manifestText)}  candidate-freeze-manifest.json\n`,
  )
  await runCandidateReveal({
    manifestText,
    expectedManifestDigest: sha256(manifestText),
    protocolFreezeCommit,
    shared,
    spec,
    runtimeManifest: runtime,
    runtimeArtifactRoot: join(root, 'runtime-artifact'),
    attemptPath: join(root, 'candidate-reveal-attempt.json'),
    resultPath: join(root, 'candidate-reveal-result.json'),
    failurePath: join(root, 'candidate-reveal-failure.json'),
    importRouter: async () => router(),
  })
  const loadShared = vi.fn(async () => shared)
  const dependencies = {
    loadSpec: async () => ({ spec }),
    assertCandidateFreeze: async () => ({
      commit: spec.candidateFreeze.commit,
      tree: spec.candidateFreeze.tree,
      sourceDigest: spec.candidateFreeze.sourceDigest,
    }),
    assertProtocolFreeze: () => ({ commit: protocolFreezeCommit, ref: spec.protocolFreeze.publicRef }),
    loadSharedCorpus: loadShared,
    verifyFrozenRuntimeArtifact: async () => ({ manifest: runtime }),
    importFrozenRouter: async () => router(),
  }
  return { dependencies, loadShared, manifest, root, runtime, shared, spec }
}

async function verify(current: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return verifyV14EvidenceBundle({
    dataRoot: current.root,
    v13DataRoot: join(current.root, 'v13'),
    runtimeArtifactRoot: join(current.root, 'runtime-artifact'),
    dependencies: { ...current.dependencies, ...overrides },
  })
}

async function mutateJson(path: string, mutate: (value: any) => void) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  mutate(value)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('RC.4 independent V14 evidence verifier', () => {
  it('re-verifies the V13 bundle and independently replays V14 scoring', async () => {
    const current = await fixture()
    const evidence = await verify(current)
    expect(evidence).toMatchObject({
      evidenceStatus: 'independently-verified-v14-reveal',
      candidateCommit: current.spec.candidateFreeze.commit,
      rows: 4,
      analysis: { releaseGatePassed: true },
      pairedV13Outcome: current.shared.v13Outcome,
    })
    expect(current.loadShared).toHaveBeenCalledWith(expect.objectContaining({ requireRevealed: true }))
  })

  it('rejects a changed freeze digest and a self-consistently changed manifest candidate', async () => {
    const current = await fixture()
    await writeFile(join(current.root, 'candidate-freeze-manifest.sha256'), `${'0'.repeat(64)}  candidate-freeze-manifest.json\n`)
    await expect(verify(current)).rejects.toThrow('digest commitment')

    const second = await fixture()
    const manifestPath = join(second.root, 'candidate-freeze-manifest.json')
    await mutateJson(manifestPath, value => { value.candidateCommit = '0'.repeat(40) })
    const body = await readFile(manifestPath, 'utf8')
    await writeFile(join(second.root, 'candidate-freeze-manifest.sha256'), `${sha256(body)}  candidate-freeze-manifest.json\n`)
    await expect(verify(second)).rejects.toThrow('freeze manifest changed')
  })

  it('requires one attempt and exactly one result outcome', async () => {
    const noAttempt = await fixture()
    await unlink(join(noAttempt.root, 'candidate-reveal-attempt.json'))
    await expect(verify(noAttempt)).rejects.toThrow('one attempt and exactly one complete outcome')

    const missing = await fixture()
    await unlink(join(missing.root, 'candidate-reveal-result.json'))
    await expect(verify(missing)).rejects.toThrow('exactly one complete outcome')

    const doubled = await fixture()
    await writeFile(join(doubled.root, 'candidate-reveal-failure.json'), '{}\n')
    await expect(verify(doubled)).rejects.toThrow('exactly one complete outcome')
  })

  it('rejects an immutable V14 failure instead of treating it as evidence', async () => {
    const current = await fixture()
    await unlink(join(current.root, 'candidate-reveal-result.json'))
    await writeFile(join(current.root, 'candidate-reveal-failure.json'), `${JSON.stringify({
      schemaVersion: 1,
      protocol: current.spec.protocol,
      evidenceStatus: 'immutable-candidate-reveal-failure',
    })}\n`)
    await expect(verify(current)).rejects.toThrow('immutable failure')
  })

  it('rejects wrong protocol and candidate bindings in the reveal attempt', async () => {
    const protocol = await fixture()
    await mutateJson(join(protocol.root, 'candidate-reveal-attempt.json'), value => { value.protocol = 'wrong-protocol' })
    await expect(verify(protocol)).rejects.toThrow('attempt binding changed')

    const candidate = await fixture()
    await mutateJson(join(candidate.root, 'candidate-reveal-attempt.json'), value => { value.candidateCommit = '0'.repeat(40) })
    await expect(verify(candidate)).rejects.toThrow('attempt binding changed')

    const specIdentity = await fixture()
    await expect(verify(specIdentity, {
      loadSpec: async () => ({
        spec: {
          ...specIdentity.spec,
          candidateFreeze: { ...specIdentity.spec.candidateFreeze, commit: '0'.repeat(40) },
        },
      }),
    })).rejects.toThrow('candidate identity changed')
  })

  it('does not trust the stored releaseGatePassed field or stored score', async () => {
    const current = await fixture()
    await mutateJson(join(current.root, 'candidate-reveal-result.json'), value => {
      value.analysis.releaseGatePassed = true
      value.analysis.metrics.exactAccuracy = 0
    })
    await expect(verify(current)).rejects.toThrow('independent replay and scoring')
  })

  it('binds the paired V13 outcome digest and validates its status', async () => {
    const digest = await fixture()
    await mutateJson(join(digest.root, 'candidate-reveal-result.json'), value => {
      value.pairedV13Outcome.outcomeSha256 = 'f'.repeat(64)
    })
    await expect(verify(digest)).rejects.toThrow('independent replay and scoring')

    const status = await fixture()
    await expect(verify(status, {
      loadSharedCorpus: async () => ({
        ...status.shared,
        v13Outcome: { ...status.shared.v13Outcome, status: 'unrevealed' },
      }),
    })).rejects.toThrow('paired V13 outcome status is invalid')
  })

  it('rejects a recomputed failing router even when the stored result says pass', async () => {
    const current = await fixture()
    const failingRouter = {
      routeRequest(text: string) {
        if (text.startsWith('route:')) return { phase: 'bypass', reasons: ['tampered runtime'] }
        return { phase: 'bypass', reasons: ['tampered runtime'] }
      },
    }
    await expect(verify(current, {
      importFrozenRouter: async () => failingRouter,
    })).rejects.toThrow('independent replay and scoring')
  })
})
