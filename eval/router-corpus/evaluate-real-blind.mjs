#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeRequest } from '../../lib/router.js'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const jsonLines = async name => (await readFile(join(here, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))

const manifest = JSON.parse(await readFile(join(here, 'blind-real.manifest.json'), 'utf8'))
const routerSourceDigest = sha256(await readFile(join(repositoryRoot, 'src', 'router.ts')))
if (routerSourceDigest !== manifest.routerSourceDigest) {
  throw new Error('router source changed after the real blind set was frozen')
}
const prompts = await jsonLines('blind-real.prompts.jsonl')
const labels = await jsonLines('blind-real.labels.jsonl')
const labelById = new Map(labels.map(label => [label.id, label]))
const config = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}
const rows = prompts.map(prompt => {
  const label = labelById.get(prompt.id)
  if (!label) throw new Error(`missing label for ${prompt.id}`)
  const route = routeRequest(prompt.text, config)
  return {
    id: prompt.id,
    sourceGroup: prompt.sourceGroup,
    language: prompt.language,
    expected: label.expected,
    outcomeCritical: label.outcomeCritical,
    observed: route.phase,
    confidence: route.confidence,
    executionSpan: route.executionSpan,
    productDefinitionGap: route.productDefinitionGap,
    reasons: route.reasons,
  }
})
const simple = rows.filter(row => row.expected === 'bypass')
const complex = rows.filter(row => row.expected !== 'bypass')
const simpleFailures = simple.filter(row => row.observed !== 'bypass')
const complexFailures = complex.filter(row => row.observed === 'bypass')
const criticalBypasses = rows.filter(row => row.outcomeCritical && row.observed === 'bypass')
const metrics = {
  simpleFalseActivationRate: simpleFailures.length / simple.length,
  complexCriticalRecall: (complex.length - complexFailures.length) / complex.length,
  outcomeCriticalBypassCount: criticalBypasses.length,
}
const gates = {
  simpleFalseActivation: metrics.simpleFalseActivationRate <= 0.05,
  complexCriticalRecall: metrics.complexCriticalRecall >= 0.9,
  outcomeCriticalNeverBypass: metrics.outcomeCriticalBypassCount === 0,
}
const result = {
  schemaVersion: 1,
  revealedAt: new Date().toISOString(),
  routerSourceDigest,
  blindManifestDigest: sha256(await readFile(join(here, 'blind-real.manifest.json'))),
  samples: rows.length,
  metrics,
  gates,
  releaseGatePassed: Object.values(gates).every(Boolean),
  failures: {
    simpleFalseActivations: simpleFailures,
    complexCriticalMisses: complexFailures,
    outcomeCriticalBypasses: criticalBypasses,
  },
  rows,
}
const serialized = `${JSON.stringify(result, null, 2)}\n`
if (process.argv.includes('--write')) await writeFile(join(here, 'blind-real-results.json'), serialized, 'utf8')
process.stdout.write(serialized)
process.exitCode = result.releaseGatePassed ? 0 : 3
