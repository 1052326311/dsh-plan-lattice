#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..')
const promptsText = await readFile(join(here, 'blind-v4.prompts.jsonl'), 'utf8')
const labelsText = await readFile(join(here, 'blind-v4.labels.jsonl'), 'utf8')
const manifestText = await readFile(join(here, 'blind-v4.manifest.json'), 'utf8')
const prompts = promptsText.trim().split('\n').map(line => JSON.parse(line))
const labels = new Map(labelsText.trim().split('\n').map(line => {
  const row = JSON.parse(line)
  return [row.id, row]
}))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const router = await import(`${pathToFileURL(join(root, 'lib/router.js')).href}?development=${Date.now()}`)
const config = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}
const rows = prompts.map(prompt => {
  const expected = labels.get(prompt.id)
  if (expected === undefined) throw new Error(`missing V4 label ${prompt.id}`)
  const actual = router.routeRequest(prompt.text, config)
  return {
    id: prompt.id,
    language: prompt.language,
    expected: expected.expected,
    outcomeCritical: expected.outcomeCritical,
    actual: actual.phase,
    reasons: actual.reasons,
  }
})
const routeNames = ['bypass', 'contract', 'lattice']
const ratio = (numerator, denominator) => denominator === 0 ? 0 : numerator / denominator
const simple = rows.filter(row => row.expected === 'bypass')
const complex = rows.filter(row => row.expected !== 'bypass')
const lattice = rows.filter(row => row.expected === 'lattice')
const f1 = routeNames.map(route => {
  const truePositive = rows.filter(row => row.expected === route && row.actual === route).length
  const falsePositive = rows.filter(row => row.expected !== route && row.actual === route).length
  const falseNegative = rows.filter(row => row.expected === route && row.actual !== route).length
  return truePositive === 0 ? 0 : 2 * truePositive / (2 * truePositive + falsePositive + falseNegative)
})
const report = {
  schemaVersion: 1,
  evidenceStatus: 'revealed-development-only',
  evaluatedAt: new Date().toISOString(),
  runtimeCommit: process.env.ROUTER_RUNTIME_COMMIT ?? 'WORKTREE',
  runtimeDigest: sha256((await Promise.all([
    'src/router.ts', 'src/task-invariants.ts', 'src/router-classifier.ts', 'src/router-model.ts',
  ].map(path => readFile(join(root, path))))).map(body => sha256(body)).join('\n')),
  frozenV4ManifestDigest: sha256(manifestText),
  metrics: {
    exactAccuracy: ratio(rows.filter(row => row.actual === row.expected).length, rows.length),
    macroF1: f1.reduce((sum, value) => sum + value, 0) / f1.length,
    simpleFalseActivationRate: ratio(simple.filter(row => row.actual !== 'bypass').length, simple.length),
    complexCriticalRecall: ratio(complex.filter(row => row.actual !== 'bypass').length, complex.length),
    outcomeCriticalBypass: rows.filter(row => row.outcomeCritical && row.actual === 'bypass').length,
    latticeRecall: ratio(lattice.filter(row => row.actual === 'lattice').length, lattice.length),
    probeRate: ratio(rows.filter(row => row.actual === 'probe').length, rows.length),
  },
  confusion: Object.fromEntries(routeNames.flatMap(expected => [...routeNames, 'probe'].map(actual => [
    `${expected}->${actual}`,
    rows.filter(row => row.expected === expected && row.actual === actual).length,
  ]))),
  failures: rows.filter(row => row.actual !== row.expected),
}
await writeFile(join(here, 'development-current-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ metrics: report.metrics, confusion: report.confusion }, null, 2))
