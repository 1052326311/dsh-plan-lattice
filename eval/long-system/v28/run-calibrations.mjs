#!/usr/bin/env node

import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { budgetSnapshotWithinLimits, startPilotBudgetProxy } from '../../pilots/driver/budget-proxy.mjs'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { analyzeV28, V28_EXECUTION_PLAN } from './analysis.mjs'
import {
  ATTEMPT_BUDGET_TERMINAL,
  budgetMatchesSession,
  budgetTerminalEvidence,
  retainedResponseBudgetCrossing,
} from './budget-terminal.mjs'
import { buildV28Protocol } from './protocol.mjs'
import {
  candidateActivationProven,
  runV28Attempt,
  validateCandidateActivations,
} from './driver/evocode-runner.mjs'
import { sanitized } from './driver/runtime.mjs'
import { inspectSigningPrivateKey, writeJsonExclusive } from './freeze.mjs'
import { FROZEN_MANIFEST_PATH, readV28FrozenManifest } from './manifest.mjs'
import { preflightV28 } from './preflight.mjs'
import { finalizeV28ReportFile } from './report-verifier.mjs'
import {
  inspectV28ExecutionSnapshot,
  materializeV28ExecutionSnapshot,
} from './execution-snapshot.mjs'

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
  const retainedFinalCrossing = result?.outcome?.class === 'completed'
    && result?.outcome?.terminalKind === 'completed'
    && result?.productGrade?.reachedRounds === 9
    && result?.processLedger?.length === 2
    ? retainedResponseBudgetCrossing(budget)
    : null
  const receiptEvidenceValid = terminalEvidence === null
    ? Array.isArray(recordedBudgetReceipts) && recordedBudgetReceipts.length === 0
    : Array.isArray(recordedBudgetReceipts)
      && recordedBudgetReceipts.length === 1
      && recordedBudgetReceipts[0]?.terminalId === terminalEvidence.terminalId
      && recordedBudgetReceipts[0]?.attemptId === attemptId
      && recordedBudgetReceipts[0]?.sessionId === terminalEvidence.sessionId
      && recordedBudgetReceipts[0]?.requestSequence === terminalEvidence.requestSequence
      && canonicalJson(recordedBudgetReceipts[0]?.exhausted) === canonicalJson(terminalEvidence.exhausted)
      && /^[0-9a-f]{64}$/.test(recordedBudgetReceipts[0]?.receiptDigest ?? '')
  const protocolValid = metricsMatch && receiptEvidenceValid && (terminalEvidence !== null
    || (withinLimits && budget?.budgetRejections === 0)
    || retainedFinalCrossing !== null)
  return {
    withinLimits,
    metricsMatch,
    terminalEvidence,
    retainedFinalCrossing,
    receiptEvidenceValid,
    protocolValid,
  }
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
  let activationValid = Array.isArray(result.candidateActivations)
    && result.candidateActivations.length === 0
  if (arm === 'v0.4-native-continuity') {
    try {
      validateCandidateActivations(result.candidateActivations, {
        attemptId,
        processLedger: result.processLedger,
      })
      activationValid = true
    } catch {
      activationValid = false
    }
  }
  const complete = (lifecycleComplete || scoredTerminal)
    && budgetValidation.protocolValid
    && activationValid
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
      candidateActivations: result.candidateActivations,
      rawAttemptSha256: sha256(result),
    },
  }
}

export async function runComparativeTrial({
  protocolId,
  executeAttempt,
  writeCheckpoint = async () => {},
  recordFatal = async () => {},
  analyze = analyzeV28,
}) {
  if (typeof executeAttempt !== 'function') throw new Error('executeAttempt is required')
  const attempts = []
  for (const slot of V28_EXECUTION_PLAN) {
    let attempt
    try {
      attempt = await executeAttempt({ ...slot, ordinal: slot.pair })
    } catch (error) {
      await recordFatal({ phase: 'attempt-terminalization', slot, error })
      throw error
    }
    attempts.push(attempt)
    try {
      await writeCheckpoint(`${slot.label}.json`, attempt)
    } catch (error) {
      await recordFatal({ phase: 'checkpoint-persistence', slot, error })
      throw error
    }
    if (attempt?.status !== 'completed') break
  }

  const analysis = analyze({ protocolId, attempts })
  await writeCheckpoint('trial-analysis.json', analysis)
  return {
    attempts,
    qualification: analysis.qualification,
    analysis,
    candidateExecuted: attempts.some(candidateActivationProven),
  }
}

export const runGatedCalibrations = runComparativeTrial

export async function executeStartedSlot({
  attemptId,
  arm,
  prepare,
  execute,
  seal,
}) {
  await prepare()
  const unsigned = await execute()
  if (unsigned?.status !== 'completed') {
    throw new Error(`V28 slot ${attemptId} produced an infrastructure-invalid result`)
  }
  return seal(unsigned)
}

export function attachV28AttemptSignature({ attempt, body, signaturePayloadDigest, signature }) {
  if (body?.schemaVersion !== 3
    || signaturePayloadDigest !== sha256(canonicalJson(body))
    || typeof signature !== 'string'
    || signature.length < 32) {
    throw new Error('V28 attempt signature is not a complete schema-v3 envelope')
  }
  return {
    ...attempt,
    evidence: {
      ...(attempt.evidence ?? {}),
      signing: {
        schemaVersion: 3,
        body,
        signaturePayloadDigest,
        signature,
      },
    },
  }
}

export async function persistFatalTrialRecord({
  outputRoot,
  runId,
  manifest,
  phase,
  error,
  secrets = [],
  manifestCommit,
  writer = writeJsonExclusive,
}) {
  if (!/^[0-9a-f]{40}$/u.test(manifestCommit ?? '')) {
    throw new Error('V28 fatal record requires the exact public manifest commit')
  }
  const body = {
    schemaVersion: 2,
    status: 'inconclusive',
    runId,
    protocolId: manifest.protocolId,
    manifestDigest: manifest.manifestDigest,
    manifestCommit,
    phase,
    failure: sanitized(String(error?.message ?? error), secrets),
    recordedAt: new Date().toISOString(),
    replacementAllowed: false,
    rerunAllowed: false,
  }
  const record = { ...body, fatalRecordDigest: sha256(body) }
  const path = join(outputRoot, `v28-trial-fatal-${manifest.manifestDigest}.json`)
  await writer(path, record)
  return record
}

export async function claimV28Trial({
  outputRoot,
  runId,
  manifest,
  manifestCommit,
  writer = writeJsonExclusive,
}) {
  if (resolve(outputRoot) !== manifest.outputPolicy?.absoluteRoot
    || runId !== manifest.trial?.runId) {
    throw new Error('V28 claim must use the unique output root and run ID frozen in the manifest')
  }
  if (!/^[0-9a-f]{40}$/u.test(manifestCommit ?? '')) {
    throw new Error('V28 claim requires the exact public manifest commit')
  }
  const body = {
    schemaVersion: 2,
    runId,
    protocolId: manifest.protocolId,
    manifestDigest: manifest.manifestDigest,
    manifestCommit,
    claimedAt: new Date().toISOString(),
    replacementAllowed: false,
    rerunAllowed: false,
  }
  const claim = { ...body, trialClaimDigest: sha256(body) }
  const path = join(outputRoot, `v28-trial-claim-${manifest.manifestDigest}.json`)
  await writer(path, claim)
  return { path, claim }
}

async function executePaidRun({
  manifest,
  runId,
  runRoot,
  executionEnvelopeDigest,
  apiKey,
  baseURL,
  taskRoot,
  packagePath,
  runtimePath,
  driverSourceRoot,
  executionSnapshotRoot,
  signing,
  manifestCommit,
}) {
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
    executionEnvelopeDigest,
    signingSchemaVersion: 3,
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
    const body = {
      schemaVersion: 3,
      attemptId: attempt.id,
      runId,
      ordinal: signingOrdinal + 1,
      signingLedgerId: proxy.signingLedgerId,
      executionEnvelopeDigest,
      manifestDigest: manifest.manifestDigest,
      manifestCommit,
      previousRecordDigest: signingHead,
      recordDigest,
    }
    const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`failed to seal V28 attempt ${attempt.id}`)
    const result = await response.json()
    const signaturePayloadDigest = sha256(canonicalJson(body))
    if (result?.signaturePayloadDigest !== signaturePayloadDigest
      || typeof result?.signature !== 'string'
      || result.signature.length < 32) {
      throw new Error(`V28 signer omitted the signature for ${attempt.id}`)
    }
    signingOrdinal += 1
    signingHead = signaturePayloadDigest
    return attachV28AttemptSignature({
      attempt: unsigned,
      body,
      signaturePayloadDigest,
      signature: result.signature,
    })
  }

  try {
    process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
    process.env.DEEPSEEK_API_KEY = proxy.token
    process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL

    const sequence = await runComparativeTrial({
      protocolId: manifest.protocolId,
      writeCheckpoint: (name, value) => writeJsonExclusive(join(runRoot, name), value),
      async executeAttempt({ arm, ordinal, label }) {
        const attemptId = `${runId}-${label}`
        const attemptDir = join(runRoot, 'attempts', label)
        const workspace = join(attemptDir, 'workspace')
        let protocol
        let slotStarted
        try {
          return await executeStartedSlot({
            attemptId,
            arm,
            async prepare() {
              await mkdir(attemptDir, { recursive: false, mode: 0o700 })
              attemptRoots.push(attemptDir)
              const slotBody = {
                schemaVersion: 2,
                attemptId,
                runId,
                protocolId: manifest.protocolId,
                manifestDigest: manifest.manifestDigest,
                manifestCommit,
                label,
                arm,
                ordinal,
                startedAt: new Date().toISOString(),
              }
              slotStarted = { ...slotBody, slotStartedDigest: sha256(slotBody) }
              await writeJsonExclusive(join(attemptDir, 'slot-started.json'), slotStarted)
              await cp(join(taskRoot, 'environment', 'app-starter'), workspace, {
                recursive: true,
                force: false,
                errorOnExist: true,
              })
              const rootSessionId = `plan-lattice-v28-${runId}-${label}`
              protocol = await buildV28Protocol(taskRoot, rootSessionId)
              await budgetProxy.activate(attemptId)
              await activateModelProxy(proxy, attemptId)
            },
            async execute() {
            const result = await runV28Attempt({
              runtimeArtifacts: {
                hostHarness: {
                  path: runtimePath,
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
              driverSourceRoot,
              budgetSnapshot: () => budgetProxy.snapshot(),
              forbiddenReadRoots: [executionSnapshotRoot, ...attemptRoots.slice(0, -1)],
              timeoutMsPerEpoch: manifest.model.timeoutMsPerEpoch,
            })
            const budget = budgetProxy.snapshot()
            const budgetValidation = validateAttemptBudget({ attemptId, result, budget })
              const analyzed = analysisAttempt({
              attemptId,
              arm,
              result,
              trace: result.trace,
              budget,
              budgetValidation,
            })
              analyzed.evidence.slotStartedDigest = slotStarted.slotStartedDigest
              return analyzed
            },
            seal: sealAttempt,
            failureEvidence: () => slotStarted
              ? { slotStartedDigest: slotStarted.slotStartedDigest }
              : {},
            async writeFailure(failed) {
              if (!slotStarted) throw new Error('V28 slot failed before its durable start record')
              await writeJsonExclusive(join(attemptDir, 'attempt-failure.json'), failed)
            },
            sanitizeFailure: error => sanitized(
              String(error?.message ?? error),
              [apiKey, budgetProxy.token, proxy.token],
            ),
          })
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

export async function runV28Calibrations({
  manifestPath = FROZEN_MANIFEST_PATH,
  env = process.env,
  runId,
} = {}) {
  const manifest = await readV28FrozenManifest(manifestPath)
  const effectiveRunId = runId ?? manifest.trial.runId
  safeRunId(effectiveRunId)
  if (effectiveRunId !== manifest.trial.runId) {
    throw new Error('V28 run ID differs from the one frozen before execution')
  }
  const preflight = await preflightV28({ manifestPath, env })
  if (!preflight.readyForTrial || preflight.manifestDigest !== manifest.manifestDigest) {
    throw new Error('V28 preflight did not authorize the paired trial')
  }
  const apiKey = env.DEEPSEEK_API_KEY
  const baseURL = preflight.modelEndpoint
  if (baseURL !== manifest.model.upstreamBaseUrl
    || preflight.modelEndpointSha256 !== manifest.model.upstreamBaseUrlSha256) {
    throw new Error('V28 preflight did not bind the frozen DeepSeek endpoint')
  }
  const outputRoot = resolve(env[manifest.outputPolicy.rootEnvironmentVariable])
  if (outputRoot !== manifest.outputPolicy.absoluteRoot) {
    throw new Error('V28 output root differs from the unique root frozen before execution')
  }
  const manifestCommit = preflight.manifestCommit
  const signing = await inspectSigningPrivateKey(
    env[manifest.evidenceSigning.privateKeyPathEnvironmentVariable],
  )
  if (signing.publicKeyBase64 !== manifest.evidenceSigning.publicKeyBase64
    || signing.publicKeySha256 !== manifest.evidenceSigning.publicKeySha256) {
    throw new Error('V28 runtime signing key does not match the frozen manifest')
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  const previousManifestCommit = process.env[manifest.publicationAnchor.commitEnvironmentVariable]
  process.env[manifest.publicationAnchor.commitEnvironmentVariable] = manifestCommit
  const runRoot = join(outputRoot, effectiveRunId)
  let stagedSnapshotRoot
  let trialClaimed = false
  try {
    stagedSnapshotRoot = await mkdtemp(join(outputRoot, '.v28-input-snapshot-'))
    await materializeV28ExecutionSnapshot({
      root: stagedSnapshotRoot,
      manifest,
      env,
    })
    await claimV28Trial({ outputRoot, runId: effectiveRunId, manifest, manifestCommit })
    trialClaimed = true
    await mkdir(runRoot, { recursive: false, mode: 0o700 })
    await mkdir(join(runRoot, 'attempts'), { recursive: false, mode: 0o700 })
    const executionSnapshotRoot = join(runRoot, 'input-snapshot')
    await rename(stagedSnapshotRoot, executionSnapshotRoot)
    stagedSnapshotRoot = undefined
    const executionSnapshot = await inspectV28ExecutionSnapshot(
      executionSnapshotRoot,
      manifest,
      { verifyDriverCommit: false },
    )
    const runEnvelopeBody = {
      schemaVersion: 3,
      runId: effectiveRunId,
      protocolId: manifest.protocolId,
      manifestDigest: manifest.manifestDigest,
      manifestCommit,
      harnessCommit: manifest.harness.commit,
      candidateCommit: manifest.candidate.commit,
      taskDatasetCommit: manifest.task.datasetCommit,
      taskDigests: manifest.task.digests,
      image: manifest.image,
      upstreamBaseUrl: baseURL,
      upstreamBaseUrlSha256: preflight.modelEndpointSha256,
      evidenceSigningPublicKeySha256: manifest.evidenceSigning.publicKeySha256,
      executionSnapshot: {
        relativePath: 'input-snapshot',
        identity: executionSnapshot.identity,
        identityDigest: executionSnapshot.identityDigest,
      },
      startedAt: new Date().toISOString(),
    }
    const executionEnvelopeDigest = sha256(runEnvelopeBody)
    await writeJsonExclusive(join(runRoot, 'run-envelope.json'), {
      ...runEnvelopeBody,
      executionEnvelopeDigest,
    })
    const execution = await executePaidRun({
      manifest,
      runId: effectiveRunId,
      runRoot,
      executionEnvelopeDigest,
      apiKey,
      baseURL,
      taskRoot: executionSnapshot.paths.task,
      packagePath: executionSnapshot.paths.candidate,
      runtimePath: executionSnapshot.paths.harness,
      driverSourceRoot: executionSnapshot.paths.driver,
      executionSnapshotRoot,
      signing,
      manifestCommit,
    })
    const { sequence } = execution
    const body = {
      schemaVersion: 3,
      runId: effectiveRunId,
      protocolId: manifest.protocolId,
      frozenManifestDigest: manifest.manifestDigest,
      manifestCommit,
      executionEnvelopeDigest,
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
    const verifiedAnalysis = await finalizeV28ReportFile({
      reportPath,
      manifestPath,
      runtimePath: executionSnapshot.paths.harness,
      candidatePath: executionSnapshot.paths.candidate,
      signingPrivateKeyBase64: signing.privateKeyBase64,
    })
    return { runRoot, report, verifiedAnalysis }
  } catch (error) {
    if (trialClaimed) {
      try {
        await persistFatalTrialRecord({
          outputRoot,
          runId: effectiveRunId,
          manifest,
          phase: 'paid-trial-or-finalization',
          error,
          secrets: [apiKey],
          manifestCommit,
        })
      } catch (fatalError) {
        if (fatalError?.code !== 'EEXIST') {
          throw new AggregateError([error, fatalError], 'V28 failed and could not persist its fatal trial record')
        }
      }
    }
    throw error
  } finally {
    if (stagedSnapshotRoot !== undefined) {
      await rm(stagedSnapshotRoot, { recursive: true, force: true })
    }
    if (previousManifestCommit === undefined) delete process.env[manifest.publicationAnchor.commitEnvironmentVariable]
    else process.env[manifest.publicationAnchor.commitEnvironmentVariable] = previousManifestCommit
  }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const result = await runV28Calibrations({ runId: option('--run-id') })
  process.stdout.write(canonicalJson(result.report))
  if (!result.verifiedAnalysis.releaseAllowed) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
