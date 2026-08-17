import { generateKeyPairSync } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createFreezeManifest,
  requiredFreezeArtifacts,
  runOneReveal,
  verifyFreezeManifest,
} from '../eval/router-corpus/v13/freeze-reveal.mjs'
import { RevealPersistenceCrash } from '../eval/router-corpus/reveal-persistence.mjs'
import { canonical, loadSpec, sha256, stableLines } from '../eval/router-corpus/v13/protocol.mjs'
import { scoreRouterRows } from '../eval/router-corpus/v13/statistics.mjs'

function selectedRows(spec: any) {
  return ['en', 'zh'].flatMap(language => Object.entries(spec.blindSelection.targetPerLanguage)
    .flatMap(([route, count]) => Array.from({ length: count as number }, (_, index) => ({
      id: language + '-' + route + '-' + index,
      language,
      route,
      text: 'route:' + route + ' ' + language + ' controlled task ' + index,
    }))))
}

function frozenArtifacts(spec: any) {
  const rows = selectedRows(spec)
  const archiveMerkleRoot = 'a'.repeat(64)
  const { publicKey } = generateKeyPairSync('ed25519')
  const drandResponseRaw = '{"round":6391766}'
  const drandChainInfoRaw = '{"hash":"fixture"}'
  const drandExternalVerification = { attestation: { verifierId: 'fixture-verifier' } }
  const drandVerifierPublicKey = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const prompts = stableLines(rows.map(row => ({ id: row.id, language: row.language, text: row.text })))
  const labels = stableLines(rows.map(row => ({
    id: row.id,
    language: row.language,
    expected: row.route,
    outcomeCritical: row.route === 'contract',
  })))
  const sources = stableLines(rows.map(row => ({
    id: row.id,
    language: row.language,
    repository: row.language + '-org/repository-' + row.id,
    sourceFamilyId: 'family-' + row.id,
  })))
  const capacityManifest = JSON.stringify({
    protocol: spec.protocol,
    evidenceStatus: 'exact-capacity-proven',
    feasible: true,
    witnessDigest: 'b'.repeat(64),
    capacityWitness: { witnessDigest: 'b'.repeat(64) },
  })
  const beaconResponse = JSON.stringify({
    protocol: spec.protocol,
    evidenceStatus: 'verified-drand-beacon',
    chainHash: spec.selectionBeacon.chainHash,
    round: spec.selectionBeacon.round,
    randomness: 'c'.repeat(64),
    responseSha256: sha256(drandResponseRaw),
    chainInfoSha256: sha256(drandChainInfoRaw),
    externalAttestationDigest: sha256(`${JSON.stringify(canonical(drandExternalVerification.attestation))}\n`),
    externalVerifierId: drandExternalVerification.attestation.verifierId,
    trustedVerifierPublicKeySha256: sha256(publicKey.export({ format: 'der', type: 'spki' })),
  })
  const artifacts: Record<string, string> = Object.fromEntries(requiredFreezeArtifacts.map(name => [name, '{}']))
  Object.assign(artifacts, {
    spec: JSON.stringify(spec),
    archiveManifest: JSON.stringify({
      protocol: spec.protocol,
      evidenceStatus: 'frozen-raw-archive-manifest',
      archiveMerkleRoot,
    }),
    sourceManifest: JSON.stringify({
      protocol: spec.protocol,
      evidenceStatus: 'immutable-post-cutoff-source-frame',
      archiveMerkleRoot,
      selectionBeaconAccessed: false,
      selectionSeedAccessed: false,
    }),
    agreementReport: JSON.stringify({ gates: { allPassed: true } }),
    capacityManifest,
    beaconResponse,
    selectionManifest: JSON.stringify({
      evidenceStatus: 'frozen-blind-selection',
      capacityManifestDigest: sha256(`${JSON.stringify(canonical(JSON.parse(capacityManifest)))}\n`),
      beaconEvidenceDigest: sha256(`${JSON.stringify(canonical(JSON.parse(beaconResponse)))}\n`),
      selectionWitnessDigest: 'd'.repeat(64),
      digests: {
        prompts: sha256(prompts),
        labels: sha256(labels),
        sources: sha256(sources),
      },
    }),
    runtimeManifest: JSON.stringify({ schemaVersion: 2, exactCommit: spec.routerFreeze.commit }),
    prompts,
    labels,
    sources,
    sourceFrame: stableLines([{ id: 'source-frame-fixture' }]),
    sourceRejections: JSON.stringify([]),
    annotationRubric: 'frozen rubric',
    annotationSchema: 'frozen schema',
    annotationCandidates: stableLines([{ id: 'annotation-fixture' }]),
    annotationPacketManifest: JSON.stringify({ candidateCount: 1 }),
    annotationPacketA: stableLines([{ id: 'packet-a' }]),
    annotationPacketB: stableLines([{ id: 'packet-b' }]),
    annotationPacketC: stableLines([{ id: 'packet-c' }]),
    annotationMappings: JSON.stringify({ a: [], b: [], c: [] }),
    annotationsA: stableLines([{ id: 'a' }]),
    annotationsB: stableLines([{ id: 'b' }]),
    annotationsC: stableLines([{ id: 'c' }]),
    adjudicationPacket: JSON.stringify([]),
    adjudicationDecisions: JSON.stringify([]),
    adjudicated: stableLines([{ id: 'resolved' }]),
    capacityWitness: JSON.stringify({ flow: rows.length, witnessDigest: 'b'.repeat(64) }),
    drandResponseRaw,
    drandChainInfoRaw,
    drandExternalVerification: JSON.stringify(drandExternalVerification),
    drandVerifierPublicKey,
    selectionWitness: JSON.stringify({ witnessDigest: 'd'.repeat(64) }),
    statisticsSource: 'frozen statistics implementation',
  })
  return artifacts
}

describe('V13 complete router gates', () => {
  it('passes a perfect frozen allocation and fails probe recall and false-positive regressions', async () => {
    const { spec } = await loadSpec()
    const perfect = selectedRows(spec).map(row => ({
      expected: row.route,
      actual: row.route,
      outcomeCritical: row.route === 'contract',
    }))
    const passed = scoreRouterRows(perfect, spec.releaseGates)
    expect(passed.releaseGatePassed).toBe(true)
    expect(Object.keys(passed.checks)).toHaveLength(8)

    let missed = 0
    const missedProbe = perfect.map(row => {
      if (row.expected === 'probe' && missed < 2) {
        missed += 1
        return { ...row, actual: 'contract' }
      }
      return row
    })
    expect(scoreRouterRows(missedProbe, spec.releaseGates).checks.probeRecall).toBe(false)

    let changed = 0
    const falseProbes = perfect.map(row => {
      if (row.expected === 'bypass' && changed < 12) {
        changed += 1
        return { ...row, actual: 'probe' }
      }
      return row
    })
    expect(scoreRouterRows(falseProbes, spec.releaseGates).checks.probeFalsePositiveRate).toBe(false)
  })
})

describe('V13 frozen evidence and one reveal', () => {
  it('binds every evidence class and rejects a tampered artifact', async () => {
    const { spec } = await loadSpec()
    const artifacts = frozenArtifacts(spec)
    const protocolFreezeCommit = 'd'.repeat(40)
    const manifest = createFreezeManifest({ spec, protocolFreezeCommit, artifacts })
    expect(manifest.rowCount).toBe(120)
    expect(verifyFreezeManifest(manifest, artifacts, spec, protocolFreezeCommit)).toBe(manifest)
    expect(() => verifyFreezeManifest(manifest, { ...artifacts, annotationRubric: 'changed' }, spec, protocolFreezeCommit))
      .toThrow('frozen artifacts changed')
  })

  it('consumes the reveal before importing the router and replays a recorded failure without a second import', async () => {
    const { spec } = await loadSpec()
    const artifacts = frozenArtifacts(spec)
    const protocolFreezeCommit = 'e'.repeat(40)
    const manifest = createFreezeManifest({ spec, protocolFreezeCommit, artifacts })
    const manifestText = JSON.stringify(manifest, null, 2) + '\n'
    const root = await mkdtemp(join(tmpdir(), 'router-v13-reveal-'))
    const paths = {
      attemptPath: join(root, 'reveal-attempt.json'),
      resultPath: join(root, 'result.json'),
      failurePath: join(root, 'failure.json'),
    }
    const input = {
      manifestText,
      expectedManifestDigest: sha256(manifestText),
      expectedProtocolFreezeCommit: protocolFreezeCommit,
      artifacts,
      spec,
      runtimeArtifactRoot: root,
      ...paths,
    }
    try {
      await expect(runOneReveal({
        ...input,
        importRouter: async () => { throw new Error('synthetic importer crash') },
      })).rejects.toThrow('synthetic importer crash')
      expect(JSON.parse(await readFile(paths.attemptPath, 'utf8')).evidenceStatus)
        .toBe('one-reveal-consumed-before-router-execution')
      expect(JSON.parse(await readFile(paths.failurePath, 'utf8')).evidenceStatus)
        .toBe('immutable-reveal-failure')
      let retried = false
      await expect(runOneReveal({
        ...input,
        importRouter: async () => {
          retried = true
          throw new Error('must not import twice')
        },
      })).rejects.toThrow('recorded reveal failure: synthetic importer crash')
      expect(retried).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers every durable success boundary and never executes the router twice', async () => {
    const { spec } = await loadSpec()
    const artifacts = frozenArtifacts(spec)
    const protocolFreezeCommit = 'f'.repeat(40)
    const manifest = createFreezeManifest({ spec, protocolFreezeCommit, artifacts })
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const boundaries = [
      'lease:prepared',
      'lease:committed',
      'attempt:staged',
      'attempt:prepared',
      'attempt:committed',
      'attempt:prepared-cleared',
      'result:staged',
      'result:prepared',
      'result:committed',
      'result:prepared-cleared',
      'lease:released',
    ]
    for (const boundary of boundaries) {
      const root = await mkdtemp(join(tmpdir(), 'router-v13-crash-success-'))
      const paths = {
        attemptPath: join(root, 'attempt.json'),
        resultPath: join(root, 'result.json'),
        failurePath: join(root, 'failure.json'),
      }
      const input = {
        manifestText,
        expectedManifestDigest: sha256(manifestText),
        expectedProtocolFreezeCommit: protocolFreezeCommit,
        artifacts,
        spec,
        runtimeArtifactRoot: root,
        ...paths,
      }
      let imports = 0
      const importRouter = async () => {
        imports += 1
        return {
          routeRequest(text: string) {
            return { phase: text.match(/route:(\w+)/)?.[1], reasons: [] }
          },
        }
      }
      try {
        await expect(runOneReveal({
          ...input,
          importRouter,
          persistence: { faultAt: boundary, processId: 2_147_483_647 },
        })).rejects.toThrow(`simulated hard crash after ${boundary}`)
        const recovered = await runOneReveal({ ...input, importRouter })
        expect(recovered.evidenceStatus).toBe('immutable-first-reveal')
        expect(imports, boundary).toBe(1)
        const replayed = await runOneReveal({
          ...input,
          importRouter: async () => { throw new Error('must not import a committed reveal') },
        })
        expect(replayed).toEqual(recovered)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 20_000)

  it('recovers every durable failure boundary without retrying a failed import', async () => {
    const { spec } = await loadSpec()
    const artifacts = frozenArtifacts(spec)
    const protocolFreezeCommit = '1'.repeat(40)
    const manifest = createFreezeManifest({ spec, protocolFreezeCommit, artifacts })
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    for (const boundary of ['failure:staged', 'failure:prepared', 'failure:committed', 'failure:prepared-cleared']) {
      const root = await mkdtemp(join(tmpdir(), 'router-v13-crash-failure-'))
      const paths = {
        attemptPath: join(root, 'attempt.json'),
        resultPath: join(root, 'result.json'),
        failurePath: join(root, 'failure.json'),
      }
      const input = {
        manifestText,
        expectedManifestDigest: sha256(manifestText),
        expectedProtocolFreezeCommit: protocolFreezeCommit,
        artifacts,
        spec,
        runtimeArtifactRoot: root,
        ...paths,
      }
      let imports = 0
      try {
        await expect(runOneReveal({
          ...input,
          importRouter: async () => {
            imports += 1
            throw new Error('stable importer failure')
          },
          persistence: { faultAt: boundary, processId: 2_147_483_647 },
        })).rejects.toThrow(`simulated hard crash after ${boundary}`)
        await expect(runOneReveal({
          ...input,
          importRouter: async () => {
            imports += 1
            throw new Error('must not retry')
          },
        })).rejects.toThrow('recorded reveal failure: stable importer failure')
        expect(imports, boundary).toBe(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('refuses recovery when the committed attempt is presented with changed inputs', async () => {
    const { spec } = await loadSpec()
    const artifacts = frozenArtifacts(spec)
    const protocolFreezeCommit = '2'.repeat(40)
    const manifest = createFreezeManifest({ spec, protocolFreezeCommit, artifacts })
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const root = await mkdtemp(join(tmpdir(), 'router-v13-input-drift-'))
    const paths = {
      attemptPath: join(root, 'attempt.json'),
      resultPath: join(root, 'result.json'),
      failurePath: join(root, 'failure.json'),
    }
    const input = {
      manifestText,
      expectedManifestDigest: sha256(manifestText),
      expectedProtocolFreezeCommit: protocolFreezeCommit,
      artifacts,
      spec,
      runtimeArtifactRoot: root,
      ...paths,
    }
    try {
      await expect(runOneReveal({
        ...input,
        importRouter: async () => { throw new Error('must not import before attempt commit') },
        persistence: { faultAt: 'attempt:committed', processId: 2_147_483_647 },
      })).rejects.toThrow('simulated hard crash')
      await expect(runOneReveal({
        ...input,
        artifacts: { ...artifacts, annotationRubric: 'changed after attempt' },
      })).rejects.toThrow('frozen artifacts changed')
      await expect(access(paths.resultPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(paths.failurePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(runOneReveal({
        ...input,
        importRouter: async () => ({
          routeRequest(text: string) {
            return { phase: text.match(/route:(\w+)/)?.[1], reasons: [] }
          },
        }),
      })).resolves.toMatchObject({ evidenceStatus: 'immutable-first-reveal' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never imports twice after execution is durably started', async () => {
    const { spec } = await loadSpec()
    const artifacts = frozenArtifacts(spec)
    const protocolFreezeCommit = '3'.repeat(40)
    const manifest = createFreezeManifest({ spec, protocolFreezeCommit, artifacts })
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const scenarios = [
      { name: 'execution:committed', faultAt: 'execution:committed', expectedImports: 0 },
      { name: 'execute:before-call', faultAt: 'execute:before-call', expectedImports: 0 },
      { name: 'execute:inside', hardCrashInside: true, expectedImports: 1 },
      { name: 'execute:returned', faultAt: 'execute:returned', expectedImports: 1 },
    ]
    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), 'router-v13-execution-crash-'))
      const paths = {
        attemptPath: join(root, 'attempt.json'),
        resultPath: join(root, 'result.json'),
        failurePath: join(root, 'failure.json'),
      }
      const input = {
        manifestText,
        expectedManifestDigest: sha256(manifestText),
        expectedProtocolFreezeCommit: protocolFreezeCommit,
        artifacts,
        spec,
        runtimeArtifactRoot: root,
        ...paths,
      }
      let imports = 0
      try {
        await expect(runOneReveal({
          ...input,
          importRouter: async () => {
            imports += 1
            if (scenario.hardCrashInside) throw new RevealPersistenceCrash('execute:inside')
            return {
              routeRequest(text: string) {
                return { phase: text.match(/route:(\w+)/)?.[1], reasons: [] }
              },
            }
          },
          persistence: {
            ...(scenario.faultAt === undefined ? {} : { faultAt: scenario.faultAt }),
            processId: 2_147_483_647,
          },
        })).rejects.toThrow('simulated hard crash')
        await expect(runOneReveal({
          ...input,
          importRouter: async () => {
            imports += 1
            throw new Error('must not import after durable execution start')
          },
        })).rejects.toThrow('recorded reveal failure: reveal process terminated after durable execution start')
        expect(imports, scenario.name).toBe(scenario.expectedImports)
        expect(JSON.parse(await readFile(paths.failurePath, 'utf8'))).toMatchObject({
          evidenceStatus: 'immutable-reveal-failure',
          revealAttemptSha256: sha256(await readFile(paths.attemptPath)),
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })
})
