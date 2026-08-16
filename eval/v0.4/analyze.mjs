#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeEvaluation } from './lib/analysis.mjs'
import { verifyAttemptReceipts } from './lib/attempt-integrity.mjs'
import { canonicalJson, readJson } from './lib/canonical.mjs'
import { buildManifest } from './lib/design.mjs'
import { assertCandidateCheckout, driverSourceDigest, verifyProtocolChecksums } from './lib/integrity.mjs'
import { readJsonLines } from './lib/results.mjs'
import { validateBenchmarkLock, validateManifest, validatePreregistration } from './lib/validation.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const arguments_ = process.argv.slice(2)
const option = (name) => {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}
const resultsPath = resolve(option('--results') ?? join(root, 'results.jsonl'))
const outputPath = option('--out') ? resolve(option('--out')) : undefined
const preregistration = await readJson(join(root, 'preregistration.json'))
const manifest = await readJson(join(root, 'frozen-manifest.json'))
const routerBlindResult = await readJson(join(root, '..', 'router-corpus', 'blind-real-results.json'))
const benchmarkLock = await readJson(join(root, 'benchmark-lock.json'))
const simpleTasks = await readJson(join(root, 'simple-tasks.json'))
const runtimeArtifacts = await readJson(join(root, 'runtime-artifacts.json'))
const records = await readJsonLines(resultsPath)
const analysis = analyzeEvaluation({ preregistration, manifest, records, routerBlindResult })
const controllerErrors = []
try {
  validatePreregistration(preregistration, { executionReady: true })
  validateBenchmarkLock(benchmarkLock)
  validateManifest(manifest)
  await verifyProtocolChecksums()
  const digest = await driverSourceDigest()
  const deterministic = buildManifest(preregistration, benchmarkLock, simpleTasks, runtimeArtifacts, routerBlindResult, digest)
  if (canonicalJson(deterministic) !== canonicalJson(manifest)) throw new Error('frozen manifest differs from the deterministic protocol')
  if (runtimeArtifacts.status !== 'frozen') throw new Error('runtime artifacts are not frozen')
  assertCandidateCheckout(preregistration.pluginCommits['v0.4.0Candidate'])
} catch (error) {
  controllerErrors.push(String(error?.message ?? error))
}
controllerErrors.push(...await verifyAttemptReceipts(records, resultsPath, preregistration.resultSigning.publicKeySpkiBase64))
analysis.integrity.gates.unshift({
  name: 'controller, manifest, checksum, candidate, result-chain, and artifact binding',
  passed: controllerErrors.length === 0,
  observed: controllerErrors,
  threshold: 'exact frozen clean candidate and deterministic protocol',
})
analysis.integrity.errors.push(...controllerErrors)
if (controllerErrors.length > 0) {
  analysis.releaseAllowed = false
  analysis.statement = 'Release blocked. No v0.4 uplift claim is permitted from this result set.'
}
const rendered = canonicalJson(analysis)
if (outputPath) await writeFile(outputPath, rendered, 'utf8')
process.stdout.write(rendered)
process.exitCode = analysis.releaseAllowed ? 0 : 3
