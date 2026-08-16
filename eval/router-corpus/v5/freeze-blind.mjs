#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertFrozenRuntime,
  codeFreezeCommit,
  expectedCounts,
  here,
  languages,
  lines,
  releaseGates,
  routes,
  sha256,
  targetPerLanguage,
} from './protocol.mjs'
import { assertSourceDisjoint, priorSourceInventory } from './source-isolation.mjs'

const selectionSeed = 'plan-lattice-router-v5-first-reveal-2026-08-16'

function indexed(rows, name) {
  const result = new Map()
  for (const row of rows) {
    if (result.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    result.set(row.id, row)
  }
  return result
}

async function load(name, allowEmpty = false) {
  const text = await readFile(join(here, name), 'utf8')
  const rows = text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line))
  if (!allowEmpty && rows.length === 0) throw new Error(`${name} is empty`)
  return { text, rows }
}

const runtimeDigest = await assertFrozenRuntime()
const [candidates, sources, annotationsA, annotationsB, annotationsC] = await Promise.all([
  load('candidates.jsonl'),
  load('sources.jsonl'),
  load('annotations-a.jsonl'),
  load('annotations-b.jsonl'),
  load('annotations-c.jsonl', true),
])
const candidateManifestText = await readFile(join(here, 'candidate-manifest.json'), 'utf8')
const candidateManifest = JSON.parse(candidateManifestText)
if (candidateManifest.codeFreezeCommit !== codeFreezeCommit) throw new Error('candidate manifest is not bound to the V5 code freeze')
if (candidateManifest.runtimeDigest !== runtimeDigest) throw new Error('candidate manifest router runtime does not match the V5 code freeze')
if (candidateManifest.digests.candidates !== sha256(candidates.text)) throw new Error('candidate digest mismatch')
if (candidateManifest.digests.sources !== sha256(sources.text)) throw new Error('source digest mismatch')
if (candidates.rows.length !== sources.rows.length) throw new Error('candidate/source count mismatch')
assertSourceDisjoint(sources.rows, await priorSourceInventory())

const sourceById = indexed(sources.rows, 'sources')
const left = indexed(annotationsA.rows, 'annotations A')
const right = indexed(annotationsB.rows, 'annotations B')
const third = indexed(annotationsC.rows, 'annotations C')
const resolved = []
let excludedNoMajority = 0
for (const candidate of candidates.rows) {
  const a = left.get(candidate.id)
  const b = right.get(candidate.id)
  if (a === undefined || b === undefined) throw new Error(`missing primary annotation for ${candidate.id}`)
  const primaryDisagreement = a.route !== b.route || a.outcomeCritical !== b.outcomeCritical
  const c = primaryDisagreement ? third.get(candidate.id) : undefined
  if (primaryDisagreement && c === undefined) throw new Error(`missing independent adjudication for ${candidate.id}`)
  if (!primaryDisagreement && third.has(candidate.id)) throw new Error(`annotations C includes agreed row ${candidate.id}`)
  const annotations = c === undefined ? [a, b] : [a, b, c]
  for (const annotation of annotations) {
    if (!routes.includes(annotation.route)) throw new Error(`${candidate.id} has invalid label ${annotation.route}; probe is prediction-only`)
  }
  const routeVotes = new Map(routes.map(route => [route, annotations.filter(row => row.route === route).length]))
  const [route, votes] = [...routeVotes].sort((x, y) => y[1] - x[1])[0]
  if (votes < 2) {
    excludedNoMajority += 1
    continue
  }
  const supporters = annotations.filter(row => row.route === route)
  if (supporters.filter(row => row.confidence !== 'low').length < 2) continue
  const outcomeCritical = annotations.filter(row => row.outcomeCritical).length >= 2
  if (route === 'bypass' && outcomeCritical) throw new Error(`resolved outcome-critical ${candidate.id} as bypass`)
  const source = sourceById.get(candidate.id)
  if (source === undefined) throw new Error(`missing source for ${candidate.id}`)
  resolved.push({
    candidate,
    source,
    label: {
      route,
      outcomeCritical,
      confidence: supporters.every(row => row.confidence === 'high') ? 'high' : 'medium',
      authoritativeMutationBasis: supporters.map(row => row.authoritativeMutationBasis),
      rationale: supporters.map(row => row.rationale).join(' | '),
    },
  })
}

const available = Object.fromEntries(languages.flatMap(language => routes.map(route => [
  `${language}/${route}`,
  resolved.filter(row => row.candidate.language === language && row.label.route === route).length,
])))
for (const language of languages) {
  for (const [route, count] of Object.entries(targetPerLanguage)) {
    if (available[`${language}/${route}`] < count) {
      throw new Error(`V5 stratum ${language}/${route} has ${available[`${language}/${route}`]} rows; requires ${count}`)
    }
  }
}

const selected = []
for (const language of languages) {
  for (const [route, count] of Object.entries(targetPerLanguage)) {
    const bucket = resolved
      .filter(row => row.candidate.language === language && row.label.route === route)
      .sort((a, b) => sha256(`${selectionSeed}:${a.candidate.id}`).localeCompare(sha256(`${selectionSeed}:${b.candidate.id}`)))
    selected.push(...bucket.slice(0, count))
  }
}
selected.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id))
const actualCounts = {
  total: selected.length,
  english: selected.filter(row => row.candidate.language === 'en').length,
  chinese: selected.filter(row => row.candidate.language === 'zh').length,
  bypass: selected.filter(row => row.label.route === 'bypass').length,
  contract: selected.filter(row => row.label.route === 'contract').length,
  lattice: selected.filter(row => row.label.route === 'lattice').length,
}
if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) throw new Error(`V5 balance mismatch: ${JSON.stringify(actualCounts)}`)

const promptText = lines(selected.map(({ candidate }) => ({ ...candidate, split: 'blind' })))
const labelText = lines(selected.map(({ candidate, label }) => ({ id: candidate.id, expected: label.route, ...label })))
const sourceText = lines(selected.map(({ source }) => source))
const manifest = {
  schemaVersion: 1,
  protocol: 'authoritative-mutation-basis-v5',
  selectionSeed,
  frozenAt: new Date().toISOString(),
  codeFreezeCommit,
  runtimeDigest,
  counts: { ...actualCounts, eligibleBeforeSelection: resolved.length, excludedNoMajority, available },
  labelDomain: routes,
  predictionDomain: [...routes, 'probe'],
  gates: releaseGates,
  sourceIsolation: candidateManifest.sourceIsolation,
  digests: {
    candidateManifest: sha256(candidateManifestText),
    prompts: sha256(promptText),
    labels: sha256(labelText),
    sources: sha256(sourceText),
    annotationsA: sha256(annotationsA.text),
    annotationsB: sha256(annotationsB.text),
    annotationsC: sha256(annotationsC.text),
  },
}
await Promise.all([
  writeFile(join(here, 'blind-v5.prompts.jsonl'), promptText, 'utf8'),
  writeFile(join(here, 'blind-v5.labels.jsonl'), labelText, 'utf8'),
  writeFile(join(here, 'blind-v5.sources.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'blind-v5.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])
console.log(JSON.stringify({ counts: actualCounts, codeFreezeCommit, runtimeDigest }, null, 2))
