import { sha256 } from './canonical.mjs'
import { mean, median, pairedBootstrapInterval, percentile, reductionRate, relativeOverhead } from './statistics.mjs'
import { resolveEvaluationSlots } from './results.mjs'

function metric(record, name) {
  return record.metrics?.[name]
}

function scorePoints(record) {
  return (metric(record, 'score') / metric(record, 'maxScore')) * 100
}

function pairRuns(runs, resolved, baselineArm, candidateArm) {
  const byKey = new Map()
  for (const run of runs.filter((entry) => [baselineArm, candidateArm].includes(entry.arm.id))) {
    const key = `${run.taskId}:r${run.repetition}`
    const pair = byKey.get(key) ?? { key, taskId: run.taskId, repetition: run.repetition }
    pair[run.arm.id] = { run, result: resolved.get(run.runId) }
    byKey.set(key, pair)
  }
  return [...byKey.values()].filter((pair) => pair[baselineArm]?.result && pair[candidateArm]?.result)
}

function gate(name, passed, observed, threshold) {
  return { name, passed: Boolean(passed), observed, threshold }
}

function available(value) {
  return Number.isFinite(value)
}

function armSummary(runs, resolved) {
  const groups = new Map()
  for (const run of runs) {
    const result = resolved.get(run.runId)
    if (!result) continue
    const key = `${run.suite}:${run.arm.id}`
    const values = groups.get(key) ?? []
    values.push(scorePoints(result))
    groups.set(key, values)
  }
  return [...groups].map(([key, scores]) => {
    const [suite, armId] = key.split(':')
    return { suite, armId, samples: scores.length, meanScorePoints: mean(scores) }
  }).sort((left, right) => `${left.suite}:${left.armId}`.localeCompare(`${right.suite}:${right.armId}`))
}

export function analyzeEvaluation({ preregistration, manifest, records, routerBlindResult, requireProxyAccounting = false }) {
  const evaluationSlots = resolveEvaluationSlots(records, manifest, preregistration.retryPolicy)
  const slotState = {
    errors: evaluationSlots.errors,
    resolved: evaluationSlots.statistical.resolved,
    missingRunIds: evaluationSlots.statistical.missingRunIds,
    retainedAttemptCount: evaluationSlots.retainedAttemptCount,
  }
  const runById = new Map([...manifest.infrastructureRuns, ...manifest.statisticalRuns].map((run) => [run.runId, run]))
  const allResolved = new Map([
    ...evaluationSlots.infrastructure.resolved,
    ...evaluationSlots.statistical.resolved,
  ])
  const expectedModelDigest = sha256(manifest.model)
  const expectedRuntimeDigest = sha256(manifest.runtimePolicy)
  const endpointDigests = new Set()
  const proxyAccountingErrors = []
  const proxyAccounting = {
    resolvedAttempts: 0,
    agentRequests: 0,
    agentInputTokens: 0,
    agentOutputTokens: 0,
    oracleRequests: 0,
    oracleInputTokens: 0,
    oracleOutputTokens: 0,
  }
  for (const [runId, record] of allResolved) {
    const run = runById.get(runId)
    const expectedPlugin = run.arm.plugin === 'none'
      ? null
      : run.arm.plugin === 'v0.3.0'
        ? manifest.pluginCommits['v0.3.0']
        : manifest.pluginCommits['v0.4.0Candidate']
    const expectedPluginPackage = run.arm.plugin === 'none'
      ? null
      : run.arm.plugin === 'v0.3.0'
        ? manifest.runtimeArtifacts?.hostPlugins?.['v0.3.0']?.sha256
        : run.suite === 'evocode'
          ? manifest.runtimeArtifacts?.artifacts?.[run.arm.id]?.pluginPackageDigest
          : manifest.runtimeArtifacts?.hostPlugins?.['v0.4.0-candidate']?.sha256
    if (record.provenance?.harnessCommit !== manifest.sourceCommits.harness) slotState.errors.push(`Harness provenance mismatch for ${record.attemptId}`)
    if (record.provenance?.modelId !== manifest.model.modelId) slotState.errors.push(`model provenance mismatch for ${record.attemptId}`)
    if (record.provenance?.modelConfigDigest !== expectedModelDigest) slotState.errors.push(`model configuration provenance mismatch for ${record.attemptId}`)
    if (record.provenance?.runtimePolicyDigest !== expectedRuntimeDigest) slotState.errors.push(`runtime policy provenance mismatch for ${record.attemptId}`)
    if (record.provenance?.sourceLockDigest !== manifest.sourceLockDigest) slotState.errors.push(`source lock provenance mismatch for ${record.attemptId}`)
    if (record.provenance?.runtimeArtifactsDigest !== manifest.runtimeArtifactsDigest) slotState.errors.push(`runtime artifact provenance mismatch for ${record.attemptId}`)
    if (record.provenance?.driverSourceDigest !== manifest.driverSourceDigest) slotState.errors.push(`driver source provenance mismatch for ${record.attemptId}`)
    if ((record.provenance?.pluginCommit ?? null) !== expectedPlugin) slotState.errors.push(`plugin provenance mismatch for ${record.attemptId}`)
    if (manifest.runtimeArtifacts && (record.provenance?.pluginPackageDigest ?? null) !== expectedPluginPackage) {
      slotState.errors.push(`plugin package provenance mismatch for ${record.attemptId}`)
    }
    if (record.provenance?.endpointDigest) endpointDigests.add(record.provenance.endpointDigest)
    else slotState.errors.push(`endpoint provenance missing for ${record.attemptId}`)
    const accounting = {
      proxyAgentRequests: metric(record, 'proxyAgentRequests'),
      proxyOracleRequests: metric(record, 'proxyOracleRequests'),
      modelTurns: metric(record, 'modelTurns'),
      inputTokens: metric(record, 'inputTokens'),
      outputTokens: metric(record, 'outputTokens'),
      oracleInputTokens: metric(record, 'oracleInputTokens'),
      oracleOutputTokens: metric(record, 'oracleOutputTokens'),
    }
    if (Object.values(accounting).some(value => !Number.isSafeInteger(value) || value < 0)) {
      proxyAccountingErrors.push(`proxy accounting fields are incomplete for ${record.attemptId}`)
    } else {
      if (accounting.proxyAgentRequests !== accounting.modelTurns) {
        proxyAccountingErrors.push(`agent request/response count differs for ${record.attemptId}`)
      }
      if (run.suite !== 'icae' && (accounting.proxyOracleRequests !== 0
        || accounting.oracleInputTokens !== 0
        || accounting.oracleOutputTokens !== 0)) {
        proxyAccountingErrors.push(`Oracle accounting appears outside ICAE for ${record.attemptId}`)
      }
      if (run.suite === 'icae' && accounting.proxyOracleRequests > 5) {
        proxyAccountingErrors.push(`Oracle request limit exceeded for ${record.attemptId}`)
      }
      proxyAccounting.resolvedAttempts += 1
      proxyAccounting.agentRequests += accounting.proxyAgentRequests
      proxyAccounting.agentInputTokens += accounting.inputTokens
      proxyAccounting.agentOutputTokens += accounting.outputTokens
      proxyAccounting.oracleRequests += accounting.proxyOracleRequests
      proxyAccounting.oracleInputTokens += accounting.oracleInputTokens
      proxyAccounting.oracleOutputTokens += accounting.oracleOutputTokens
    }
  }
  if (requireProxyAccounting) slotState.errors.push(...proxyAccountingErrors)
  if (endpointDigests.size > 1) slotState.errors.push('multiple model endpoint digests found')
  const provenanceCells = new Map()
  for (const [runId, record] of slotState.resolved) {
    const run = runById.get(runId)
    const key = `${run.suite}:${run.taskId}:r${run.repetition}`
    const cell = provenanceCells.get(key) ?? { taskDigests: new Set(), graderDigests: new Set() }
    if (record.provenance?.taskDigest) cell.taskDigests.add(record.provenance.taskDigest)
    if (record.provenance?.graderDigest) cell.graderDigests.add(record.provenance.graderDigest)
    provenanceCells.set(key, cell)
  }
  for (const [key, cell] of provenanceCells) {
    if (cell.taskDigests.size !== 1) slotState.errors.push(`task digest differs across arms for ${key}`)
    if (cell.graderDigests.size !== 1) slotState.errors.push(`grader digest differs across arms for ${key}`)
  }
  const integrityGates = [
    gate(
      'router blind result manifest binding',
      sha256(routerBlindResult) === manifest.routerBlindResultDigest,
      sha256(routerBlindResult),
      manifest.routerBlindResultDigest,
    ),
    gate(
      'real-source router blind precondition',
      routerBlindResult?.releaseGatePassed === true,
      routerBlindResult?.metrics ?? null,
      'all frozen router gates pass before model experiments',
    ),
    gate('all 6 infrastructure slots completed', evaluationSlots.infrastructure.missingRunIds.length === 0, 6 - evaluationSlots.infrastructure.missingRunIds.length, 6),
    gate('all 90 statistical slots resolved', slotState.missingRunIds.length === 0, 90 - slotState.missingRunIds.length, 90),
    gate('no unauthorized or malformed reruns', slotState.errors.length === 0, slotState.errors, 'no errors'),
    gate('one endpoint across all resolved runs', endpointDigests.size === 1 && slotState.resolved.size === 90, [...endpointDigests], 'exactly one digest across 90 runs'),
    ...(requireProxyAccounting ? [gate(
        'complete proxy audit role and token accounting',
        proxyAccountingErrors.length === 0 && proxyAccounting.resolvedAttempts === allResolved.size && allResolved.size === 96,
        { ...proxyAccounting, errors: proxyAccountingErrors },
        'all 96 resolved attempts have paired agent/Oracle request accounting and suite-valid Oracle use',
      )] : []),
  ]
  const runs = manifest.statisticalRuns
  const resolved = slotState.resolved

  const simplePairs = pairRuns(runs.filter((run) => run.suite === 'simple'), resolved, 'native', 'v0.4-auto')
  const simpleScoreDifferences = simplePairs.map((pair) => scorePoints(pair['v0.4-auto'].result) - scorePoints(pair.native.result))
  const turnDifferences = simplePairs.map((pair) => metric(pair['v0.4-auto'].result, 'modelTurns') - metric(pair.native.result, 'modelTurns'))
  const tokenOverheads = simplePairs.map((pair) => relativeOverhead(
    metric(pair['v0.4-auto'].result, 'inputTokens') + metric(pair['v0.4-auto'].result, 'outputTokens'),
    metric(pair.native.result, 'inputTokens') + metric(pair.native.result, 'outputTokens'),
  ))
  const durationOverheads = simplePairs.map((pair) => relativeOverhead(
    metric(pair['v0.4-auto'].result, 'durationMs'),
    metric(pair.native.result, 'durationMs'),
  ))
  const simpleGateConfig = preregistration.releaseGates.simple
  const simpleGates = [
    gate('simple pair count', simplePairs.length === 12, simplePairs.length, 12),
    gate('simple score non-inferiority', available(mean(simpleScoreDifferences)) && mean(simpleScoreDifferences) >= -simpleGateConfig.scoreNonInferiorityMarginPoints, mean(simpleScoreDifferences), `>= -${simpleGateConfig.scoreNonInferiorityMarginPoints}`),
    gate('zero added model turns', turnDifferences.length > 0 && turnDifferences.every((value) => value <= simpleGateConfig.maximumAddedModelTurns), turnDifferences.length ? Math.max(...turnDifferences) : null, `<= ${simpleGateConfig.maximumAddedModelTurns}`),
    gate('median token overhead', available(median(tokenOverheads)) && median(tokenOverheads) <= simpleGateConfig.medianTokenOverheadMaximum, median(tokenOverheads), `<= ${simpleGateConfig.medianTokenOverheadMaximum}`),
    gate('p95 token overhead', available(percentile(tokenOverheads, 0.95)) && percentile(tokenOverheads, 0.95) <= simpleGateConfig.p95TokenOverheadMaximum, percentile(tokenOverheads, 0.95), `<= ${simpleGateConfig.p95TokenOverheadMaximum}`),
    gate('median duration overhead', available(median(durationOverheads)) && median(durationOverheads) <= simpleGateConfig.medianDurationOverheadMaximum, median(durationOverheads), `<= ${simpleGateConfig.medianDurationOverheadMaximum}`),
    gate('p95 duration overhead', available(percentile(durationOverheads, 0.95)) && percentile(durationOverheads, 0.95) <= simpleGateConfig.p95DurationOverheadMaximum, percentile(durationOverheads, 0.95), `<= ${simpleGateConfig.p95DurationOverheadMaximum}`),
  ]

  const icaePairs = pairRuns(runs.filter((run) => run.suite === 'icae'), resolved, 'native', 'v0.4-critical')
  const nativeHidden = icaePairs.map((pair) => metric(pair.native.result, 'hiddenFeatureScore'))
  const criticalHidden = icaePairs.map((pair) => metric(pair['v0.4-critical'].result, 'hiddenFeatureScore'))
  const hiddenDifferences = criticalHidden.map((value, index) => value - nativeHidden[index])
  const nativeMisses = icaePairs.map((pair) => metric(pair.native.result, 'criticalRequirementsMissed'))
  const criticalMisses = icaePairs.map((pair) => metric(pair['v0.4-critical'].result, 'criticalRequirementsMissed'))
  const icaeConfig = preregistration.releaseGates.icae
  const hiddenInterval = pairedBootstrapInterval(hiddenDifferences, {
    confidence: icaeConfig.pairedBootstrapConfidence,
    samples: icaeConfig.bootstrapSamples,
    seed: `${manifest.manifestDigest}:icae`,
    clusters: icaePairs.map(pair => pair.taskId),
  })
  const icaeTaskCount = new Set(icaePairs.map(pair => pair.taskId)).size
  const icaeGates = [
    gate('ICAE pair count', icaePairs.length === 12, icaePairs.length, 12),
    gate('ICAE independent task count', icaeTaskCount === 6, icaeTaskCount, 6),
    gate('ICAE relative hidden-feature uplift', available(mean(criticalHidden)) && available(mean(nativeHidden)) && mean(criticalHidden) >= mean(nativeHidden) * icaeConfig.minimumRelativeHiddenFeatureScore, mean(nativeHidden) === 0 || mean(nativeHidden) == null ? null : mean(criticalHidden) / mean(nativeHidden), `>= ${icaeConfig.minimumRelativeHiddenFeatureScore}`),
    gate('ICAE absolute hidden-feature uplift', available(mean(hiddenDifferences)) && mean(hiddenDifferences) >= icaeConfig.minimumAbsoluteHiddenFeaturePointGain, mean(hiddenDifferences), `>= ${icaeConfig.minimumAbsoluteHiddenFeaturePointGain} points`),
    gate('ICAE critical requirement miss reduction', reductionRate(criticalMisses, nativeMisses) >= icaeConfig.minimumCriticalRequirementMissReduction, reductionRate(criticalMisses, nativeMisses), `>= ${icaeConfig.minimumCriticalRequirementMissReduction}`),
    gate('ICAE paired bootstrap lower bound', hiddenInterval.lower > icaeConfig.pairedBootstrapLowerBoundMustExceed, hiddenInterval, `lower > ${icaeConfig.pairedBootstrapLowerBoundMustExceed}`),
  ]

  const evoPairs = pairRuns(runs.filter((run) => run.suite === 'evocode'), resolved, 'native', 'v0.4-lattice')
  const nativeRegressions = evoPairs.map((pair) => metric(pair.native.result, 'historicalRequirementRegressions'))
  const latticeRegressions = evoPairs.map((pair) => metric(pair['v0.4-lattice'].result, 'historicalRequirementRegressions'))
  const cumulativeDifferences = evoPairs.map((pair) => metric(pair['v0.4-lattice'].result, 'cumulativeCaseScore') - metric(pair.native.result, 'cumulativeCaseScore'))
  const questionCounts = evoPairs.map((pair) => metric(pair['v0.4-lattice'].result, 'clarificationQuestions'))
  const evoConfig = preregistration.releaseGates.evocode
  const cumulativeInterval = pairedBootstrapInterval(cumulativeDifferences, {
    confidence: evoConfig.pairedBootstrapConfidence,
    samples: evoConfig.bootstrapSamples,
    seed: `${manifest.manifestDigest}:evocode`,
    clusters: evoPairs.map(pair => pair.taskId),
  })
  const evoTaskCount = new Set(evoPairs.map(pair => pair.taskId)).size
  const evoGates = [
    gate('EvoCode pair count', evoPairs.length === 6, evoPairs.length, 6),
    gate('EvoCode independent task count', evoTaskCount === 3, evoTaskCount, 3),
    gate('historical requirement regression reduction', reductionRate(latticeRegressions, nativeRegressions) >= evoConfig.minimumHistoricalRequirementRegressionReduction, reductionRate(latticeRegressions, nativeRegressions), `>= ${evoConfig.minimumHistoricalRequirementRegressionReduction}`),
    gate('cumulative case score uplift', mean(cumulativeDifferences) > 0, mean(cumulativeDifferences), '> 0'),
    gate('EvoCode paired bootstrap lower bound', cumulativeInterval.lower > evoConfig.pairedBootstrapLowerBoundMustExceed, cumulativeInterval, `lower > ${evoConfig.pairedBootstrapLowerBoundMustExceed}`),
    gate('median clarification questions', available(median(questionCounts)) && median(questionCounts) <= evoConfig.medianClarificationQuestionsMaximum, median(questionCounts), `<= ${evoConfig.medianClarificationQuestionsMaximum}`),
    gate('maximum clarification questions', questionCounts.length > 0 && Math.max(...questionCounts) <= evoConfig.perTaskClarificationQuestionsMaximum, questionCounts.length ? Math.max(...questionCounts) : null, `<= ${evoConfig.perTaskClarificationQuestionsMaximum}`),
  ]

  const allGates = [...integrityGates, ...simpleGates, ...icaeGates, ...evoGates]
  return {
    schemaVersion: 1,
    protocolId: preregistration.protocolId,
    manifestDigest: manifest.manifestDigest,
    releaseAllowed: allGates.every((entry) => entry.passed),
    statement: allGates.every((entry) => entry.passed)
      ? 'All preregistered gates passed; release evidence may be prepared.'
      : 'Release blocked. No v0.4 uplift claim is permitted from this result set.',
    integrity: {
      retainedAttemptCount: slotState.retainedAttemptCount,
      resolvedInfrastructureSlots: 6 - evaluationSlots.infrastructure.missingRunIds.length,
      missingInfrastructureRunIds: evaluationSlots.infrastructure.missingRunIds,
      resolvedStatisticalSlots: 90 - slotState.missingRunIds.length,
      missingRunIds: slotState.missingRunIds,
      errors: slotState.errors,
      proxyAccounting,
      gates: integrityGates,
    },
    simple: { pairs: simplePairs.length, gates: simpleGates },
    icae: { pairs: icaePairs.length, independentTasks: icaeTaskCount, hiddenFeatureBootstrap: hiddenInterval, gates: icaeGates },
    evocode: { pairs: evoPairs.length, independentTasks: evoTaskCount, cumulativeCaseBootstrap: cumulativeInterval, gates: evoGates },
    armSummary: armSummary(runs, resolved),
  }
}
