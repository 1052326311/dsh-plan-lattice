import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  verifyCandidateFreezeManifest,
} from '../router-v14/candidate-reveal.mjs'
import {
  assertCandidateFreeze,
  assertProtocolFreeze,
  canonical,
  loadSpec,
  protocolId,
  sha256,
  validateSpec,
} from '../router-v14/protocol.mjs'
import {
  importFrozenRouter,
  verifyFrozenRuntimeArtifact,
} from '../router-v14/runtime-artifact.mjs'
import { loadSharedCorpus } from '../router-v14/shared-corpus.mjs'
import { executeRouterRows } from '../../eval/router-corpus/v13/freeze-reveal.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const defaultV13SourceRoot = resolve(here, '../../eval/router-corpus/v13')
const v14ProtocolFreezeCommit = '4031b0bf954892ffb4531f4504a070f9f8288938'

const files = Object.freeze({
  manifest: 'candidate-freeze-manifest.json',
  manifestDigest: 'candidate-freeze-manifest.sha256',
  attempt: 'candidate-reveal-attempt.json',
  result: 'candidate-reveal-result.json',
  failure: 'candidate-reveal-failure.json',
  runtime: 'runtime-artifact',
})

const defaults = Object.freeze({
  assertCandidateFreeze,
  assertProtocolFreeze,
  executeRouterRows,
  importFrozenRouter,
  loadSharedCorpus,
  loadSpec,
  validateSpec,
  verifyCandidateFreezeManifest,
  verifyFrozenRuntimeArtifact,
})

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function exactHex(value, length, context) {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value ?? '')) {
    throw new Error(`${context} is invalid`)
  }
  return value
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

async function readRequired(path, context) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`V14 evidence is missing ${context}`)
    throw error
  }
}

function parseJson(bytes, context) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`V14 ${context} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseDigestFile(bytes) {
  const text = bytes.toString('utf8')
  const match = text.match(/^([a-f0-9]{64})  candidate-freeze-manifest\.json\n?$/u)
  if (match === null) throw new Error('V14 freeze manifest digest file is invalid')
  return match[1]
}

function validateV13Outcome(outcome) {
  if (outcome?.status !== 'result' && outcome?.status !== 'failure') {
    throw new Error('V14 paired V13 outcome status is invalid')
  }
  exactHex(outcome.attemptSha256, 64, 'V14 paired V13 attempt digest')
  exactHex(outcome.outcomeSha256, 64, 'V14 paired V13 outcome digest')
  const expectedStatus = outcome.status === 'result' ? 'immutable-first-reveal' : 'immutable-reveal-failure'
  if (outcome.evidenceStatus !== expectedStatus) {
    throw new Error('V14 paired V13 evidence status is invalid')
  }
  if (outcome.status === 'result' && typeof outcome.releaseGatePassed !== 'boolean') {
    throw new Error('V14 paired V13 result is missing its recomputed gate status')
  }
  return outcome
}

function checkKnownCounterexamples(router, spec) {
  const rows = spec.knownCounterexamples.map(row => {
    const actual = router.routeRequest(row.text, spec.candidateFreeze.configuration).phase
    return { ...row, actual, passed: actual === row.expected }
  })
  return { rows, allPassed: rows.every(row => row.passed) }
}

function expectedAttempt({ manifestDigest, protocolFreezeCommit, spec, shared }) {
  return {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'candidate-reveal-consumed-before-router-execution',
    freezeManifestSha256: manifestDigest,
    protocolFreezeCommit,
    candidateCommit: spec.candidateFreeze.commit,
    sharedV13FreezeManifestSha256: shared.binding.freezeManifestSha256,
  }
}

/**
 * Independently verifies and replays a completed V14 reveal bundle.
 *
 * The default dependency path re-verifies the complete V13 freeze through
 * loadSharedCorpus(), verifies the frozen RC.4 runtime, imports that runtime,
 * and re-scores every blind row. Dependency injection exists only so tests can
 * replace external artifact acquisition while retaining the real manifest and
 * scoring implementations.
 */
export async function verifyV14EvidenceBundle({
  dataRoot,
  v13DataRoot = process.env.PLAN_LATTICE_V13_DATA_DIR,
  v13SourceRoot = defaultV13SourceRoot,
  runtimeArtifactRoot,
  dependencies = {},
} = {}) {
  if (!dataRoot) throw new Error('V14 evidence dataRoot is required')
  const root = resolve(dataRoot)
  const runtimeRoot = resolve(runtimeArtifactRoot ?? resolve(root, files.runtime))
  const dependency = { ...defaults, ...dependencies }

  const loaded = await dependency.loadSpec()
  const spec = dependency.validateSpec(loaded.spec)
  const candidate = await dependency.assertCandidateFreeze(spec)
  if (candidate.commit !== spec.candidateFreeze.commit
    || candidate.tree !== spec.candidateFreeze.tree
    || candidate.sourceDigest !== spec.candidateFreeze.sourceDigest) {
    throw new Error('V14 evidence uses the wrong candidate')
  }
  const protocol = dependency.assertProtocolFreeze(spec)
  if (protocol.commit !== v14ProtocolFreezeCommit) throw new Error('V14 evidence uses the wrong protocol freeze')

  const shared = await dependency.loadSharedCorpus({
    root: v13DataRoot,
    sourceRoot: resolve(v13SourceRoot),
    spec,
    requireRevealed: true,
  })
  validateV13Outcome(shared.v13Outcome)

  const verifiedRuntime = await dependency.verifyFrozenRuntimeArtifact(runtimeRoot)
  const runtimeManifest = verifiedRuntime?.manifest
  if (runtimeManifest === undefined) throw new Error('V14 frozen runtime verifier returned no manifest')

  const manifestPath = resolve(root, files.manifest)
  const manifestBytes = await readRequired(manifestPath, 'freeze manifest')
  const digestBytes = await readRequired(resolve(root, files.manifestDigest), 'freeze manifest digest')
  const manifestText = manifestBytes.toString('utf8')
  const manifestDigest = parseDigestFile(digestBytes)
  if (sha256(manifestText) !== manifestDigest) throw new Error('V14 freeze manifest differs from its digest commitment')
  const manifest = parseJson(manifestBytes, 'freeze manifest')
  dependency.verifyCandidateFreezeManifest(manifest, {
    spec,
    protocolFreezeCommit: protocol.commit,
    shared,
    runtimeManifest,
  })

  const attemptPath = resolve(root, files.attempt)
  const resultPath = resolve(root, files.result)
  const failurePath = resolve(root, files.failure)
  const [attemptPresent, resultPresent, failurePresent] = await Promise.all([
    exists(attemptPath),
    exists(resultPath),
    exists(failurePath),
  ])
  if (!attemptPresent || Number(resultPresent) + Number(failurePresent) !== 1) {
    throw new Error('V14 reveal evidence must contain one attempt and exactly one complete outcome')
  }
  if (failurePresent) throw new Error('V14 reveal ended in an immutable failure')

  const attemptBytes = await readRequired(attemptPath, 'reveal attempt')
  const attempt = parseJson(attemptBytes, 'reveal attempt')
  const recomputedAttempt = expectedAttempt({
    manifestDigest,
    protocolFreezeCommit: protocol.commit,
    spec,
    shared,
  })
  if (!same(attempt, recomputedAttempt)) throw new Error('V14 reveal attempt binding changed')

  const resultBytes = await readRequired(resultPath, 'reveal result')
  const result = parseJson(resultBytes, 'reveal result')
  const router = await dependency.importFrozenRouter(runtimeRoot)
  const knownCounterexamples = checkKnownCounterexamples(router, spec)
  const blind = dependency.executeRouterRows({
    router,
    artifacts: shared.artifacts,
    manifest: {
      configuration: spec.candidateFreeze.configuration,
      gates: Object.fromEntries(Object.entries(spec.releaseGates)
        .filter(([key]) => key !== 'knownCounterexamplesMustPass')),
    },
  })
  const releaseGatePassed = blind.analysis.releaseGatePassed && knownCounterexamples.allPassed
  const recomputedResult = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'immutable-first-candidate-reveal',
    freezeManifestSha256: manifestDigest,
    revealAttemptSha256: sha256(attemptBytes),
    sharedV13FreezeManifestSha256: shared.binding.freezeManifestSha256,
    pairedV13Outcome: shared.v13Outcome,
    knownCounterexamples,
    rows: blind.rows,
    analysis: { ...blind.analysis, releaseGatePassed },
  }
  if (!same(result, recomputedResult)) {
    throw new Error('V14 reveal result differs from independent replay and scoring')
  }
  if (!releaseGatePassed) throw new Error('V14 independently recomputed release gates did not pass')

  return {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'independently-verified-v14-reveal',
    candidateCommit: spec.candidateFreeze.commit,
    candidateTree: spec.candidateFreeze.tree,
    protocolFreezeCommit: protocol.commit,
    freezeManifestSha256: manifestDigest,
    revealAttemptSha256: sha256(attemptBytes),
    revealResultSha256: sha256(resultBytes),
    pairedV13Outcome: shared.v13Outcome,
    rows: blind.rows.length,
    recomputedRowsSha256: sha256(`${JSON.stringify(canonical(blind.rows), null, 2)}\n`),
    analysis: recomputedResult.analysis,
  }
}

export { files as v14EvidenceFiles }
