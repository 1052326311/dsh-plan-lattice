#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const selectionSeed = 'plan-lattice-router-v3-final-2026-08-16'
const routeNames = ['bypass', 'contract', 'lattice']

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
const supplementCandidates = await textAndRows('supplement-candidates.jsonl')
const supplementSources = await textAndRows('supplement-source-records.jsonl')
const supplementAnnotationsA = await textAndRows('supplement-annotations-a.jsonl')
const supplementAnnotationsB = await textAndRows('supplement-annotations-b.jsonl')
const supplementAdjudication = await textAndRows('supplement-annotations-c.jsonl', true)
const candidateManifestText = await readFile(join(here, 'candidate-manifest.json'), 'utf8')
const candidateManifest = JSON.parse(candidateManifestText)
const supplementManifestText = await readFile(join(here, 'supplement-manifest.json'), 'utf8')
const supplementManifest = JSON.parse(supplementManifestText)
if (candidateManifest.routerSourceDigest !== supplementManifest.routerSourceDigest) {
  throw new Error('base and supplement were not frozen against the same router')
}

function resolvePool(candidateRows, sourceRows, leftRows, rightRows, thirdRows, prefix) {
  const sourceById = byId(sourceRows, `${prefix} sources`)
  const leftById = byId(leftRows, `${prefix} annotations A`)
  const rightById = byId(rightRows, `${prefix} annotations B`)
  const adjudicationById = byId(thirdRows, `${prefix} annotations C`)
  const resolved = []
  for (const candidate of candidateRows) {
  const left = leftById.get(candidate.id)
  const right = rightById.get(candidate.id)
  if (left === undefined || right === undefined) throw new Error(`missing primary annotation for ${candidate.id}`)
  const needsAdjudication = left.route !== right.route
    || left.outcomeCritical !== right.outcomeCritical
  const third = needsAdjudication ? adjudicationById.get(candidate.id) : undefined
  if (needsAdjudication && third === undefined) throw new Error(`missing adjudication for ${candidate.id}`)

  let route
  if (left.route === right.route) route = left.route
  else if (third?.route === left.route || third?.route === right.route) route = third.route
  else continue
  if (!routeNames.includes(route)) continue

  const annotations = third === undefined ? [left, right] : [left, right, third]
  const routeSupport = annotations.filter(row => row.route === route && row.confidence !== 'low')
  if (routeSupport.length < 2) continue
  const criticalVotes = annotations.filter(row => row.outcomeCritical).length
  const outcomeCritical = criticalVotes > annotations.length / 2
  if (route === 'bypass' && outcomeCritical) continue
  const confidence = routeSupport.every(row => row.confidence === 'high') ? 'high' : 'medium'
  const rationale = routeSupport.map(row => row.rationale).join(' | ')
  resolved.push({
    candidate,
    label: { route, outcomeCritical, confidence, rationale },
    source: sourceById.get(candidate.id),
  })
  }
  return resolved
}

const resolved = [
  ...resolvePool(candidates.rows, sources.rows, annotationsA.rows, annotationsB.rows,
    adjudication.rows, 'base'),
  ...resolvePool(supplementCandidates.rows, supplementSources.rows,
    supplementAnnotationsA.rows, supplementAnnotationsB.rows,
    supplementAdjudication.rows, 'supplement'),
]

const available = Object.fromEntries(['en', 'zh'].flatMap(language => routeNames.map(route => [
  `${language}/${route}`,
  resolved.filter(row => row.candidate.language === language && row.label.route === route).length,
])))
const latticeTarget = Math.min(12, available['en/lattice'], available['zh/lattice'])
const contractTarget = Math.min(24, available['en/contract'], available['zh/contract'])
if (latticeTarget < 8) throw new Error(`high-confidence lattice stratum is too small: ${latticeTarget} per language`)
if (contractTarget < 18) throw new Error(`high-confidence contract stratum is too small: ${contractTarget} per language`)
const targetPerLanguage = {
  lattice: latticeTarget,
  contract: contractTarget,
  bypass: 60 - latticeTarget - contractTarget,
}
if (targetPerLanguage.bypass > available['en/bypass'] || targetPerLanguage.bypass > available['zh/bypass']) {
  throw new Error(`high-confidence bypass stratum is too small: ${JSON.stringify(available)}`)
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
  counts: {
    total: 120,
    english: 60,
    chinese: 60,
    bypass: targetPerLanguage.bypass * 2,
    contract: targetPerLanguage.contract * 2,
    lattice: targetPerLanguage.lattice * 2,
    eligibleBeforeSelection: resolved.length,
  },
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
    supplementManifest: sha256(supplementManifestText),
    prompts: sha256(promptText),
    labels: sha256(labelText),
    sources: sha256(sourceText),
    annotationsA: sha256(annotationsA.text),
    annotationsB: sha256(annotationsB.text),
    annotationsC: sha256(adjudication.text),
    supplementAnnotationsA: sha256(supplementAnnotationsA.text),
    supplementAnnotationsB: sha256(supplementAnnotationsB.text),
    supplementAnnotationsC: sha256(supplementAdjudication.text),
  },
}

await Promise.all([
  writeFile(join(here, 'blind-v3.prompts.jsonl'), promptText, 'utf8'),
  writeFile(join(here, 'blind-v3.labels.jsonl'), labelText, 'utf8'),
  writeFile(join(here, 'blind-v3.sources.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'blind-v3.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])
console.log(`froze router v3 blind set: ${JSON.stringify(targetPerLanguage)} per language`)
