import {
  canonical,
  nonEmptyString,
  sha256,
  stableLines,
} from './pipeline-common.mjs'

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('annotation candidates must be non-empty')
  const ids = new Set()
  for (const [index, candidate] of candidates.entries()) {
    const keys = Object.keys(candidate).sort()
    if (canonical(keys) !== canonical(['id', 'language', 'text'])) {
      throw new Error(`candidate ${index + 1} exposes source metadata`)
    }
    nonEmptyString(candidate.id, `candidate ${index + 1}.id`)
    nonEmptyString(candidate.language, `candidate ${index + 1}.language`)
    nonEmptyString(candidate.text, `candidate ${index + 1}.text`)
    if (ids.has(candidate.id)) throw new Error(`annotation candidates duplicate ${candidate.id}`)
    ids.add(candidate.id)
  }
  return candidates
}

function annotatorNames(values) {
  if (!Array.isArray(values) || values.length !== 3) throw new Error('exactly three isolated annotators are required')
  const names = values.map((value, index) => nonEmptyString(value, `annotators[${index}]`))
  if (new Set(names).size !== names.length) throw new Error('annotator names must be unique')
  return names
}

function withoutDerived(annotation) {
  const { derived: _derived, ...whole } = annotation
  return whole
}

export function createIsolatedAnnotationPackets({ candidates, annotators, randomizationSeed }) {
  validateCandidates(candidates)
  const names = annotatorNames(annotators)
  const seed = nonEmptyString(randomizationSeed, 'annotation randomization seed')
  const packets = {}
  const mappings = {}
  for (const name of names) {
    const entries = candidates.map(candidate => ({
      candidate,
      packetId: `item-${sha256(`${seed}\nid\n${name}\n${candidate.id}`).slice(0, 24)}`,
      order: sha256(`${seed}\norder\n${name}\n${candidate.id}`),
    })).sort((left, right) => left.order.localeCompare(right.order))
    packets[name] = entries.map(({ candidate, packetId }) => ({
      id: packetId,
      language: candidate.language,
      text: candidate.text,
    }))
    mappings[name] = entries.map(({ candidate, packetId }) => ({ packetId, candidateId: candidate.id }))
  }
  return {
    packets,
    mappings,
    manifest: {
      schemaVersion: 1,
      evidenceStatus: 'three-isolated-annotation-packets',
      annotators: names,
      candidateCount: candidates.length,
      randomizationSeedCommitment: sha256(seed),
      packetDigests: Object.fromEntries(names.map(name => [name, sha256(stableLines(packets[name]))])),
      privateMappingDigests: Object.fromEntries(names.map(name => [name, sha256(stableLines(mappings[name]))])),
    },
  }
}

export function restoreAnnotationSets({ candidates, annotators, mappings, annotations, validateAnnotation }) {
  validateCandidates(candidates)
  const names = annotatorNames(annotators)
  if (typeof validateAnnotation !== 'function') throw new Error('validateAnnotation must be a function')
  const candidateIds = new Set(candidates.map(candidate => candidate.id))
  return names.map(name => {
    const mapping = mappings[name]
    const rows = annotations[name]
    if (!Array.isArray(mapping) || mapping.length !== candidates.length) throw new Error(`${name} mapping is incomplete`)
    if (!Array.isArray(rows) || rows.length !== candidates.length) throw new Error(`${name} annotations are incomplete`)
    const candidateByPacket = new Map()
    for (const entry of mapping) {
      nonEmptyString(entry.packetId, `${name} packet ID`)
      if (!candidateIds.has(entry.candidateId)) throw new Error(`${name} mapping contains unknown candidate`)
      if (candidateByPacket.has(entry.packetId)) throw new Error(`${name} mapping duplicates ${entry.packetId}`)
      candidateByPacket.set(entry.packetId, entry.candidateId)
    }
    const result = new Map()
    for (const [index, row] of rows.entries()) {
      const candidateId = candidateByPacket.get(row?.id)
      if (candidateId === undefined) throw new Error(`${name} annotations contain unknown packet ${row?.id}`)
      const validated = validateAnnotation({ ...row, id: candidateId }, `${name}:${index + 1}`)
      if (result.has(candidateId)) throw new Error(`${name} annotations duplicate ${candidateId}`)
      result.set(candidateId, validated)
    }
    if (result.size !== candidates.length) throw new Error(`${name} annotations do not cover every candidate`)
    return result
  })
}

function disagreement(annotations) {
  return new Set(annotations.map(annotation => canonical(annotation.facts))).size > 1
}

export function verifyAgreementGate({
  candidates,
  annotationSets,
  agreementReport,
  buildAgreementReport,
}) {
  validateCandidates(candidates)
  if (!Array.isArray(annotationSets) || annotationSets.length !== 3
    || annotationSets.some(value => !(value instanceof Map))) {
    throw new Error('agreement requires exactly three restored annotation maps')
  }
  if (typeof buildAgreementReport !== 'function') throw new Error('buildAgreementReport must be a function')
  const agreementDigests = {
    candidates: sha256(stableLines(candidates)),
    annotations: annotationSets.map((set, index) => ({
      annotator: index + 1,
      sha256: sha256(stableLines(candidates.map(candidate => withoutDerived(set.get(candidate.id))))),
    })),
  }
  const recomputed = buildAgreementReport(candidates, annotationSets, agreementDigests)
  if (canonical(recomputed) !== canonical(agreementReport)) {
    throw new Error('agreement report does not match the frozen annotation inputs')
  }
  if (recomputed?.gates?.allPassed !== true) {
    throw new Error('reliability gates failed; adjudication is forbidden')
  }
  return recomputed
}

export function createAdjudicationPacket({
  candidates,
  annotationSets,
  agreementReport,
  buildAgreementReport,
  optionRandomizationSeed,
}) {
  verifyAgreementGate({ candidates, annotationSets, agreementReport, buildAgreementReport })
  const seed = nonEmptyString(optionRandomizationSeed, 'adjudication option randomization seed')
  const packet = []
  for (const candidate of candidates) {
    const annotations = annotationSets.map(set => set.get(candidate.id))
    if (annotations.some(value => value === undefined)) throw new Error(`${candidate.id} is missing an annotation`)
    if (!disagreement(annotations)) continue
    const options = annotations.map((annotation, index) => ({
      id: `option-${sha256(`${seed}\n${candidate.id}\n${index}`).slice(0, 16)}`,
      annotation: withoutDerived(annotation),
      order: sha256(`${seed}\norder\n${candidate.id}\n${index}`),
    })).sort((left, right) => left.order.localeCompare(right.order))
      .map(({ order: _order, ...option }) => option)
    packet.push({
      id: candidate.id,
      language: candidate.language,
      text: candidate.text,
      options,
    })
  }
  return packet.sort((left, right) => sha256(`${seed}\nrow\n${left.id}`)
    .localeCompare(sha256(`${seed}\nrow\n${right.id}`)))
}

function normalizedRationale(value) {
  return nonEmptyString(value, 'adjudication rationale').replace(/\s+/gu, ' ').toLowerCase()
}

function validatePacketRow(candidate, packetRow, annotations) {
  if (packetRow === null || typeof packetRow !== 'object' || Array.isArray(packetRow)) {
    throw new Error(`adjudication packet ${candidate.id} must be an object`)
  }
  if (canonical(Object.keys(packetRow).sort()) !== canonical(['id', 'language', 'options', 'text'])) {
    throw new Error(`adjudication packet ${candidate.id} exposes forbidden fields`)
  }
  if (packetRow.id !== candidate.id
    || packetRow.language !== candidate.language
    || packetRow.text !== candidate.text) {
    throw new Error(`adjudication packet ${candidate.id} differs from the candidate prompt`)
  }
  if (!Array.isArray(packetRow.options) || packetRow.options.length !== 3) {
    throw new Error(`adjudication packet ${candidate.id} must contain exactly three whole records`)
  }
  const optionIds = new Set()
  for (const option of packetRow.options) {
    if (canonical(Object.keys(option ?? {}).sort()) !== canonical(['annotation', 'id'])) {
      throw new Error(`adjudication packet ${candidate.id} has an invalid option`)
    }
    nonEmptyString(option.id, `adjudication packet ${candidate.id} option ID`)
    if (optionIds.has(option.id)) throw new Error(`adjudication packet ${candidate.id} duplicates an option ID`)
    optionIds.add(option.id)
  }
  const expected = annotations.map(annotation => canonical(withoutDerived(annotation))).sort()
  const actual = packetRow.options.map(option => canonical(option.annotation)).sort()
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`adjudication packet ${candidate.id} contains a synthesized annotation record`)
  }
}

export function resolveAdjudication({
  candidates,
  annotationSets,
  packet,
  decisions,
  deriveLabel,
  minimumRationaleCharacters = 40,
}) {
  validateCandidates(candidates)
  if (!Array.isArray(annotationSets) || annotationSets.length !== 3) throw new Error('resolution requires three annotation sets')
  if (!Array.isArray(packet) || !Array.isArray(decisions)) throw new Error('packet and decisions must be arrays')
  if (typeof deriveLabel !== 'function') throw new Error('deriveLabel must be a function')
  const packetById = new Map(packet.map(row => [row.id, row]))
  if (packetById.size !== packet.length) throw new Error('adjudication packet duplicates a candidate')
  const disagreementIds = new Set(candidates.filter(candidate => (
    disagreement(annotationSets.map(set => set.get(candidate.id)))
  )).map(candidate => candidate.id))
  if (canonical([...packetById.keys()].sort()) !== canonical([...disagreementIds].sort())) {
    throw new Error('adjudication packet must contain every and only disagreement row')
  }
  const decisionsById = new Map()
  const rationales = new Set()
  for (const decision of decisions) {
    const keys = Object.keys(decision ?? {}).sort()
    if (canonical(keys) !== canonical(['id', 'rationale', 'selectedOption'])) {
      throw new Error(`adjudication decision ${decision?.id ?? '<unknown>'} has invalid keys`)
    }
    const row = packetById.get(decision.id)
    if (row === undefined) throw new Error(`${decision.id} is not a disagreement row`)
    if (!row.options.some(option => option.id === decision.selectedOption)) {
      throw new Error(`${decision.id} does not select one whole annotation record`)
    }
    const rationale = normalizedRationale(decision.rationale)
    if (decision.rationale.trim().length < minimumRationaleCharacters) {
      throw new Error(`${decision.id} rationale is too short`)
    }
    if (rationales.has(rationale)) throw new Error(`${decision.id} repeats another adjudication rationale`)
    rationales.add(rationale)
    if (decisionsById.has(decision.id)) throw new Error(`adjudication decisions duplicate ${decision.id}`)
    decisionsById.set(decision.id, decision)
  }
  if (decisionsById.size !== packet.length) {
    throw new Error('decisions must cover every and only disagreement row')
  }

  return candidates.map(candidate => {
    const annotations = annotationSets.map(set => set.get(candidate.id))
    const isDisagreement = disagreement(annotations)
    if (isDisagreement !== packetById.has(candidate.id)) {
      throw new Error(`adjudication packet disagreement set is invalid for ${candidate.id}`)
    }
    let annotation
    let resolution
    if (isDisagreement) {
      const packetRow = packetById.get(candidate.id)
      validatePacketRow(candidate, packetRow, annotations)
      const decision = decisionsById.get(candidate.id)
      annotation = packetRow.options.find(option => option.id === decision.selectedOption).annotation
      resolution = decision.selectedOption
    } else {
      annotation = withoutDerived(annotations[0])
      resolution = 'unanimous'
    }
    return {
      id: candidate.id,
      annotation,
      derived: deriveLabel(annotation.facts),
      resolution,
    }
  })
}
