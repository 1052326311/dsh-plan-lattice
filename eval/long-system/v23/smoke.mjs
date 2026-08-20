#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { configureProfile } from '../../v0.4/driver/lib/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../v0.4/driver/lib/environment.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { packagePluginAtCommit, runHarnessTask } from './driver/runtime.mjs'
import { buildShellProbeCommand, SHELL_PROBE_TEST_FILE, verifyShellProbe } from './driver/shell-probe.mjs'
import { auditPersistentNativeContinuity } from './session-audit.mjs'
import {
  CANDIDATE_COMMIT,
  FREE_SMOKE_REPORT_PATH,
  HARNESS_COMMIT,
  PROTOCOL_ID,
} from './manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const runtimePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V23_HOST_RUNTIME
if (!runtimePath) throw new Error('PLAN_LATTICE_LONG_SYSTEM_V23_HOST_RUNTIME is required')
const keepArtifacts = process.argv.includes('--keep-artifacts')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}: ${(result.stderr || result.stdout || '').trim()}`)
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
  if (!address || typeof address === 'string') throw new Error('V23 loopback model did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  server.closeAllConnections?.()
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function workspaceDshFileCount(workspace) {
  try {
    return (await readdir(join(workspace, '.dsh'), { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).length
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

function requestUserTexts(payload) {
  return (payload.messages ?? [])
    .filter(message => message?.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
}

function writeSse(response, rows) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(`${rows.map(row => `data: ${typeof row === 'string' ? row : JSON.stringify(row)}`).join('\n\n')}\n\n`)
}

function textResponse(response, text) {
  writeSse(response, [
    { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } },
    '[DONE]',
  ])
}

function toolCallResponse(response, callId, name, args) {
  const encoded = JSON.stringify(args)
  const midpoint = Math.max(1, Math.floor(encoded.length / 2))
  writeSse(response, [
    { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0,
      id: callId,
      type: 'function',
      function: { name, arguments: encoded.slice(0, midpoint) },
    }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: encoded.slice(midpoint) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 13, completion_tokens: 5 } },
    '[DONE]',
  ])
}

function workflowTodos(stageId, advanced = false, complete = false) {
  const first = stageId === 'foundation'
    ? 'Implement the real shell probe'
    : stageId === 'delegated-summary'
      ? 'Delegate and verify the reporting summary'
      : `Inspect ${stageId} requirements and state`
  const second = `Verify ${stageId} completion evidence`
  return [
    { content: first, status: complete || advanced ? 'completed' : 'in_progress' },
    { content: second, status: complete ? 'completed' : advanced ? 'in_progress' : 'pending' },
  ]
}

function driveWorkflow(response, { stage, sessionId, toolResultIds, childPrompt, forbiddenReadablePath }) {
  const id = suffix => `v23-${stage.id}-${sessionId}-${suffix}`
  if (!toolResultIds.includes(id('todo-start'))) {
    toolCallResponse(response, id('todo-start'), 'todo_write', { todos: workflowTodos(stage.id) })
    return
  }
  if (!toolResultIds.includes(id('action'))) {
    if (stage.id === 'foundation') {
      toolCallResponse(response, id('action'), 'bash', {
        command: buildShellProbeCommand(forbiddenReadablePath),
        description: 'Verify real workspace execution boundary',
      })
      return
    }
    if (stage.id === 'delegated-summary') {
      toolCallResponse(response, id('action'), 'subagent_fork', {
        description: 'Summarize reporting contract',
        prompt: childPrompt,
        run_in_background: false,
      })
      return
    }
    toolCallResponse(response, id('action'), 'bash', {
      command: 'pwd',
      description: `Inspect ${stage.id} workspace`,
    })
    return
  }
  if ((stage.id === 'foundation' || stage.id === 'delegated-summary')
    && !toolResultIds.includes(id('post-action-verify'))) {
    toolCallResponse(response, id('post-action-verify'), 'bash', {
      command: `node --test '${SHELL_PROBE_TEST_FILE}'`,
      description: `Verify ${stage.id} after the last mutation`,
    })
    return
  }
  if (!toolResultIds.includes(id('todo-next'))) {
    toolCallResponse(response, id('todo-next'), 'todo_write', { todos: workflowTodos(stage.id, true) })
    return
  }
  if (!toolResultIds.includes(id('second-evidence'))) {
    toolCallResponse(response, id('second-evidence'), 'bash', {
      command: stage.id === 'foundation' || stage.id === 'delegated-summary'
        ? `node --test '${SHELL_PROBE_TEST_FILE}'`
        : 'pwd',
      description: `Record ${stage.id} final evidence`,
    })
    return
  }
  if (!toolResultIds.includes(id('todo-done'))) {
    toolCallResponse(response, id('todo-done'), 'todo_write', { todos: workflowTodos(stage.id, true, true) })
    return
  }
  textResponse(response, `V23_STAGE_${stage.id}_OK_AFTER_NATIVE_WORKFLOW`)
}

async function activate(proxy, attemptId) {
  const response = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify({ attemptId }),
  })
  assert.equal(response.status, 200, `failed to activate ${attemptId}`)
}

const driverCommit = run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD']).stdout.trim()
assert.match(driverCommit, /^[0-9a-f]{40}$/)
const clean = run('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all']).stdout.trim()
assert.equal(clean, '', 'V23 free CLI smoke requires a clean committed driver checkout')
run('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', CANDIDATE_COMMIT, driverCommit])

const runtimeBytes = await readFile(resolve(runtimePath))
const hostRuntimeSha256 = sha256(runtimeBytes)
const taskPath = join(repositoryRoot, 'eval/long-system/v23/task.json')
const task = JSON.parse(await readFile(taskPath, 'utf8'))
assert.equal(task.schemaVersion, 1)
assert.equal(task.stages.length, 5)
const supportSource = await readFile(join(repositoryRoot, 'eval/long-system/v23/driver/support-plugin/index.js'), 'utf8')
assert.doesNotMatch(supportSource, /subagents\s*\.\s*start/, 'evaluation support must not start a child outside the model-facing tool')
const delegatedStage = task.stages.find(stage => stage.id === 'delegated-summary')
assert.equal(delegatedStage?.actor, 'child')
const childPrompt = 'Read the current project requirements and implementation, then return a concise factual summary of the historical reporting behavior required by the task. Do not modify files.'

const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v23-cli-smoke-'))
try {
  const runtimeRoot = join(root, 'runtime')
  const packages = join(root, 'packages')
  await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(packages, { recursive: true })])
  run('tar', ['-xzf', resolve(runtimePath), '-C', runtimeRoot])
  const runtimeMetadata = JSON.parse(await readFile(join(runtimeRoot, 'runtime.json'), 'utf8'))
  assert.equal(runtimeMetadata.harnessCommit, HARNESS_COMMIT)
  const dshBin = join(runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  run(process.execPath, [dshBin, '--version'], { env: inheritedRuntimeEnvironment() })

  const candidate = await packagePluginAtCommit(CANDIDATE_COMMIT, packages)
  const support = join(repositoryRoot, 'eval/long-system/v23/driver/support-plugin')
  const candidateArm = {
    plugin: 'v0.4.0-candidate',
    activationMode: 'auto',
    clarificationPolicy: 'never',
    controlCeiling: 'lattice',
    shellAdapter: 'workspace-tree',
  }
  const profileA = await configureProfile({
    dshBin, dshHome: join(root, 'profile-a'), supportPlugin: support,
    pluginPackage: candidate.path, arm: candidateArm,
  })
  const profileB = await configureProfile({
    dshBin, dshHome: join(root, 'profile-b'), supportPlugin: support,
    pluginPackage: candidate.path, arm: candidateArm,
  })
  assert.equal(
    await readFile(join(profileA.profileDir, 'cordis.patch.yml'), 'utf8'),
    await readFile(join(profileB.profileDir, 'cordis.patch.yml'), 'utf8'),
    'fresh candidate installations produced different profiles',
  )
  const listed = run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'list'], {
    env: { ...inheritedRuntimeEnvironment(), DSH_HOME: join(root, 'profile-a') },
  })
  assert.match(`${listed.stdout}\n${listed.stderr}`, /dsh-plan-lattice@0\.4\.0-rc\.9/)

  const rootSessionIds = new Set()
  const upstreamRequests = []
  const modelErrors = []
  const model = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.once('end', () => {
      try {
        assert.equal(request.method, 'POST')
        assert.equal(request.url, '/chat/completions')
        const payload = JSON.parse(raw)
        const sessionId = String(request.headers['x-deepseek-harness-session-id'] ?? '')
        const compact = request.headers['x-deepseek-harness-compact'] === '1'
        const texts = requestUserTexts(payload)
        const stage = compact ? undefined : [...task.stages].reverse().find(item => {
          const message = item.message === '$INITIAL_PROMPT' ? task.initialPrompt : item.message
          return texts.includes(message)
        })
        const toolResultIds = (payload.messages ?? [])
          .filter(message => message?.role === 'tool')
          .map(message => String(message.tool_call_id ?? ''))
        upstreamRequests.push({ sessionId, compact, stageId: stage?.id ?? null, toolResultIds })
        if (compact) {
          textResponse(response, 'V23_COMPACTION_SUMMARY')
          return
        }
        // A forked child inherits completed parent messages, so its request can
        // still contain a root stage prompt. Its own exact user prompt and
        // distinct Session identity are the authoritative routing signals.
        if (texts.includes(childPrompt)) {
          assert.equal(rootSessionIds.has(sessionId), false, 'root Session must not impersonate the delegated child')
          textResponse(response, 'V23_CHILD_FOREGROUND_RESULT')
          return
        }
        assert.ok(stage, 'loopback received an unexpected non-compaction request')
        assert.ok(rootSessionIds.has(sessionId), 'only a root Session may execute a staged workflow')
        if (stage.id === 'foundation') {
          assert.equal((payload.tools ?? []).filter(tool => tool?.function?.name === 'bash').length, 1,
            'root request must expose exactly one Bash schema')
        }
        if (stage.id === delegatedStage.id) {
          assert.equal((payload.tools ?? []).filter(tool => tool?.function?.name === 'subagent_fork').length, 1,
            'root request must expose exactly one subagent_fork schema')
        }
        driveWorkflow(response, {
          stage,
          sessionId,
          toolResultIds,
          childPrompt,
          forbiddenReadablePath: join(repositoryRoot, 'package.json'),
        })
      } catch (error) {
        const message = String(error?.message ?? error)
        modelErrors.push({ method: request.method, url: request.url, message })
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: message })}\n`)
      }
    })
  })
  const modelBaseUrl = await listen(model)
  const keys = generateKeyPairSync('ed25519')
  const proxy = await startModelProxy({
    apiKey: 'v23-local-loopback-only',
    baseURL: modelBaseUrl,
    auditPath: join(root, 'proxy-audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'proxy-signing-ledger.jsonl'),
    signingLedgerId: `${PROTOCOL_ID}-free-smoke`,
    executionEnvelopeDigest: sha256(await readFile(taskPath)),
    host: '127.0.0.1',
  })
  const previous = Object.fromEntries([
    'PLAN_LATTICE_CREDENTIAL_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  ].map(name => [name, process.env[name]]))
  const armResults = []
  try {
    process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
    process.env.DEEPSEEK_API_KEY = proxy.token
    process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL
    const runtimeArtifacts = {
      hostHarness: {
        pathEnvironmentVariable: 'PLAN_LATTICE_LONG_SYSTEM_V23_HOST_RUNTIME',
        sha256: hostRuntimeSha256,
      },
    }
    const arms = [
      { id: 'native', plugin: 'none', shellAdapter: 'workspace-tree' },
      { id: 'v0.4-native-continuity', ...candidateArm },
    ]
    for (const arm of arms) {
      const attemptDir = join(root, `five-stage-${arm.id}`)
      const workspace = join(attemptDir, 'workspace')
      const sessionId = `plan-lattice-v23-free-smoke-${arm.id}`
      const attemptId = `${PROTOCOL_ID}-${arm.id}-free-smoke`
      rootSessionIds.add(sessionId)
      await mkdir(workspace, { recursive: true })
      await activate(proxy, attemptId)
      const stageProtocol = {
        schemaVersion: 1,
        taskId: task.id,
        stages: task.stages.map(stage => ({
          ...stage,
          message: stage.message === '$INITIAL_PROMPT' ? task.initialPrompt : stage.message,
          ...(stage.actor === 'root' ? { sessionId } : { parentSessionId: sessionId }),
        })),
      }
      const result = await runHarnessTask({
        runtimeArtifacts,
        harnessCommit: HARNESS_COMMIT,
        attemptDir,
        workspace,
        prompt: task.initialPrompt,
        arm,
        ...(arm.plugin === 'none' ? {} : { pluginCommit: CANDIDATE_COMMIT }),
        sessionId,
        attemptId,
        permissionMode: 'danger-full-access',
        timeoutMs: 180_000,
        maxRecoveryEpochs: 0,
        stageProtocol,
      })
      assert.equal(result.status, 0, `${result.stderr}\nloopback errors: ${JSON.stringify(modelErrors)}`)
      assert.equal(result.allStagesCompleted, true)
      assert.equal(result.stageCount, 5)
      assert.equal(result.processEpochs, 5)
      assert.ok(result.compactionSummaries >= 2)
      assert.ok(result.surfaceReplacements >= 2)
      assert.equal(result.foregroundDelegations.length, 1)
      assert.equal(result.controlToolCalls.length, 0, `${arm.id} exposed or used Plan Lattice control tools`)
      assert.equal(result.forbiddenAutomaticControlCalls.length, 0)
      assert.ok(result.todoWrites >= 15, `${arm.id} did not persist every native Todo transition`)
      assert.ok(result.completedTodoWrites >= 5, `${arm.id} did not complete one native Todo per stage`)
      assert.deepEqual(result.invalidTodoWrites, [], `${arm.id} persisted an invalid native Todo snapshot`)
      const delegation = result.foregroundDelegations[0]
      assert.equal(delegation.promptSha256, sha256(childPrompt))
      assert.ok(Number.isSafeInteger(delegation.childTerminalSeq))
      const continuity = await auditPersistentNativeContinuity(join(attemptDir, 'sessions'), {
        expectedSessionIds: [sessionId, delegation.childSessionId],
        maxSnapshotBytes: 65_536,
      })
      assert.equal(continuity.valid, true, JSON.stringify(continuity.violations))
      if (arm.id === 'native') {
        assert.equal(continuity.totalSnapshots, 0)
      } else {
        assert.ok(continuity.totalWorkflowSnapshots >= 5)
        assert.equal(continuity.totalDelegatedCapsules, 1)
      }
      assert.match(result.stdout, /V23_STAGE_delegated-summary_OK_AFTER_NATIVE_WORKFLOW/)
      assert.match(result.stdout, /V23_STAGE_foundation_OK_AFTER_NATIVE_WORKFLOW/)
      const shellProbe = await verifyShellProbe(workspace)
      const dshFiles = await workspaceDshFileCount(workspace)
      assert.equal(dshFiles, 0, `${arm.id} automatic path created workspace .dsh state`)
      armResults.push({
        id: arm.id,
        stageCount: result.stageCount,
        processEpochs: result.processEpochs,
        compactionSummaries: result.compactionSummaries,
        surfaceReplacements: result.surfaceReplacements,
        foregroundDelegations: result.foregroundDelegations.length,
        controlToolCalls: result.controlToolCalls.length,
        todoWrites: result.todoWrites,
        completedTodoWrites: result.completedTodoWrites,
        invalidTodoWrites: result.invalidTodoWrites.length,
        workflowSnapshots: continuity.totalWorkflowSnapshots,
        delegatedCapsules: continuity.totalDelegatedCapsules,
        maximumContextSnapshotBytes: continuity.maximumObservedSnapshotBytes,
        workspaceDshFiles: dshFiles,
        subagentToolSchemaSha256: delegation.toolSchemaSha256,
        childPromptSha256: delegation.promptSha256,
        shellProbe: {
          mutation: 'passed',
          nodeTest: 'passed',
          outerSandboxReadDenial: 'passed',
          testSourceSha256: sha256(shellProbe.testSourceSha256Input),
        },
      })
    }
    assert.equal(armResults[0].subagentToolSchemaSha256, armResults[1].subagentToolSchemaSha256)
    assert.equal(armResults[0].shellProbe.testSourceSha256, armResults[1].shellProbe.testSourceSha256)
  } finally {
    await activate(proxy, null)
    restoreEnvironment(previous)
    await close(proxy.server)
    await close(model)
  }

  const report = {
    schemaVersion: 1,
    protocolId: PROTOCOL_ID,
    status: 'passed',
    paidModelCalls: 0,
    candidateCommit: CANDIDATE_COMMIT,
    driverCommit,
    harnessCommit: HARNESS_COMMIT,
    candidatePackageSha256: candidate.digest,
    hostRuntimeSha256,
    installation: 'passed',
    fiveStageProxyLifecycle: 'passed',
    foregroundChildDurability: 'passed',
    matchedSubagentToolSchema: 'passed',
    realBashMutationAndNodeTest: 'passed',
    outerSandboxReadDenial: 'passed',
    dshPermissionMode: 'danger-full-access-inside-outer-evaluator-sandbox',
    candidateAutomaticControlCalls: armResults[1].controlToolCalls,
    candidateWorkspaceDshFiles: armResults[1].workspaceDshFiles,
    arms: armResults,
    upstreamModelRequests: upstreamRequests.length,
  }
  if (process.argv.includes('--write-report')) {
    await writeFile(FREE_SMOKE_REPORT_PATH, canonicalJson(report), 'utf8')
  }
  process.stdout.write(canonicalJson(report))
} finally {
  if (keepArtifacts) process.stderr.write(`V23 smoke artifacts retained at ${root}\n`)
  else await rm(root, { recursive: true, force: true })
}
