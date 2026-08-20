#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyMutant, mutants } from './mutants/catalog.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const grader = join(root, 'grader.mjs')
const reference = join(root, 'reference')

function runGrader(workspace) {
  const result = spawnSync(process.execPath, [grader, workspace], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status !== 0) {
    throw new Error(`grader failed for ${workspace}: ${result.stderr || result.stdout}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`grader returned invalid JSON for ${workspace}: ${error.message}`)
  }
}

function failedCheckNames(report) {
  return report.checks.filter((check) => !check.passed).map((check) => check.name)
}

export async function qualify(options = {}) {
  const tempParent = options.tempParent ?? tmpdir()
  const knownGood = runGrader(reference)
  const hardChecks = knownGood.checks.filter((check) => check.hard).map((check) => check.name)
  const targetCounts = new Map(hardChecks.map((name) => [name, 0]))
  for (const mutant of mutants) {
    if (!targetCounts.has(mutant.targetCheck)) {
      throw new Error(`${mutant.id}: target is not a hard grader check: ${mutant.targetCheck}`)
    }
    targetCounts.set(mutant.targetCheck, targetCounts.get(mutant.targetCheck) + 1)
  }

  const uncoveredHardChecks = [...targetCounts]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
  const results = []

  for (const mutant of mutants) {
    const tempRoot = await mkdtemp(join(tempParent, 'duty-window-v23-mutant-'))
    const workspace = join(tempRoot, 'workspace')
    try {
      await cp(reference, workspace, { recursive: true })
      await applyMutant(workspace, mutant)
      const report = runGrader(workspace)
      const target = report.checks.find((check) => check.name === mutant.targetCheck)
      results.push({
        id: mutant.id,
        targetCheck: mutant.targetCheck,
        targetCaught: target?.passed === false,
        score: report.score,
        hardRequirementsMissed: report.hardRequirementsMissed,
        failedChecks: failedCheckNames(report),
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }

  const knownGoodPassed = knownGood.score === 100
    && knownGood.hardRequirementsMissed === 0
    && hardChecks.every((name) => knownGood.checks.find((check) => check.name === name)?.passed)
  const allMutantsCaught = results.every((result) => result.targetCaught && result.hardRequirementsMissed > 0)
  const qualified = knownGoodPassed && uncoveredHardChecks.length === 0 && allMutantsCaught

  return {
    schemaVersion: 1,
    qualified,
    knownGood: {
      score: knownGood.score,
      hardRequirementsMissed: knownGood.hardRequirementsMissed,
      hardCheckCount: hardChecks.length,
    },
    coverage: {
      hardChecks: hardChecks.length,
      mutants: mutants.length,
      uncoveredHardChecks,
    },
    mutants: results,
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await qualify()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.qualified) process.exitCode = 1
}
