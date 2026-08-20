import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { qualify } from '../qualification.mjs'

let qualification

async function result() {
  if (!qualification) qualification = qualify()
  return qualification
}

test('known-good reference earns 100/100 with no hard misses', async () => {
  const report = await result()
  assert.deepEqual(report.knownGood, {
    score: 100,
    hardRequirementsMissed: 0,
    hardCheckCount: 19,
  })
})

test('every hard check has an attributable mutant and every target is caught', async () => {
  const report = await result()
  assert.equal(report.qualified, true)
  assert.deepEqual(report.coverage, {
    hardChecks: 19,
    mutants: 19,
    uncoveredHardChecks: [],
  })
  for (const mutant of report.mutants) {
    assert.equal(mutant.targetCaught, true, mutant.id)
    assert.ok(mutant.hardRequirementsMissed > 0, mutant.id)
    assert.ok(mutant.failedChecks.includes(mutant.targetCheck), mutant.id)
  }
})

test('mutation order counterexample is caught at the immediate byte-stability check', async () => {
  const report = await result()
  const mutant = report.mutants.find((entry) => entry.id === 'reassign-leaves-old-worker-authorized')
  assert.ok(mutant)
  assert.equal(mutant.targetCaught, true)
  assert.ok(mutant.failedChecks.includes(
    'reassign rejects old worker byte-stably before accepting new worker mutation',
  ))
})

test('adjust-start equal or greater boundary remains an input-error hard check', async () => {
  const report = await result()
  const mutant = report.mutants.find((entry) => entry.id === 'adjust-start-invalid-window-is-state-error')
  assert.ok(mutant)
  assert.equal(mutant.targetCaught, true)
  assert.ok(mutant.failedChecks.includes(
    'adjust-start replaces start and classifies start >= end as atomic input failure',
  ))
})

test('qualification removes every temporary mutant workspace', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'duty-window-v23-cleanup-'))
  try {
    const report = await qualify({ tempParent: parent })
    assert.equal(report.qualified, true)
    assert.deepEqual(await readdir(parent), [])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
