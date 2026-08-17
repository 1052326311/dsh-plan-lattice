import { runRevealStateMachine } from '../../eval/router-corpus/reveal-persistence.mjs'
import { scoreRouterRows } from '../../eval/router-corpus/v13/statistics.mjs'
import { canonical, protocolId, sanitizedMessage, sha256 } from './protocol.mjs'
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

function checkKnownCounterexamples(router, spec) {
  const rows = spec.knownCounterexamples.map(row => {
    const actual = router.routeRequest(row.text, spec.candidateFreeze.configuration).phase
    return { ...row, actual, passed: actual === row.expected }
  })
  return { rows, allPassed: rows.every(row => row.passed) }
}

function parseJsonLines(value, context) {
  const rows = value.toString().trim().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${context}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (rows.length === 0) throw new Error(`${context} must not be empty`)
  return rows
}

function validateResultRecord(result, { manifestDigest, shared, spec }, attemptDigest) {
  if (result?.schemaVersion !== 1
    || result.protocol !== protocolId
    || result.evidenceStatus !== 'immutable-first-candidate-reveal'
    || result.freezeManifestSha256 !== manifestDigest
    || result.revealAttemptSha256 !== attemptDigest
    || result.sharedV13FreezeManifestSha256 !== shared.binding.freezeManifestSha256
    || !semanticEqual(result.pairedV13Outcome, shared.v13Outcome)
    || !Array.isArray(result.rows)) {
    throw new Error('V14 persisted reveal result binding is invalid')
  }

  const expectedKnown = spec.knownCounterexamples.map(row => ({ ...row }))
  if (!Array.isArray(result.knownCounterexamples?.rows)
    || result.knownCounterexamples.rows.length !== expectedKnown.length) {
    throw new Error('V14 persisted known-counterexample coverage changed')
  }
  for (const [index, row] of result.knownCounterexamples.rows.entries()) {
    const expected = expectedKnown[index]
    if (row.text !== expected.text
      || row.expected !== expected.expected
      || !['bypass', 'contract', 'lattice', 'probe'].includes(row.actual)
      || row.passed !== (row.actual === expected.expected)) {
      throw new Error(`V14 persisted known counterexample ${index} is invalid`)
    }
  }
  const knownPassed = result.knownCounterexamples.rows.every(row => row.passed)
  if (result.knownCounterexamples.allPassed !== knownPassed) {
    throw new Error('V14 persisted known-counterexample summary changed')
  }

  const prompts = parseJsonLines(shared.artifacts.prompts, 'V14 shared prompts')
  const labels = new Map(parseJsonLines(shared.artifacts.labels, 'V14 shared labels').map(row => [row.id, row]))
  if (result.rows.length !== prompts.length) throw new Error('V14 persisted reveal result row coverage changed')
  for (const [index, row] of result.rows.entries()) {
    const prompt = prompts[index]
    const expected = labels.get(prompt.id)
    if (row?.id !== prompt.id
      || row.language !== prompt.language
      || row.expected !== expected?.expected
      || row.outcomeCritical !== expected?.outcomeCritical
      || !['bypass', 'contract', 'lattice', 'probe'].includes(row.actual)
      || !Array.isArray(row.reasons)) {
      throw new Error(`V14 persisted reveal result row ${index} is invalid`)
    }
  }
  const blindGates = Object.fromEntries(Object.entries(spec.releaseGates)
    .filter(([key]) => key !== 'knownCounterexamplesMustPass'))
  const blindAnalysis = scoreRouterRows(result.rows, blindGates)
  const expectedAnalysis = { ...blindAnalysis, releaseGatePassed: blindAnalysis.releaseGatePassed && knownPassed }
  if (!semanticEqual(result.analysis, expectedAnalysis)) throw new Error('V14 persisted reveal analysis changed')
}

function validateExecutionFailureRecord(failure, manifestDigest, attemptDigest) {
  if (failure?.schemaVersion !== 1
    || failure.protocol !== protocolId
    || failure.evidenceStatus !== 'immutable-candidate-reveal-failure'
    || failure.stage !== 'candidate-router-reveal'
    || failure.freezeManifestSha256 !== manifestDigest
    || failure.revealAttemptSha256 !== attemptDigest
    || typeof failure.message !== 'string') {
    throw new Error('V14 persisted reveal failure binding is invalid')
  }
}

function validatePreflightFailureRecord(failure, manifestDigest) {
  if (failure?.schemaVersion !== 1
    || failure.protocol !== protocolId
    || failure.evidenceStatus !== 'retired-before-candidate-reveal'
    || failure.stage !== 'pre-reveal-verification'
    || failure.freezeManifestSha256 !== manifestDigest
    || typeof failure.message !== 'string') {
    throw new Error('V14 persisted pre-reveal failure binding is invalid')
  }
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
  persistence,
}) {
  const manifestDigest = sha256(manifestText)
  return runRevealStateMachine({
    paths: { attemptPath, resultPath, failurePath },
    persistence,
    digest: sha256,
    prepare: async () => {
      if (!/^[a-f0-9]{64}$/u.test(expectedManifestDigest ?? '') || manifestDigest !== expectedManifestDigest) {
        throw new Error('V14 candidate freeze differs from its commitment')
      }
      const manifest = JSON.parse(manifestText)
      verifyCandidateFreezeManifest(manifest, { spec, protocolFreezeCommit, shared, runtimeManifest })
      return { manifest, manifestDigest, shared, spec }
    },
    createAttempt: () => ({
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'candidate-reveal-consumed-before-router-execution',
      freezeManifestSha256: manifestDigest,
      protocolFreezeCommit,
      candidateCommit: spec.candidateFreeze.commit,
      sharedV13FreezeManifestSha256: shared.binding.freezeManifestSha256,
    }),
    execute: async () => {
      const router = importRouter === undefined
        ? await (await import('./runtime-artifact.mjs')).importFrozenRouter(runtimeArtifactRoot)
        : await importRouter(runtimeArtifactRoot)
      const known = checkKnownCounterexamples(router, spec)
      const blind = executeRouterRows({
        router,
        artifacts: shared.artifacts,
        manifest: {
          configuration: spec.candidateFreeze.configuration,
          gates: Object.fromEntries(Object.entries(spec.releaseGates)
            .filter(([key]) => key !== 'knownCounterexamplesMustPass')),
        },
      })
      return { known, blind }
    },
    createResult: ({ known, blind }, _context, attemptDigest) => ({
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'immutable-first-candidate-reveal',
      freezeManifestSha256: manifestDigest,
      revealAttemptSha256: attemptDigest,
      sharedV13FreezeManifestSha256: shared.binding.freezeManifestSha256,
      pairedV13Outcome: shared.v13Outcome,
      knownCounterexamples: known,
      rows: blind.rows,
      analysis: { ...blind.analysis, releaseGatePassed: blind.analysis.releaseGatePassed && known.allPassed },
    }),
    createExecutionFailure: (error, _context, attemptDigest) => ({
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'immutable-candidate-reveal-failure',
      stage: 'candidate-router-reveal',
      freezeManifestSha256: manifestDigest,
      revealAttemptSha256: attemptDigest,
      message: sanitizedMessage(error),
    }),
    createPreflightFailure: error => ({
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'retired-before-candidate-reveal',
      stage: 'pre-reveal-verification',
      freezeManifestSha256: manifestDigest,
      message: sanitizedMessage(error),
    }),
    validateResult: validateResultRecord,
    validateExecutionFailure: (failure, _context, attemptDigest) => {
      validateExecutionFailureRecord(failure, manifestDigest, attemptDigest)
    },
    validatePreflightFailure: failure => validatePreflightFailureRecord(failure, manifestDigest),
  })
}
