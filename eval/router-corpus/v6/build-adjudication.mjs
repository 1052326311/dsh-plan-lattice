#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAgreementReport } from './agreement.mjs'
import { validateAnnotationSet } from './annotation-schema.mjs'
import {
  annotationGates,
  assertArtifactsAbsent,
  assertFrozenRuntime,
  here,
  lines,
  loadJsonLines,
  sha256,
  writeExclusive,
} from './protocol.mjs'

const annotationNames = ['a', 'b', 'c']
const ordinalFields = ['authorizationEpochs', 'verificationHorizon', 'staleActionLoss', 'recovery']
const outputPaths = {
  packet: join(here, 'adjudication-packet.jsonl'),
  manifest: join(here, 'adjudication-packet.manifest.json'),
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertDigest(actual, expected, context) {
  if (actual !== expected) throw new Error(`${context} digest mismatch`)
}

function assertGate(actual, expected, context) {
  if (!Number.isFinite(actual) || actual < expected) {
    throw new Error(`${context} ${String(actual)} does not meet the frozen gate ${expected}`)
  }
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

await assertArtifactsAbsent(Object.values(outputPaths), 'V6 adjudication')

const runtime = await assertFrozenRuntime()
const [candidates, sources, annotationsA, annotationsB, annotationsC] = await Promise.all([
  loadJsonLines('candidates.jsonl'),
  loadJsonLines('sources.jsonl'),
  loadJsonLines('annotations-a.jsonl'),
  loadJsonLines('annotations-b.jsonl'),
  loadJsonLines('annotations-c.jsonl'),
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
  agreementScriptText,
  buildScriptText,
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
  readFile(join(here, 'agreement.mjs'), 'utf8'),
  readFile(join(here, 'build-adjudication.mjs'), 'utf8'),
])
const candidateManifest = JSON.parse(candidateManifestText)
const agreementReport = JSON.parse(agreementReportText)

assertCandidateManifest(candidateManifest, runtime, {
  candidates: candidates.text,
  sources: sources.text,
  sourceConfig: sourceConfigText,
  'ANNOTATION_RUBRIC.md': rubricText,
  'annotation-schema.mjs': annotationSchemaText,
  'derive-label.mjs': deriveLabelText,
  'protocol.mjs': protocolText,
  'collect-candidates.mjs': collectorText,
  'source-isolation.mjs': sourceIsolationText,
})
if (candidateManifest.counts?.total !== candidates.rows.length || sources.rows.length !== candidates.rows.length) {
  throw new Error('candidate, source, and manifest counts do not match')
}

const sourceById = new Map()
for (const [index, candidate] of candidates.rows.entries()) {
  if (!isObject(candidate)
    || typeof candidate.id !== 'string'
    || !['en', 'zh'].includes(candidate.language)
    || typeof candidate.text !== 'string'
    || candidate.text.trim() === '') {
    throw new Error(`candidates.jsonl:${index + 1} is invalid`)
  }
  const source = sources.rows[index]
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
  sources: sha256(sources.text),
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

const packet = candidates.rows.map(candidate => ({
  id: candidate.id,
  language: candidate.language,
  text: candidate.text,
  source: sourceById.get(candidate.id),
  annotations: Object.fromEntries(annotationNames.map(name => [
    name,
    withoutDerived(annotationSets[name].get(candidate.id)),
  ])),
}))
const packetText = lines(packet)
const manifest = {
  schemaVersion: 1,
  protocol: 'authoritative-mutation-basis-v6',
  codeFreezeCommit: runtime.exactCommit,
  runtimeDigest: runtime.runtimeDigest,
  counts: {
    candidates: candidates.rows.length,
    annotators: annotationNames.length,
  },
  decisionFormat: {
    exactKeys: ['id', 'selectedAnnotation', 'rationale'],
    selectedAnnotation: annotationNames,
    minimumRationaleCharacters: 40,
    repeatedRationalesAllowed: false,
    fieldWiseSynthesisAllowed: false,
  },
  digests: {
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
    adjudicationPacket: sha256(packetText),
  },
}

await Promise.all([
  writeExclusive(outputPaths.packet, packetText),
  writeExclusive(outputPaths.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
])
console.log(JSON.stringify({ counts: manifest.counts, packetDigest: manifest.digests.adjudicationPacket }, null, 2))
