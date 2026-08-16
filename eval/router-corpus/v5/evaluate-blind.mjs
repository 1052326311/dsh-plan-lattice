#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertFrozenRuntime,
  codeFreezeCommit,
  here,
  routes,
  sha256,
  writeExclusive,
} from './protocol.mjs'

const resultPath = join(here, 'blind-v5-results.json')
try {
  await access(resultPath, constants.F_OK)
  throw new Error(`${resultPath} already exists; refusing to overwrite the immutable V5 first reveal`)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const [promptsText, labelsText, sourcesText, manifestText] = await Promise.all([
  readFile(join(here, 'blind-v5.prompts.jsonl'), 'utf8'),
  readFile(join(here, 'blind-v5.labels.jsonl'), 'utf8'),
  readFile(join(here, 'blind-v5.sources.jsonl'), 'utf8'),
  readFile(join(here, 'blind-v5.manifest.json'), 'utf8'),
])
const manifest = JSON.parse(manifestText)
if (manifest.codeFreezeCommit !== codeFreezeCommit) throw new Error('V5 manifest code freeze mismatch')
const runtimeDigest = await assertFrozenRuntime()
if (manifest.runtimeDigest !== runtimeDigest) throw new Error('V5 manifest router runtime mismatch')
if (sha256(promptsText) !== manifest.digests.prompts) throw new Error('V5 prompt digest mismatch')
if (sha256(labelsText) !== manifest.digests.labels) throw new Error('V5 label digest mismatch')
if (sha256(sourcesText) !== manifest.digests.sources) throw new Error('V5 source digest mismatch')
if (JSON.stringify(manifest.labelDomain) !== JSON.stringify(routes)) throw new Error('V5 labels must exclude probe')

const prompts = promptsText.trim().split('\n').map(line => JSON.parse(line))
const labels = new Map(labelsText.trim().split('\n').map(line => {
  const row = JSON.parse(line)
  if (!routes.includes(row.expected)) throw new Error(`${row.id} has invalid expected route ${row.expected}`)
  return [row.id, row]
}))
const router = await import(`${pathToFileURL(join(here, '../../../lib/router.js')).href}?v5=${Date.now()}`)
const config = { activationMode: 'auto', clarificationPolicy: 'critical', controlCeiling: 'lattice', longTaskThreshold: 8 }
const rows = prompts.map(prompt => {
  const expected = labels.get(prompt.id)
  if (expected === undefined) throw new Error(`missing V5 label ${prompt.id}`)
  const assessment = router.routeRequest(prompt.text, config)
  return {
    id: prompt.id,
    language: prompt.language,
    expected: expected.expected,
    outcomeCritical: expected.outcomeCritical,
    actual: assessment.phase,
    reasons: assessment.reasons,
  }
})
const simple = rows.filter(row => row.expected === 'bypass')
const complex = rows.filter(row => row.expected !== 'bypass')
const critical = rows.filter(row => row.outcomeCritical)
const lattice = rows.filter(row => row.expected === 'lattice')
const exactAccuracy = rows.filter(row => row.actual === row.expected).length / rows.length
const simpleFalseActivationRate = simple.filter(row => row.actual !== 'bypass').length / simple.length
const complexCriticalRecall = complex.filter(row => row.actual !== 'bypass').length / complex.length
const outcomeCriticalBypass = critical.filter(row => row.actual === 'bypass').length
const latticeRecall = lattice.filter(row => row.actual === 'lattice').length / lattice.length
const probeRate = rows.filter(row => row.actual === 'probe').length / rows.length
const routeF1 = routes.map(route => {
  const tp = rows.filter(row => row.expected === route && row.actual === route).length
  const fp = rows.filter(row => row.expected !== route && row.actual === route).length
  const fn = rows.filter(row => row.expected === route && row.actual !== route).length
  return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn)
})
const macroF1 = routeF1.reduce((sum, value) => sum + value, 0) / routeF1.length
const metrics = { exactAccuracy, macroF1, simpleFalseActivationRate, complexCriticalRecall, outcomeCriticalBypass, latticeRecall, probeRate }
const gates = manifest.gates
const checks = {
  simpleFalseActivationRate: simpleFalseActivationRate <= gates.simpleFalseActivationRateMax,
  complexCriticalRecall: complexCriticalRecall >= gates.complexCriticalRecallMin,
  outcomeCriticalBypass: outcomeCriticalBypass <= gates.outcomeCriticalBypassMax,
  exactAccuracy: exactAccuracy >= gates.exactAccuracyMin,
  macroF1: macroF1 >= gates.macroF1Min,
  latticeRecall: latticeRecall >= gates.latticeRecallMin,
  probeRate: probeRate <= gates.probeRateMax,
}
const result = {
  schemaVersion: 1,
  evidenceStatus: 'immutable-first-reveal',
  evaluatedAt: new Date().toISOString(),
  codeFreezeCommit,
  runtimeDigest,
  manifestDigest: sha256(manifestText),
  metrics,
  checks,
  releaseGatePassed: Object.values(checks).every(Boolean),
  confusion: Object.fromEntries(routes.flatMap(expected => [...routes, 'probe'].map(actual => [
    `${expected}->${actual}`,
    rows.filter(row => row.expected === expected && row.actual === actual).length,
  ]))),
  failures: rows.filter(row => row.actual !== row.expected),
}
await writeExclusive(resultPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.releaseGatePassed ? 0 : 2
