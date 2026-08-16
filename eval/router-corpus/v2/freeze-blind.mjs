#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const selectionSeed = 'plan-lattice-router-v2-final-2026-08-16'
const routeNames = ['bypass', 'contract', 'lattice']
// Maximal common bilingual strata available after independent annotation and
// adjudication, fixed before any router output was evaluated.
const targetPerLanguage = { bypass: 29, contract: 22, lattice: 9 }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function textAndRows(name, allowEmpty = false) {
  const text = await readFile(join(here, name), 'utf8')
  if (text.trim() === '') {
    if (allowEmpty) return { text, rows: [] }
    throw new Error(`${name} is empty`)
  }
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line)) }
}

function byId(rows, name) {
  const map = new Map()
  for (const row of rows) {
    if (map.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    map.set(row.id, row)
  }
  return map
}

const candidates = await textAndRows('candidates.jsonl')
const sources = await textAndRows('sources.jsonl')
const annotationsA = await textAndRows('annotations-a.jsonl')
const annotationsB = await textAndRows('annotations-b.jsonl')
const adjudication = await textAndRows('annotations-c.jsonl', true)
const candidateManifestText = await readFile(join(here, 'candidate-manifest.json'), 'utf8')
const candidateManifest = JSON.parse(candidateManifestText)
const sourceById = byId(sources.rows, 'sources.jsonl')
const leftById = byId(annotationsA.rows, 'annotations-a.jsonl')
const rightById = byId(annotationsB.rows, 'annotations-b.jsonl')
const adjudicationById = byId(adjudication.rows, 'annotations-c.jsonl')

const resolved = []
for (const candidate of candidates.rows) {
  const left = leftById.get(candidate.id)
  const right = rightById.get(candidate.id)
  if (left === undefined || right === undefined) throw new Error(`missing primary annotation for ${candidate.id}`)
  let label
  if (left.route === right.route && left.outcomeCritical === right.outcomeCritical) {
    label = left
  } else {
    const third = adjudicationById.get(candidate.id)
    if (third === undefined) throw new Error(`missing adjudication for ${candidate.id}`)
    const leftPair = `${left.route}:${left.outcomeCritical}`
    const rightPair = `${right.route}:${right.outcomeCritical}`
    const thirdPair = `${third.route}:${third.outcomeCritical}`
    label = thirdPair === leftPair ? left : thirdPair === rightPair ? right : third
  }
  if (label.route === 'exclude') continue
  if (!routeNames.includes(label.route)) throw new Error(`invalid resolved route for ${candidate.id}`)
  resolved.push({ candidate, label, source: sourceById.get(candidate.id) })
}

const selected = []
for (const language of ['en', 'zh']) {
  for (const route of routeNames) {
    const bucket = resolved
      .filter(row => row.candidate.language === language && row.label.route === route)
      .sort((left, right) => sha256(`${selectionSeed}:${left.candidate.id}`).localeCompare(
        sha256(`${selectionSeed}:${right.candidate.id}`),
      ))
    const target = targetPerLanguage[route]
    if (bucket.length < target) throw new Error(`${language}/${route} has ${bucket.length} resolved rows; expected at least ${target}`)
    selected.push(...bucket.slice(0, target))
  }
}
selected.sort((left, right) => left.candidate.id.localeCompare(right.candidate.id))

const prompts = selected.map(({ candidate }) => ({
  id: candidate.id,
  split: 'blind',
  language: candidate.language,
  text: candidate.text,
}))
const labels = selected.map(({ candidate, label }) => ({
  id: candidate.id,
  expected: label.route,
  outcomeCritical: label.outcomeCritical,
  confidence: label.confidence,
  rationale: label.rationale,
}))
const selectedSources = selected.map(({ source }) => source)
const lines = rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
const promptText = lines(prompts)
const labelText = lines(labels)
const sourceText = lines(selectedSources)
const manifest = {
  schemaVersion: 2,
  selectionSeed,
  frozenAt: new Date().toISOString(),
  routerSourceDigest: candidateManifest.routerSourceDigest,
  counts: { total: 120, english: 60, chinese: 60, bypass: 58, contract: 44, lattice: 18 },
  gates: {
    simpleFalseActivationRateMax: 0.05,
    complexCriticalRecallMin: 0.9,
    outcomeCriticalBypassMax: 0,
    exactAccuracyMin: 0.8,
    macroF1Min: 0.8,
    latticeRecallMin: 0.75,
    probeRateMax: 0.1,
  },
  digests: {
    candidateManifest: sha256(candidateManifestText),
    prompts: sha256(promptText),
    labels: sha256(labelText),
    sources: sha256(sourceText),
    annotationsA: sha256(annotationsA.text),
    annotationsB: sha256(annotationsB.text),
    annotationsC: sha256(adjudication.text),
  },
}

await Promise.all([
  writeFile(join(here, 'blind-v2.prompts.jsonl'), promptText, 'utf8'),
  writeFile(join(here, 'blind-v2.labels.jsonl'), labelText, 'utf8'),
  writeFile(join(here, 'blind-v2.sources.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'blind-v2.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])
console.log('froze 120-row router v2 blind set (29 bypass, 22 contract, 9 lattice per language)')
