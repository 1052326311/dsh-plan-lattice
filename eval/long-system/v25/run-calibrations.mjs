#!/usr/bin/env node

import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { budgetSnapshotWithinLimits, startPilotBudgetProxy } from '../../pilots/driver/budget-proxy.mjs'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { analyzeV25 } from './analysis.mjs'
import { buildV25Protocol } from './protocol.mjs'
import { runV25Attempt } from './driver/evocode-runner.mjs'
import { sanitized } from './driver/runtime.mjs'
import { writeJsonExclusive } from './freeze.mjs'
import { FROZEN_MANIFEST_PATH, readV25FrozenManifest } from './manifest.mjs'
import { preflightV25 } from './preflight.mjs'

function safeRunId(value) {
  if (!/^[a-z0-9][a-z0-9._-]{7,47}$/.test(value ?? '')) {
    throw new Error('run ID must contain 8-48 lowercase letters, digits, dots, underscores, or hyphens')
  }
  return value
}

async function activateModelProxy(proxy, attemptId) {
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify({ attemptId }),
  })
  if (!response.ok) throw new Error(`failed to bind model proxy to ${String(attemptId)}`)
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function hardMisses(productGrade) {
  return productGrade.rounds.filter(round => round.reward !== 1).length
}

function analysisAttempt({ attemptId, arm, result, trace, budget, budgetValid }) {
  const product = result.productGrade
  const lifecycleComplete = result.outcome?.class === 'completed'
    && product.reachedRounds === 9
    && result.processLedger.length === 2
  const scoredTerminal = result.outcome?.class === 'product-terminal'
    && result.outcome?.terminalKind === 'max-tokens'
    && product.reachedRounds >= 1
    && result.processLedger.length >= 1
  const complete = (lifecycleComplete || scoredTerminal)
    && budgetValid
  return {
    id: attemptId,
    arm,
    status: complete ? 'completed' : 'failed',
    metrics: {
      score: product.rewardScore,
      cumulativeCaseScore: product.cumulativeCaseScore,
      historicalRequirementRegressions: product.historicalRequirementRegressions,
      hardRequirementsMissed: hardMisses(product),
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      modelTurns: result.metrics.modelTurns,
      maxTokenProductTerminals: result.metrics.maxTokenProductTerminals,
    },
    trace,
    productGrade: product,
    budget,
    budgetWithinLimits: budgetValid,
    evidence: {
      outcome: result.outcome,
      rootSessionId: result.rootSessionId,
      reachedRounds: product.reachedRounds,
      processEpochs: result.processLedger.length,
      terminalOutcomes: result.terminalOutcomes,
      taskDigests: Object.fromEntries(Object.entries(result.taskIdentity.digests)
        .map(([name, identity]) => [name, identity.sha256])),
      dockerImage: result.dockerImage,
      pluginIdentity: result.pluginIdentity,
      rawAttemptSha256: sha256(result),
    },
  }
}

export async function runGatedCalibrations({
  protocolId,
  nativeRuns = 5,
  executeAttempt,
  writeCheckpoint = async () => {},
  analyze = analyzeV25,
}) {
  if (!Number.isSafeInteger(nativeRuns) || nativeRuns !== 5) {
    throw new Error('V25 requires exactly five native calibrations')
  }
  if (typeof executeAttempt !== 'function') throw new Error('executeAttempt is required')
  const attempts = []
  for (let ordinal = 1; ordinal <= nativeRuns; ordinal += 1) {
    const attempt = await executeAttempt({ arm: 'native', ordinal })
    attempts.push(attempt)
    await writeCheckpoint(`native-${ordinal}.json`, attempt)
    if (attempt?.status !== 'completed') break
  }

  const qualification = analyze({ protocolId, attempts })
  await writeCheckpoint('native-qualification.json', qualification)
  if (!qualification.candidateExecutionAllowed) {
    return { attempts, qualification, analysis: qualification, candidateExecuted: false }
  }

  const candidate = await executeAttempt({ arm: 'v0.4-native-continuity', ordinal: 1 })
  attempts.push(candidate)
  await writeCheckpoint('candidate.json', candidate)
  const analysis = analyze({ protocolId, attempts })
  await writeCheckpoint('candidate-analysis.json', analysis)
  return { attempts, qualification, analysis, candidateExecuted: true }
}

async function executePaidRun({ manifest, runId, runRoot, apiKey, baseURL, taskRoot, packagePath }) {
  const budgetProxy = await startPilotBudgetProxy({
    apiKey,
    baseURL,
    auditPath: join(runRoot, 'budget-audit.jsonl'),
    limits: manifest.budgetPerAttempt,
  })
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: budgetProxy.token,
    baseURL: budgetProxy.hostBaseURL,
    auditPath: join(runRoot, 'model-proxy-audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(runRoot, 'signing-ledger.jsonl'),
    signingLedgerId: `${manifest.protocolId}.${runId}`,
    executionEnvelopeDigest: manifest.manifestDigest,
    host: '127.0.0.1',
  })
  const previous = Object.fromEntries([
    'PLAN_LATTICE_CREDENTIAL_PROXY',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
  ].map(name => [name, process.env[name]]))
  const attemptRoots = []

  try {
    process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
    process.env.DEEPSEEK_API_KEY = proxy.token
    process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL

    return await runGatedCalibrations({
      protocolId: manifest.protocolId,
      nativeRuns: manifest.calibration.nativeRuns,
      writeCheckpoint: (name, value) => writeJsonExclusive(join(runRoot, name), value),
      async executeAttempt({ arm, ordinal }) {
        const label = arm === 'native' ? `native-${ordinal}` : 'candidate'
        const attemptId = `${runId}-${label}`
        const attemptDir = join(runRoot, 'attempts', label)
        await mkdir(attemptDir, { recursive: false, mode: 0o700 })
        attemptRoots.push(attemptDir)
        const workspace = join(attemptDir, 'workspace')
        await cp(join(taskRoot, 'environment', 'app-starter'), workspace, {
          recursive: true,
          force: false,
          errorOnExist: true,
        })
        const rootSessionId = `plan-lattice-v25-${runId}-${label}`
        const protocol = await buildV25Protocol(taskRoot, rootSessionId)
        await budgetProxy.activate(attemptId)
        await activateModelProxy(proxy, attemptId)
        try {
          const result = await runV25Attempt({
            runtimeArtifacts: {
              hostHarness: {
                pathEnvironmentVariable: manifest.harness.runtimePathEnvironmentVariable,
                sha256: manifest.harness.runtimeSha256,
              },
            },
            harnessCommit: manifest.harness.commit,
            taskRoot,
            dockerImage: manifest.image.reference,
            protocol,
            attemptDir,
            workspace,
            arm: arm === 'native' ? manifest.arms.native : manifest.arms.candidate,
            attemptId,
            pluginCommit: arm === 'native' ? undefined : manifest.candidate.commit,
            pluginPackagePath: arm === 'native' ? undefined : packagePath,
            pluginPackageDigest: arm === 'native' ? undefined : manifest.candidate.tarballSha256,
            forbiddenReadRoots: attemptRoots.slice(0, -1),
            timeoutMsPerEpoch: manifest.model.timeoutMsPerEpoch,
          })
          const budget = budgetProxy.snapshot()
          const budgetValid = budgetSnapshotWithinLimits(budget)
            && budget.agentRequests === result.metrics.modelTurns
            && budget.inputTokens === result.metrics.inputTokens
            && budget.outputTokens === result.metrics.outputTokens
          return analysisAttempt({ attemptId, arm, result, trace: result.trace, budget, budgetValid })
        } catch (error) {
          const failure = {
            id: attemptId,
            arm,
            status: 'failed',
            metrics: {
              score: null,
              cumulativeCaseScore: null,
              historicalRequirementRegressions: null,
              hardRequirementsMissed: null,
              inputTokens: null,
              maxTokenProductTerminals: null,
            },
            trace: { valid: false, violations: [{ code: 'ATTEMPT_EXECUTION_FAILED' }] },
            failure: sanitized(String(error?.message ?? error), [apiKey, budgetProxy.token, proxy.token]),
          }
          await writeJsonExclusive(join(attemptDir, 'attempt-failure.json'), failure)
          return failure
        } finally {
          try { await activateModelProxy(proxy, null) } catch {}
        }
      },
    })
  } finally {
    restoreEnvironment(previous)
    proxy.server.closeAllConnections?.()
    if (proxy.server.listening) await new Promise(resolveClose => proxy.server.close(resolveClose))
    await budgetProxy.close()
  }
}

export async function runV25Calibrations({
  manifestPath = FROZEN_MANIFEST_PATH,
  env = process.env,
  runId = `v25-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`,
} = {}) {
  safeRunId(runId)
  const manifest = await readV25FrozenManifest(manifestPath)
  const preflight = await preflightV25({ manifestPath, env })
  if (!preflight.readyForNative || preflight.manifestDigest !== manifest.manifestDigest) {
    throw new Error('V25 preflight did not authorize native calibration')
  }
  const apiKey = env.DEEPSEEK_API_KEY
  const baseURL = env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  const outputRoot = resolve(env[manifest.outputPolicy.rootEnvironmentVariable])
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  const runRoot = join(outputRoot, runId)
  await mkdir(runRoot, { recursive: false, mode: 0o700 })
  await mkdir(join(runRoot, 'attempts'), { recursive: false, mode: 0o700 })
  await writeJsonExclusive(join(runRoot, 'run-envelope.json'), {
    schemaVersion: 1,
    runId,
    protocolId: manifest.protocolId,
    manifestDigest: manifest.manifestDigest,
    harnessCommit: manifest.harness.commit,
    candidateCommit: manifest.candidate.commit,
    taskDatasetCommit: manifest.task.datasetCommit,
    taskDigests: manifest.task.digests,
    image: manifest.image,
    startedAt: new Date().toISOString(),
  })

  const sequence = await executePaidRun({
    manifest,
    runId,
    runRoot,
    apiKey,
    baseURL,
    taskRoot: resolve(env[manifest.task.rootPathEnvironmentVariable]),
    packagePath: resolve(env[manifest.candidate.packagePathEnvironmentVariable]),
  })
  const body = {
    schemaVersion: 1,
    runId,
    protocolId: manifest.protocolId,
    frozenManifestDigest: manifest.manifestDigest,
    completedAt: new Date().toISOString(),
    candidateExecuted: sequence.candidateExecuted,
    attempts: sequence.attempts,
    qualification: sequence.qualification,
    analysis: sequence.analysis,
  }
  const report = { ...body, reportDigest: sha256(body) }
  await writeJsonExclusive(join(runRoot, 'final-report.json'), report)
  return { runRoot, report }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const result = await runV25Calibrations({ runId: option('--run-id') })
  process.stdout.write(canonicalJson(result.report))
  if (!result.report.analysis.releaseAllowed) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
