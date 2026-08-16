#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateAnnotationSet as validateV6Set } from '../v6/annotation-schema.mjs'
import {
  assertArtifactsAbsent,
  here,
  lines,
  parseJsonLines,
  sha256,
  writeExclusive,
} from './protocol.mjs'

const v6 = join(here, '..', 'v6')
const output = join(here, 'calibration-candidates.jsonl')
const manifestPath = join(here, 'calibration-manifest.json')
await assertArtifactsAbsent([output, manifestPath], 'V7 calibration selection')

const [candidateText, ...annotationTexts] = await Promise.all([
  readFile(join(v6, 'candidates.jsonl'), 'utf8'),
  ...['a', 'b', 'c'].map(name => readFile(join(v6, `annotations-${name}.jsonl`), 'utf8')),
])
const candidates = parseJsonLines(candidateText, 'V6 candidates')
const annotationSets = annotationTexts.map((text, index) => validateV6Set(
  candidates,
  parseJsonLines(text, `V6 annotations ${index + 1}`),
  `V6 annotations ${index + 1}`,
))

function oldRoutes(candidate) {
  return annotationSets.map(set => {
    const derived = set.get(candidate.id).derived
    return derived.eligible ? derived.route : 'non-executable'
  })
}

function order(candidate) {
  return sha256(`plan-lattice-v7-calibration:${candidate.id}:${sha256(candidate.text)}`)
}

const buckets = new Map([
  ['three-way-disagreement', []],
  ['two-way-disagreement', []],
  ['unanimous-bypass', []],
  ['unanimous-contract', []],
  ['unanimous-probe', []],
  ['unanimous-lattice', []],
  ['unanimous-non-executable', []],
])
for (const candidate of candidates) {
  const routes = oldRoutes(candidate)
  const unique = new Set(routes)
  const key = unique.size === 3
    ? 'three-way-disagreement'
    : unique.size === 2
      ? 'two-way-disagreement'
      : `unanimous-${routes[0]}`
  buckets.get(key)?.push(candidate)
}
for (const rows of buckets.values()) rows.sort((left, right) => order(left).localeCompare(order(right)))

const quotas = {
  'three-way-disagreement': 10,
  'two-way-disagreement': 26,
  'unanimous-bypass': 12,
  'unanimous-contract': 8,
  'unanimous-probe': 8,
  'unanimous-lattice': 4,
  'unanimous-non-executable': 4,
}
const selected = []
const selectedCounts = {}
for (const [key, quota] of Object.entries(quotas)) {
  const rows = buckets.get(key) ?? []
  const picked = rows.slice(0, quota)
  selected.push(...picked)
  selectedCounts[key] = picked.length
}
if (selected.length < 72) {
  const selectedIds = new Set(selected.map(row => row.id))
  const fallback = candidates
    .filter(row => !selectedIds.has(row.id))
    .sort((left, right) => order(left).localeCompare(order(right)))
    .slice(0, 72 - selected.length)
  selected.push(...fallback)
  selectedCounts.fallback = fallback.length
}
selected.sort((left, right) => left.id.localeCompare(right.id))
if (selected.length !== 72 || new Set(selected.map(row => row.id)).size !== 72) {
  throw new Error(`expected 72 unique calibration rows, got ${selected.length}`)
}

const rows = selected.map(row => ({
  id: `v7-cal-${row.id.slice(3)}`,
  language: row.language,
  text: row.text,
  revealedDevelopmentSource: row.id,
}))
const body = lines(rows)
const manifest = {
  schemaVersion: 1,
  purpose: 'revealed-development-calibration-only',
  sourceVersion: 'v6',
  selectionSeed: 'plan-lattice-v7-calibration',
  selectedCounts,
  counts: {
    total: rows.length,
    english: rows.filter(row => row.language === 'en').length,
    chinese: rows.filter(row => row.language === 'zh').length,
  },
  digests: {
    candidates: sha256(body),
    sourceCandidates: sha256(candidateText),
    sourceAnnotations: annotationTexts.map(sha256),
  },
}
await Promise.all([
  writeExclusive(output, body),
  writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
])
console.log(JSON.stringify(manifest, null, 2))
