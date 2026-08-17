import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sha256 } from '../lib/canonical.mjs'
import { buildManifest } from '../lib/design.mjs'
import { driverSourceDigest } from '../lib/integrity.mjs'
import { validateBenchmarkLock, validateManifest, validatePreregistration } from '../lib/validation.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the preregistered matrix is deterministic and exact', async () => {
  const preregistration = await readJson(join(root, 'preregistration.json'))
  const lock = await readJson(join(root, 'benchmark-lock.json'))
  const simple = await readJson(join(root, 'simple-tasks.json'))
  const runtimeArtifacts = await readJson(join(root, 'runtime-artifacts.json'))
  const routerBlindResult = await readJson(join(root, '..', 'router-corpus', 'blind-real-results.json'))
  const frozen = await readJson(join(root, 'frozen-manifest.json'))
  validatePreregistration(preregistration)
  validateBenchmarkLock(lock)
  validateManifest(frozen)
  const regenerated = buildManifest(preregistration, lock, simple, runtimeArtifacts, routerBlindResult, frozen.driverSourceDigest)
  assert.equal(sha256(regenerated), sha256(frozen))
  assert.notEqual(await driverSourceDigest(), frozen.driverSourceDigest, 'the historical RC.3 driver must not impersonate the RC.4 study source')
  assert.deepEqual(frozen.counts, {
    infrastructure: 6,
    statistical: 90,
    simple: 36,
    icae: 36,
    evocode: 18,
  })
})

test('all explicit arms have two repetitions per statistical task', async () => {
  const manifest = await readJson(join(root, 'frozen-manifest.json'))
  const cells = new Map()
  for (const run of manifest.statisticalRuns) {
    const key = `${run.suite}:${run.taskId}:${run.arm.id}`
    const repetitions = cells.get(key) ?? []
    repetitions.push(run.repetition)
    cells.set(key, repetitions)
  }
  for (const repetitions of cells.values()) assert.deepEqual(repetitions.sort(), [1, 2])
  assert.equal(cells.size, 45)
})

test('outcome data is absent from the run manifest', async () => {
  const manifest = await readJson(join(root, 'frozen-manifest.json'))
  const text = JSON.stringify([...manifest.infrastructureRuns, ...manifest.statisticalRuns])
  assert.doesNotMatch(text, /metrics|score|releaseAllowed/i)
  assert.match(manifest.routerBlindResultDigest, /^[0-9a-f]{64}$/)
})

test('official ICAE hidden assets are bound before model execution', async () => {
  const lock = await readJson(join(root, 'benchmark-lock.json'))
  const assets = lock.sources.icae.officialDataAssets
  assert.deepEqual(Object.keys(assets).sort(), [
    'authoritativeTests',
    'goldenRepositories',
    'hiddenPrdBundle',
  ])
  for (const asset of Object.values(assets)) {
    assert.match(asset.url, /^https:\/\/zenodo\.org\/records\//)
    assert.match(asset.sha256, /^[0-9a-f]{64}$/)
  }
  validateBenchmarkLock(lock)
})
