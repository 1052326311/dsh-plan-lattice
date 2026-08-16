#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAgreementReport } from './agreement.mjs'
import { validateAnnotationSet } from './annotation-schema.mjs'
import { assertArtifactsAbsent, here, lines, parseJsonLines, sha256, writeExclusive } from './protocol.mjs'

const names = ['a', 'b', 'c']
const outputs = {
  packet: join(here, 'adjudication-packet.jsonl'),
  manifest: join(here, 'adjudication-packet.manifest.json'),
}
await assertArtifactsAbsent(Object.values(outputs), 'V7 adjudication packet')

async function load(name) {
  const text = await readFile(join(here, name), 'utf8')
  return { text, rows: parseJsonLines(text, name) }
}

function withoutDerived(annotation) {
  const { derived: _derived, ...whole } = annotation
  return whole
}

const [candidates, sources, ...annotations] = await Promise.all([
  load('candidates.jsonl'),
  load('sources.jsonl'),
  ...names.map(name => load(`annotations-${name}.jsonl`)),
])
const reportText = await readFile(join(here, 'agreement-report.json'), 'utf8')
const report = JSON.parse(reportText)
const sets = annotations.map((annotation, index) => validateAnnotationSet(
  candidates.rows,
  annotation.rows,
  `annotations ${names[index]}`,
))
const bindings = {
  candidates: sha256(candidates.text),
  annotations: annotations.map((annotation, index) => ({ annotator: index + 1, sha256: sha256(annotation.text) })),
}
const recomputed = buildAgreementReport(candidates.rows, sets, bindings)
if (JSON.stringify(report) !== JSON.stringify(recomputed)) throw new Error('V7 agreement report does not match the frozen inputs')
if (report.gates?.allPassed !== true) throw new Error('V7 reliability gates failed; adjudication remains forbidden')
if (sources.rows.length !== candidates.rows.length) throw new Error('V7 candidate/source count mismatch')

const sourceById = new Map(sources.rows.map(source => [source.id, source]))
const packet = []
for (const candidate of candidates.rows) {
  const rows = sets.map(set => set.get(candidate.id))
  const factBodies = rows.map(row => JSON.stringify(row.facts))
  if (new Set(factBodies).size === 1) continue
  packet.push({
    id: candidate.id,
    language: candidate.language,
    text: candidate.text,
    source: sourceById.get(candidate.id),
    annotations: Object.fromEntries(names.map((name, index) => [name, withoutDerived(rows[index])])),
  })
}
const packetText = lines(packet)
const manifest = {
  schemaVersion: 1,
  protocol: 'observable-authorization-v7',
  counts: { candidates: candidates.rows.length, disagreements: packet.length, annotators: 3 },
  decisionFormat: {
    exactKeys: ['id', 'selectedAnnotation', 'rationale'],
    selectedAnnotation: names,
    minimumRationaleCharacters: 40,
    fieldWiseSynthesisAllowed: false,
    decisionsRequiredOnlyForDisagreements: true,
  },
  digests: {
    candidates: sha256(candidates.text),
    sources: sha256(sources.text),
    annotations: annotations.map(annotation => sha256(annotation.text)),
    agreementReport: sha256(reportText),
    adjudicationPacket: sha256(packetText),
  },
}
await Promise.all([
  writeExclusive(outputs.packet, packetText),
  writeExclusive(outputs.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
])
console.log(JSON.stringify({ counts: manifest.counts, packetDigest: manifest.digests.adjudicationPacket }, null, 2))
