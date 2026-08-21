import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { configureProfile } from '../../../v0.4/driver/lib/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../../v0.4/driver/lib/environment.mjs'
import { requireProxyCapabilities } from '../../../v0.4/driver/lib/proxy-capability.mjs'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import { inspectEvoCodeTask, runOfficialRoundInDocker, summarizeOfficialRounds } from '../benchmark.mjs'
import { ATTEMPT_BUDGET_TERMINAL, budgetTerminalEvidenceSince } from '../budget-terminal.mjs'
import {
  digestTree,
  materializeFrozenHarnessRuntime,
  materializeLongSystemWrapper,
  repositoryRoot,
  sanitized,
  verifyInstalledCandidate,
} from './runtime.mjs'
import { gradeV26Trace } from '../trace-grader.mjs'
import { countClarificationQuestions, parseSessionMetrics } from './session-metrics.mjs'

const MARKER = '@@PLAN_LATTICE_V26@@'
const driverRoot = dirname(fileURLToPath(import.meta.url))

function quoteSandbox(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function commandForSandbox(dshBin, forbiddenReadRoots, workspace, prompt) {
  if (process.platform !== 'darwin') throw new Error('V26 host execution currently requires Darwin sandbox-exec')
  const workspaceRoot = resolve(workspace)
  const roots = [...new Set([repositoryRoot, ...forbiddenReadRoots].map(path => resolve(path)))]
  if (roots.some(path => workspaceRoot === path || workspaceRoot.startsWith(`${path}/`))) {
    throw new Error('sandbox forbidden roots must not contain the agent workspace')
  }
  const profile = `(version 1)\n(allow default)\n${roots.map(path => `(deny file-read* (subpath "${quoteSandbox(path)}"))\n(deny file-write* (subpath "${quoteSandbox(path)}"))`).join('\n')}\n`
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, process.execPath, dshBin, '--profile', 'headless', prompt],
  }
}

function appendBuffer(target, chunk, state, stream, maxBuffer) {
  const bytes = Buffer.byteLength(chunk)
  state[stream] += bytes
  if (state[stream] > maxBuffer) throw new Error(`${stream} exceeded maxBuffer`)
  target.push(Buffer.from(chunk))
}

function writeChildLine(child, value) {
  return new Promise((resolveWrite, rejectWrite) => {
    child.stdin.write(`${JSON.stringify(value)}\n`, error => {
      if (error) rejectWrite(error)
      else resolveWrite()
    })
  })
}

export async function writeReceiptExclusive(path, body, openFile = open, openDirectory = open) {
  const receipt = { ...body, receiptDigest: sha256(body) }
  const handle = await openFile(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const directory = await openDirectory(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  return receipt
}

function assertStageMarker(value, markerType, stage, expectedEpoch, expectedSessionId) {
  if (value?.type !== markerType
    || value.epoch !== expectedEpoch
    || value.stageId !== stage?.id
    || value.stageIndex !== stage?.index
    || value.kind !== stage?.kind
    || value.revision !== stage?.revision
    || value.sessionId !== expectedSessionId) {
    throw new Error(`${markerType} marker does not match the frozen stage ${String(stage?.id)}`)
  }
}

export async function handleV26StageComplete({
  value,
  stage,
  expectedEpoch,
  attemptId,
  sessionId,
  budgetSnapshot,
  budgetBeforeSnapshot,
  auditBeforeSha256,
  workspace,
  taskRoot,
  dockerImage,
  verifierTempRoot,
  receiptPath,
  hiddenAssetsSha256,
  gradeRound = runOfficialRoundInDocker,
  digestWorkspace = digestTree,
  writeReceipt = writeReceiptExclusive,
}) {
  assertStageMarker(value, 'stage-complete', stage, expectedEpoch, sessionId)
  const observed = value.observedTurnReason
  const currentBudget = typeof budgetSnapshot === 'function' ? budgetSnapshot() : budgetSnapshot
  let terminalBudgetEvidence
  let effectiveTerminal
  const freshBudgetTerminalEvidence = budgetTerminalEvidenceSince(
    currentBudget,
    budgetBeforeSnapshot,
    attemptId,
  )
  if (freshBudgetTerminalEvidence !== null) {
    terminalBudgetEvidence = freshBudgetTerminalEvidence
    effectiveTerminal = { kind: ATTEMPT_BUDGET_TERMINAL }
  } else if (observed?.kind === 'completed' || observed?.kind === 'max-tokens') {
    effectiveTerminal = observed
  } else {
    throw new Error('Harness ended without a host-authenticated scoreable terminal')
  }

  const decision = effectiveTerminal.kind === 'completed' ? 'continue' : 'terminal'
  let receipt = null
  if (stage.kind === 'audit') {
    if (!/^[0-9a-f]{64}$/.test(auditBeforeSha256 ?? '')) {
      throw new Error(`audit stage ${stage.id} has no authenticated start digest`)
    }
    const after = await digestWorkspace(workspace)
    if (auditBeforeSha256 !== after) throw new Error('foreground audit mutated the product workspace')
  } else {
    const workspaceSha256 = await digestWorkspace(workspace)
    const grade = await gradeRound({
      taskRoot,
      workspaceRoot: workspace,
      round: stage.productRound,
      image: dockerImage,
      verifierTempRoot,
    })
    const afterGradeSha256 = await digestWorkspace(workspace)
    if (afterGradeSha256 !== workspaceSha256) {
      throw new Error(`official verifier mutated the product workspace after ${stage.id}`)
    }
    receipt = await writeReceipt(receiptPath, {
      ...grade,
      stageId: stage.id,
      revision: stage.revision,
      workspaceSha256,
      hiddenAssetsSha256,
      observedTurnReasonKind: observed?.kind ?? null,
      effectiveTerminal,
      ...(terminalBudgetEvidence === undefined ? {} : { terminalBudgetEvidence }),
    })
  }

  return {
    acknowledgement: {
      revision: stage.revision,
      decision,
      continue: decision === 'continue',
      effectiveTerminal,
      receiptDigest: receipt?.receiptDigest ?? null,
      budgetTerminalId: terminalBudgetEvidence?.terminalId ?? null,
    },
    receipt,
    terminalBudgetEvidence,
  }
}

export async function handleV26AttemptAbort({
  value,
  stage,
  expectedEpoch,
  attemptId,
  sessionId,
  budgetSnapshot,
  budgetBeforeSnapshot,
  priorAcknowledgement,
  auditBeforeSha256,
  workspace,
  taskRoot,
  dockerImage,
  verifierTempRoot,
  productReceiptPath,
  terminalReceiptPath,
  hiddenAssetsSha256,
  gradeRound = runOfficialRoundInDocker,
  digestWorkspace = digestTree,
  writeReceipt = writeReceiptExclusive,
}) {
  assertStageMarker(value, 'stage-abort', stage, expectedEpoch, sessionId)
  let productReceipt = null
  let terminalBudgetEvidence
  let productReceiptDigest = null
  if (priorAcknowledgement !== undefined) {
    if (priorAcknowledgement.decision !== 'continue'
      || priorAcknowledgement.effectiveTerminal?.kind !== 'completed') {
      throw new Error(`aborted stage ${stage.id} has no valid prior continuation`)
    }
    terminalBudgetEvidence = budgetTerminalEvidenceSince(
      typeof budgetSnapshot === 'function' ? budgetSnapshot() : budgetSnapshot,
      budgetBeforeSnapshot,
      attemptId,
    )
    if (terminalBudgetEvidence === null) {
      throw new Error('Harness aborted without host-authenticated attempt budget evidence')
    }
    productReceiptDigest = priorAcknowledgement.receiptDigest ?? null
  } else {
    const handled = await handleV26StageComplete({
      value: {
        ...value,
        type: 'stage-complete',
        observedTurnReason: { kind: 'error' },
      },
      stage,
      expectedEpoch,
      attemptId,
      sessionId,
      budgetSnapshot,
      budgetBeforeSnapshot,
      auditBeforeSha256,
      workspace,
      taskRoot,
      dockerImage,
      verifierTempRoot,
      receiptPath: productReceiptPath,
      hiddenAssetsSha256,
      gradeRound,
      digestWorkspace,
      writeReceipt,
    })
    productReceipt = handled.receipt
    productReceiptDigest = productReceipt?.receiptDigest ?? null
    terminalBudgetEvidence = handled.terminalBudgetEvidence
  }

  const terminalReceipt = await writeReceipt(terminalReceiptPath, {
    stageId: stage.id,
    revision: stage.revision,
    stageKind: stage.kind,
    abortedPhase: value.phase ?? null,
    productReceiptDigest,
    hiddenAssetsSha256,
    effectiveTerminal: { kind: ATTEMPT_BUDGET_TERMINAL },
    terminalBudgetEvidence,
  })
  return {
    acknowledgement: {
      revision: stage.revision,
      decision: 'terminal',
      continue: false,
      effectiveTerminal: { kind: ATTEMPT_BUDGET_TERMINAL },
      receiptDigest: terminalReceipt.receiptDigest,
      budgetTerminalId: terminalBudgetEvidence.terminalId,
    },
    productReceipt,
    terminalReceipt,
    terminalBudgetEvidence,
  }
}

export function validateV26TerminalEchoes(stageDecisions, markers) {
  const terminalDecisions = stageDecisions.filter(item => item.decision === 'terminal')
  const echoed = markers.filter(item => item.type === 'attempt-terminal')
  if (terminalDecisions.length !== echoed.length || terminalDecisions.length > 1) {
    throw new Error('Harness terminal acknowledgements and echoes are not one-to-one')
  }
  for (const decision of terminalDecisions) {
    const marker = echoed[0]
    if (decision.stageId !== marker?.stageId
      || decision.epoch !== marker?.epoch
      || decision.stageIndex !== marker?.stageIndex
      || decision.kind !== marker?.kind
      || decision.revision !== marker?.revision
      || decision.effectiveTerminal?.kind !== marker?.terminalReason?.kind
      || decision.receiptDigest !== marker?.receiptDigest
      || decision.budgetTerminalId !== marker?.budgetTerminalId
      || decision.sessionId !== marker?.sessionId) {
      throw new Error('Harness attempt terminal did not echo the evaluator receipt authority')
    }
  }
}

export async function runInteractiveEpoch({
  epoch,
  dshBin,
  env,
  workspace,
  forbiddenReadRoots,
  timeoutMs,
  onMarker,
  logPrefix,
  secretValues,
}) {
  const invocation = commandForSandbox(
    dshBin,
    forbiddenReadRoots,
    workspace,
    'Run the evaluator-supplied V26 protocol through the installed support plugin.',
  )
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspace,
    env: { ...env, DSH_PLAN_LATTICE_V26_EPOCH_JSON: JSON.stringify(epoch) },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  const sizes = { stdout: 0, stderr: 0 }
  const maxBuffer = 64 * 1024 * 1024
  let markerChain = Promise.resolve()
  let callbackError
  let timedOut = false
  let forceTimer
  let rejectionTimer
  let rejectionTimedOut = false
  const observedMarkers = []

  const terminate = () => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    forceTimer ??= setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }, 5_000)
  }
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)

  const capture = (target, chunk, stream) => {
    try { appendBuffer(target, chunk, sizes, stream, maxBuffer) } catch (error) {
      callbackError ??= error
      terminate()
    }
  }
  child.stdout.on('data', chunk => capture(stdout, chunk, 'stdout'))
  child.stderr.on('data', chunk => capture(stderr, chunk, 'stderr'))
  const lines = createInterface({ input: child.stderr, crlfDelay: Infinity, terminal: false })
  lines.on('line', line => {
    if (!line.startsWith(MARKER)) return
    let value
    try { value = JSON.parse(line.slice(MARKER.length)) } catch (error) {
      callbackError ??= new Error(`invalid V26 marker: ${error.message}`)
      terminate()
      return
    }
    observedMarkers.push(value)
    markerChain = markerChain.then(async () => {
      if (callbackError) return
      try {
        const acknowledgement = await onMarker(value)
        if (value.type === 'stage-start') {
          await writeChildLine(child, {
            type: 'stage-start-ack',
            epoch: value.epoch,
            stageId: value.stageId,
            stageIndex: value.stageIndex,
            kind: value.kind,
            revision: value.revision,
            sessionId: value.sessionId,
          })
        } else if (value.type === 'stage-complete' || value.type === 'stage-abort') {
          await writeChildLine(child, {
            type: 'stage-ack',
            stageId: value.stageId,
            ...acknowledgement,
          })
        }
      } catch (error) {
        callbackError = error
        if (value.type === 'stage-complete' || value.type === 'stage-abort') {
          try {
            await writeChildLine(child, {
              type: 'stage-ack',
              stageId: value.stageId,
              revision: value.revision,
              decision: 'invalid',
              continue: false,
              effectiveTerminal: null,
            })
            rejectionTimer = setTimeout(() => {
              rejectionTimedOut = true
              terminate()
            }, Math.min(timeoutMs, 15_000))
          } catch {
            terminate()
          }
        } else {
          terminate()
        }
      }
    })
  })

  const closed = await new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', (status, signal) => resolveClose({ status, signal }))
  })
  clearTimeout(timer)
  clearTimeout(forceTimer)
  clearTimeout(rejectionTimer)
  lines.close()
  await markerChain
  const stdoutText = sanitized(Buffer.concat(stdout).toString('utf8'), secretValues)
  const stderrText = sanitized(Buffer.concat(stderr).toString('utf8'), secretValues)
  await Promise.all([
    writeFile(`${logPrefix}.stdout.log`, stdoutText, 'utf8'),
    writeFile(`${logPrefix}.stderr.log`, stderrText, 'utf8'),
  ])
  const processResult = {
    epoch: epoch.epoch,
    pid: child.pid,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    status: closed.status,
    signal: closed.signal ?? null,
    observedMarkers,
  }
  if (callbackError) {
    callbackError.processResult = processResult
    callbackError.evaluatorRejectionTimedOut = rejectionTimedOut
    throw callbackError
  }
  if (timedOut) {
    const error = new Error(`V26 epoch ${epoch.epoch} timed out`)
    error.processResult = processResult
    throw error
  }
  if (closed.status !== 0) {
    const error = new Error(`V26 epoch ${epoch.epoch} exited ${String(closed.status)} signal ${String(closed.signal)}`)
    error.processResult = processResult
    throw error
  }
  return processResult
}

export async function runV26Attempt({
  runtimeArtifacts,
  harnessCommit,
  taskRoot,
  dockerImage,
  protocol,
  attemptDir,
  workspace,
  arm,
  attemptId,
  pluginCommit,
  pluginPackagePath,
  pluginPackageDigest,
  budgetSnapshot,
  forbiddenReadRoots = [],
  timeoutMsPerEpoch = 4 * 60 * 60 * 1000,
}) {
  const proxy = requireProxyCapabilities(process.env)
  const taskIdentity = await inspectEvoCodeTask(taskRoot)
  if (protocol?.schemaVersion !== 1 || protocol.rootSessionId !== protocol.epochs?.[0]?.rootSessionId) {
    throw new Error('V26 protocol is malformed or has no stable root session')
  }
  await mkdir(attemptDir, { recursive: true })
  const dshBin = await materializeFrozenHarnessRuntime(runtimeArtifacts, harnessCommit, attemptDir)
  const packageRoot = join(attemptDir, 'packages')
  await mkdir(packageRoot, { recursive: true })
  let pluginPackage
  if (pluginPackagePath) {
    pluginPackage = resolve(pluginPackagePath)
    if (sha256(await readFile(pluginPackage)) !== pluginPackageDigest) {
      throw new Error('frozen candidate package digest mismatch')
    }
  }
  const wrapperPackage = await materializeLongSystemWrapper(attemptDir, pluginPackage)
  const dshHome = join(attemptDir, 'dsh-home')
  const processHome = join(attemptDir, 'process-home')
  const processTmp = join(attemptDir, 'tmp')
  const sessionsRoot = join(attemptDir, 'sessions')
  const oracleAudit = join(attemptDir, 'oracle-questions.jsonl')
  const verifierTempRoot = join(dirname(attemptDir), '.v26-verifier-tmp')
  await Promise.all([
    mkdir(processHome, { recursive: true }),
    mkdir(processTmp, { recursive: true }),
    mkdir(verifierTempRoot, { recursive: true }),
  ])
  const { profileDir, pluginConfig } = await configureProfile({
    dshBin,
    dshHome,
    supportPlugin: join(driverRoot, 'support-plugin'),
    pluginPackage: wrapperPackage.path,
    arm,
  })
  const pluginIdentity = pluginPackage && pluginPackageDigest && pluginCommit
    ? await verifyInstalledCandidate({
        profileDir,
        attemptDir,
        candidatePackage: pluginPackage,
        candidateDigest: pluginPackageDigest,
        wrapperDigest: wrapperPackage.digest,
        candidateCommit: pluginCommit,
        wrapperName: 'dsh-plan-lattice-long-system-wrapper',
      })
    : undefined
  const env = {
    ...inheritedRuntimeEnvironment(),
    HOME: processHome,
    TMPDIR: processTmp,
    DEEPSEEK_API_KEY: proxy.agentCapability,
    DEEPSEEK_BASE_URL: proxy.hostBaseURL,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TOOLS_MODE: 'native',
    DSH_PLAN_LATTICE_EVAL_SESSION_ID: protocol.rootSessionId,
    DSH_PLAN_LATTICE_EVAL_ATTEMPT_ID: attemptId,
    DSH_PLAN_LATTICE_SESSION_ROOT: sessionsRoot,
    DSH_PLAN_LATTICE_ORACLE_AUDIT_PATH: oracleAudit,
    DSH_PLAN_LATTICE_ORACLE_POLICY: 'closed-world-task-requirements',
  }
  const roundResults = []
  const markers = []
  const processLedger = []
  const budgetTerminalReceipts = []
  const stageDecisions = []
  const auditDigests = new Map()
  const budgetAtStageStart = new Map()
  const budgetAfterStageDecision = new Map()
  const receiptRoot = join(attemptDir, 'round-receipts')
  await mkdir(receiptRoot, { recursive: false, mode: 0o700 })
  const stageById = new Map(protocol.stages.map(stage => [stage.id, stage]))
  const allForbidden = [...new Set([
    taskIdentity.root,
    verifierTempRoot,
    ...forbiddenReadRoots,
  ].map(path => realpathSync(path)))]

  for (const epoch of protocol.epochs) {
    const processResult = await runInteractiveEpoch({
      epoch,
      dshBin,
      env,
      workspace,
      forbiddenReadRoots: allForbidden,
      timeoutMs: timeoutMsPerEpoch,
      logPrefix: join(attemptDir, `harness.epoch-${epoch.epoch}`),
      secretValues: [proxy.agentCapability],
      async onMarker(value) {
        markers.push(value)
        const stage = value.stageId === undefined ? undefined : stageById.get(value.stageId)
        if (value.type === 'stage-start' && stage?.kind === 'audit') {
          auditDigests.set(stage.id, await digestTree(workspace))
        }
        if (value.type === 'stage-start' && stage) {
          budgetAtStageStart.set(stage.id,
            typeof budgetSnapshot === 'function' ? budgetSnapshot() : budgetSnapshot)
        }
        if (value.type !== 'stage-complete' && value.type !== 'stage-abort') return { continue: true }
        if (!stage) throw new Error(`unknown completed V26 stage ${String(value.stageId)}`)
        const priorIndex = stageDecisions.findIndex(item => item.stageId === stage.id)
        const handled = value.type === 'stage-complete' ? await handleV26StageComplete({
          value,
          stage,
          expectedEpoch: epoch.epoch,
          attemptId,
          sessionId: protocol.rootSessionId,
          budgetSnapshot,
          budgetBeforeSnapshot: budgetAtStageStart.get(stage.id),
          auditBeforeSha256: auditDigests.get(stage.id),
          workspace,
          taskRoot: taskIdentity.root,
          dockerImage,
          verifierTempRoot,
          receiptPath: join(receiptRoot, `${stage.id}.json`),
          hiddenAssetsSha256: taskIdentity.digests.hidden.sha256,
        }) : await handleV26AttemptAbort({
          value,
          stage,
          expectedEpoch: epoch.epoch,
          attemptId,
          sessionId: protocol.rootSessionId,
          budgetSnapshot,
          budgetBeforeSnapshot: priorIndex === -1
            ? budgetAtStageStart.get(stage.id)
            : budgetAfterStageDecision.get(stage.id),
          priorAcknowledgement: priorIndex === -1 ? undefined : stageDecisions[priorIndex],
          auditBeforeSha256: auditDigests.get(stage.id),
          workspace,
          taskRoot: taskIdentity.root,
          dockerImage,
          verifierTempRoot,
          productReceiptPath: join(receiptRoot, `${stage.id}.json`),
          terminalReceiptPath: join(receiptRoot, `${stage.id}.terminal.json`),
          hiddenAssetsSha256: taskIdentity.digests.hidden.sha256,
        })
        const receipt = handled.receipt ?? handled.productReceipt ?? null
        const { acknowledgement, terminalBudgetEvidence } = handled
        if (terminalBudgetEvidence !== undefined) {
          budgetTerminalReceipts.push({
            stageId: stage.id,
            receiptDigest: acknowledgement.receiptDigest,
            ...terminalBudgetEvidence,
          })
        }
        if (receipt !== null) roundResults.push(receipt)
        const decision = {
          epoch: epoch.epoch,
          stageId: stage.id,
          stageIndex: stage.index,
          kind: stage.kind,
          revision: stage.revision,
          sessionId: protocol.rootSessionId,
          ...acknowledgement,
        }
        if (priorIndex === -1) stageDecisions.push(decision)
        else stageDecisions[priorIndex] = decision
        budgetAfterStageDecision.set(stage.id,
          typeof budgetSnapshot === 'function' ? budgetSnapshot() : budgetSnapshot)
        return acknowledgement
      },
    })
    const { observedMarkers: _observedMarkers, ...processSummary } = processResult
    const epochReady = markers.filter(item => item.type === 'epoch-ready' && item.epoch === epoch.epoch)
    const epochComplete = markers.filter(item => item.type === 'epoch-complete' && item.epoch === epoch.epoch)
    if (epochReady.length !== 1 || epochComplete.length !== 1) {
      throw new Error(`V26 epoch ${epoch.epoch} did not emit exactly one ready and complete boundary`)
    }
    const firstSeq = epochReady[0].firstSeq
    const lastSeq = epochComplete[0].lastSeq
    if (!Number.isSafeInteger(firstSeq) || firstSeq < 0
      || !Number.isSafeInteger(lastSeq) || lastSeq < firstSeq) {
      throw new Error(`V26 epoch ${epoch.epoch} emitted an invalid Session event range`)
    }
    const priorEpoch = processLedger.at(-1)
    if (priorEpoch !== undefined && priorEpoch.lastSeq >= firstSeq) {
      throw new Error(`V26 epoch ${epoch.epoch} overlaps the prior process Session range`)
    }
    processLedger.push({
      ...processSummary,
      epochId: `epoch-${epoch.epoch}`,
      processId: `${processResult.pid}@${processResult.startedAt}`,
      sessionId: protocol.rootSessionId,
      rootSessionId: protocol.rootSessionId,
      firstSeq,
      lastSeq,
      ended: true,
      exit: { status: processResult.status, signal: processResult.signal },
      coldStart: epoch.epoch > 1,
      endSeedSeq: epochReady[0].endSeedSeq,
      ...(epoch.epoch > 1 ? { resumedFromEpochId: `epoch-${epoch.epoch - 1}` } : {}),
    })
    if (markers.some(item => item.type === 'attempt-terminal')) break
  }

  validateV26TerminalEchoes(stageDecisions, markers)

  const productGrade = summarizeOfficialRounds(roundResults)
  productGrade.hidden = true
  productGrade.hiddenAssetsSha256 = taskIdentity.digests.hidden.sha256
  productGrade.staleBehavior = {
    hidden: true,
    failures: productGrade.historicalRequirementRegressions,
    passed: productGrade.historicalRequirementRegressions === 0,
  }
  const sessionMetrics = await parseSessionMetrics(sessionsRoot, { terminalSessionId: protocol.rootSessionId })
  const clarificationQuestions = await countClarificationQuestions(oracleAudit)
  const terminalOutcomes = stageDecisions
    .map(decision => ({
      stageId: decision.stageId,
      kind: decision.kind,
      terminalKind: decision.effectiveTerminal?.kind ?? null,
    }))
  const productTerminalOutcomes = terminalOutcomes.filter(outcome => outcome.kind === 'product')
  const maxTokenProductTerminals = productTerminalOutcomes
    .filter(outcome => outcome.terminalKind === 'max-tokens').length
  const prematureTaskTerminals = terminalOutcomes
    .filter(outcome => outcome.terminalKind !== 'completed').length
  const attemptBudgetTerminals = terminalOutcomes
    .filter(outcome => outcome.terminalKind === ATTEMPT_BUDGET_TERMINAL).length
  const metrics = {
    ...sessionMetrics,
    clarificationQuestions,
    durationMs: processLedger.reduce((sum, epoch) => sum + epoch.durationMs, 0),
    score: productGrade.rewardScore,
    caseScore: productGrade.cumulativeCaseScore,
    historicalRequirementRegressions: productGrade.historicalRequirementRegressions,
    hardRequirementsMissed: productGrade.rounds.filter(round => round.reward !== 1).length,
    maxTokenProductTerminals,
    prematureTaskTerminals,
    attemptBudgetTerminals,
  }
  const attemptTerminal = markers.filter(marker => marker.type === 'attempt-terminal').at(-1)
  const outcome = attemptTerminal === undefined
    ? { class: 'completed', terminalKind: 'completed', stageId: 'round-9' }
    : {
        class: 'premature-terminal',
        terminalKind: attemptTerminal.terminalReason?.kind ?? null,
        stageId: attemptTerminal.stageId,
        stageKind: attemptTerminal.kind,
      }
  const auditStage = protocol.stages.find(stage => stage.kind === 'audit')
  const auditStart = markers.filter(marker => marker.type === 'stage-start' && marker.stageId === auditStage?.id)
  const auditComplete = markers.filter(marker => marker.type === 'stage-complete' && marker.stageId === auditStage?.id)
  if (outcome.class === 'completed'
    && (auditStage === undefined || auditStart.length !== 1 || auditComplete.length !== 1)) {
    throw new Error('V26 protocol did not produce one exact foreground audit stage range')
  }
  const traceProtocol = outcome.class === 'completed' ? {
    expectedCompactions: protocol.lifecycle.compactionAfter.length,
    expectedColdResumes: 1,
    guardedTools: [],
    hiddenAssetsSha256: taskIdentity.digests.hidden.sha256,
    foregroundFork: {
      stageId: auditStage.id,
      firstSeq: auditStart[0].firstSeq,
      lastSeq: auditComplete[0].lastSeq,
      revisionId: auditStage.revision,
      requiredFragments: [],
    },
  } : null
  const decoderModulePath = resolve(
    dirname(dshBin), '..', '..', 'dsh-session', 'lib', 'index.js',
  )
  const trace = arm.id === 'v0.4-native-continuity'
    ? outcome.class === 'completed' ? await gradeV26Trace({
        sessionsRoot,
        rootSessionId: protocol.rootSessionId,
        stageProtocol: traceProtocol,
        processLedger,
        productGrade,
        decoderModulePath,
      }) : {
        valid: false,
        violations: [{
          code: 'ATTEMPT_PRODUCT_TERMINAL',
          message: `Candidate ended at ${String(outcome.stageId)} with ${String(outcome.terminalKind)}`,
        }],
      }
    : null
  const result = {
    schemaVersion: 1,
    attemptId,
    id: attemptId,
    arm: arm.id,
    status: 'completed',
    outcome,
    taskIdentity,
    dockerImage,
    protocolId: protocol.protocolId,
    rootSessionId: protocol.rootSessionId,
    processLedger,
    markers,
    productGrade,
    pluginConfig: pluginConfig ?? null,
    pluginIdentity: pluginIdentity ?? null,
    wrapperPackageSha256: wrapperPackage.digest,
    sessionsRoot,
    metrics,
    traceProtocol,
    trace,
    terminalOutcomes,
    budgetTerminalReceipts,
  }
  await writeFile(join(attemptDir, 'attempt-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}
