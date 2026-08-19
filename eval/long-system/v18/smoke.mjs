#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../v0.4/lib/canonical.mjs'
import { configureProfile } from '../../v0.4/driver/lib/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../v0.4/driver/lib/environment.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { packagePluginAtCommit, runHarnessTask } from './driver/runtime.mjs'
import { verifyV18Manifest } from './freeze.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const runtimePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V18_HOST_RUNTIME

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
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
  if (!address || typeof address === 'string') throw new Error('native lifecycle mock server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  server.closeAllConnections?.()
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
}

function requestUserTexts(payload) {
  return payload.messages
    .filter(message => message?.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

if (!runtimePath) throw new Error('PLAN_LATTICE_LONG_SYSTEM_V18_HOST_RUNTIME is required')

const manifest = await verifyV18Manifest()
const bytes = await readFile(resolve(runtimePath))
assert.equal(sha256(bytes), manifest.harness.hostRuntimeSha256, 'host runtime digest mismatch')

const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v18-smoke-'))
try {
  const runtimeRoot = join(root, 'runtime')
  const packages = join(root, 'packages')
  await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(packages, { recursive: true })])
  run('tar', ['-xzf', resolve(runtimePath), '-C', runtimeRoot])
  const dshBin = join(runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  run(process.execPath, [dshBin, '--version'], { env: inheritedRuntimeEnvironment() })

  const candidate = await packagePluginAtCommit(manifest.candidate.commit, packages)
  const support = join(repositoryRoot, 'eval/long-system/v18/driver/support-plugin')
  const common = {
    dshBin,
    supportPlugin: support,
    pluginPackage: candidate.path,
    arm: {
      plugin: 'v0.4.0-candidate',
      activationMode: 'auto',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      shellAdapter: 'workspace-tree',
    },
  }
  const first = await configureProfile({ ...common, dshHome: join(root, 'dsh-home-a') })
  const second = await configureProfile({ ...common, dshHome: join(root, 'dsh-home-b') })
  const firstPatch = await readFile(join(first.profileDir, 'cordis.patch.yml'), 'utf8')
  const secondPatch = await readFile(join(second.profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(firstPatch, secondPatch, 'fresh installations must receive the same profile patch')
  assert.match(firstPatch, /- id: plan-lattice\n  config:\n    activationMode: auto/)
  assert.doesNotMatch(firstPatch, /maxTokenContinuations:/)

  const check = run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'list'], {
    env: { ...inheritedRuntimeEnvironment(), DSH_HOME: join(root, 'dsh-home-a') },
  })
  assert.match(`${check.stdout}\n${check.stderr}`, /dsh-plan-lattice@0\.4\.0-rc\.7/)

  // This is a real rc.7 AgentLoop and process-restart lifecycle. A deterministic
  // loopback model keeps the smoke free, while every root, compaction, and child
  // request still crosses the exact frozen proxy contract used by the paid pair.
  const taskPath = join(repositoryRoot, 'eval/long-system/v18/task.json')
  const task = JSON.parse(await readFile(taskPath, 'utf8'))
  assert.equal(task.stages.length, 5, 'all five native lifecycle stages must be reachable before paid execution')
  const stageMessages = task.stages.map(stage => ({
    id: stage.id,
    text: stage.message === '$INITIAL_PROMPT' ? task.initialPrompt : stage.message,
  }))
  const upstreamRequests = []
  const model = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.once('end', () => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/chat/completions')
      const payload = JSON.parse(raw)
      const userTexts = requestUserTexts(payload)
      const compact = request.headers['x-deepseek-harness-compact'] === '1'
      const matchedStage = compact
        ? undefined
        : [...stageMessages].reverse().find(stage => userTexts.includes(stage.text))
      assert.ok(compact || matchedStage !== undefined, 'loopback received an unexpected agent request')
      upstreamRequests.push({
        sessionId: request.headers['x-deepseek-harness-session-id'],
        compact,
        stageId: matchedStage?.id,
      })
      const responseText = compact ? 'V18_COMPACTION_SUMMARY' : `V18_STAGE_${matchedStage.id}_OK`
      const delta = JSON.stringify({ choices: [{ delta: { content: responseText } }] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
        `data: ${delta}`,
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  const modelBaseUrl = await listen(model)
  const keys = generateKeyPairSync('ed25519')
  const proxyAuditPath = join(root, 'model-proxy-audit.jsonl')
  const proxy = await startModelProxy({
    apiKey: 'loopback-smoke-upstream-key',
    baseURL: modelBaseUrl,
    auditPath: proxyAuditPath,
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'model-proxy-signing-ledger.jsonl'),
    signingLedgerId: 'plan-lattice-v18-smoke-ledger',
    executionEnvelopeDigest: sha256(await readFile(taskPath)),
    host: '127.0.0.1',
  })
  const previous = Object.fromEntries([
    'PLAN_LATTICE_CREDENTIAL_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  ].map(name => [name, process.env[name]]))
  const activate = async attemptId => {
    const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
      body: JSON.stringify({ attemptId }),
    })
    assert.equal(response.status, 200, `failed to activate ${attemptId}`)
  }
  const smokeResults = []
  try {
    process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
    process.env.DEEPSEEK_API_KEY = proxy.token
    process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL
    const runtimeArtifacts = {
      hostHarness: {
        pathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V18_HOST_RUNTIME',
        sha256: manifest.harness.hostRuntimeSha256,
      },
    }
    const arms = [
      { id: 'native', plugin: 'none', shellAdapter: 'workspace-tree' },
      {
        id: 'v0.4-lattice', plugin: 'v0.4.0-candidate', activationMode: 'auto',
        clarificationPolicy: 'never', controlCeiling: 'lattice', shellAdapter: 'workspace-tree',
      },
    ]
    for (const arm of arms) {
      const attemptDir = join(root, `five-stage-${arm.id}`)
      const workspace = join(attemptDir, 'workspace')
      const sessionId = `plan-lattice-v18-smoke-${arm.id}`
      const attemptId = `v18-five-stage-${arm.id}-smoke`
      await mkdir(workspace, { recursive: true })
      await activate(attemptId)
      const stageProtocol = {
        schemaVersion: 1,
        stages: task.stages.map(stage => ({
          ...stage,
          message: stage.message === '$INITIAL_PROMPT' ? task.initialPrompt : stage.message,
          ...(stage.actor === 'root' ? { sessionId } : { parentSessionId: sessionId }),
        })),
      }
      const result = await runHarnessTask({
        runtimeArtifacts,
        harnessCommit: manifest.harness.commit,
        attemptDir,
        workspace,
        prompt: task.initialPrompt,
        arm,
        ...(arm.plugin === 'none' ? {} : { pluginCommit: manifest.candidate.commit }),
        sessionId,
        attemptId,
        permissionMode: 'workspace-write',
        timeoutMs: 120_000,
        maxRecoveryEpochs: 0,
        stageProtocol,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.allStagesCompleted, true)
      assert.equal(result.stageCount, 5)
      assert.deepEqual(result.stages.map(stage => stage.id), task.stages.map(stage => stage.id))
      assert.equal(result.processEpochs, 5)
      assert.ok(result.compactionSummaries >= 2)
      const childStage = result.stages.find(stage => stage.id === 'delegated-summary')
      assert.notEqual(childStage?.sessionId, sessionId, 'child stage must have its own native session')
      assert.equal(result.nativeSubagentEvidence.length, 1)
      assert.deepEqual(result.nativeSubagentEvidence[0], {
        type: 'subagent/start',
        runId: result.nativeSubagentEvidence[0].runId,
        provider: 'spawn',
        sessionId: childStage?.sessionId,
        local: true,
      })
      assert.match(result.stdout, /V18_STAGE_delegated-summary_OK/)
      smokeResults.push({ arm: arm.id, attemptId, sessionId, childSessionId: childStage.sessionId })
    }

    const audit = (await readFile(proxyAuditPath, 'utf8')).trim().split(/\r?\n/).map(row => JSON.parse(row))
    for (const result of smokeResults) {
      const requests = audit.filter(row => row.event === 'request'
        && row.role === 'agent' && row.attemptId === result.attemptId)
      assert.ok(requests.length >= 7, `${result.arm} must send five stage and two compaction requests through the proxy`)
      assert.equal(requests.every(row => row.contractValid === true), true)
      assert.equal(requests.filter(row => row.compact === true).length, 2)
      assert.ok(requests.some(row => row.sessionId === result.childSessionId && row.compact === false),
        'child model request must pass the frozen proxy contract')
    }
  } finally {
    await activate(null)
    restoreEnvironment(previous)
    await close(proxy.server)
    await close(model)
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    protocolId: manifest.protocolId,
    candidateCommit: manifest.candidate.commit,
    candidatePackageSha256: candidate.digest,
    hostRuntimeSha256: manifest.harness.hostRuntimeSha256,
    installation: 'passed',
    fiveStageProxyLifecycle: 'passed',
    arms: smokeResults.map(result => result.arm),
    upstreamModelRequests: upstreamRequests.length,
  }, null, 2)}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
