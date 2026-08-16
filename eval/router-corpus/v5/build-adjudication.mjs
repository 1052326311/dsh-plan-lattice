#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { disagreementIds, validateAnnotationSet } from './annotation-schema.mjs'
import {
  assertArtifactsAbsent,
  assertFrozenRuntime,
  codeFreezeCommit,
  here,
  lines,
  loadJsonLines,
  routes,
  sha256,
  writeExclusive,
} from './protocol.mjs'

const outputPaths = {
  packet: join(here, 'adjudication-packet.jsonl'),
  report: join(here, 'agreement-report.json'),
}
await assertArtifactsAbsent(Object.values(outputPaths), 'V5 adjudication')
const runtimeDigest = await assertFrozenRuntime()
const [candidates, annotationsA, annotationsB] = await Promise.all([
  loadJsonLines('candidates.jsonl'),
  loadJsonLines('annotations-a.jsonl'),
  loadJsonLines('annotations-b.jsonl'),
])
const candidateManifestText = await readFile(join(here, 'candidate-manifest.json'), 'utf8')
const candidateManifest = JSON.parse(candidateManifestText)
if (candidateManifest.codeFreezeCommit !== codeFreezeCommit) throw new Error('candidate manifest is not bound to the V5 code freeze')
if (candidateManifest.runtimeDigest !== runtimeDigest) throw new Error('candidate manifest runtime does not match the V5 code freeze')
if (candidateManifest.digests.candidates !== sha256(candidates.text)) throw new Error('candidate digest mismatch')

const left = validateAnnotationSet(candidates.rows, annotationsA.rows, routes, 'annotations A')
const right = validateAnnotationSet(candidates.rows, annotationsB.rows, routes, 'annotations B')
const disagreements = disagreementIds(candidates.rows, left, right)
const disagreementSet = new Set(disagreements)
const packet = candidates.rows
  .filter(candidate => disagreementSet.has(candidate.id))
  .map(candidate => ({
    id: candidate.id,
    language: candidate.language,
    text: candidate.text,
  }))
const axisDisagreements = candidates.rows.filter(candidate => {
  const a = left.get(candidate.id).authoritativeMutationBasis
  const b = right.get(candidate.id).authoritativeMutationBasis
  return JSON.stringify(a) !== JSON.stringify(b)
}).length
const packetText = lines(packet)
const report = {
  schemaVersion: 1,
  codeFreezeCommit,
  runtimeDigest,
  counts: {
    candidates: candidates.rows.length,
    agreements: candidates.rows.length - disagreements.length,
    disagreements: disagreements.length,
    axisDisagreements,
  },
  disagreementIds: disagreements,
  digests: {
    candidateManifest: sha256(candidateManifestText),
    candidates: sha256(candidates.text),
    annotationsA: sha256(annotationsA.text),
    annotationsB: sha256(annotationsB.text),
    adjudicationPacket: sha256(packetText),
  },
}
await Promise.all([
  writeExclusive(outputPaths.packet, packetText),
  writeExclusive(outputPaths.report, `${JSON.stringify(report, null, 2)}\n`),
])
console.log(JSON.stringify(report.counts, null, 2))
