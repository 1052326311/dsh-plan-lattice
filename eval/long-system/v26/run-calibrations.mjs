#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { budgetSnapshotWithinLimits, startPilotBudgetProxy } from '../../pilots/driver/budget-proxy.mjs'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { analyzeV26 } from './analysis.mjs'
import { ATTEMPT_BUDGET_TERMINAL, budgetMatchesSession, budgetTerminalEvidence } from './budget-terminal.mjs'
import { buildV26Protocol } from './protocol.mjs'
import { runV26Attempt } from './driver/evocode-runner.mjs'
import { sanitized } from './driver/runtime.mjs'
import { inspectSigningPrivateKey, writeJsonExclusive } from './freeze.mjs'
import { FROZEN_MANIFEST_PATH, readV26FrozenManifest } from './manifest.mjs'
import { preflightV26 } from './preflight.mjs'
import { verifyV26ReportFile } from './report-verifier.mjs'

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

export function validateAttemptBudget({ attemptId, result, budget }) {
  const withinLimits = budgetSnapshotWithinLimits(budget)
  const metricsMatch = budgetMatchesSession(budget, result?.metrics)
  const terminalEvidence = result?.outcome?.terminalKind === ATTEMPT_BUDGET_TERMINAL
    ? budgetTerminalEvidence(budget, attemptId, undefined)
    : null
  const recordedBudgetReceipts = result?.budgetTerminalReceipts
  const receiptEvidenceValid = terminalEvidence === null
    ? Array.isArray(recordedBudgetReceipts) && recordedBudgetReceipts.length === 0
    : Array.isArray(recordedBudgetReceipts)
      && recordedBudgetReceipts.length === 1
      && recordedBudgetReceipts[0]?.terminalId === terminalEvidence.terminalId
      && recordedBudgetReceipts[0]?.attemptId === attemptId
      && recordedBudgetReceipts[0]?.sessionId === terminalEvidence.sessionId
      && recordedBudgetReceipts[0]?.requestSequence === terminalEvidence.requestSequence
      && JSON.stringify(recordedBudgetReceipts[0]?.exhausted) === JSON.stringify(terminalEvidence.exhausted)
      && /^[0-9a-f]{64}$/.test(recordedBudgetReceipts[0]?.receiptDigest ?? '')
  const protocolValid = metricsMatch && receiptEvidenceValid && (terminalEvidence !== null
    || (withinLimits && budget?.budgetRejections === 0))
  return { withinLimits, metricsMatch, terminalEvidence, receiptEvidenceValid, protocolValid }
}

function analysisAttempt({ attemptId, arm, result, trace, budget, budgetValidation }) {
  const product = result.productGrade
  const lifecycleComplete = result.outcome?.class === 'completed'
    && product.reachedRounds === 9
    && result.processLedger.length === 2
  const scoredTerminal = result.outcome?.class === 'premature-terminal'
    && ['max-tokens', ATTEMPT_BUDGET_TERMINAL].includes(result.outcome?.terminalKind)
    && product.reachedRounds >= 1
    && result.processLedger.length >= 1
  const complete = (lifecycleComplete || scoredTerminal)
    && budgetValidation.protocolValid
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
      prematureTaskTerminals: result.metrics.prematureTaskTerminals,
      attemptBudgetTerminals: result.metrics.attemptBudgetTerminals,
    },
    trace,
    productGrade: product,
    budget,
    budgetWithinLimits: budgetValidation.withinLimits,
    budgetProtocolValid: budgetValidation.protocolValid,
    evidence: {
      outcome: result.outcome,
      rootSessionId: result.rootSessionId,
      reachedRounds: product.reachedRounds,
      processEpochs: result.processLedger.length,
      terminalOutcomes: result.terminalOutcomes,
      budgetTerminalReceipts: result.budgetTerminalReceipts,
      budgetTerminalEvidence: budgetValidation.terminalEvidence,
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
  analyze = analyzeV26,
}) {
  if (!Number.isSafeInteger(nativeRuns) || nativeRuns !== 5) {
    throw new Error('V26 requires exactly five native calibrations')
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

async function executePaidRun({ manifest, runId, runRoot, apiKey, baseURL, taskRoot, packagePath, signing }) {
  const budgetProxy = await startPilotBudgetProxy({
    apiKey,
    baseURL,
    auditPath: join(runRoot, 'budget-audit.jsonl'),
    limits: manifest.budgetPerAttempt,
  })
  const proxy = await startModelProxy({
    apiKey: budgetProxy.token,
    baseURL: budgetProxy.hostBaseURL,
    auditPath: join(runRoot, 'model-proxy-audit.jsonl'),
    signingPrivateKeyBase64: signing.privateKeyBase64,
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
  let signingHead = '0'.repeat(64)
  let signingOrdinal = 0

  async function sealAttempt(attempt) {
    const unsigned = {
      ...attempt,
      evidence: { ...(attempt.evidence ?? {}) },
    }
    const recordDigest = sha256(unsigned)
    const payload = {
      attemptId: attempt.id,
      runId,
      attempt: signingOrdinal + 1,
      signingLedgerId: proxy.signingLedgerId,
      executionEnvelopeDigest: manifest.manifestDigest,
      manifestDigest: manifest.manifestDigest,
      previousRecordDigest: signingHead,
      recordDigest,
    }
    const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`failed to seal V26 attempt ${attempt.id}`)
    const result = await response.json()
    if (typeof result?.signature !== 'string' || result.signature.length < 32) {
      throw new Error(`V26 signer omitted the signature for ${attempt.id}`)
    }
    signingOrdinal += 1
    signingHead = recordDigest
    return {
      ...unsigned,
      evidence: {
        ...unsigned.evidence,
        signing: { schemaVersion: 1, ...payload, signature: result.signature },
      },
    }
  }

  try {
    process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
    process.env.DEEPSEEK_API_KEY = proxy.token
    process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL

    const sequence = await runGatedCalibrations({
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
        const rootSessionId = `plan-lattice-v26-${runId}-${label}`
        const protocol = await buildV26Protocol(taskRoot, rootSessionId)
        await budgetProxy.activate(attemptId)
        await activateModelProxy(proxy, attemptId)
        try {
          let unsignedAttempt
          try {
            const result = await runV26Attempt({
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
              budgetSnapshot: () => budgetProxy.snapshot(),
              forbiddenReadRoots: attemptRoots.slice(0, -1),
              timeoutMsPerEpoch: manifest.model.timeoutMsPerEpoch,
            })
            const budget = budgetProxy.snapshot()
            const budgetValidation = validateAttemptBudget({ attemptId, result, budget })
            unsignedAttempt = analysisAttempt({
              attemptId,
              arm,
              result,
              trace: result.trace,
              budget,
              budgetValidation,
            })
          } catch (error) {
            unsignedAttempt = {
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
                prematureTaskTerminals: null,
                attemptBudgetTerminals: null,
              },
              trace: { valid: false, violations: [{ code: 'ATTEMPT_EXECUTION_FAILED' }] },
              failure: sanitized(String(error?.message ?? error), [apiKey, budgetProxy.token, proxy.token]),
            }
          }
          const sealed = await sealAttempt(unsignedAttempt)
          if (sealed.status === 'failed') {
            await writeJsonExclusive(join(attemptDir, 'attempt-failure.json'), sealed)
          }
          return sealed
        } finally {
          try { await activateModelProxy(proxy, null) } catch {}
        }
      },
    })
    return {
      sequence,
      signing: {
        publicKeyBase64: proxy.signingPublicKeyBase64,
        ledgerId: proxy.signingLedgerId,
        head: signingHead,
        records: signingOrdinal,
      },
    }
  } finally {
    restoreEnvironment(previous)
    proxy.server.closeAllConnections?.()
    if (proxy.server.listening) await new Promise(resolveClose => proxy.server.close(resolveClose))
    await budgetProxy.close()
  }
}

export async function runV26Calibrations({
  manifestPath = FROZEN_MANIFEST_PATH,
  env = process.env,
  runId = `v26-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`,
} = {}) {
  safeRunId(runId)
  const manifest = await readV26FrozenManifest(manifestPath)
  const preflight = await preflightV26({ manifestPath, env })
  if (!preflight.readyForNative || preflight.manifestDigest !== manifest.manifestDigest) {
    throw new Error('V26 preflight did not authorize native calibration')
  }
  const apiKey = env.DEEPSEEK_API_KEY
  const baseURL = env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  const outputRoot = resolve(env[manifest.outputPolicy.rootEnvironmentVariable])
  const signing = await inspectSigningPrivateKey(
    env[manifest.evidenceSigning.privateKeyPathEnvironmentVariable],
  )
  if (signing.publicKeyBase64 !== manifest.evidenceSigning.publicKeyBase64
    || signing.publicKeySha256 !== manifest.evidenceSigning.publicKeySha256) {
    throw new Error('V26 runtime signing key does not match the frozen manifest')
  }
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
    evidenceSigningPublicKeySha256: manifest.evidenceSigning.publicKeySha256,
    startedAt: new Date().toISOString(),
  })

  const execution = await executePaidRun({
    manifest,
    runId,
    runRoot,
    apiKey,
    baseURL,
    taskRoot: resolve(env[manifest.task.rootPathEnvironmentVariable]),
    packagePath: resolve(env[manifest.candidate.packagePathEnvironmentVariable]),
    signing,
  })
  const { sequence } = execution
  const body = {
    schemaVersion: 1,
    runId,
    protocolId: manifest.protocolId,
    frozenManifestDigest: manifest.manifestDigest,
    completedAt: new Date().toISOString(),
    candidateExecuted: sequence.candidateExecuted,
    signing: execution.signing,
    attempts: sequence.attempts,
    qualification: sequence.qualification,
    analysis: sequence.analysis,
  }
  const report = { ...body, reportDigest: sha256(body) }
  const reportPath = join(runRoot, 'final-report.json')
  await writeJsonExclusive(reportPath, report)
  const verifiedAnalysis = await verifyV26ReportFile({ reportPath, manifestPath })
  return { runRoot, report, verifiedAnalysis }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const result = await runV26Calibrations({ runId: option('--run-id') })
  process.stdout.write(canonicalJson(result.report))
  if (!result.verifiedAnalysis.releaseAllowed) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
