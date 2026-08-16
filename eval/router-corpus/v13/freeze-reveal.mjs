import { createPublicKey } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { canonical, protocolId, sha256, stableLines, writeExclusive } from './protocol.mjs'
import { scoreRouterRows } from './statistics.mjs'

export const requiredFreezeArtifacts = Object.freeze([
  'spec',
  'archiveManifest',
  'sourceManifest',
  'sourceFrame',
  'sourceRejections',
  'annotationRubric',
  'annotationSchema',
  'annotationCandidates',
  'annotationPacketManifest',
  'annotationPacketA',
  'annotationPacketB',
  'annotationPacketC',
  'annotationMappings',
  'annotationsA',
  'annotationsB',
  'annotationsC',
  'agreementReport',
  'adjudicationPacket',
  'adjudicationDecisions',
  'adjudicated',
  'capacityManifest',
  'capacityWitness',
  'drandResponseRaw',
  'drandChainInfoRaw',
  'drandExternalVerification',
  'drandVerifierPublicKey',
  'beaconResponse',
  'selectionManifest',
  'selectionWitness',
  'prompts',
  'labels',
  'sources',
  'runtimeManifest',
  'statisticsSource',
])

function exactCommit(value, context) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) throw new Error(`${context} must be an exact Git commit`)
  return value
}

function bodyOf(value, context) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value
  throw new Error(`${context} must be a string or Buffer`)
}

function parseJsonArtifact(artifacts, name) {
  try {
    return JSON.parse(bodyOf(artifacts[name], `artifact ${name}`).toString())
  } catch (error) {
    throw new Error(`artifact ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseJsonLinesArtifact(artifacts, name) {
  const body = bodyOf(artifacts[name], `artifact ${name}`).toString()
  const rows = body.trim().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`artifact ${name}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (rows.length === 0) throw new Error(`artifact ${name} must not be empty`)
  return rows
}

function semanticJsonDigest(value) {
  return sha256(`${JSON.stringify(canonical(value))}\n`)
}

function artifactRecords(artifacts) {
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('V13 freeze artifacts must be an object')
  }
  for (const name of requiredFreezeArtifacts) {
    if (!Object.hasOwn(artifacts, name)) throw new Error(`V13 freeze artifacts are missing ${name}`)
  }
  return Object.fromEntries(Object.entries(artifacts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const body = bodyOf(value, `artifact ${name}`)
      return [name, { bytes: Buffer.byteLength(body), sha256: sha256(body) }]
    }))
}

function exactSelectionCoverage(artifacts, spec) {
  const prompts = parseJsonLinesArtifact(artifacts, 'prompts')
  const labels = parseJsonLinesArtifact(artifacts, 'labels')
  const sources = parseJsonLinesArtifact(artifacts, 'sources')
  const ids = rows => rows.map(row => row.id).sort()
  if (new Set(ids(prompts)).size !== prompts.length
    || JSON.stringify(ids(prompts)) !== JSON.stringify(ids(labels))
    || JSON.stringify(ids(prompts)) !== JSON.stringify(ids(sources))) {
    throw new Error('V13 prompts, labels, and sources must have exact unique ID coverage')
  }
  for (const language of ['en', 'zh']) {
    for (const [route, expected] of Object.entries(spec.blindSelection.targetPerLanguage)) {
      const observed = labels.filter(row => row.language === language && row.expected === route).length
      if (observed !== expected) throw new Error(`V13 frozen selection has ${observed} ${language}/${route} rows, expected ${expected}`)
    }
  }
  return prompts.length
}

function verifyPreRevealEvidence(artifacts, spec) {
  const archive = parseJsonArtifact(artifacts, 'archiveManifest')
  const source = parseJsonArtifact(artifacts, 'sourceManifest')
  const agreement = parseJsonArtifact(artifacts, 'agreementReport')
  const capacity = parseJsonArtifact(artifacts, 'capacityManifest')
  const beacon = parseJsonArtifact(artifacts, 'beaconResponse')
  const selection = parseJsonArtifact(artifacts, 'selectionManifest')
  const capacityWitness = parseJsonArtifact(artifacts, 'capacityWitness')
  const selectionWitness = parseJsonArtifact(artifacts, 'selectionWitness')
  const runtime = parseJsonArtifact(artifacts, 'runtimeManifest')
  const externalVerification = parseJsonArtifact(artifacts, 'drandExternalVerification')
  if (archive.protocol !== protocolId || archive.evidenceStatus !== 'frozen-raw-archive-manifest') {
    throw new Error('V13 archive manifest is not frozen raw evidence')
  }
  if (source.protocol !== protocolId || source.evidenceStatus !== 'immutable-post-cutoff-source-frame') {
    throw new Error('V13 source manifest is invalid')
  }
  if (source.archiveMerkleRoot !== archive.archiveMerkleRoot) throw new Error('V13 source frame uses another archive root')
  if (source.selectionBeaconAccessed === true || source.selectionSeedAccessed === true) {
    throw new Error('V13 source construction accessed selection randomness')
  }
  if (agreement?.gates?.allPassed !== true) throw new Error('V13 annotation reliability did not pass')
  if (capacity.evidenceStatus !== 'exact-capacity-proven' || capacity.feasible !== true) {
    throw new Error('V13 exact capacity was not proven')
  }
  if (capacity.witnessDigest !== capacityWitness.witnessDigest
    || capacity.capacityWitness?.witnessDigest !== capacityWitness.witnessDigest) {
    throw new Error('V13 exact-capacity manifest and witness differ')
  }
  if (beacon.evidenceStatus !== 'verified-drand-beacon'
    || beacon.chainHash !== spec.selectionBeacon.chainHash
    || beacon.round !== spec.selectionBeacon.round) {
    throw new Error('V13 beacon response is not the frozen verified round')
  }
  let trustedVerifierPublicKey
  try {
    trustedVerifierPublicKey = createPublicKey(bodyOf(artifacts.drandVerifierPublicKey, 'drand verifier public key'))
  } catch (error) {
    throw new Error(`V13 trusted drand verifier public key is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (beacon.responseSha256 !== sha256(bodyOf(artifacts.drandResponseRaw, 'raw drand response'))
    || beacon.chainInfoSha256 !== sha256(bodyOf(artifacts.drandChainInfoRaw, 'raw drand chain info'))
    || beacon.externalAttestationDigest !== semanticJsonDigest(externalVerification.attestation)
    || beacon.externalVerifierId !== externalVerification.attestation?.verifierId
    || beacon.trustedVerifierPublicKeySha256 !== sha256(trustedVerifierPublicKey.export({ format: 'der', type: 'spki' }))) {
    throw new Error('V13 beacon evidence is not bound to its raw response, attestation, and trust key')
  }
  if (selection.evidenceStatus !== 'frozen-blind-selection'
    || selection.capacityManifestDigest !== semanticJsonDigest(capacity)
    || selection.beaconEvidenceDigest !== semanticJsonDigest(beacon)
    || selection.selectionWitnessDigest !== selectionWitness.witnessDigest
    || selection.digests?.prompts !== sha256(bodyOf(artifacts.prompts, 'prompts'))
    || selection.digests?.labels !== sha256(bodyOf(artifacts.labels, 'labels'))
    || selection.digests?.sources !== sha256(bodyOf(artifacts.sources, 'sources'))) {
    throw new Error('V13 blind selection is not bound to capacity and beacon evidence')
  }
  if (runtime.schemaVersion !== 2 || runtime.exactCommit !== spec.routerFreeze.commit) {
    throw new Error('V13 runtime uses another router commit')
  }
  return { archive, source, agreement, capacity, beacon, selection, runtime }
}

export function createFreezeManifest({ spec, protocolFreezeCommit, artifacts }) {
  const records = artifactRecords(artifacts)
  const evidence = verifyPreRevealEvidence(artifacts, spec)
  const rowCount = exactSelectionCoverage(artifacts, spec)
  const specBody = bodyOf(artifacts.spec, 'artifact spec').toString()
  if (JSON.stringify(canonical(JSON.parse(specBody))) !== JSON.stringify(canonical(spec))) {
    throw new Error('V13 frozen spec artifact differs from the loaded spec')
  }
  return {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'frozen-before-one-reveal',
    protocolFreezeCommit: exactCommit(protocolFreezeCommit, 'V13 protocol freeze'),
    routerCommit: spec.routerFreeze.commit,
    routerSourceDigest: spec.routerFreeze.sourceDigest,
    configuration: spec.routerFreeze.configuration,
    gates: spec.releaseGates,
    rowCount,
    bindings: {
      archiveMerkleRoot: evidence.archive.archiveMerkleRoot,
      capacityManifestDigest: records.capacityManifest.sha256,
      beaconResponseDigest: records.beaconResponse.sha256,
      runtimeManifestDigest: records.runtimeManifest.sha256,
      statisticsSourceDigest: records.statisticsSource.sha256,
    },
    artifacts: records,
  }
}

export function verifyFreezeManifest(manifest, artifacts, spec, expectedProtocolFreezeCommit) {
  if (manifest?.schemaVersion !== 1 || manifest.protocol !== protocolId
    || manifest.evidenceStatus !== 'frozen-before-one-reveal') {
    throw new Error('V13 freeze manifest identity is invalid')
  }
  if (manifest.protocolFreezeCommit !== exactCommit(expectedProtocolFreezeCommit, 'expected V13 protocol freeze')
    || manifest.routerCommit !== spec.routerFreeze.commit
    || manifest.routerSourceDigest !== spec.routerFreeze.sourceDigest) {
    throw new Error('V13 freeze manifest code binding changed')
  }
  if (JSON.stringify(canonical(manifest.configuration)) !== JSON.stringify(canonical(spec.routerFreeze.configuration))
    || JSON.stringify(canonical(manifest.gates)) !== JSON.stringify(canonical(spec.releaseGates))) {
    throw new Error('V13 freeze manifest configuration or gates changed')
  }
  const records = artifactRecords(artifacts)
  if (JSON.stringify(canonical(manifest.artifacts)) !== JSON.stringify(canonical(records))) {
    throw new Error('V13 frozen artifacts changed')
  }
  const evidence = verifyPreRevealEvidence(artifacts, spec)
  const rowCount = exactSelectionCoverage(artifacts, spec)
  if (manifest.rowCount !== rowCount
    || manifest.bindings.archiveMerkleRoot !== evidence.archive.archiveMerkleRoot
    || manifest.bindings.capacityManifestDigest !== records.capacityManifest.sha256
    || manifest.bindings.beaconResponseDigest !== records.beaconResponse.sha256
    || manifest.bindings.runtimeManifestDigest !== records.runtimeManifest.sha256
    || manifest.bindings.statisticsSourceDigest !== records.statisticsSource.sha256) {
    throw new Error('V13 freeze manifest evidence binding changed')
  }
  return manifest
}

async function artifactsAbsent(paths) {
  for (const path of paths) {
    const exists = await access(path).then(() => true, () => false)
    if (exists) throw new Error(`V13 one-reveal artifact already exists: ${path}`)
  }
}

function sanitizedMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:gh[pousr]|sk)-[A-Za-z0-9_-]{16,}\b/gu, '<redacted>')
}

async function loadFrozenRouter(runtimeArtifactRoot, artifacts) {
  const module = await import('./runtime-artifact.mjs')
  if (typeof module.importFrozenRouter !== 'function') throw new Error('V13 frozen runtime importer is unavailable')
  parseJsonArtifact(artifacts, 'runtimeManifest')
  return module.importFrozenRouter(runtimeArtifactRoot)
}

export function executeRouterRows({ router, artifacts, manifest }) {
  if (typeof router?.routeRequest !== 'function') throw new Error('V13 frozen router lacks routeRequest')
  const prompts = parseJsonLinesArtifact(artifacts, 'prompts')
  const labels = new Map(parseJsonLinesArtifact(artifacts, 'labels').map(row => [row.id, row]))
  if (labels.size !== prompts.length) throw new Error('V13 label coverage changed before reveal')
  const rows = prompts.map(prompt => {
    const expected = labels.get(prompt.id)
    if (expected === undefined) throw new Error(`missing V13 label ${prompt.id}`)
    const assessment = router.routeRequest(prompt.text, manifest.configuration)
    return {
      id: prompt.id,
      language: prompt.language,
      expected: expected.expected,
      outcomeCritical: expected.outcomeCritical,
      actual: assessment.phase,
      reasons: assessment.reasons,
    }
  })
  return { rows, analysis: scoreRouterRows(rows, manifest.gates) }
}

export async function runOneReveal({
  manifestText,
  expectedManifestDigest,
  expectedProtocolFreezeCommit,
  artifacts,
  spec,
  runtimeArtifactRoot,
  attemptPath,
  resultPath,
  failurePath,
  importRouter = loadFrozenRouter,
}) {
  await artifactsAbsent([attemptPath, resultPath, failurePath])
  let manifest
  try {
    if (!/^[a-f0-9]{64}$/u.test(expectedManifestDigest ?? '')
      || sha256(manifestText) !== expectedManifestDigest) {
      throw new Error('V13 freeze manifest differs from its public commitment')
    }
    manifest = JSON.parse(manifestText)
    verifyFreezeManifest(manifest, artifacts, spec, expectedProtocolFreezeCommit)
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'retired-before-router-reveal',
      stage: 'pre-reveal-verification',
      freezeManifestSha256: sha256(manifestText),
      message: sanitizedMessage(error),
    }
    await writeExclusive(failurePath, `${JSON.stringify(failure, null, 2)}\n`)
    throw error
  }

  const attempt = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'one-reveal-consumed-before-router-execution',
    freezeManifestSha256: sha256(manifestText),
    protocolFreezeCommit: manifest.protocolFreezeCommit,
    routerCommit: manifest.routerCommit,
    artifactDigests: Object.fromEntries(Object.entries(manifest.artifacts)
      .map(([name, value]) => [name, value.sha256])),
  }
  const attemptText = `${JSON.stringify(attempt, null, 2)}\n`
  await writeExclusive(attemptPath, attemptText)

  try {
    const router = await importRouter(runtimeArtifactRoot, artifacts)
    const outcome = executeRouterRows({ router, artifacts, manifest })
    const result = {
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'immutable-first-reveal',
      freezeManifestSha256: sha256(manifestText),
      revealAttemptSha256: sha256(attemptText),
      ...outcome,
    }
    await writeExclusive(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      protocol: protocolId,
      evidenceStatus: 'immutable-reveal-failure',
      stage: 'router-reveal',
      freezeManifestSha256: sha256(manifestText),
      revealAttemptSha256: sha256(attemptText),
      message: sanitizedMessage(error),
    }
    await writeExclusive(failurePath, `${JSON.stringify(failure, null, 2)}\n`)
    throw error
  }
}

export async function freezeArtifactFromFile(path) {
  return readFile(path)
}

export function freezeArtifactText(values) {
  return stableLines(values)
}
