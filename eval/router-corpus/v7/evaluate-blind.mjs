#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expectedCounts, routes } from './blind-protocol.mjs'
import { assertArtifactsAbsent, assertFrozenRuntime, here, parseJsonLines, releaseGates, sha256, writeExclusive } from './protocol.mjs'

const resultPath = join(here, 'blind-v7-results.json')
await assertArtifactsAbsent([resultPath], 'V7 router reveal')
const [promptsText, labelsText, sourcesText, manifestText] = await Promise.all([
  readFile(join(here, 'blind-v7.prompts.jsonl'), 'utf8'),
  readFile(join(here, 'blind-v7.labels.jsonl'), 'utf8'),
  readFile(join(here, 'blind-v7.sources.jsonl'), 'utf8'),
  readFile(join(here, 'blind-v7.manifest.json'), 'utf8'),
])
const prompts = parseJsonLines(promptsText, 'blind-v7.prompts.jsonl')
const labels = parseJsonLines(labelsText, 'blind-v7.labels.jsonl')
const sources = parseJsonLines(sourcesText, 'blind-v7.sources.jsonl')
const manifest = JSON.parse(manifestText)
const frozen = await assertFrozenRuntime()
if (manifest.evidenceStatus !== 'frozen-before-router-reveal'
  || manifest.runtimeFreezeCommit !== frozen.exactCommit
  || manifest.runtimeDigest !== frozen.runtimeDigest) throw new Error('V7 blind manifest is not bound to the frozen runtime')
if (prompts.length !== expectedCounts.total || labels.length !== prompts.length || sources.length !== prompts.length) {
  throw new Error('V7 blind input counts are invalid')
}
if (manifest.digests.prompts !== sha256(promptsText)
  || manifest.digests.labels !== sha256(labelsText)
  || manifest.digests.sources !== sha256(sourcesText)) throw new Error('V7 blind input digest mismatch')

const labelById = new Map(labels.map(row => [row.id, row]))
const runtimeUrl = pathToFileURL(join(here, '../../../lib/router.js'))
runtimeUrl.searchParams.set('v7', `${Date.now()}-${process.pid}`)
const runtime = await import(runtimeUrl.href)
const config = { activationMode: 'auto', clarificationPolicy: 'critical', controlCeiling: 'lattice', longTaskThreshold: 8 }
const rows = prompts.map(prompt => {
  const expected = labelById.get(prompt.id)
  const assessment = runtime.routeRequest(prompt.text, config)
  if (!routes.includes(assessment.phase)) throw new Error(`${prompt.id} produced invalid route ${assessment.phase}`)
  return { id: prompt.id, language: prompt.language, expected: expected.expected, outcomeCritical: expected.outcomeCritical, actual: assessment.phase, assessment }
})

const ratio = (numerator, denominator, name) => {
  if (denominator === 0) throw new Error(`cannot compute ${name} from an empty stratum`)
  return numerator / denominator
}
const classMetrics = Object.fromEntries(routes.map(route => {
  const tp = rows.filter(row => row.expected === route && row.actual === route).length
  const predicted = rows.filter(row => row.actual === route).length
  const expected = rows.filter(row => row.expected === route).length
  const precision = predicted === 0 ? 0 : tp / predicted
  const recall = ratio(tp, expected, `${route} recall`)
  return [route, { truePositive: tp, falsePositive: predicted - tp, falseNegative: expected - tp, precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) }]
}))
const simple = rows.filter(row => row.expected === 'bypass')
const complex = rows.filter(row => row.expected !== 'bypass')
const critical = rows.filter(row => row.outcomeCritical)
const probe = rows.filter(row => row.expected === 'probe')
const nonProbe = rows.filter(row => row.expected !== 'probe')
const metrics = {
  exactAccuracy: ratio(rows.filter(row => row.actual === row.expected).length, rows.length, 'exact accuracy'),
  macroF1: routes.reduce((sum, route) => sum + classMetrics[route].f1, 0) / routes.length,
  simpleFalseActivationRate: ratio(simple.filter(row => row.actual !== 'bypass').length, simple.length, 'simple false activation'),
  complexCriticalRecall: ratio(complex.filter(row => row.actual !== 'bypass').length, complex.length, 'complex recall'),
  outcomeCriticalBypassCount: critical.filter(row => row.actual === 'bypass').length,
  latticeRecall: classMetrics.lattice.recall,
  probeRecall: classMetrics.probe.recall,
  probeFalsePositiveRate: ratio(nonProbe.filter(row => row.actual === 'probe').length, nonProbe.length, 'probe false positive'),
  classMetrics,
}
const checks = {
  simpleFalseActivationRate: metrics.simpleFalseActivationRate <= releaseGates.simpleFalseActivationRateMax,
  complexCriticalRecall: metrics.complexCriticalRecall >= releaseGates.complexCriticalRecallMin,
  outcomeCriticalBypass: metrics.outcomeCriticalBypassCount <= releaseGates.outcomeCriticalBypassMax,
  exactAccuracy: metrics.exactAccuracy >= releaseGates.exactAccuracyMin,
  macroF1: metrics.macroF1 >= releaseGates.macroF1Min,
  latticeRecall: metrics.latticeRecall >= releaseGates.latticeRecallMin,
  probeRecall: metrics.probeRecall >= releaseGates.probeRecallMin,
  probeFalsePositiveRate: metrics.probeFalsePositiveRate <= releaseGates.probeFalsePositiveRateMax,
}
const result = {
  schemaVersion: 1,
  evidenceStatus: 'immutable-first-reveal',
  evaluatedAt: new Date().toISOString(),
  runtimeFreezeCommit: frozen.exactCommit,
  runtimeDigest: frozen.runtimeDigest,
  manifestDigest: sha256(manifestText),
  counts: expectedCounts,
  config,
  metrics,
  releaseGates,
  checks,
  releaseGatePassed: Object.values(checks).every(Boolean),
  confusion: Object.fromEntries(routes.flatMap(expected => routes.map(actual => [`${expected}->${actual}`, rows.filter(row => row.expected === expected && row.actual === actual).length]))),
  rows,
  failures: rows.filter(row => row.actual !== row.expected),
}
await writeExclusive(resultPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ releaseGatePassed: result.releaseGatePassed, metrics, checks }, null, 2))
process.exitCode = result.releaseGatePassed ? 0 : 2
