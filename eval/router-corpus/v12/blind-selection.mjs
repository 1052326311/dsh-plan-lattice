import { resolveV12Adjudication, verifyV12Agreement } from './annotation-pipeline.mjs'
import { solveExactSelectionFlow } from './capacity-flow.mjs'
import { canonical, routes, sha256, stableLines } from './protocol.mjs'
import { verifyDrandBeacon } from './selection-beacon.mjs'

const languages = ['en', 'zh']
const frozenTargets = { bypass: 30, contract: 12, lattice: 12, probe: 6 }
const minimumEligiblePerStratum = 40

function digest(value) {
  return sha256(`${JSON.stringify(canonical(value))}\n`)
}

function assertSha256(value, context) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${context} must be a lowercase SHA-256 digest`)
  return value
}

function exactFrozenConstraints(spec) {
  if (JSON.stringify(spec?.blindSelection?.targetPerLanguage) !== JSON.stringify(frozenTargets)) {
    throw new Error('V12 final route quotas differ from the frozen 30/12/12/6 targets')
  }
  if (spec.blindSelection.maximumPerRepository !== 8 || spec.blindSelection.maximumPerRoutePerRepository !== 3) {
    throw new Error('V12 repository caps differ from the frozen 8/3 limits')
  }
  if (spec.limits?.minimumPostAnnotationPerLanguageRoute !== minimumEligiblePerStratum) {
    throw new Error('V12 post-annotation minimum differs from 40 rows per language/route')
  }
}

function sourceByCandidate(frame) {
  if (!Array.isArray(frame) || frame.length === 0) throw new Error('V12 source frame must be non-empty')
  const map = new Map()
  const families = new Set()
  for (const [index, row] of frame.entries()) {
    if (typeof row?.stableSourceId !== 'string' || row.stableSourceId === '') throw new Error(`V12 source frame row ${index + 1} has no stable ID`)
    if (typeof row.sourceFamilyId !== 'string' || row.sourceFamilyId === '') throw new Error(`V12 source frame row ${index + 1} has no family ID`)
    const id = `v12-${sha256(row.stableSourceId).slice(0, 20)}`
    const family = row.sourceFamilyId.toLowerCase()
    if (map.has(id)) throw new Error(`V12 source frame candidate collision ${id}`)
    if (families.has(family)) throw new Error(`V12 source frame duplicates family ${family}`)
    map.set(id, row)
    families.add(family)
  }
  return map
}

function assertCandidateSourceCoverage(candidates, frame) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('V12 candidates must be non-empty')
  const sourceMap = sourceByCandidate(frame)
  const candidateMap = new Map()
  for (const candidate of candidates) {
    if (candidateMap.has(candidate?.id)) throw new Error(`V12 candidates duplicate ${candidate?.id}`)
    const source = sourceMap.get(candidate?.id)
    if (source === undefined) throw new Error(`V12 source missing for ${candidate?.id}`)
    if (candidate.language !== source.language || candidate.text !== source.text) {
      throw new Error(`V12 candidate ${candidate.id} differs from its frozen source row`)
    }
    candidateMap.set(candidate.id, candidate)
  }
  if (candidateMap.size !== sourceMap.size) throw new Error('V12 candidates do not exactly cover the source frame')
  return { candidateMap, sourceMap }
}

function assertAdjudicationCoverage({ candidates, adjudicated, annotationSets, adjudicationPacket, adjudicationDecisions }) {
  if (!Array.isArray(adjudicated)) throw new Error('V12 adjudicated rows are required')
  const recomputed = resolveV12Adjudication({
    candidates,
    annotationSets,
    packet: adjudicationPacket,
    decisions: adjudicationDecisions,
  })
  if (JSON.stringify(canonical(recomputed)) !== JSON.stringify(canonical(adjudicated))) {
    throw new Error('V12 adjudicated rows do not match the complete frozen annotation evidence')
  }
  const resolvedMap = new Map(adjudicated.map(row => [row.id, row]))
  if (resolvedMap.size !== adjudicated.length || resolvedMap.size !== candidates.length) {
    throw new Error('V12 adjudication does not exactly cover every candidate')
  }
  for (const candidate of candidates) {
    const resolution = resolvedMap.get(candidate.id)
    if (resolution === undefined || typeof resolution.derived?.eligible !== 'boolean'
      || typeof resolution.derived.outcomeCritical !== 'boolean'
      || resolution.derived.eligible && !routes.includes(resolution.derived.route)
      || !resolution.derived.eligible && resolution.derived.route !== undefined) {
      throw new Error(`V12 adjudication result is invalid for ${candidate.id}`)
    }
  }
  return resolvedMap
}

function availableCounts(rows) {
  return Object.fromEntries(languages.flatMap(language => routes.map(route => [
    `${language}/${route}`,
    rows.filter(row => row.language === language && row.route === route).length,
  ])))
}

function selectedCounts(rows) {
  return {
    total: rows.length,
    byLanguageRoute: availableCounts(rows),
    repositories: new Set(rows.map(row => row.repository.toLowerCase())).size,
    sourceFamilies: new Set(rows.map(row => row.sourceFamilyId.toLowerCase())).size,
  }
}

export function prepareBlindSelectionCapacity({
  candidates,
  frame,
  annotationSets,
  agreementReport,
  adjudicationPacket,
  adjudicationDecisions,
  adjudicated,
  spec,
}) {
  exactFrozenConstraints(spec)
  const { sourceMap } = assertCandidateSourceCoverage(candidates, frame)
  verifyV12Agreement({ candidates, annotationSets, agreementReport, gates: spec.reliabilityGates })
  const resolvedMap = assertAdjudicationCoverage({
    candidates,
    adjudicated,
    annotationSets,
    adjudicationPacket,
    adjudicationDecisions,
  })
  const eligibleRows = candidates.flatMap(candidate => {
    const resolution = resolvedMap.get(candidate.id)
    if (!resolution.derived.eligible) return []
    const source = sourceMap.get(candidate.id)
    return [{
      id: candidate.id,
      language: candidate.language,
      route: resolution.derived.route,
      repository: source.repository,
      sourceFamilyId: source.sourceFamilyId,
    }]
  })
  const available = availableCounts(eligibleRows)
  for (const [stratum, count] of Object.entries(available)) {
    if (count < minimumEligiblePerStratum) {
      throw new Error(`V12 ${stratum} has ${count} eligible rows; requires at least ${minimumEligiblePerStratum} before beacon access`)
    }
  }
  const capacity = solveExactSelectionFlow({
    rows: eligibleRows,
    targetPerLanguage: spec.blindSelection.targetPerLanguage,
    maximumPerRepository: spec.blindSelection.maximumPerRepository,
    maximumPerRoutePerRepository: spec.blindSelection.maximumPerRoutePerRepository,
  })
  if (!capacity.feasible) {
    const error = new Error(`V12 exact capacity flow reached ${capacity.witness.flowValue}; requires ${capacity.witness.requiredFlow} before beacon access`)
    error.capacityWitness = capacity.witness
    throw error
  }
  const capacityManifest = {
    schemaVersion: 1,
    protocol: spec.protocol,
    evidenceStatus: 'exact-capacity-proven',
    feasible: true,
    witnessDigest: capacity.witness.witnessDigest,
    minimumEligiblePerLanguageRoute: minimumEligiblePerStratum,
    available,
    constraints: {
      targetPerLanguage: spec.blindSelection.targetPerLanguage,
      maximumPerRepository: spec.blindSelection.maximumPerRepository,
      maximumPerRoutePerRepository: spec.blindSelection.maximumPerRoutePerRepository,
      oneSelectedRowPerSourceFamily: true,
    },
    digests: {
      candidates: sha256(stableLines(candidates)),
      frame: sha256(stableLines(frame)),
      agreementReport: digest(agreementReport),
      adjudicated: sha256(stableLines(adjudicated)),
    },
    capacityWitness: capacity.witness,
  }
  return {
    eligibleRows,
    capacityManifest,
    capacityManifestDigest: digest(capacityManifest),
  }
}

export function deriveSelectionRandomness({ protocol, archiveMerkleRoot, capacityManifestDigest, beaconRandomness }) {
  assertSha256(archiveMerkleRoot, 'V12 archive Merkle root')
  assertSha256(capacityManifestDigest, 'V12 capacity manifest digest')
  assertSha256(beaconRandomness, 'V12 verified drand randomness')
  if (typeof protocol !== 'string' || protocol === '') throw new Error('V12 protocol identity is required')
  return sha256(`${protocol}${archiveMerkleRoot}${capacityManifestDigest}${beaconRandomness}`)
}

export async function selectBlindCorpus({
  candidates,
  frame,
  annotationSets,
  agreementReport,
  adjudicationPacket,
  adjudicationDecisions,
  adjudicated,
  spec,
  archiveMerkleRoot,
  loadBeacon,
  trustedVerifierPublicKey,
  now,
}) {
  const prepared = prepareBlindSelectionCapacity({
    candidates,
    frame,
    annotationSets,
    agreementReport,
    adjudicationPacket,
    adjudicationDecisions,
    adjudicated,
    spec,
  })
  assertSha256(archiveMerkleRoot, 'V12 archive Merkle root')
  if (typeof loadBeacon !== 'function') throw new Error('V12 beacon loader is required after capacity passes')
  const beaconInput = await loadBeacon({
    chainHash: spec.selectionBeacon.chainHash,
    round: spec.selectionBeacon.round,
    roundTime: spec.selectionBeacon.roundTime,
    capacityManifest: structuredClone(prepared.capacityManifest),
    capacityManifestDigest: prepared.capacityManifestDigest,
  })
  const beacon = verifyDrandBeacon({
    ...beaconInput,
    trustedVerifierPublicKey,
    spec,
    ...(now === undefined ? {} : { now }),
  })
  const selectionRandomness = deriveSelectionRandomness({
    protocol: spec.protocol,
    archiveMerkleRoot,
    capacityManifestDigest: prepared.capacityManifestDigest,
    beaconRandomness: beacon.randomness,
  })
  const selected = solveExactSelectionFlow({
    rows: prepared.eligibleRows,
    targetPerLanguage: spec.blindSelection.targetPerLanguage,
    maximumPerRepository: spec.blindSelection.maximumPerRepository,
    maximumPerRoutePerRepository: spec.blindSelection.maximumPerRoutePerRepository,
    orderingMaterial: selectionRandomness,
  })
  if (!selected.feasible) throw new Error('V12 randomized exact max-flow unexpectedly lost frozen capacity')

  const sourceMap = sourceByCandidate(frame)
  const resolvedMap = new Map(adjudicated.map(row => [row.id, row]))
  const selectedIds = new Set(selected.selectedRows.map(row => row.id))
  const prompts = candidates.filter(row => selectedIds.has(row.id)).sort((left, right) => left.id.localeCompare(right.id))
  const labels = prompts.map(candidate => ({
    id: candidate.id,
    language: candidate.language,
    expected: resolvedMap.get(candidate.id).derived.route,
    outcomeCritical: resolvedMap.get(candidate.id).derived.outcomeCritical,
  }))
  const sources = prompts.map(candidate => ({ id: candidate.id, ...sourceMap.get(candidate.id) }))
  const counts = selectedCounts(selected.selectedRows)
  const selectionManifest = {
    schemaVersion: 1,
    protocol: spec.protocol,
    evidenceStatus: 'frozen-blind-selection',
    derivedSeedDigest: sha256(selectionRandomness),
    counts,
    caps: {
      maximumPerRepository: spec.blindSelection.maximumPerRepository,
      maximumPerRoutePerRepository: spec.blindSelection.maximumPerRoutePerRepository,
      maximumPerSourceFamily: 1,
    },
    targetPerLanguage: spec.blindSelection.targetPerLanguage,
    archiveMerkleRoot,
    capacityManifestDigest: prepared.capacityManifestDigest,
    capacityWitnessDigest: prepared.capacityManifest.witnessDigest,
    beaconEvidenceDigest: digest(beacon),
    selectionWitnessDigest: selected.witness.witnessDigest,
    digests: {
      prompts: sha256(stableLines(prompts)),
      labels: sha256(stableLines(labels)),
      sources: sha256(stableLines(sources)),
    },
  }
  return {
    prompts,
    labels,
    sources,
    capacityManifest: prepared.capacityManifest,
    capacityManifestDigest: prepared.capacityManifestDigest,
    beacon,
    selectionManifest,
    selectionWitness: selected.witness,
  }
}
