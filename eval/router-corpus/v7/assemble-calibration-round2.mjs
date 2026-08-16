#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertArtifactsAbsent, here, parseJsonLines, sha256, writeExclusive } from './protocol.mjs'

const candidateInputs = ['calibration-candidates.jsonl', 'calibration-supplement-candidates.jsonl']
const annotationInputs = suffix => [
  `calibration-annotations-${suffix}.jsonl`,
  `calibration-supplement-annotations-${suffix}.jsonl`,
]
const outputCandidates = join(here, 'calibration-round2-candidates.jsonl')
const outputAnnotations = ['a', 'b', 'c'].map(suffix => join(here, `calibration-round2-annotations-${suffix}.jsonl`))
const manifestPath = join(here, 'calibration-round2-manifest.json')
await assertArtifactsAbsent([outputCandidates, ...outputAnnotations, manifestPath], 'V7 calibration round two')

async function combine(names, label) {
  const texts = await Promise.all(names.map(name => readFile(join(here, name), 'utf8')))
  const rows = texts.flatMap((text, index) => parseJsonLines(text, names[index]))
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error(`${label} contains duplicate IDs`)
  return { body: `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, rows, sourceDigests: texts.map(sha256) }
}

const candidates = await combine(candidateInputs, 'round-two candidates')
const annotations = await Promise.all(['a', 'b', 'c'].map(suffix => combine(
  annotationInputs(suffix),
  `round-two annotations ${suffix}`,
)))
for (const annotation of annotations) {
  if (annotation.rows.length !== candidates.rows.length) throw new Error('round-two annotations do not cover every candidate')
}
const manifest = {
  schemaVersion: 1,
  purpose: 'revealed-development-calibration-only',
  counts: {
    candidates: candidates.rows.length,
    base: parseJsonLines(await readFile(join(here, candidateInputs[0]), 'utf8'), candidateInputs[0]).length,
    supplement: parseJsonLines(await readFile(join(here, candidateInputs[1]), 'utf8'), candidateInputs[1]).length,
  },
  digests: {
    candidates: sha256(candidates.body),
    annotations: annotations.map(annotation => sha256(annotation.body)),
    sourceCandidates: candidates.sourceDigests,
    sourceAnnotations: annotations.map(annotation => annotation.sourceDigests),
  },
}
await Promise.all([
  writeExclusive(outputCandidates, candidates.body),
  ...outputAnnotations.map((path, index) => writeExclusive(path, annotations[index].body)),
  writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
])
console.log(JSON.stringify(manifest, null, 2))
