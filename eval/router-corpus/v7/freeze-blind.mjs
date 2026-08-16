#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAgreementReport } from './agreement.mjs'
import { validateAnnotationSet } from './annotation-schema.mjs'
import { deriveLabel } from './derive-label.mjs'
import {
  expectedCounts,
  languages,
  maximumPerRepository,
  maximumPerRoutePerRepository,
  routes,
  selectionSeed,
  targetPerLanguage,
} from './blind-protocol.mjs'
import { assertArtifactsAbsent, assertFrozenRuntime, here, lines, parseJsonLines, sha256, writeExclusive } from './protocol.mjs'

const names = ['a', 'b', 'c']
const outputs = {
  prompts: join(here, 'blind-v7.prompts.jsonl'),
  labels: join(here, 'blind-v7.labels.jsonl'),
  sources: join(here, 'blind-v7.sources.jsonl'),
  manifest: join(here, 'blind-v7.manifest.json'),
}
await assertArtifactsAbsent(Object.values(outputs), 'V7 blind freeze')

async function load(name, allowEmpty = false) {
  const text = await readFile(join(here, name), 'utf8')
  const rows = parseJsonLines(text, name)
  if (!allowEmpty && rows.length === 0) throw new Error(`${name} is empty`)
  return { text, rows }
}

function withoutDerived(annotation) {
  const { derived: _derived, ...whole } = annotation
  return whole
}

function normalizedRationale(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function key(row, route) {
  return sha256(`${selectionSeed}\n${row.candidate.language}\n${route}\n${row.candidate.id}`)
}

const [candidates, sources, ...annotationFiles] = await Promise.all([
  load('candidates.jsonl'),
  load('sources.jsonl'),
  ...names.map(name => load(`annotations-${name}.jsonl`)),
])
const [reportText, packetText, packetManifestText, decisions, blindProtocolText] = await Promise.all([
  readFile(join(here, 'agreement-report.json'), 'utf8'),
  readFile(join(here, 'adjudication-packet.jsonl'), 'utf8'),
  readFile(join(here, 'adjudication-packet.manifest.json'), 'utf8'),
  load('adjudication-decisions.jsonl', true),
  readFile(join(here, 'blind-protocol.mjs'), 'utf8'),
])
const report = JSON.parse(reportText)
const packet = parseJsonLines(packetText, 'adjudication-packet.jsonl')
const packetManifest = JSON.parse(packetManifestText)
const sets = annotationFiles.map((annotation, index) => validateAnnotationSet(
  candidates.rows,
  annotation.rows,
  `annotations ${names[index]}`,
))
const bindings = {
  candidates: sha256(candidates.text),
  annotations: annotationFiles.map((annotation, index) => ({ annotator: index + 1, sha256: sha256(annotation.text) })),
}
if (JSON.stringify(report) !== JSON.stringify(buildAgreementReport(candidates.rows, sets, bindings))) {
  throw new Error('V7 agreement report does not match the frozen inputs')
}
if (report.gates?.allPassed !== true) throw new Error('V7 reliability gates failed; blind freeze remains forbidden')
if (sources.rows.length !== candidates.rows.length) throw new Error('V7 candidate/source count mismatch')
if (packetManifest.digests?.adjudicationPacket !== sha256(packetText)
  || packetManifest.counts?.disagreements !== packet.length) {
  throw new Error('V7 adjudication packet manifest mismatch')
}

const packetIds = new Set(packet.map(row => row.id))
const decisionsById = new Map()
const rationales = new Set()
for (const decision of decisions.rows) {
  if (JSON.stringify(Object.keys(decision).sort()) !== JSON.stringify(['id', 'rationale', 'selectedAnnotation'])) {
    throw new Error(`V7 decision ${decision.id ?? '<unknown>'} has invalid keys`)
  }
  if (!packetIds.has(decision.id) || !names.includes(decision.selectedAnnotation)) {
    throw new Error(`V7 decision ${decision.id} is not a valid whole-record selection`)
  }
  if (typeof decision.rationale !== 'string' || decision.rationale.trim().length < 40) {
    throw new Error(`V7 decision ${decision.id} needs a row-specific rationale`)
  }
  const normalized = normalizedRationale(decision.rationale)
  if (rationales.has(normalized)) throw new Error(`V7 decision ${decision.id} repeats another rationale`)
  rationales.add(normalized)
  if (decisionsById.has(decision.id)) throw new Error(`V7 decisions duplicate ${decision.id}`)
  decisionsById.set(decision.id, decision)
}
if (decisionsById.size !== packet.length) throw new Error('V7 decisions must cover every and only disagreement row')

const sourceById = new Map(sources.rows.map(source => [source.id, source]))
const resolved = []
for (const candidate of candidates.rows) {
  const rows = sets.map(set => set.get(candidate.id))
  const disagreement = new Set(rows.map(row => JSON.stringify(row.facts))).size > 1
  const selectedName = disagreement ? decisionsById.get(candidate.id)?.selectedAnnotation : 'a'
  if (selectedName === undefined) throw new Error(`V7 disagreement ${candidate.id} has no decision`)
  const annotation = withoutDerived(rows[names.indexOf(selectedName)])
  const derived = deriveLabel(annotation.facts)
  if (!derived.eligible) continue
  resolved.push({ candidate, source: sourceById.get(candidate.id), annotation, derived, selectedName })
}

const available = Object.fromEntries(languages.flatMap(language => routes.map(route => [
  `${language}/${route}`,
  resolved.filter(row => row.candidate.language === language && row.derived.route === route).length,
])))
for (const language of languages) {
  for (const route of routes) {
    if (available[`${language}/${route}`] < targetPerLanguage[route]) {
      throw new Error(`V7 stratum ${language}/${route} has ${available[`${language}/${route}`]} rows; requires ${targetPerLanguage[route]}`)
    }
  }
}

const selected = []
const repositoryCounts = new Map()
const routeRepositoryCounts = new Map()
for (const language of languages) {
  for (const route of routes) {
    const bucket = resolved
      .filter(row => row.candidate.language === language && row.derived.route === route)
      .sort((left, right) => key(left, route).localeCompare(key(right, route)))
    let added = 0
    for (const row of bucket) {
      const repository = String(row.source.repository).toLowerCase()
      const routeRepository = `${route}/${repository}`
      if ((repositoryCounts.get(repository) ?? 0) >= maximumPerRepository) continue
      if ((routeRepositoryCounts.get(routeRepository) ?? 0) >= maximumPerRoutePerRepository) continue
      selected.push(row)
      repositoryCounts.set(repository, (repositoryCounts.get(repository) ?? 0) + 1)
      routeRepositoryCounts.set(routeRepository, (routeRepositoryCounts.get(routeRepository) ?? 0) + 1)
      added += 1
      if (added === targetPerLanguage[route]) break
    }
    if (added !== targetPerLanguage[route]) {
      throw new Error(`V7 diversity caps leave ${language}/${route} at ${added}; requires ${targetPerLanguage[route]}`)
    }
  }
}
selected.sort((left, right) => left.candidate.id.localeCompare(right.candidate.id))
if (selected.length !== expectedCounts.total) throw new Error(`V7 selected ${selected.length}; expected ${expectedCounts.total}`)

const prompts = selected.map(row => ({ id: row.candidate.id, language: row.candidate.language, text: row.candidate.text }))
const labels = selected.map(row => ({ id: row.candidate.id, expected: row.derived.route, outcomeCritical: row.derived.outcomeCritical }))
const selectedSources = selected.map(row => row.source)
const promptText = lines(prompts)
const labelText = lines(labels)
const sourceText = lines(selectedSources)
const frozen = await assertFrozenRuntime()
const counts = {
  total: selected.length,
  english: prompts.filter(row => row.language === 'en').length,
  chinese: prompts.filter(row => row.language === 'zh').length,
  ...Object.fromEntries(routes.map(route => [route, labels.filter(row => row.expected === route).length])),
}
if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) throw new Error('V7 selected counts differ from preregistration')
const manifest = {
  schemaVersion: 1,
  protocol: 'observable-authorization-v7',
  evidenceStatus: 'frozen-before-router-reveal',
  runtimeFreezeCommit: frozen.exactCommit,
  runtimeDigest: frozen.runtimeDigest,
  selectionSeed,
  targetPerLanguage,
  maximumPerRepository,
  maximumPerRoutePerRepository,
  available,
  counts,
  repositories: repositoryCounts.size,
  expectedCounts,
  labelDomain: routes,
  digests: {
    prompts: sha256(promptText),
    labels: sha256(labelText),
    sources: sha256(sourceText),
    candidatePool: sha256(candidates.text),
    agreementReport: sha256(reportText),
    adjudicationPacket: sha256(packetText),
    adjudicationDecisions: sha256(decisions.text),
    blindProtocol: sha256(blindProtocolText),
  },
}
await Promise.all([
  writeExclusive(outputs.prompts, promptText),
  writeExclusive(outputs.labels, labelText),
  writeExclusive(outputs.sources, sourceText),
  writeExclusive(outputs.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
])
console.log(JSON.stringify({ counts, repositories: manifest.repositories, available }, null, 2))
