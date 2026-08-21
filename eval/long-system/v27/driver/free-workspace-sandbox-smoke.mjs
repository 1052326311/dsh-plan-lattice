#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { configureProfile } from '../../../v0.4/driver/lib/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../../v0.4/driver/lib/environment.mjs'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import { CANDIDATE_COMMIT, CANDIDATE_TARBALL_SHA256, HARNESS_COMMIT } from '../manifest.mjs'
import {
  buildCandidateActivationReceiptBody,
  candidateActivationReceiptName,
  readCandidateActivationReceipt,
} from './evocode-runner.mjs'
import { materializeLongSystemWrapper, verifyInstalledCandidate } from './runtime.mjs'

const runtimePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V27_HOST_RUNTIME
if (!runtimePath) throw new Error('PLAN_LATTICE_LONG_SYSTEM_V27_HOST_RUNTIME is required')
const candidatePackagePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V27_CANDIDATE_PACKAGE
const candidateMode = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
}
const ancestorCanaryEnvironmentVariable = 'DSH_PLAN_LATTICE_V27_SMOKE_ANCESTOR_CANARY'

function writeSse(response, rows) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(`${rows.map(row => `data: ${typeof row === 'string' ? row : JSON.stringify(row)}`).join('\n\n')}\n\n`)
}

function toolCall(response, id, command, description) {
  const arguments_ = JSON.stringify({ command, description })
  writeSse(response, [
    { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id, type: 'function', function: { name: 'bash', arguments: arguments_ },
    }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    '[DONE]',
  ])
}

function finalText(response) {
  writeSse(response, [
    { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'WORKSPACE_SANDBOX_SMOKE_COMPLETE' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    '[DONE]',
  ])
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('sandbox smoke model did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  server.closeAllConnections?.()
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
}

async function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('error', rejectRun)
    child.once('close', (status, signal) => resolveRun({
      pid: child.pid,
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

if (process.env[ancestorCanaryEnvironmentVariable] === undefined) {
  const reexecuted = await run(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: {
      ...inheritedRuntimeEnvironment(),
      PLAN_LATTICE_LONG_SYSTEM_V27_HOST_RUNTIME: runtimePath,
      ...(candidatePackagePath === undefined
        ? {}
        : { PLAN_LATTICE_LONG_SYSTEM_V27_CANDIDATE_PACKAGE: candidatePackagePath }),
      [ancestorCanaryEnvironmentVariable]: `v27-ancestor-${randomBytes(24).toString('hex')}`,
    },
  })
  process.stdout.write(reexecuted.stdout)
  process.stderr.write(reexecuted.stderr)
  process.exit(reexecuted.status ?? 1)
}
const ancestorEnvironmentCanary = process.env[ancestorCanaryEnvironmentVariable]

const root = await mkdtemp(join(dirname(resolve(runtimePath)), 'v27-workspace-sandbox-smoke-'))
const runtimeRoot = join(root, 'runtime')
const workspace = join(root, 'workspace')
const dshHome = join(root, 'dsh-home')
const processHome = join(root, 'process-home')
const processTmp = join(root, 'process-tmp')
const sessionsRoot = join(root, 'sessions')
const escapePath = join(root, 'escape-proof.txt')
const hiddenPath = join(root, 'hidden-proof.txt')
const leakedPath = join(workspace, 'leaked-proof.txt')
const allowedPath = join(workspace, 'allowed.txt')
const activationAttemptId = 'v27-free-candidate-activation-smoke'
const activationEpoch = {
  schemaVersion: 1,
  epoch: 1,
  rootSessionId: activationAttemptId,
  stages: [{ id: 'workspace-sandbox-smoke' }],
}
const activationProcess = {
  epoch: activationEpoch.epoch,
  epochSha256: sha256(activationEpoch),
  processNonce: randomBytes(32).toString('hex'),
}
const activationReceiptPath = join(root, candidateActivationReceiptName(1))
const modelErrors = []
let observedDenial = false
let observedReadDenial = false
let observedNetworkDenial = false
let observedProcessInfoDenial = false
let observedAncestorCanaryLeak = false
let observedToolchain = false
let observedToolchainText = ''
let networkProbePort
const model = http.createServer((request, response) => {
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { raw += chunk })
  request.once('end', () => {
    try {
      assert.equal(request.url, '/chat/completions')
      const payload = JSON.parse(raw)
      const results = (payload.messages ?? []).filter(message => message?.role === 'tool')
      const ids = new Set(results.map(message => String(message.tool_call_id ?? '')))
      if (!ids.has('v27-escape')) {
        toolCall(response, 'v27-escape', 'printf escaped > ../escape-proof.txt', 'Probe sibling write denial')
        return
      }
      const escapeResult = results.find(message => message.tool_call_id === 'v27-escape')
      observedDenial ||= /sandbox: file access denied|operation not permitted|permission denied/iu
        .test(JSON.stringify(escapeResult?.content ?? ''))
      if (!ids.has('v27-read-escape')) {
        toolCall(response, 'v27-read-escape', 'value=$(cat ../hidden-proof.txt) && printf %s "$value" > leaked-proof.txt', 'Probe sibling read denial')
        return
      }
      const readResult = results.find(message => message.tool_call_id === 'v27-read-escape')
      observedReadDenial ||= /sandbox: file access denied|operation not permitted|permission denied/iu
        .test(JSON.stringify(readResult?.content ?? ''))
      if (!ids.has('v27-network-escape')) {
        toolCall(response, 'v27-network-escape', `/usr/bin/nc -z 127.0.0.1 ${networkProbePort} && printf NETWORK_ALLOWED || { status=$?; printf NETWORK_DENIED_STATUS_%s "$status" >&2; exit "$status"; }`, 'Probe outbound network denial')
        return
      }
      const networkResult = results.find(message => message.tool_call_id === 'v27-network-escape')
      observedNetworkDenial ||= /NETWORK_DENIED_STATUS_[1-9][0-9]*/u
        .test(JSON.stringify(networkResult?.content ?? ''))
      if (!ids.has('v27-process-info')) {
        toolCall(response, 'v27-process-info', `/bin/ps eww -p ${process.pid}`, 'Probe ancestor process metadata denial')
        return
      }
      const processInfoResult = results.find(message => message.tool_call_id === 'v27-process-info')
      const processInfoText = JSON.stringify(processInfoResult?.content ?? '')
      observedAncestorCanaryLeak ||= processInfoText.includes(ancestorEnvironmentCanary)
      observedProcessInfoDenial ||= /sandbox|operation not permitted|permission denied|not allowed|exited with (?:code|status) [1-9]/iu
        .test(processInfoText)
      if (!ids.has('v27-allowed')) {
        toolCall(response, 'v27-allowed', 'printf allowed > allowed.txt', 'Probe workspace write authority')
        return
      }
      if (!ids.has('v27-toolchain')) {
        toolCall(response, 'v27-toolchain', 'git --version && node --version && go version', 'Probe sandboxed task toolchain')
        return
      }
      const toolchainResult = results.find(message => message.tool_call_id === 'v27-toolchain')
      const toolchainText = JSON.stringify(toolchainResult?.content ?? '')
      observedToolchainText = toolchainText
      observedToolchain ||= /git version /u.test(toolchainText)
        && /v22\./u.test(toolchainText)
        && /go version go/u.test(toolchainText)
      finalText(response)
    } catch (error) {
      modelErrors.push(String(error?.message ?? error))
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: modelErrors.at(-1) }))
    }
  })
})

try {
  await Promise.all([
    mkdir(runtimeRoot), mkdir(workspace), mkdir(dshHome), mkdir(processHome), mkdir(processTmp), mkdir(sessionsRoot),
  ])
  await writeFile(hiddenPath, 'must-not-leak')
  const extracted = await run('tar', ['-xzf', resolve(runtimePath), '-C', runtimeRoot], {
    cwd: root,
    env: inheritedRuntimeEnvironment(),
  })
  assert.equal(extracted.status, 0, extracted.stderr)
  const metadata = JSON.parse(await readFile(join(runtimeRoot, 'runtime.json'), 'utf8'))
  assert.equal(metadata.harnessCommit, HARNESS_COMMIT)
  const dshBin = join(runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const supportRoot = join(root, 'smoke-support')
  await mkdir(supportRoot)
  await Promise.all([
    writeFile(join(supportRoot, 'package.json'), JSON.stringify({
      name: 'dsh-v27-workspace-sandbox-smoke-support',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.js',
      files: ['index.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })),
    writeFile(join(supportRoot, 'index.js'), "export const name = 'v27-workspace-sandbox-smoke-support'\nexport function apply() {}\n"),
    writeFile(join(supportRoot, 'cordis.patch.yml'), '- insert:\n    - id: v27-workspace-sandbox-smoke-support\n      name: dsh-v27-workspace-sandbox-smoke-support\n'),
  ])
  const candidate = typeof candidatePackagePath === 'string' && candidatePackagePath.length > 0
  const wrapper = await materializeLongSystemWrapper(
    root,
    candidate ? resolve(candidatePackagePath) : undefined,
  )
  const profile = await configureProfile({
    dshBin,
    dshHome,
    supportPlugin: supportRoot,
    pluginPackage: wrapper.path,
    arm: candidate
      ? { id: 'v0.4-native-continuity', plugin: 'v0.4.0-rc.9', ...candidateMode }
      : { id: 'native', plugin: 'none', shellAdapter: 'workspace-tree' },
  })
  assert.equal(profile.profileDir, join(dshHome, 'profiles', 'headless'))
  const pluginIdentity = candidate ? await verifyInstalledCandidate({
    profileDir: profile.profileDir,
    attemptDir: root,
    candidatePackage: resolve(candidatePackagePath),
    candidateDigest: CANDIDATE_TARBALL_SHA256,
    wrapperDigest: wrapper.digest,
    candidateCommit: CANDIDATE_COMMIT,
    wrapperName: 'dsh-plan-lattice-long-system-wrapper',
  }) : undefined
  const adapterBytes = candidate ? await readFile(join(
    profile.profileDir,
    'node_modules',
    'dsh-plan-lattice-long-system-wrapper',
    'workspace-shell-adapter.js',
  )) : undefined
  const baseUrl = await listen(model)
  networkProbePort = new URL(baseUrl).port
  const goRootProbe = await run('go', ['env', 'GOROOT'], {
    cwd: workspace,
    env: inheritedRuntimeEnvironment(),
  })
  assert.equal(goRootProbe.status, 0, goRootProbe.stderr)
  const allowedToolchainRoots = [
    dirname(dirname(await realpath(process.execPath))),
    await realpath(goRootProbe.stdout.trim()),
  ]
  const harnessEnvironment = {
    ...inheritedRuntimeEnvironment(),
    HOME: processHome,
    TMPDIR: processTmp,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TOOLS_MODE: 'native',
    DSH_PLAN_LATTICE_SESSION_ROOT: sessionsRoot,
    DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
    DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify(allowedToolchainRoots),
    DSH_PLAN_LATTICE_EVAL_ATTEMPT_ID: activationAttemptId,
    ...(candidate ? {
      DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_RECEIPT_PATH: activationReceiptPath,
      DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_IDENTITY_JSON: JSON.stringify({
        attemptId: activationAttemptId,
        wrapperPackageSha256: pluginIdentity.wrapperPackageSha256,
        candidateCommit: pluginIdentity.candidateCommit,
        candidateVersion: pluginIdentity.candidateVersion,
        candidatePackageSha256: pluginIdentity.candidatePackageSha256,
        candidatePayloadSha256: pluginIdentity.candidatePayloadSha256,
      }),
      DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_PROCESS_JSON: JSON.stringify(activationProcess),
    } : {}),
    DEEPSEEK_API_KEY: 'v27-local-loopback-only',
    DEEPSEEK_BASE_URL: baseUrl,
  }
  assert.equal(Object.hasOwn(harnessEnvironment, ancestorCanaryEnvironmentVariable), false)
  const result = await run(process.execPath, [
    dshBin, '--profile', 'headless',
    'Do not use Plan Lattice for this bounded smoke. Run the requested sandbox probes and finish.',
  ], {
    cwd: workspace,
    env: harnessEnvironment,
  })
  assert.equal(result.status, 0, `${result.stderr}\n${modelErrors.join('\n')}`)
  assert.equal(observedDenial, true, 'real rc.7 Bash did not report the sibling write denial')
  assert.equal(observedReadDenial, true, 'real rc.7 Bash did not report the sibling read denial')
  assert.equal(observedNetworkDenial, true, 'real rc.7 Bash did not report the outbound network denial')
  assert.equal(observedProcessInfoDenial, true, 'real rc.7 Bash could inspect ancestor process metadata')
  assert.equal(observedAncestorCanaryLeak, false, 'real rc.7 Bash leaked its ancestor environment canary')
  assert.equal(observedToolchain, true, `real rc.7 Bash could not invoke the frozen task toolchain: ${observedToolchainText}`)
  await assert.rejects(access(escapePath), error => error?.code === 'ENOENT')
  await assert.rejects(access(leakedPath), error => error?.code === 'ENOENT')
  assert.equal(await readFile(allowedPath, 'utf8'), 'allowed')
  assert.equal(Number.isSafeInteger(result.pid) && result.pid > 0, true, 'smoke Harness has no process identity')
  const expectedActivationBody = candidate ? buildCandidateActivationReceiptBody({
    attemptId: activationAttemptId,
    ...activationProcess,
    processPid: result.pid,
    pluginIdentity,
    pluginConfig: profile.pluginConfig,
    bashAdapterSha256: sha256(adapterBytes),
  }) : undefined
  const candidateActivation = await readCandidateActivationReceipt({
    receiptPath: activationReceiptPath,
    expectedBody: expectedActivationBody,
    candidate,
  })
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    harnessCommit: HARNESS_COMMIT,
    permissionMode: 'workspace-write-private-host-deny-seatbelt-command',
    siblingWriteDenied: true,
    siblingReadDenied: true,
    outboundNetworkDenied: true,
    processMetadataDenied: true,
    ancestorEnvironmentCanaryProtected: true,
    workspaceWriteAllowed: true,
    taskToolchainAvailable: true,
    candidateActivated: candidateActivation !== null,
    paidModelCalls: 0,
  }))
} finally {
  await close(model)
  await rm(root, { recursive: true, force: true })
}
