#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sha256 } from './lib/canonical.mjs'
import { buildManifest } from './lib/design.mjs'
import { assertCandidateCheckout, driverSourceDigest, verifyProtocolChecksums } from './lib/integrity.mjs'
import { validateBenchmarkLock, validateManifest, validatePreregistration } from './lib/validation.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const executionReady = process.argv.includes('--execution-ready')
const preregistration = await readJson(join(root, 'preregistration.json'))
const lock = await readJson(join(root, 'benchmark-lock.json'))
const simpleTasks = await readJson(join(root, 'simple-tasks.json'))
const runtimeArtifacts = await readJson(join(root, 'runtime-artifacts.json'))
const routerBlindResult = await readJson(join(root, '..', 'router-corpus', 'blind-real-results.json'))
const frozen = await readJson(join(root, 'frozen-manifest.json'))

validatePreregistration(preregistration, { executionReady })
validateBenchmarkLock(lock)
validateManifest(frozen)
const regenerated = buildManifest(preregistration, lock, simpleTasks, runtimeArtifacts, routerBlindResult, await driverSourceDigest())
if (sha256(regenerated) !== sha256(frozen)) {
  throw new Error('frozen manifest does not match preregistration, benchmark lock, and task registry')
}
if (frozen.preregistrationDigest !== sha256(preregistration)) throw new Error('preregistration digest mismatch')
if (frozen.sourceLockDigest !== sha256(lock)) throw new Error('benchmark lock digest mismatch')
if (frozen.runtimeArtifactsDigest !== sha256(runtimeArtifacts)) throw new Error('runtime artifacts digest mismatch')
if (frozen.routerBlindResultDigest !== sha256(routerBlindResult)) throw new Error('router blind result digest mismatch')
if (executionReady) {
  await verifyProtocolChecksums()
  if (runtimeArtifacts.status !== 'frozen') throw new Error('runtime artifacts are not frozen')
  if (routerBlindResult.releaseGatePassed !== true) throw new Error('real-source router blind gate failed')
  assertCandidateCheckout(preregistration.pluginCommits['v0.4.0Candidate'])
}
console.log(`v0.4 protocol valid: ${frozen.manifestDigest}`)
console.log(`runs: ${frozen.counts.infrastructure} infrastructure excluded, ${frozen.counts.statistical} statistical`)
if (!executionReady) console.log('dry validation only; candidate code commit may remain unresolved')
