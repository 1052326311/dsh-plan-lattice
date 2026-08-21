import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { configureProfile } from '../../../v0.4/driver/lib/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../../v0.4/driver/lib/environment.mjs'
import { requireProxyCapabilities } from '../../../v0.4/driver/lib/proxy-capability.mjs'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import { inspectEvoCodeTask, runOfficialRoundInDocker, summarizeOfficialRounds } from '../benchmark.mjs'
import {
  digestTree,
  materializeFrozenHarnessRuntime,
  materializeLongSystemWrapper,
  repositoryRoot,
  sanitized,
  verifyInstalledCandidate,
} from './runtime.mjs'
import { gradeV24Trace } from '../trace-grader.mjs'
import { countClarificationQuestions, parseSessionMetrics } from './session-metrics.mjs'

const MARKER = '@@PLAN_LATTICE_V24@@'
const driverRoot = dirname(fileURLToPath(import.meta.url))

function quoteSandbox(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function commandForSandbox(dshBin, forbiddenReadRoots, workspace, prompt) {
  if (process.platform !== 'darwin') throw new Error('V24 host execution currently requires Darwin sandbox-exec')
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

async function runInteractiveEpoch({
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
    'Run the evaluator-supplied V24 protocol through the installed support plugin.',
  )
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspace,
    env: { ...env, DSH_PLAN_LATTICE_V24_EPOCH_JSON: JSON.stringify(epoch) },
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
      callbackError ??= new Error(`invalid V24 marker: ${error.message}`)
      terminate()
      return
    }
    markerChain = markerChain.then(async () => {
      if (callbackError) return
      try {
        const acknowledgement = await onMarker(value)
        if (value.type === 'stage-complete') {
          child.stdin.write(`${JSON.stringify({
            type: 'stage-ack',
            stageId: value.stageId,
            continue: acknowledgement?.continue === true,
          })}\n`)
        }
      } catch (error) {
        callbackError = error
        if (value.type === 'stage-complete') {
          child.stdin.write(`${JSON.stringify({ type: 'stage-ack', stageId: value.stageId, continue: false })}\n`)
        }
        terminate()
      }
    })
  })

  const closed = await new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', (status, signal) => resolveClose({ status, signal }))
  })
  clearTimeout(timer)
  clearTimeout(forceTimer)
  lines.close()
  await markerChain
  const stdoutText = sanitized(Buffer.concat(stdout).toString('utf8'), secretValues)
  const stderrText = sanitized(Buffer.concat(stderr).toString('utf8'), secretValues)
  await Promise.all([
    writeFile(`${logPrefix}.stdout.log`, stdoutText, 'utf8'),
    writeFile(`${logPrefix}.stderr.log`, stderrText, 'utf8'),
  ])
  if (callbackError) throw callbackError
  if (timedOut) throw new Error(`V24 epoch ${epoch.epoch} timed out`)
  if (closed.status !== 0) {
    throw new Error(`V24 epoch ${epoch.epoch} exited ${String(closed.status)} signal ${String(closed.signal)}`)
  }
  return {
    epoch: epoch.epoch,
    pid: child.pid,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    status: closed.status,
    signal: closed.signal ?? null,
  }
}

export async function runV24Attempt({
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
  forbiddenReadRoots = [],
  timeoutMsPerEpoch = 4 * 60 * 60 * 1000,
}) {
  const proxy = requireProxyCapabilities(process.env)
  const taskIdentity = await inspectEvoCodeTask(taskRoot)
  if (protocol?.schemaVersion !== 1 || protocol.rootSessionId !== protocol.epochs?.[0]?.rootSessionId) {
    throw new Error('V24 protocol is malformed or has no stable root session')
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
  const verifierTempRoot = join(dirname(attemptDir), '.v24-verifier-tmp')
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
  const auditDigests = new Map()
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
        if (value.type !== 'stage-complete') return { continue: true }
        if (!stage) throw new Error(`unknown completed V24 stage ${String(value.stageId)}`)
        if (stage.kind === 'audit') {
          const before = auditDigests.get(stage.id)
          const after = await digestTree(workspace)
          if (before !== after) throw new Error('foreground audit mutated the product workspace')
          return { continue: true }
        }
        const grade = await runOfficialRoundInDocker({
          taskRoot: taskIdentity.root,
          workspaceRoot: workspace,
          round: stage.productRound,
          image: dockerImage,
          verifierTempRoot,
        })
        roundResults.push(grade)
        return { continue: true }
      },
    })
    const epochReady = markers.filter(item => item.type === 'epoch-ready' && item.epoch === epoch.epoch)
    const epochComplete = markers.filter(item => item.type === 'epoch-complete' && item.epoch === epoch.epoch)
    if (epochReady.length !== 1 || epochComplete.length !== 1) {
      throw new Error(`V24 epoch ${epoch.epoch} did not emit exactly one ready and complete boundary`)
    }
    const firstSeq = epochReady[0].firstSeq
    const lastSeq = epochComplete[0].lastSeq
    if (!Number.isSafeInteger(firstSeq) || firstSeq < 0
      || !Number.isSafeInteger(lastSeq) || lastSeq < firstSeq) {
      throw new Error(`V24 epoch ${epoch.epoch} emitted an invalid Session event range`)
    }
    const priorEpoch = processLedger.at(-1)
    if (priorEpoch !== undefined && priorEpoch.lastSeq >= firstSeq) {
      throw new Error(`V24 epoch ${epoch.epoch} overlaps the prior process Session range`)
    }
    processLedger.push({
      ...processResult,
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
  }

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
  const metrics = {
    ...sessionMetrics,
    clarificationQuestions,
    durationMs: processLedger.reduce((sum, epoch) => sum + epoch.durationMs, 0),
    score: productGrade.rewardScore,
    caseScore: productGrade.cumulativeCaseScore,
    historicalRequirementRegressions: productGrade.historicalRequirementRegressions,
    hardRequirementsMissed: productGrade.rounds.filter(round => round.reward !== 1).length,
  }
  const auditStage = protocol.stages.find(stage => stage.kind === 'audit')
  const auditStart = markers.filter(marker => marker.type === 'stage-start' && marker.stageId === auditStage?.id)
  const auditComplete = markers.filter(marker => marker.type === 'stage-complete' && marker.stageId === auditStage?.id)
  if (auditStage === undefined || auditStart.length !== 1 || auditComplete.length !== 1) {
    throw new Error('V24 protocol did not produce one exact foreground audit stage range')
  }
  const traceProtocol = {
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
  }
  const decoderModulePath = resolve(
    dirname(dshBin), '..', '..', 'dsh-session', 'lib', 'index.js',
  )
  const trace = arm.id === 'v0.4-native-continuity'
    ? await gradeV24Trace({
        sessionsRoot,
        rootSessionId: protocol.rootSessionId,
        stageProtocol: traceProtocol,
        processLedger,
        productGrade,
        decoderModulePath,
      })
    : null
  const result = {
    schemaVersion: 1,
    attemptId,
    id: attemptId,
    arm: arm.id,
    status: 'completed',
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
  }
  await writeFile(join(attemptDir, 'attempt-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}
