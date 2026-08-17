#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const resultDirectory = join(root, 'eval/pilots/results')
const sources = [
  'rc6-simple-bypass-run1.json',
  'rc6-simple-bypass.json',
]
const runs = await Promise.all(sources.map(async source => ({
  source,
  report: JSON.parse(await readFile(join(resultDirectory, source), 'utf8')),
})))

const arms = ['native', 'v0.4-auto']
const totals = Object.fromEntries(arms.map(arm => [arm, {
  hiddenScore: 0,
  maxScore: 0,
  modelTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
  clarificationQuestions: 0,
}]))

for (const { report } of runs) {
  for (const arm of arms) {
    const attempt = report.attempts.find(item => item.arm === arm)
    if (!attempt) throw new Error(`missing ${arm} attempt`)
    totals[arm].hiddenScore += attempt.score
    totals[arm].maxScore += attempt.maxScore
    totals[arm].modelTurns += attempt.modelTurns
    totals[arm].inputTokens += attempt.inputTokens
    totals[arm].outputTokens += attempt.outputTokens
    totals[arm].durationMs += attempt.durationMs
    totals[arm].clarificationQuestions += attempt.clarificationQuestions
  }
}

const reductionPercent = (baseline, observed) => Number(
  (((baseline - observed) / baseline) * 100).toFixed(1),
)
const native = totals.native
const candidate = totals['v0.4-auto']
const summary = {
  schemaVersion: 1,
  scope: 'two-repeat exploratory paired pilot; not statistical uplift evidence',
  sources: runs.map(({ source, report }) => ({
    source,
    generatedAt: report.generatedAt,
    pluginTarballSha256: report.pluginTarballSha256,
    passedStrictPerRunGate: report.passed,
  })),
  runCount: runs.length,
  totals,
  observedAggregateComparison: {
    scoreDelta: candidate.hiddenScore - native.hiddenScore,
    modelTurnDelta: candidate.modelTurns - native.modelTurns,
    modelTurnReductionPercent: reductionPercent(native.modelTurns, candidate.modelTurns),
    inputTokenReductionPercent: reductionPercent(native.inputTokens, candidate.inputTokens),
    outputTokenReductionPercent: reductionPercent(native.outputTokens, candidate.outputTokens),
    durationReductionPercent: reductionPercent(native.durationMs, candidate.durationMs),
  },
  conclusions: {
    taskQualityRegressionRecovered: candidate.hiddenScore === candidate.maxScore
      && candidate.hiddenScore === native.hiddenScore,
    zeroClarificationQuestions: candidate.clarificationQuestions === 0,
    perRunOverheadNonInferiorityEstablished: runs.every(({ report }) => report.checks.noAddedModelTurns),
    generalQualityUpliftEstablished: false,
  },
}

await writeFile(
  join(resultDirectory, 'rc6-simple-bypass-summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
