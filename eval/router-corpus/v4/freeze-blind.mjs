#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..', '..')
const selectionSeed = 'plan-lattice-router-v4-final-2026-08-16'
const targetPerLanguage = { bypass: 30, contract: 18, lattice: 12 }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function load(name, allowEmpty = false) {
  const text = await readFile(join(here, name), 'utf8')
  const rows = text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line))
  if (!allowEmpty && rows.length === 0) throw new Error(`${name} is empty`)
  return { text, rows }
}

function indexed(rows, name) {
  const result = new Map()
  for (const row of rows) {
    if (result.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    result.set(row.id, row)
  }
  return result
}

const candidates = await load('candidates.jsonl')
const sources = await load('sources.jsonl')
const annotationsA = await load('annotations-a.jsonl')
const annotationsB = await load('annotations-b.jsonl')
const annotationsC = await load('annotations-c.jsonl', true)
const supplementCandidates = await load('supplement-candidates.jsonl')
const supplementSources = await load('supplement-source-records.jsonl')
const supplementAnnotationsA = await load('supplement-annotations-a.jsonl')
const supplementAnnotationsB = await load('supplement-annotations-b.jsonl')
const supplementAnnotationsC = await load('supplement-annotations-c.jsonl', true)
const candidateManifestText = await readFile(join(here, 'candidate-manifest.json'), 'utf8')
const candidateManifest = JSON.parse(candidateManifestText)
const supplementManifestText = await readFile(join(here, 'supplement-manifest.json'), 'utf8')
const supplementManifest = JSON.parse(supplementManifestText)
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
if (currentCommit !== candidateManifest.codeFreezeCommit) {
  throw new Error(`code freeze moved from ${candidateManifest.codeFreezeCommit} to ${currentCommit}`)
}
if (supplementManifest.codeFreezeCommit !== candidateManifest.codeFreezeCommit
  || supplementManifest.runtimeDigest !== candidateManifest.runtimeDigest) {
  throw new Error('base and supplement were not frozen against the same router runtime')
}

function resolvePool(candidateRows, sourceRows, leftRows, rightRows, thirdRows, name) {
  const sourceById = indexed(sourceRows, `${name} sources`)
  const a = indexed(leftRows, `${name} annotations A`)
  const b = indexed(rightRows, `${name} annotations B`)
  const c = indexed(thirdRows, `${name} annotations C`)
  const resolvedRows = []
  let excludedNoMajority = 0
  for (const candidate of candidateRows) {
    const left = a.get(candidate.id)
    const right = b.get(candidate.id)
    if (left === undefined || right === undefined) throw new Error(`missing ${name} primary annotation for ${candidate.id}`)
    const disagrees = left.route !== right.route || left.outcomeCritical !== right.outcomeCritical
    const third = disagrees ? c.get(candidate.id) : undefined
    if (disagrees && third === undefined) throw new Error(`missing ${name} independent adjudication for ${candidate.id}`)
    if (!disagrees && c.has(candidate.id)) throw new Error(`${name} annotations C includes agreed row ${candidate.id}`)
    const annotations = third === undefined ? [left, right] : [left, right, third]
    const routeVotes = new Map(['bypass', 'contract', 'lattice'].map(route => [route, annotations.filter(row => row.route === route).length]))
    const route = [...routeVotes].sort((x, y) => y[1] - x[1])[0][0]
    if (routeVotes.get(route) < 2) {
      excludedNoMajority += 1
      continue
    }
    const outcomeCritical = annotations.filter(row => row.outcomeCritical).length >= 2
    if (route === 'bypass' && outcomeCritical) throw new Error(`resolved outcome-critical ${candidate.id} as bypass`)
    const supporters = annotations.filter(row => row.route === route)
    if (supporters.filter(row => row.confidence !== 'low').length < 2) continue
    const source = sourceById.get(candidate.id)
    if (source === undefined) throw new Error(`missing ${name} source for ${candidate.id}`)
    resolvedRows.push({
      candidate,
      source,
      label: {
        route,
        outcomeCritical,
        confidence: supporters.every(row => row.confidence === 'high') ? 'high' : 'medium',
        rationale: supporters.map(row => row.rationale).join(' | '),
      },
    })
  }
  return { rows: resolvedRows, excludedNoMajority }
}
const baseResolved = resolvePool(candidates.rows, sources.rows, annotationsA.rows, annotationsB.rows, annotationsC.rows, 'base')
const supplementResolved = resolvePool(supplementCandidates.rows, supplementSources.rows, supplementAnnotationsA.rows, supplementAnnotationsB.rows, supplementAnnotationsC.rows, 'supplement')
const resolved = [...baseResolved.rows, ...supplementResolved.rows]

const available = Object.fromEntries(['en', 'zh'].flatMap(language => Object.keys(targetPerLanguage).map(route => [
  `${language}/${route}`,
  resolved.filter(row => row.candidate.language === language && row.label.route === route).length,
])))
for (const language of ['en', 'zh']) {
  for (const [route, count] of Object.entries(targetPerLanguage)) {
    if (available[`${language}/${route}`] < count) {
      throw new Error(`V4 stratum ${language}/${route} has ${available[`${language}/${route}`]} eligible rows; requires ${count}. Collect the preregistered source-disjoint coverage supplement without changing router code.`)
    }
  }
}
const selected = []
for (const language of ['en', 'zh']) {
  for (const [route, count] of Object.entries(targetPerLanguage)) {
    const bucket = resolved
      .filter(row => row.candidate.language === language && row.label.route === route)
      .sort((left, right) => sha256(`${selectionSeed}:${left.candidate.id}`).localeCompare(sha256(`${selectionSeed}:${right.candidate.id}`)))
    selected.push(...bucket.slice(0, count))
  }
}
selected.sort((left, right) => left.candidate.id.localeCompare(right.candidate.id))
const lines = rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
const promptText = lines(selected.map(({ candidate }) => ({ ...candidate, split: 'blind' })))
const labelText = lines(selected.map(({ candidate, label }) => ({ id: candidate.id, expected: label.route, outcomeCritical: label.outcomeCritical, confidence: label.confidence, rationale: label.rationale })))
const sourceText = lines(selected.map(({ source }) => source))
const manifest = {
  schemaVersion: 1,
  selectionSeed,
  frozenAt: new Date().toISOString(),
  codeFreezeCommit: candidateManifest.codeFreezeCommit,
  runtimeDigest: candidateManifest.runtimeDigest,
  counts: {
    total: selected.length,
    english: selected.filter(row => row.candidate.language === 'en').length,
    chinese: selected.filter(row => row.candidate.language === 'zh').length,
    bypass: selected.filter(row => row.label.route === 'bypass').length,
    contract: selected.filter(row => row.label.route === 'contract').length,
    lattice: selected.filter(row => row.label.route === 'lattice').length,
    eligibleBeforeSelection: resolved.length,
    excludedNoMajority: baseResolved.excludedNoMajority + supplementResolved.excludedNoMajority,
    available,
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
  sourceIsolation: {
    base: candidateManifest.sourceIsolation,
    supplement: supplementManifest.sourceIsolation,
  },
  digests: {
    candidateManifest: sha256(candidateManifestText),
    supplementManifest: sha256(supplementManifestText),
    prompts: sha256(promptText),
    labels: sha256(labelText),
    sources: sha256(sourceText),
    annotationsA: sha256(annotationsA.text),
    annotationsB: sha256(annotationsB.text),
    annotationsC: sha256(annotationsC.text),
    supplementAnnotationsA: sha256(supplementAnnotationsA.text),
    supplementAnnotationsB: sha256(supplementAnnotationsB.text),
    supplementAnnotationsC: sha256(supplementAnnotationsC.text),
  },
}
await Promise.all([
  writeFile(join(here, 'blind-v4.prompts.jsonl'), promptText, 'utf8'),
  writeFile(join(here, 'blind-v4.labels.jsonl'), labelText, 'utf8'),
  writeFile(join(here, 'blind-v4.sources.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'blind-v4.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])
console.log(JSON.stringify(manifest.counts, null, 2))
