#!/usr/bin/env node
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertFrozenRuntime,
  expectedCounts,
  here,
  languages,
  parseJsonLines,
  releaseGates,
  routes,
  sha256,
  writeExclusive,
} from './protocol.mjs'

const resultPath = join(here, 'blind-v6-results.json')
const inputPaths = {
  prompts: join(here, 'blind-v6.prompts.jsonl'),
  labels: join(here, 'blind-v6.labels.jsonl'),
  sources: join(here, 'blind-v6.sources.jsonl'),
  manifest: join(here, 'blind-v6.manifest.json'),
}

try {
  await access(resultPath, constants.F_OK)
  throw new Error(`${resultPath} already exists; refusing to overwrite the immutable V6 first reveal`)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

function assertRecord(value, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`)
  }
  return value
}

function assertExactArray(actual, expected, context) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context} must equal ${JSON.stringify(expected)}`)
  }
}

function assertExactRecord(actual, expected, context) {
  assertRecord(actual, context)
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || expectedKeys.some(key => actual[key] !== expected[key])) {
    throw new Error(`${context} does not match the preregistered V6 protocol`)
  }
}

function assertDigest(value, expected, context) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`${context} is not a SHA-256 digest`)
  }
  if (sha256(value) !== expected) throw new Error(`${context} mismatch`)
}

function assertUniqueIds(rows, context) {
  const seen = new Set()
  for (const [index, rowValue] of rows.entries()) {
    const row = assertRecord(rowValue, `${context}:${index + 1}`)
    if (typeof row.id !== 'string' || row.id.trim() === '') {
      throw new Error(`${context}:${index + 1}.id must be a non-empty string`)
    }
    if (seen.has(row.id)) throw new Error(`${context} contains duplicate id ${row.id}`)
    seen.add(row.id)
  }
  return seen
}

function ratio(numerator, denominator, context) {
  if (denominator === 0) throw new Error(`cannot compute ${context} from an empty stratum`)
  return numerator / denominator
}

const [promptsText, labelsText, sourcesText, manifestText] = await Promise.all([
  readFile(inputPaths.prompts, 'utf8'),
  readFile(inputPaths.labels, 'utf8'),
  readFile(inputPaths.sources, 'utf8'),
  readFile(inputPaths.manifest, 'utf8'),
])

let manifest
try {
  manifest = assertRecord(JSON.parse(manifestText), 'V6 manifest')
} catch (error) {
  if (error instanceof SyntaxError) throw new Error('blind-v6.manifest.json is not valid JSON', { cause: error })
  throw error
}

const frozen = await assertFrozenRuntime()
if (manifest.schemaVersion !== 1 || manifest.protocol !== 'authoritative-mutation-basis-v6') {
  throw new Error('V6 manifest schema or protocol mismatch')
}
if (manifest.codeFreezeCommit !== frozen.exactCommit) throw new Error('V6 manifest code freeze mismatch')
if (manifest.runtimeDigest !== frozen.runtimeDigest) throw new Error('V6 manifest router runtime mismatch')
assertExactArray(manifest.labelDomain, routes, 'V6 label domain')
assertExactArray(manifest.predictionDomain, routes, 'V6 prediction domain')
assertExactRecord(manifest.expectedCounts, expectedCounts, 'V6 expected counts')
assertExactRecord(manifest.gates, releaseGates, 'V6 release gates')

const digests = assertRecord(manifest.digests, 'V6 manifest digests')
assertDigest(promptsText, digests.prompts, 'V6 prompt digest')
assertDigest(labelsText, digests.labels, 'V6 label digest')
assertDigest(sourcesText, digests.sources, 'V6 source digest')

const prompts = parseJsonLines(promptsText, 'blind-v6.prompts.jsonl')
const labels = parseJsonLines(labelsText, 'blind-v6.labels.jsonl')
const sources = parseJsonLines(sourcesText, 'blind-v6.sources.jsonl')
if (prompts.length !== expectedCounts.total) throw new Error(`V6 prompt count must be ${expectedCounts.total}`)
if (labels.length !== prompts.length) throw new Error('V6 prompt/label count mismatch')
if (sources.length !== prompts.length) throw new Error('V6 prompt/source count mismatch')

const promptIds = assertUniqueIds(prompts, 'V6 prompts')
const labelIds = assertUniqueIds(labels, 'V6 labels')
const sourceIds = assertUniqueIds(sources, 'V6 sources')
if (labelIds.size !== promptIds.size || [...promptIds].some(id => !labelIds.has(id))) {
  throw new Error('V6 label IDs do not exactly match prompt IDs')
}
if (sourceIds.size !== promptIds.size || [...promptIds].some(id => !sourceIds.has(id))) {
  throw new Error('V6 source IDs do not exactly match prompt IDs')
}

const labelById = new Map(labels.map(label => [label.id, label]))
const sourceById = new Map(sources.map(source => [source.id, source]))
const actualCounts = Object.fromEntries(Object.keys(expectedCounts).map(key => [key, 0]))
actualCounts.total = prompts.length

for (const [index, promptValue] of prompts.entries()) {
  const prompt = assertRecord(promptValue, `V6 prompt ${index + 1}`)
  if (!languages.includes(prompt.language)) throw new Error(`${prompt.id} has invalid language ${prompt.language}`)
  if (typeof prompt.text !== 'string' || prompt.text.trim() === '') throw new Error(`${prompt.id} has an empty prompt`)
  actualCounts[prompt.language === 'en' ? 'english' : 'chinese'] += 1

  const label = assertRecord(labelById.get(prompt.id), `V6 label ${prompt.id}`)
  if (!routes.includes(label.expected)) throw new Error(`${prompt.id} has invalid expected route ${label.expected}`)
  if (typeof label.outcomeCritical !== 'boolean') throw new Error(`${prompt.id}.outcomeCritical must be boolean`)
  actualCounts[label.expected] += 1

  const source = assertRecord(sourceById.get(prompt.id), `V6 source ${prompt.id}`)
  if (source.promptDigest !== sha256(prompt.text)) {
    throw new Error(`${prompt.id} source prompt digest mismatch`)
  }
}

for (const [key, expected] of Object.entries(expectedCounts)) {
  if (actualCounts[key] !== expected) throw new Error(`V6 ${key} count must be ${expected}; received ${actualCounts[key]}`)
  if (manifest.counts?.[key] !== expected) throw new Error(`V6 manifest ${key} count must be ${expected}`)
}

const publicRuntimeUrl = pathToFileURL(join(here, '../../../lib/router.js'))
publicRuntimeUrl.searchParams.set('v6', `${Date.now()}-${process.pid}`)
const runtime = await import(publicRuntimeUrl.href)
if (typeof runtime.routeRequest !== 'function') throw new Error('built router public API does not export routeRequest')

const config = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}
const rows = prompts.map(prompt => {
  const label = labelById.get(prompt.id)
  const assessment = assertRecord(runtime.routeRequest(prompt.text, config), `router output ${prompt.id}`)
  if (!routes.includes(assessment.phase)) throw new Error(`${prompt.id} produced invalid route ${assessment.phase}`)
  if (!Array.isArray(assessment.reasons) || assessment.reasons.some(reason => typeof reason !== 'string')) {
    throw new Error(`${prompt.id} produced invalid route reasons`)
  }
  return {
    id: prompt.id,
    language: prompt.language,
    expected: label.expected,
    outcomeCritical: label.outcomeCritical,
    actual: assessment.phase,
    assessment: {
      confidence: assessment.confidence,
      executionSpan: assessment.executionSpan,
      productDefinitionGap: assessment.productDefinitionGap,
      outcomeCritical: assessment.outcomeCritical,
      clarificationPolicy: assessment.clarificationPolicy,
      reasons: assessment.reasons,
    },
  }
})

const simple = rows.filter(row => row.expected === 'bypass')
const complex = rows.filter(row => row.expected !== 'bypass')
const critical = rows.filter(row => row.outcomeCritical)
const lattice = rows.filter(row => row.expected === 'lattice')
const probe = rows.filter(row => row.expected === 'probe')
const nonProbe = rows.filter(row => row.expected !== 'probe')
const classMetrics = Object.fromEntries(routes.map(route => {
  const truePositive = rows.filter(row => row.expected === route && row.actual === route).length
  const predicted = rows.filter(row => row.actual === route).length
  const expected = rows.filter(row => row.expected === route).length
  const precision = predicted === 0 ? 0 : truePositive / predicted
  const recall = ratio(truePositive, expected, `${route} recall`)
  return [route, {
    truePositive,
    falsePositive: predicted - truePositive,
    falseNegative: expected - truePositive,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  }]
}))

const metrics = {
  exactAccuracy: ratio(rows.filter(row => row.actual === row.expected).length, rows.length, 'exact accuracy'),
  macroF1: routes.reduce((sum, route) => sum + classMetrics[route].f1, 0) / routes.length,
  simpleFalseActivationRate: ratio(
    simple.filter(row => row.actual !== 'bypass').length,
    simple.length,
    'simple false activation rate',
  ),
  complexCriticalRecall: ratio(
    complex.filter(row => row.actual !== 'bypass').length,
    complex.length,
    'complex critical recall',
  ),
  outcomeCriticalBypassCount: critical.filter(row => row.actual === 'bypass').length,
  latticeRecall: ratio(
    lattice.filter(row => row.actual === 'lattice').length,
    lattice.length,
    'lattice recall',
  ),
  probeRecall: ratio(
    probe.filter(row => row.actual === 'probe').length,
    probe.length,
    'probe recall',
  ),
  probeFalsePositiveRate: ratio(
    nonProbe.filter(row => row.actual === 'probe').length,
    nonProbe.length,
    'probe false-positive rate',
  ),
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
if (Object.keys(checks).length !== Object.keys(releaseGates).length) {
  throw new Error('V6 evaluator does not implement every preregistered release gate')
}

const result = {
  schemaVersion: 1,
  evidenceStatus: 'immutable-first-reveal',
  evaluatedAt: new Date().toISOString(),
  codeFreezeCommit: frozen.exactCommit,
  runtimeDigest: frozen.runtimeDigest,
  manifestDigest: sha256(manifestText),
  inputDigests: {
    prompts: sha256(promptsText),
    labels: sha256(labelsText),
    sources: sha256(sourcesText),
  },
  config,
  samples: rows.length,
  counts: actualCounts,
  metrics,
  releaseGates,
  checks,
  releaseGatePassed: Object.values(checks).every(Boolean),
  confusion: Object.fromEntries(routes.flatMap(expected => routes.map(actual => [
    `${expected}->${actual}`,
    rows.filter(row => row.expected === expected && row.actual === actual).length,
  ]))),
  rows,
  failures: rows.filter(row => row.actual !== row.expected),
}

await writeExclusive(resultPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({
  releaseGatePassed: result.releaseGatePassed,
  metrics: result.metrics,
  checks: result.checks,
}, null, 2))
process.exitCode = result.releaseGatePassed ? 0 : 2
