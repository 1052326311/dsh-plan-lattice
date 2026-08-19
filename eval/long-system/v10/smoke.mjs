#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../v0.4/lib/canonical.mjs'
import { configureProfile } from './driver/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../v0.4/driver/lib/environment.mjs'
import { packagePluginAtCommit, runHarnessTask } from './driver/runtime.mjs'
import { verifyV10Manifest } from './freeze.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const runtimePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V10_HOST_RUNTIME

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

const MAX_TOKEN_CONTINUATION_TEXT = '[plan-lattice/max-token-continuation] Continue the same accepted task from the durable session state. Preserve human authority and boundaries; execute the next incomplete acceptance item.'

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

if (!runtimePath) throw new Error('PLAN_LATTICE_LONG_SYSTEM_V10_HOST_RUNTIME is required')

const manifest = await verifyV10Manifest()
const bytes = await readFile(resolve(runtimePath))
assert.equal(sha256(bytes), manifest.harness.hostRuntimeSha256, 'host runtime digest mismatch')

const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v10-smoke-'))
try {
  const runtimeRoot = join(root, 'runtime')
  const packages = join(root, 'packages')
  await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(packages, { recursive: true })])
  run('tar', ['-xzf', resolve(runtimePath), '-C', runtimeRoot])
  const dshBin = join(runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  run(process.execPath, [dshBin, '--version'], { env: inheritedRuntimeEnvironment() })

  const candidate = await packagePluginAtCommit(manifest.candidate.commit, packages)
  const support = join(repositoryRoot, 'eval/long-system/v10/driver/support-plugin')
  const common = {
    dshBin,
    supportPlugin: support,
    pluginPackage: candidate.path,
    arm: {
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
      clarificationPolicy: 'never',
      controlCeiling: 'lattice',
      maxTokenContinuations: 2,
      shellAdapter: 'workspace-tree',
    },
  }
  const first = await configureProfile({ ...common, dshHome: join(root, 'dsh-home-a') })
  const second = await configureProfile({ ...common, dshHome: join(root, 'dsh-home-b') })
  const firstPatch = await readFile(join(first.profileDir, 'cordis.patch.yml'), 'utf8')
  const secondPatch = await readFile(join(second.profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(firstPatch, secondPatch, 'fresh installations must receive the same profile patch')
  assert.match(firstPatch, /- id: plan-lattice\n  config:\n    activationMode: always/)
  assert.match(firstPatch, /maxTokenContinuations: 2/)

  const check = run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'list'], {
    env: { ...inheritedRuntimeEnvironment(), DSH_HOME: join(root, 'dsh-home-a') },
  })
  assert.match(`${check.stdout}\n${check.stderr}`, /dsh-plan-lattice@0\.4\.0-rc\.7/)

  // This is deliberately a real rc.7 AgentLoop run, not a mocked subagent
  // service. The loopback model gives deterministic text-only completions so
  // the test can inspect the exact serialized child request without a paid key.
  const rootPrompt = 'Root lifecycle probe: reply exactly ROOT_NATIVE_LIFECYCLE_OK.'
  const delegatedPrompt = 'Native delegated child lifecycle probe: reply exactly CHILD_NATIVE_LIFECYCLE_OK.'
  const continuationPrompt = 'Build a small complete system from the written requirements. Continue work until the next incomplete acceptance item is complete.'
  const requests = []
  let continuationRequestCount = 0
  const model = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.once('end', () => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/chat/completions')
      const payload = JSON.parse(raw)
      requests.push(payload)
      const userTexts = requestUserTexts(payload)
      let responseText
      let finishReason = 'stop'
      if (userTexts.includes(continuationPrompt)) {
        continuationRequestCount += 1
        if (continuationRequestCount === 1) {
          responseText = 'CONTINUATION_FIRST_OUTPUT'
          finishReason = 'length'
        } else {
          assert.equal(userTexts.includes(MAX_TOKEN_CONTINUATION_TEXT), true,
            'the second request must be DSH native followup carrying the durable continuation marker')
          responseText = 'CONTINUATION_RESUMED_OUTPUT'
        }
      } else if (userTexts.includes(delegatedPrompt)) {
        responseText = 'CHILD_NATIVE_LIFECYCLE_OK'
      } else if (userTexts.includes(rootPrompt)) {
        responseText = 'ROOT_NATIVE_LIFECYCLE_OK'
      }
      assert.notEqual(responseText, undefined, 'mock received an unexpected agent request')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
        `data: {"choices":[{"delta":{"content":"${responseText}"}}]}`,
        `data: {"choices":[{"delta":{"content":""},"finish_reason":"${finishReason}"}],"usage":{"prompt_tokens":11,"completion_tokens":3}}`,
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  const modelBaseUrl = await listen(model)
  const previous = Object.fromEntries([
    'PLAN_LATTICE_CREDENTIAL_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  ].map(name => [name, process.env[name]]))
  try {
    process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
    process.env.DEEPSEEK_API_KEY = `plan-lattice-${'c'.repeat(64)}`
    process.env.DEEPSEEK_BASE_URL = modelBaseUrl
    const runtimeArtifacts = {
      hostHarness: {
        pathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V10_HOST_RUNTIME',
        sha256: manifest.harness.hostRuntimeSha256,
      },
    }
    const arms = [
      { id: 'native', plugin: 'none', shellAdapter: 'workspace-tree' },
      {
        id: 'v0.4-lattice', plugin: 'v0.4.0-candidate', activationMode: 'always',
        clarificationPolicy: 'never', controlCeiling: 'lattice', maxTokenContinuations: 2, shellAdapter: 'workspace-tree',
      },
    ]
    for (const arm of arms) {
      const attemptDir = join(root, `native-child-${arm.id}`)
      const workspace = join(attemptDir, 'workspace')
      const sessionId = `native-child-lifecycle-${arm.id}`
      await mkdir(workspace, { recursive: true })
      const requestOffset = requests.length
      const result = await runHarnessTask({
        runtimeArtifacts,
        harnessCommit: manifest.harness.commit,
        attemptDir,
        workspace,
        prompt: rootPrompt,
        arm,
        ...(arm.plugin === 'none' ? {} : { pluginCommit: manifest.candidate.commit }),
        sessionId,
        attemptId: `native-child-lifecycle-${arm.id}-smoke`,
        permissionMode: 'workspace-write',
        timeoutMs: 120_000,
        maxRecoveryEpochs: 0,
        stageProtocol: {
          schemaVersion: 1,
          stages: [
            { id: 'root', actor: 'root', sessionId, source: 'user', message: rootPrompt },
            { id: 'child', actor: 'child', parentSessionId: sessionId, source: 'plugin', message: delegatedPrompt },
          ],
        },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.allStagesCompleted, true)
      assert.equal(result.stageCount, 2)
      assert.equal(result.stages[1]?.sessionId === sessionId, false, 'child stage must have its own native session')
      assert.equal(result.nativeSubagentEvidence.length, 1)
      assert.deepEqual(result.nativeSubagentEvidence[0], {
        type: 'subagent/start',
        runId: result.nativeSubagentEvidence[0].runId,
        provider: 'spawn',
        sessionId: result.stages[1]?.sessionId,
        local: true,
      })
      assert.match(result.stdout, /CHILD_NATIVE_LIFECYCLE_OK/)

      const armRequests = requests.slice(requestOffset)
      assert.equal(armRequests.length, 2, 'root and child each make exactly one model request')
      const rootUserTexts = requestUserTexts(armRequests[0])
      assert.equal(rootUserTexts.filter(text => text === rootPrompt).length, 1)
      assert.equal(rootUserTexts.includes(delegatedPrompt), false)
      const childUserTexts = requestUserTexts(armRequests[1])
      assert.equal(childUserTexts.filter(text => text === delegatedPrompt).length, 1)
      assert.equal(childUserTexts.includes(rootPrompt), false, 'spawned child must not receive parent conversation as a user message')
    }

    const continuationAttemptDir = join(root, 'native-max-token-continuation')
    const continuationWorkspace = join(continuationAttemptDir, 'workspace')
    await mkdir(continuationWorkspace, { recursive: true })
    const continuation = await runHarnessTask({
      runtimeArtifacts,
      harnessCommit: manifest.harness.commit,
      attemptDir: continuationAttemptDir,
      workspace: continuationWorkspace,
      prompt: continuationPrompt,
      arm: arms[1],
      pluginCommit: manifest.candidate.commit,
      sessionId: 'native-max-token-continuation',
      attemptId: 'native-max-token-continuation-smoke',
      permissionMode: 'workspace-write',
      timeoutMs: 120_000,
      maxRecoveryEpochs: 0,
    })
    assert.equal(continuation.status, 0, continuation.stderr)
    assert.equal(continuation.terminalReason?.kind, 'completed')
    assert.equal(continuation.nativeMaxTokenContinuations, 1)
    assert.equal(continuationRequestCount, 2)
    assert.match(continuation.stdout, /CONTINUATION_RESUMED_OUTPUT/)
  } finally {
    restoreEnvironment(previous)
    await close(model)
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    protocolId: manifest.protocolId,
    candidateCommit: manifest.candidate.commit,
    candidatePackageSha256: candidate.digest,
    hostRuntimeSha256: manifest.harness.hostRuntimeSha256,
    installation: 'passed',
    nativeChildLifecycle: 'passed',
    nativeMaxTokenContinuation: 'passed',
    modelRequests: requests.length,
  }, null, 2)}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
