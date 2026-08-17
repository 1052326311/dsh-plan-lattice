#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const workspaceRoot = dirname(repositoryRoot)
const harnessCommit = '47f943859bef60e4160492346772ded9b24f765a'
const candidateCommit = process.env.PLAN_LATTICE_PILOT_CANDIDATE_COMMIT
  ?? 'dc86064e239600e7b0c5bf77310e8dd00bb363ae'
const hostRuntimeSha256 = process.env.PLAN_LATTICE_PILOT_HOST_RUNTIME_SHA256
  ?? '532fc29dae09f8ac0ac4fe20cfd08cf016506a04120b2f0ce3fbf7d2ad2f8319'
const hostRuntime = process.env.PLAN_LATTICE_PILOT_HOST_RUNTIME
const apiKey = process.env.DEEPSEEK_API_KEY
const icaeRoot = resolve(process.env.ICAE_EVAL_ROOT
  ?? join(workspaceRoot, 'benchmarks/ICAE-EVAL'))
const pythonExecutable = resolve(process.env.PLAN_LATTICE_PILOT_PYTHON
  ?? join(icaeRoot, '.venv/bin/python'))
const outputPath = resolve(process.env.PLAN_LATTICE_PILOT_OUTPUT
  ?? join(repositoryRoot, 'eval/pilots/results/rc7-icae-js-ts-01.json'))
const artifactId = `rc7-icae-js-ts-01-${new Date().toISOString().replace(/[:.]/g, '-')}`
const artifactsRoot = resolve(process.env.PLAN_LATTICE_PILOT_ARTIFACTS_ROOT
  ?? join(workspaceRoot, 'dsh-plan-lattice-eval-artifacts', artifactId))
const timeoutMs = 3_600_000
const armCatalog = [
  { id: 'native', plugin: 'none' },
  {
    id: 'v0.4-critical',
    plugin: 'v0.4.0-candidate',
    activationMode: 'auto',
    clarificationPolicy: 'critical',
    controlCeiling: 'lattice',
  },
]
const requestedArmIds = (process.env.PLAN_LATTICE_PILOT_ARMS ?? armCatalog.map(arm => arm.id).join(','))
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
assert.ok(requestedArmIds.length > 0, 'at least one pilot arm is required')
assert.equal(new Set(requestedArmIds).size, requestedArmIds.length, 'pilot arm ids must be unique')
const selectedArms = requestedArmIds.map(id => {
  const arm = armCatalog.find(candidate => candidate.id === id)
  assert.ok(arm, `unknown pilot arm ${id}`)
  return arm
})

if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')
if (!hostRuntime) throw new Error('PLAN_LATTICE_PILOT_HOST_RUNTIME is required')

const pilotDriverCommit = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
assert.match(pilotDriverCommit, /^[0-9a-f]{40}$/, 'pilot driver commit is unavailable')
const worktreeStatus = spawnSync('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
assert.equal(worktreeStatus.status, 0, 'pilot worktree status failed')
assert.equal(worktreeStatus.stdout.trim(), '', 'pilot must start from a clean committed worktree')

const { sha256 } = await import(new URL('../v0.4/lib/canonical.mjs', import.meta.url))
const { startModelProxy } = await import(new URL('../v0.4/driver/model-proxy.mjs', import.meta.url))
const hostRuntimeBytes = await readFile(hostRuntime)
assert.equal(sha256(hostRuntimeBytes), hostRuntimeSha256, 'host Harness runtime digest mismatch')

const benchmarkLock = JSON.parse(await readFile(join(repositoryRoot, 'eval/v0.4/benchmark-lock.json'), 'utf8'))
const task = benchmarkLock.sources.icae.selectedTasks.find(item => item.id === 'icae-js-ts-01')
assert.ok(task, 'frozen ICAE task icae-js-ts-01 is missing')

function runProcess(command, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, options.timeoutMs)
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolveRun({
        status,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    child.once('error', error => {
      clearTimeout(timer)
      resolveRun({ status: null, signal: null, timedOut, stdout: '', stderr: String(error.stack ?? error) })
    })
  })
}

function sanitize(text, secrets) {
  let value = text ?? ''
  for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[REDACTED]')
  return value.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
}

function lastJsonLine(text) {
  for (const line of text.split(/\r?\n/).filter(Boolean).reverse()) {
    try { return JSON.parse(line) } catch {}
  }
  return undefined
}

async function activate(proxy, attemptId) {
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-plan-lattice-control': proxy.controlToken,
    },
    body: JSON.stringify({ attemptId }),
  })
  assert.equal(response.status, 200, `failed to activate ${attemptId}`)
}

const artifactParent = dirname(artifactsRoot)
await mkdir(artifactParent, { recursive: true })
const historicalArtifactRoots = (await readdir(artifactParent, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && resolve(artifactParent, entry.name) !== artifactsRoot)
  .map(entry => resolve(artifactParent, entry.name))
await mkdir(artifactsRoot, { recursive: true })
const keys = generateKeyPairSync('ed25519')
const proxy = await startModelProxy({
  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  auditPath: join(artifactsRoot, 'proxy-audit.jsonl'),
  signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  signingLedgerPath: join(artifactsRoot, 'signing-ledger.jsonl'),
  signingLedgerId: 'plan-lattice-rc7-icae-exploratory-pilot',
  executionEnvelopeDigest: '6'.repeat(64),
  host: '127.0.0.1',
})

const previous = Object.fromEntries([
  'PLAN_LATTICE_CREDENTIAL_PROXY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN',
  'PLAN_LATTICE_ICAE_PILOT_RUNTIME',
].map(name => [name, process.env[name]]))

const startedAt = new Date().toISOString()
const attempts = []
try {
  process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
  process.env.DEEPSEEK_API_KEY = proxy.token
  process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL
  process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN = proxy.oracleToken
  process.env.PLAN_LATTICE_ICAE_PILOT_RUNTIME = hostRuntime

  for (const arm of selectedArms) {
    const attemptId = `rc7-icae-${arm.id}-${Date.now()}`
    const attemptDir = join(artifactsRoot, arm.id)
    const controllerDir = join(attemptDir, 'controller')
    await mkdir(controllerDir, { recursive: true })
    const specPath = join(controllerDir, 'run-spec.json')
    const spec = {
      attemptDir,
      benchmarkRoots: { icae: icaeRoot },
      sourceCommits: { harness: harnessCommit },
      runtimeArtifacts: {
        hostHarness: {
          pathEnvironmentVariable: 'PLAN_LATTICE_ICAE_PILOT_RUNTIME',
          sha256: hostRuntimeSha256,
        },
      },
      pluginCommits: {
        'v0.3.0': 'fc55e593c03f99c0ef62ba5948d3e4f719059cdc',
        'v0.4.0Candidate': candidateCommit,
      },
      additionalForbiddenReadRoots: [
        ...historicalArtifactRoots,
        ...attempts.map(attempt => join(artifactsRoot, attempt.arm)),
      ],
      run: {
        runId: `exploratory-icae-${task.id}-${arm.id}`,
        suite: 'icae',
        taskId: task.id,
        arm,
        taskLocator: {
          repository: task.repoId,
          repositoryKey: task.repositoryKey,
          language: task.language,
          aliasResolution: 'ICAE repo_alias.json at the pinned commit',
        },
      },
      // The outer Darwin sandbox remains the evidence boundary. Disabling the
      // inner Harness sandbox avoids unsupported nested sandbox-exec calls.
      model: { timeoutMs, permissionMode: 'danger-full-access' },
    }
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await activate(proxy, attemptId)
    process.stderr.write(`starting ${arm.id} on ${task.id}\n`)
    const started = Date.now()
    const child = await runProcess(
      pythonExecutable,
      [join(repositoryRoot, 'eval/pilots/driver/icae_adapter.py'), specPath],
      {
        cwd: icaeRoot,
        env: { ...process.env, PLAN_LATTICE_NODE: process.execPath, PYTHONDONTWRITEBYTECODE: '1' },
        timeoutMs: timeoutMs + 120_000,
      },
    )
    const secrets = [apiKey, proxy.token, proxy.oracleToken, proxy.controlToken]
    const safeStdout = sanitize(child.stdout, secrets)
    const safeStderr = sanitize(child.stderr, secrets)
    await writeFile(join(attemptDir, 'pilot.stdout.log'), safeStdout, 'utf8')
    await writeFile(join(attemptDir, 'pilot.stderr.log'), safeStderr, 'utf8')
    const payload = lastJsonLine(safeStdout)
    attempts.push({
      arm: arm.id,
      processStatus: child.status,
      signal: child.signal,
      timedOut: child.timedOut,
      durationMs: Date.now() - started,
      status: payload?.metrics ? 'completed' : 'failed',
      ...(payload?.metrics ? { metrics: payload.metrics } : {
        failure: payload?.failure ?? { classification: 'infrastructure', code: 'unparsed_adapter_output' },
      }),
    })
    process.stderr.write(`finished ${arm.id}: ${JSON.stringify(attempts.at(-1))}\n`)
  }
} finally {
  await activate(proxy, null)
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await new Promise(resolveClose => proxy.server.close(resolveClose))
}

const native = attempts.find(item => item.arm === 'native')
const candidate = attempts.find(item => item.arm === 'v0.4-critical')
const report = {
  schemaVersion: 1,
  scope: 'exploratory paired ICAE pilot; excluded from the frozen statistical study',
  startedAt,
  completedAt: new Date().toISOString(),
  artifactId,
  harnessCommit,
  candidateCommit,
  pilotDriverCommit,
  hostRuntimeSha256,
  model: 'deepseek-v4-flash',
  pythonRuntime: '.venv/bin/python',
  task: { id: task.id, language: task.language, selectionHash: task.selectionHash },
  order: attempts.map(item => item.arm),
  attempts,
  observedComparison: native?.metrics && candidate?.metrics ? {
    hiddenFeatureScoreDelta: candidate.metrics.hiddenFeatureScore - native.metrics.hiddenFeatureScore,
    criticalRequirementsMissedDelta: candidate.metrics.criticalRequirementsMissed - native.metrics.criticalRequirementsMissed,
    modelTurnDelta: candidate.metrics.modelTurns - native.metrics.modelTurns,
    clarificationQuestionDelta: candidate.metrics.clarificationQuestions - native.metrics.clarificationQuestions,
  } : null,
  conclusions: {
    allSelectedCompleted: attempts.length === selectedArms.length
      && attempts.every(item => item.status === 'completed'),
    bothCompleted: native?.status === 'completed' && candidate?.status === 'completed',
    statisticalUpliftEstablished: false,
  },
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.conclusions.allSelectedCompleted) process.exitCode = 1
