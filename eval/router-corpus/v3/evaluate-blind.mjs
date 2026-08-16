#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeRequest } from '../../../lib/router.js'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..', '..')
const routeNames = ['bypass', 'contract', 'lattice']
const config = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function jsonLines(name) {
  const text = await readFile(join(here, name), 'utf8')
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line)) }
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator
}

const manifestText = await readFile(join(here, 'blind-v3.manifest.json'), 'utf8')
const manifest = JSON.parse(manifestText)
const prompts = await jsonLines('blind-v3.prompts.jsonl')
const labels = await jsonLines('blind-v3.labels.jsonl')
const sources = await jsonLines('blind-v3.sources.jsonl')
const routerSource = await readFile(join(repositoryRoot, 'src', 'router.ts'))
if (sha256(routerSource) !== manifest.routerSourceDigest) {
  throw new Error('router changed after the v3 candidate pool was frozen')
}
if (sha256(prompts.text) !== manifest.digests.prompts) throw new Error('prompt digest mismatch')
if (sha256(labels.text) !== manifest.digests.labels) throw new Error('label digest mismatch')
if (sha256(sources.text) !== manifest.digests.sources) throw new Error('source digest mismatch')

const labelById = new Map(labels.rows.map(row => [row.id, row]))
const rows = prompts.rows.map(prompt => {
  const label = labelById.get(prompt.id)
  if (label === undefined) throw new Error(`missing label for ${prompt.id}`)
  return { id: prompt.id, language: prompt.language, expected: label.expected,
    outcomeCritical: label.outcomeCritical, observed: routeRequest(prompt.text, config) }
})
const simple = rows.filter(row => row.expected === 'bypass')
const complex = rows.filter(row => row.expected !== 'bypass')
const falseActivations = simple.filter(row => row.observed.phase !== 'bypass')
const complexBypasses = complex.filter(row => row.observed.phase === 'bypass')
const criticalBypasses = rows.filter(row => row.outcomeCritical && row.observed.phase === 'bypass')
const exact = rows.filter(row => row.observed.phase === row.expected)
const latticeRows = rows.filter(row => row.expected === 'lattice')
const probes = rows.filter(row => row.observed.phase === 'probe')
const classMetrics = Object.fromEntries(routeNames.map(route => {
  const truePositive = rows.filter(row => row.expected === route && row.observed.phase === route).length
  const predicted = rows.filter(row => row.observed.phase === route).length
  const actual = rows.filter(row => row.expected === route).length
  const precision = ratio(truePositive, predicted)
  const recall = ratio(truePositive, actual)
  return [route, { precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) }]
}))
const metrics = {
  simpleFalseActivationRate: ratio(falseActivations.length, simple.length),
  complexCriticalRecall: ratio(complex.length - complexBypasses.length, complex.length),
  outcomeCriticalBypassCount: criticalBypasses.length,
  exactAccuracy: ratio(exact.length, rows.length),
  macroF1: routeNames.reduce((sum, route) => sum + classMetrics[route].f1, 0) / routeNames.length,
  latticeRecall: classMetrics.lattice.recall,
  probeRate: ratio(probes.length, rows.length),
  classMetrics,
}
const gates = manifest.gates
const releaseGatePassed = metrics.simpleFalseActivationRate <= gates.simpleFalseActivationRateMax
  && metrics.complexCriticalRecall >= gates.complexCriticalRecallMin
  && metrics.outcomeCriticalBypassCount <= gates.outcomeCriticalBypassMax
  && metrics.exactAccuracy >= gates.exactAccuracyMin
  && metrics.macroF1 >= gates.macroF1Min
  && metrics.latticeRecall >= gates.latticeRecallMin
  && metrics.probeRate <= gates.probeRateMax
const result = {
  schemaVersion: 2,
  evaluatedAt: new Date().toISOString(),
  manifestDigest: sha256(manifestText),
  routerSourceDigest: manifest.routerSourceDigest,
  samples: rows.length,
  metrics,
  releaseGatePassed,
  failures: {
    falseActivations: falseActivations.map(row => row.id),
    complexBypasses: complexBypasses.map(row => row.id),
    criticalBypasses: criticalBypasses.map(row => row.id),
    exactMismatches: rows.filter(row => row.observed.phase !== row.expected).map(row => row.id),
  },
}
await writeFile(join(here, 'blind-v3-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ releaseGatePassed, metrics }, null, 2))
if (!releaseGatePassed) process.exitCode = 2
