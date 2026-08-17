import { access } from 'node:fs/promises'
import { canonical, protocolId, sanitizedMessage, sha256, writeExclusive } from './protocol.mjs'
import { executeRouterRows } from '../../eval/router-corpus/v13/freeze-reveal.mjs'

function semanticEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function runtimeBinding(runtimeManifest, spec) {
  if (runtimeManifest?.schemaVersion !== 2
    || runtimeManifest.kind !== 'dsh-plan-lattice-v14-frozen-router-runtime'
    || runtimeManifest.exactCommit !== spec.candidateFreeze.commit
    || runtimeManifest.exactTree !== spec.candidateFreeze.tree
    || runtimeManifest.digests?.sourceSha256 !== spec.candidateFreeze.runtimeArtifact.sourceSha256) {
    throw new Error('V14 runtime manifest is not the frozen RC.4 candidate')
  }
  return { sha256: sha256(`${JSON.stringify(runtimeManifest, null, 2)}\n`), artifactSha256: runtimeManifest.artifactSha256 }
}

export function createCandidateFreezeManifest({ spec, protocolFreezeCommit, shared, runtimeManifest }) {
  const runtime = runtimeBinding(runtimeManifest, spec)
  return {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'candidate-frozen-before-shared-corpus-reveal',
    protocolFreezeCommit,
    candidateTag: spec.candidateFreeze.publicRef,
    candidateCommit: spec.candidateFreeze.commit,
    candidateTree: spec.candidateFreeze.tree,
    candidateSourceDigest: spec.candidateFreeze.sourceDigest,
    configuration: spec.candidateFreeze.configuration,
    gates: spec.releaseGates,
    knownCounterexamples: spec.knownCounterexamples,
    sharedCorpus: shared.binding,
    runtime,
  }
}

export function verifyCandidateFreezeManifest(manifest, { spec, protocolFreezeCommit, shared, runtimeManifest }) {
  const expected = createCandidateFreezeManifest({ spec, protocolFreezeCommit, shared, runtimeManifest })
  if (!semanticEqual(manifest, expected)) throw new Error('V14 candidate freeze manifest changed')
  return manifest
}

async function outputsAbsent(paths) {
  for (const path of paths) {
    if (await access(path).then(() => true, () => false)) throw new Error(`V14 one-reveal artifact already exists: ${path}`)
  }
}

function checkKnownCounterexamples(router, spec) {
  const rows = spec.knownCounterexamples.map(row => {
    const actual = router.routeRequest(row.text, spec.candidateFreeze.configuration).phase
    return { ...row, actual, passed: actual === row.expected }
  })
  return { rows, allPassed: rows.every(row => row.passed) }
}

export async function runCandidateReveal({
  manifestText,
  expectedManifestDigest,
  protocolFreezeCommit,
  shared,
  spec,
  runtimeManifest,
  runtimeArtifactRoot,
  attemptPath,
  resultPath,
  failurePath,
  importRouter,
}) {
  await outputsAbsent([attemptPath, resultPath, failurePath])
  let manifest
  try {
    if (!/^[a-f0-9]{64}$/u.test(expectedManifestDigest ?? '') || sha256(manifestText) !== expectedManifestDigest) {
      throw new Error('V14 candidate freeze differs from its commitment')
    }
    manifest = JSON.parse(manifestText)
    verifyCandidateFreezeManifest(manifest, { spec, protocolFreezeCommit, shared, runtimeManifest })
  } catch (error) {
    await writeExclusive(failurePath, `${JSON.stringify({
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'retired-before-candidate-reveal',
      stage: 'pre-reveal-verification',
      freezeManifestSha256: sha256(manifestText),
      message: sanitizedMessage(error),
    }, null, 2)}\n`)
    throw error
  }

  const attempt = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'candidate-reveal-consumed-before-router-execution',
    freezeManifestSha256: sha256(manifestText),
    protocolFreezeCommit,
    candidateCommit: spec.candidateFreeze.commit,
    sharedV13FreezeManifestSha256: shared.binding.freezeManifestSha256,
  }
  const attemptText = `${JSON.stringify(attempt, null, 2)}\n`
  await writeExclusive(attemptPath, attemptText)
  try {
    const router = importRouter === undefined
      ? await (await import('./runtime-artifact.mjs')).importFrozenRouter(runtimeArtifactRoot)
      : await importRouter(runtimeArtifactRoot)
    const known = checkKnownCounterexamples(router, spec)
    const blind = executeRouterRows({
      router,
      artifacts: shared.artifacts,
      manifest: {
        configuration: spec.candidateFreeze.configuration,
        gates: Object.fromEntries(Object.entries(spec.releaseGates).filter(([key]) => key !== 'knownCounterexamplesMustPass')),
      },
    })
    const releaseGatePassed = blind.analysis.releaseGatePassed && known.allPassed
    const result = {
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'immutable-first-candidate-reveal',
      freezeManifestSha256: sha256(manifestText),
      revealAttemptSha256: sha256(attemptText),
      sharedV13FreezeManifestSha256: shared.binding.freezeManifestSha256,
      pairedV13Outcome: shared.v13Outcome,
      knownCounterexamples: known,
      rows: blind.rows,
      analysis: { ...blind.analysis, releaseGatePassed },
    }
    await writeExclusive(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch (error) {
    await writeExclusive(failurePath, `${JSON.stringify({
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'immutable-candidate-reveal-failure',
      stage: 'candidate-router-reveal',
      freezeManifestSha256: sha256(manifestText),
      revealAttemptSha256: sha256(attemptText),
      message: sanitizedMessage(error),
    }, null, 2)}\n`)
    throw error
  }
}
