#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..', '..')
const promptsText = await readFile(join(here, 'blind-v4.prompts.jsonl'), 'utf8')
const labelsText = await readFile(join(here, 'blind-v4.labels.jsonl'), 'utf8')
const sourcesText = await readFile(join(here, 'blind-v4.sources.jsonl'), 'utf8')
const manifestText = await readFile(join(here, 'blind-v4.manifest.json'), 'utf8')
const prompts = promptsText.trim().split('\n').map(line => JSON.parse(line))
const labels = new Map(labelsText.trim().split('\n').map(line => {
  const row = JSON.parse(line)
  return [row.id, row]
}))
const manifest = JSON.parse(manifestText)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
if (currentCommit !== manifest.codeFreezeCommit) throw new Error('router checkout moved after V4 freeze')
const runtimeFiles = ['src/router.ts', 'src/task-invariants.ts', 'src/router-classifier.ts', 'src/router-model.ts']
const runtimeBodies = await Promise.all(runtimeFiles.map(path => readFile(join(repositoryRoot, path))))
if (sha256(runtimeBodies.map(body => sha256(body)).join('\n')) !== manifest.runtimeDigest) throw new Error('router runtime changed after V4 freeze')
if (sha256(promptsText) !== manifest.digests.prompts) throw new Error('V4 prompt digest mismatch')
if (sha256(labelsText) !== manifest.digests.labels) throw new Error('V4 label digest mismatch')
if (sha256(sourcesText) !== manifest.digests.sources) throw new Error('V4 source digest mismatch')
const router = await import(`${pathToFileURL(join(repositoryRoot, 'lib/router.js')).href}?v4=${Date.now()}`)
const resolvedConfig = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}

const routeNames = ['bypass', 'contract', 'lattice']
const rows = prompts.map(prompt => {
  const expected = labels.get(prompt.id)
  if (expected === undefined) throw new Error(`missing label ${prompt.id}`)
  const assessment = router.routeRequest(prompt.text, resolvedConfig)
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
const exact = rows.filter(row => row.actual === row.expected).length / rows.length
const falseActivation = simple.filter(row => row.actual !== 'bypass').length / simple.length
const complexRecall = complex.filter(row => row.actual !== 'bypass').length / complex.length
const criticalBypass = critical.filter(row => row.actual === 'bypass').length
const latticeRecall = lattice.filter(row => row.actual === 'lattice').length / lattice.length
const probeRate = rows.filter(row => row.actual === 'probe').length / rows.length
const f1 = routeNames.map(route => {
  const tp = rows.filter(row => row.expected === route && row.actual === route).length
  const fp = rows.filter(row => row.expected !== route && row.actual === route).length
  const fn = rows.filter(row => row.expected === route && row.actual !== route).length
  return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn)
})
const macroF1 = f1.reduce((sum, value) => sum + value, 0) / f1.length
const metrics = { exactAccuracy: exact, macroF1, simpleFalseActivationRate: falseActivation, complexCriticalRecall: complexRecall, outcomeCriticalBypass: criticalBypass, latticeRecall, probeRate }
const gates = manifest.gates
const checks = {
  simpleFalseActivationRate: falseActivation <= gates.simpleFalseActivationRateMax,
  complexCriticalRecall: complexRecall >= gates.complexCriticalRecallMin,
  outcomeCriticalBypass: criticalBypass <= gates.outcomeCriticalBypassMax,
  exactAccuracy: exact >= gates.exactAccuracyMin,
  macroF1: macroF1 >= gates.macroF1Min,
  latticeRecall: latticeRecall >= gates.latticeRecallMin,
  probeRate: probeRate <= gates.probeRateMax,
}
const result = {
  schemaVersion: 1,
  evaluatedAt: new Date().toISOString(),
  codeFreezeCommit: manifest.codeFreezeCommit,
  manifestDigest: sha256(manifestText),
  metrics,
  checks,
  releaseGatePassed: Object.values(checks).every(Boolean),
  confusion: Object.fromEntries(routeNames.flatMap(expected => [...routeNames, 'probe'].map(actual => [`${expected}->${actual}`, rows.filter(row => row.expected === expected && row.actual === actual).length]))),
  failures: rows.filter(row => row.actual !== row.expected),
}
await writeFile(join(here, 'blind-v4-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.releaseGatePassed ? 0 : 2
