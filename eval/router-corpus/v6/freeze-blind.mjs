#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAgreementReport } from './agreement.mjs'
import { validateAnnotationSet } from './annotation-schema.mjs'
import { deriveLabel } from './derive-label.mjs'
import {
  annotationGates,
  assertArtifactsAbsent,
  assertFrozenRuntime,
  expectedCounts,
  here,
  languages,
  lines,
  loadJsonLines,
  releaseGates,
  routes,
  sha256,
  targetPerLanguage,
  writeExclusive,
} from './protocol.mjs'

const annotationNames = ['a', 'b', 'c']
const ordinalFields = ['authorizationEpochs', 'verificationHorizon', 'staleActionLoss', 'recovery']
const selectionSeed = 'plan-lattice-router-v6-first-reveal-2026-08-16'
const selectionOrder = 'sha256-v1:utf8(seed + LF + language + LF + route + LF + candidate-id)'
const outputPaths = {
  prompts: join(here, 'blind-v6.prompts.jsonl'),
  labels: join(here, 'blind-v6.labels.jsonl'),
  sources: join(here, 'blind-v6.sources.jsonl'),
  manifest: join(here, 'blind-v6.manifest.json'),
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value, expected, context) {
  if (!isObject(value)) throw new Error(`${context} must be an object`)
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} must contain exactly ${expected.join(', ')}`)
  }
}

function assertDigest(actual, expected, context) {
  if (actual !== expected) throw new Error(`${context} digest mismatch`)
}

function assertGate(actual, expected, context) {
  if (!Number.isFinite(actual) || actual < expected) {
    throw new Error(`${context} ${String(actual)} does not meet the frozen gate ${expected}`)
  }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertCandidateManifest(manifest, runtime, texts) {
  if (!isObject(manifest) || manifest.schemaVersion !== 1) throw new Error('candidate manifest schema is invalid')
  if (manifest.codeFreezeCommit !== runtime.exactCommit) {
    throw new Error('candidate manifest is not bound to the exact V6 code freeze')
  }
  if (manifest.runtimeDigest !== runtime.runtimeDigest) {
    throw new Error('candidate manifest runtime does not match the V6 code freeze')
  }
  for (const [name, text] of Object.entries(texts)) {
    assertDigest(manifest.digests?.[name], sha256(text), `candidate manifest ${name}`)
  }
}

function assertAgreementReport(report, candidateCount, candidateDigest, annotationDigests) {
  if (!isObject(report) || report.schemaVersion !== 1) throw new Error('agreement report schema is invalid')
  if (report.counts?.candidates !== candidateCount || report.counts?.annotators !== 3) {
    throw new Error('agreement report must cover three complete annotations for every candidate')
  }
  for (const [gate, value] of Object.entries(annotationGates)) {
    if (report.thresholds?.[gate] !== value) throw new Error(`agreement report changed frozen gate ${gate}`)
  }
  assertGate(report.agreement?.route?.kappa, annotationGates.routeKappaMin, 'route kappa')
  assertGate(
    report.agreement?.outcomeCritical?.kappa,
    annotationGates.outcomeCriticalKappaMin,
    'outcome-critical kappa',
  )
  if (!isObject(report.agreement?.ordinal?.fields)) {
    throw new Error('agreement report must contain per-axis ordinal weighted kappa')
  }
  for (const field of ordinalFields) {
    assertGate(
      report.agreement.ordinal.fields[field]?.minimumPair?.kappa,
      annotationGates.ordinalWeightedKappaMin,
      `${field} weighted kappa`,
    )
  }
  if (report.gates?.route !== true
    || report.gates?.outcomeCritical !== true
    || report.gates?.ordinal !== true
    || report.gates?.allPassed !== true) {
    throw new Error('agreement report did not pass every frozen V6 reliability gate')
  }
  assertDigest(report.digests?.candidates, candidateDigest, 'agreement report candidates')
  if (!Array.isArray(report.digests?.annotations)
    || report.digests.annotations.length !== annotationDigests.length) {
    throw new Error('agreement report must bind exactly three annotation files')
  }
  for (const [index, digest] of annotationDigests.entries()) {
    const binding = report.digests.annotations[index]
    if (!isObject(binding) || binding.annotator !== index + 1) {
      throw new Error(`agreement report annotation ${index + 1} binding is invalid`)
    }
    assertDigest(binding.sha256, digest, `agreement report annotation ${index + 1}`)
  }
}

function withoutDerived(annotation) {
  const { derived: _derived, ...wholeRecord } = annotation
  return wholeRecord
}

function selectionKey(candidate, route) {
  return sha256(`${selectionSeed}\n${candidate.language}\n${route}\n${candidate.id}`)
}

await assertArtifactsAbsent(Object.values(outputPaths), 'V6 freeze')

const runtime = await assertFrozenRuntime()
const [candidates, candidateSources, annotationsA, annotationsB, annotationsC, packet, decisions] = await Promise.all([
  loadJsonLines('candidates.jsonl'),
  loadJsonLines('sources.jsonl'),
  loadJsonLines('annotations-a.jsonl'),
  loadJsonLines('annotations-b.jsonl'),
  loadJsonLines('annotations-c.jsonl'),
  loadJsonLines('adjudication-packet.jsonl'),
  loadJsonLines('adjudication-decisions.jsonl'),
])
const [
  candidateManifestText,
  sourceConfigText,
  rubricText,
  annotationSchemaText,
  deriveLabelText,
  protocolText,
  sourceIsolationText,
  collectorText,
  agreementReportText,
  packetManifestText,
  agreementScriptText,
  buildScriptText,
  freezeScriptText,
] = await Promise.all([
  readFile(join(here, 'candidate-manifest.json'), 'utf8'),
  readFile(join(here, 'source-config.archive.json'), 'utf8'),
  readFile(join(here, 'ANNOTATION_RUBRIC.md'), 'utf8'),
  readFile(join(here, 'annotation-schema.mjs'), 'utf8'),
  readFile(join(here, 'derive-label.mjs'), 'utf8'),
  readFile(join(here, 'protocol.mjs'), 'utf8'),
  readFile(join(here, 'source-isolation.mjs'), 'utf8'),
  readFile(join(here, 'collect-candidates.mjs'), 'utf8'),
  readFile(join(here, 'agreement-report.json'), 'utf8'),
  readFile(join(here, 'adjudication-packet.manifest.json'), 'utf8'),
  readFile(join(here, 'agreement.mjs'), 'utf8'),
  readFile(join(here, 'build-adjudication.mjs'), 'utf8'),
  readFile(join(here, 'freeze-blind.mjs'), 'utf8'),
])
const candidateManifest = JSON.parse(candidateManifestText)
const agreementReport = JSON.parse(agreementReportText)
const packetManifest = JSON.parse(packetManifestText)

assertCandidateManifest(candidateManifest, runtime, {
  candidates: candidates.text,
  sources: candidateSources.text,
  sourceConfig: sourceConfigText,
  'ANNOTATION_RUBRIC.md': rubricText,
  'annotation-schema.mjs': annotationSchemaText,
  'derive-label.mjs': deriveLabelText,
  'protocol.mjs': protocolText,
  'collect-candidates.mjs': collectorText,
  'source-isolation.mjs': sourceIsolationText,
})
if (candidateManifest.counts?.total !== candidates.rows.length
  || candidateSources.rows.length !== candidates.rows.length) {
  throw new Error('candidate, source, and manifest counts do not match')
}

const sourceById = new Map()
for (const [index, candidate] of candidates.rows.entries()) {
  if (!isObject(candidate)
    || typeof candidate.id !== 'string'
    || !languages.includes(candidate.language)
    || typeof candidate.text !== 'string'
    || candidate.text.trim() === '') {
    throw new Error(`candidates.jsonl:${index + 1} is invalid`)
  }
  const source = candidateSources.rows[index]
  if (!isObject(source) || source.id !== candidate.id || source.promptDigest !== sha256(candidate.text)) {
    throw new Error(`source binding mismatch for ${candidate.id}`)
  }
  if (sourceById.has(source.id)) throw new Error(`sources.jsonl duplicates ${source.id}`)
  sourceById.set(source.id, source)
}

const annotationSets = {
  a: validateAnnotationSet(candidates.rows, annotationsA.rows, 'annotations A'),
  b: validateAnnotationSet(candidates.rows, annotationsB.rows, 'annotations B'),
  c: validateAnnotationSet(candidates.rows, annotationsC.rows, 'annotations C'),
}
const inputDigests = {
  candidateManifest: sha256(candidateManifestText),
  candidates: sha256(candidates.text),
  sources: sha256(candidateSources.text),
  annotationsA: sha256(annotationsA.text),
  annotationsB: sha256(annotationsB.text),
  annotationsC: sha256(annotationsC.text),
}
const agreementBindings = {
  candidates: inputDigests.candidates,
  annotations: [inputDigests.annotationsA, inputDigests.annotationsB, inputDigests.annotationsC]
    .map((digest, index) => ({ annotator: index + 1, sha256: digest })),
}
const recomputedAgreementReport = buildAgreementReport(
  candidates.rows,
  annotationNames.map(name => annotationSets[name]),
  agreementBindings,
)
if (JSON.stringify(agreementReport) !== JSON.stringify(recomputedAgreementReport)) {
  throw new Error('agreement report does not exactly match the frozen calculation over annotations A, B, and C')
}
assertAgreementReport(
  agreementReport,
  candidates.rows.length,
  inputDigests.candidates,
  [inputDigests.annotationsA, inputDigests.annotationsB, inputDigests.annotationsC],
)

if (!isObject(packetManifest) || packetManifest.schemaVersion !== 1) {
  throw new Error('adjudication packet manifest schema is invalid')
}
if (packetManifest.codeFreezeCommit !== runtime.exactCommit
  || packetManifest.runtimeDigest !== runtime.runtimeDigest
  || packetManifest.counts?.candidates !== candidates.rows.length
  || packetManifest.counts?.annotators !== annotationNames.length) {
  throw new Error('adjudication packet manifest is not bound to this complete V6 annotation set')
}
const expectedDecisionFormat = {
  exactKeys: ['id', 'selectedAnnotation', 'rationale'],
  selectedAnnotation: annotationNames,
  minimumRationaleCharacters: 40,
  repeatedRationalesAllowed: false,
  fieldWiseSynthesisAllowed: false,
}
if (JSON.stringify(packetManifest.decisionFormat) !== JSON.stringify(expectedDecisionFormat)) {
  throw new Error('adjudication decision format differs from the frozen whole-record selection format')
}
const packetInputDigests = {
  ...inputDigests,
  sourceConfig: sha256(sourceConfigText),
  annotationRubric: sha256(rubricText),
  annotationSchema: sha256(annotationSchemaText),
  deriveLabel: sha256(deriveLabelText),
  protocol: sha256(protocolText),
  sourceIsolation: sha256(sourceIsolationText),
  collector: sha256(collectorText),
  agreement: sha256(agreementScriptText),
  agreementReport: sha256(agreementReportText),
  buildAdjudication: sha256(buildScriptText),
  adjudicationPacket: sha256(packet.text),
}
for (const [name, digest] of Object.entries(packetInputDigests)) {
  assertDigest(packetManifest.digests?.[name], digest, `adjudication packet manifest ${name}`)
}

if (packet.rows.length !== candidates.rows.length) {
  throw new Error('adjudication packet must contain every candidate exactly once')
}
const packetById = new Map()
for (const [index, row] of packet.rows.entries()) {
  const candidate = candidates.rows[index]
  assertExactKeys(row, ['id', 'language', 'text', 'source', 'annotations'], `adjudication packet:${index + 1}`)
  if (row.id !== candidate.id || row.language !== candidate.language || row.text !== candidate.text) {
    throw new Error(`adjudication packet candidate binding mismatch for ${candidate.id}`)
  }
  if (JSON.stringify(row.source) !== JSON.stringify(sourceById.get(candidate.id))) {
    throw new Error(`adjudication packet source binding mismatch for ${candidate.id}`)
  }
  assertExactKeys(row.annotations, annotationNames, `adjudication packet annotations for ${candidate.id}`)
  for (const name of annotationNames) {
    const expected = withoutDerived(annotationSets[name].get(candidate.id))
    if (JSON.stringify(row.annotations[name]) !== JSON.stringify(expected)) {
      throw new Error(`adjudication packet changed annotation ${name} for ${candidate.id}`)
    }
  }
  if (packetById.has(row.id)) throw new Error(`adjudication packet duplicates ${row.id}`)
  packetById.set(row.id, row)
}

const decisionById = new Map()
const normalizedRationales = new Set()
for (const [index, decision] of decisions.rows.entries()) {
  assertExactKeys(decision, expectedDecisionFormat.exactKeys, `adjudication decisions:${index + 1}`)
  if (!packetById.has(decision.id)) throw new Error(`adjudication decisions contains unknown candidate ${decision.id}`)
  if (!annotationNames.includes(decision.selectedAnnotation)) {
    throw new Error(`adjudication decision for ${decision.id} must select a, b, or c`)
  }
  if (typeof decision.rationale !== 'string' || decision.rationale.trim().length < 40) {
    throw new Error(`adjudication decision for ${decision.id} needs a row-specific rationale of at least 40 characters`)
  }
  const normalized = decision.rationale.trim().replace(/\s+/g, ' ').toLowerCase()
  if (normalizedRationales.has(normalized)) {
    throw new Error(`adjudication decision for ${decision.id} repeats another row's rationale`)
  }
  normalizedRationales.add(normalized)
  if (decisionById.has(decision.id)) throw new Error(`adjudication decisions duplicates ${decision.id}`)
  decisionById.set(decision.id, decision)
}
if (decisionById.size !== candidates.rows.length) {
  const missing = candidates.rows.filter(row => !decisionById.has(row.id)).map(row => row.id)
  throw new Error(`adjudication decisions must select one whole record for every candidate; missing ${missing.join(', ')}`)
}

const resolved = candidates.rows.flatMap(candidate => {
  const decision = decisionById.get(candidate.id)
  const selected = withoutDerived(annotationSets[decision.selectedAnnotation].get(candidate.id))
  const packetSelected = packetById.get(candidate.id).annotations[decision.selectedAnnotation]
  if (JSON.stringify(selected) !== JSON.stringify(packetSelected)) {
    throw new Error(`selected whole annotation changed for ${candidate.id}`)
  }
  const derived = deriveLabel(selected.facts)
  if (!derived.eligible) return []
  if (!routes.includes(derived.route)) throw new Error(`frozen derivation returned an invalid route for ${candidate.id}`)
  return [{ candidate, source: sourceById.get(candidate.id), decision, annotation: selected, derived }]
})

const available = Object.fromEntries(languages.flatMap(language => routes.map(route => [
  `${language}/${route}`,
  resolved.filter(row => row.candidate.language === language && row.derived.route === route).length,
])))
for (const language of languages) {
  for (const route of routes) {
    const required = targetPerLanguage[route]
    const count = available[`${language}/${route}`]
    if (count < required) throw new Error(`V6 stratum ${language}/${route} has ${count} rows; requires ${required}`)
  }
}

const selected = []
for (const language of languages) {
  for (const route of routes) {
    const bucket = resolved
      .filter(row => row.candidate.language === language && row.derived.route === route)
      .sort((left, right) => {
        const byHash = compareAscii(selectionKey(left.candidate, route), selectionKey(right.candidate, route))
        return byHash || compareAscii(left.candidate.id, right.candidate.id)
      })
    selected.push(...bucket.slice(0, targetPerLanguage[route]))
  }
}
selected.sort((left, right) => compareAscii(left.candidate.id, right.candidate.id))

const actualCounts = {
  total: selected.length,
  english: selected.filter(row => row.candidate.language === 'en').length,
  chinese: selected.filter(row => row.candidate.language === 'zh').length,
  ...Object.fromEntries(routes.map(route => [route, selected.filter(row => row.derived.route === route).length])),
}
for (const [name, count] of Object.entries(expectedCounts)) {
  if (actualCounts[name] !== count) throw new Error(`V6 balance mismatch for ${name}: ${actualCounts[name]} != ${count}`)
}

const promptText = lines(selected.map(({ candidate }) => ({ ...candidate, split: 'blind' })))
const labelText = lines(selected.map(({ candidate, annotation, decision, derived }) => ({
  id: candidate.id,
  expected: derived.route,
  outcomeCritical: derived.outcomeCritical,
  selectedAnnotation: decision.selectedAnnotation,
  adjudicationRationale: decision.rationale,
  annotation,
})))
const sourceText = lines(selected.map(({ source }) => source))
const manifest = {
  schemaVersion: 1,
  protocol: 'authoritative-mutation-basis-v6',
  selection: {
    seed: selectionSeed,
    order: selectionOrder,
    strata: 'language x derived route',
  },
  codeFreezeCommit: runtime.exactCommit,
  runtimeDigest: runtime.runtimeDigest,
  counts: {
    ...actualCounts,
    eligibleBeforeSelection: resolved.length,
    ineligibleBeforeSelection: candidates.rows.length - resolved.length,
    available,
  },
  expectedCounts,
  labelDomain: routes,
  predictionDomain: routes,
  gates: releaseGates,
  annotationGates,
  sourceIsolation: candidateManifest.sourceIsolation,
  decisionFormat: expectedDecisionFormat,
  digests: {
    candidateManifest: packetInputDigests.candidateManifest,
    candidates: packetInputDigests.candidates,
    candidateSources: packetInputDigests.sources,
    annotationsA: packetInputDigests.annotationsA,
    annotationsB: packetInputDigests.annotationsB,
    annotationsC: packetInputDigests.annotationsC,
    sourceConfig: packetInputDigests.sourceConfig,
    annotationRubric: packetInputDigests.annotationRubric,
    annotationSchema: packetInputDigests.annotationSchema,
    deriveLabel: packetInputDigests.deriveLabel,
    protocol: packetInputDigests.protocol,
    sourceIsolation: packetInputDigests.sourceIsolation,
    collector: packetInputDigests.collector,
    agreement: packetInputDigests.agreement,
    agreementReport: packetInputDigests.agreementReport,
    buildAdjudication: packetInputDigests.buildAdjudication,
    adjudicationPacket: packetInputDigests.adjudicationPacket,
    packetManifest: sha256(packetManifestText),
    adjudicationDecisions: sha256(decisions.text),
    freezeBlind: sha256(freezeScriptText),
    prompts: sha256(promptText),
    labels: sha256(labelText),
    sources: sha256(sourceText),
  },
}

await Promise.all([
  writeExclusive(outputPaths.prompts, promptText),
  writeExclusive(outputPaths.labels, labelText),
  writeExclusive(outputPaths.sources, sourceText),
  writeExclusive(outputPaths.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
])
console.log(JSON.stringify({ counts: actualCounts, selectionSeed }, null, 2))
