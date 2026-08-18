import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../lib/canonical.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { requireProxyCapabilities } from '../driver/lib/proxy-capability.mjs'
import { runHarnessTask } from '../driver/lib/runtime.mjs'
import { countClarificationQuestions, parseSessionMetrics } from '../driver/lib/session-metrics.mjs'
import { runHarnessTask as runPilotHarnessTask } from '../../pilots/driver/lib/runtime.mjs'

const evaluationRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(evaluationRoot, '..', '..')
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT
  ?? resolve(repositoryRoot, '..', 'deepseek-harness')
const harnessBin = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
const harnessBuilt = await access(harnessBin).then(() => true, () => false)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
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
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  if (!server.listening) return
  await new Promise(resolveClose => server.close(resolveClose))
}

async function fixtureHarnessArtifact(root, commit) {
  const archive = join(root, 'host-harness.tgz')
  await mkdir(root, { recursive: true })
  run(process.execPath, [
    join(evaluationRoot, 'driver', 'build-host-harness-runtime.mjs'),
    '--harness-root', harnessRoot,
    '--harness-commit', commit,
    '--output', archive,
  ], { env: { ...process.env, CI: '1' } })
  return { archive, digest: sha256(await readFile(archive)) }
}

test('proxy capability gate rejects a raw provider key and mismatched Docker endpoint', () => {
  assert.throws(() => requireProxyCapabilities({
    PLAN_LATTICE_CREDENTIAL_PROXY: '1',
    DEEPSEEK_API_KEY: 'raw-provider-key',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  }), /one-time agent proxy capability/)
  assert.throws(() => requireProxyCapabilities({
    PLAN_LATTICE_CREDENTIAL_PROXY: '1',
    DEEPSEEK_API_KEY: `plan-lattice-${'a'.repeat(64)}`,
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:41000',
    PLAN_LATTICE_DOCKER_MODEL_PROXY_URL: 'http://host.docker.internal:41001',
  }, { docker: true }), /same port/)
})

test('driver preflight is a zero-model-call fail-closed dry run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-driver-dry-'))
  const harnessCommit = run('git', ['-C', harnessRoot, 'rev-parse', 'HEAD']).stdout.trim()
  const spec = {
    run: { suite: 'simple', arm: { id: 'native', plugin: 'none' } },
    sourceCommits: { harness: harnessCommit },
    benchmarkRoots: { harness: harnessRoot },
    pluginCommits: { 'v0.3.0': 'a'.repeat(40), 'v0.4.0Candidate': 'UNRESOLVED_UNTIL_CODE_FREEZE' },
    runtimeArtifacts: {},
    expectedProvenance: { driverSourceDigest: '0'.repeat(64), runtimeArtifactsDigest: '0'.repeat(64) },
    routerBlindResultDigest: '0'.repeat(64),
    simpleTask: { language: 'JavaScript' },
  }
  const specPath = join(root, 'spec.json')
  await writeFile(specPath, JSON.stringify(spec), 'utf8')
  const env = {
    ...process.env,
    DEEPSEEK_API_KEY: 'raw-provider-key-must-be-rejected',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  }
  delete env.PLAN_LATTICE_CREDENTIAL_PROXY
  const result = spawnSync(process.execPath, [join(evaluationRoot, 'driver', 'dsh-driver.mjs'), '--preflight', specPath], {
    encoding: 'utf8',
    env,
  })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.checks.find(check => check.name === 'credential-proxy')?.ok, false)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /chat\/completions/)
  await rm(root, { recursive: true, force: true })
})

test('persistent session and question metrics fail closed on corrupt evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-session-evidence-'))
  const sessionDir = join(root, 'project', 'session')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, 'session.jsonl')
  await writeFile(path, [
    { type: 'session', id: 'expected-session', createdAt: 1 },
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 20, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 7, cacheReadTokens: 2, outputTokens: 3 } } },
    { type: 'turn/end', seq: 2, time: 30, data: { turn: 1, reason: { kind: 'completed' } } },
  ].map(JSON.stringify).join('\n') + '\n', 'utf8')
  const metrics = await parseSessionMetrics(root, { expectedSessionId: 'expected-session' })
  assert.deepEqual({
    modelTurns: metrics.modelTurns,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    durationMs: metrics.transcriptDurationMs,
    terminal: metrics.terminalReason,
  }, {
    modelTurns: 1,
    inputTokens: 9,
    outputTokens: 3,
    durationMs: 20,
    terminal: { kind: 'completed' },
  })
  const unrelated = join(root, 'other', 'session.jsonl')
  await mkdir(dirname(unrelated), { recursive: true })
  await writeFile(unrelated, [
    { type: 'session', id: 'unrelated-session', createdAt: 1 },
    { type: 'assistant/message', seq: 0, time: 100, data: { usage: { inputTokens: 1000, outputTokens: 1000 } } },
  ].map(JSON.stringify).join('\n') + '\n', 'utf8')
  const isolated = await parseSessionMetrics(root, { expectedSessionId: 'expected-session' })
  assert.equal(isolated.modelTurns, 1)
  assert.equal(isolated.inputTokens, 9)
  assert.equal(isolated.outputTokens, 3)
  assert.equal(isolated.files.length, 1)
  const audit = join(root, 'questions.jsonl')
  await writeFile(audit, `${JSON.stringify({ sequence: 1, questionDigest: 'b'.repeat(64) })}\n`, 'utf8')
  assert.equal(await countClarificationQuestions(audit), 1)
  await writeFile(path, '{not-json}\n', 'utf8')
  await assert.rejects(parseSessionMetrics(root), /invalid JSON|session header/)
  await writeFile(audit, '{"questionDigest":"bad"}\n', 'utf8')
  await assert.rejects(countClarificationQuestions(audit), /invalid record/)
  await rm(root, { recursive: true, force: true })
})

test('real frozen headless Harness runs through the host proxy and durable session store', {
  skip: process.platform !== 'darwin' || !harnessBuilt,
  timeout: 240_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-real-driver-'))
  const attemptDir = join(root, 'attempt')
  const workspace = join(root, 'workspace')
  await mkdir(attemptDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  const harnessCommit = run('git', ['-C', harnessRoot, 'rev-parse', 'HEAD']).stdout.trim()
  assert.match(harnessCommit, /^[0-9a-f]{40}$/)
  const artifact = await fixtureHarnessArtifact(join(root, 'artifact'), harnessCommit)
  const upstreamSecret = 'fixture-upstream-secret-never-enters-harness'
  let upstreamAuthorization
  let upstreamMode = 'normal'
  let recoveryRequests = 0
  const upstream = http.createServer((request, response) => {
    upstreamAuthorization = request.headers.authorization
    request.resume()
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (upstreamMode === 'recovery' && ++recoveryRequests === 1) {
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n')
      } else {
        const content = upstreamMode === 'recovery' ? 'RECOVERY_DRIVER_OK' : 'REAL_DRIVER_OK'
        for (const event of [
          '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
          `{"choices":[{"delta":{"content":"${content}"}}]}`,
          '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
          '[DONE]',
        ]) response.write(`data: ${event}\n\n`)
      }
      response.end()
    })
  })
  const upstreamURL = await listen(upstream)
  const keys = generateKeyPairSync('ed25519')
  const signingLedgerId = 'plan-lattice-rc4-real-driver-test'
  const executionEnvelopeDigest = 'e'.repeat(64)
  const proxy = await startModelProxy({
    apiKey: upstreamSecret,
    baseURL: upstreamURL,
    auditPath: join(root, 'proxy-audit.jsonl'),
    signingPrivateKeyBase64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingLedgerPath: join(root, 'signing-ledger.jsonl'),
    signingLedgerId,
    executionEnvelopeDigest,
    host: '127.0.0.1',
  })
  const activated = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
    body: JSON.stringify({ attemptId: 'real-driver-fixture-attempt' }),
  })
  assert.equal(activated.status, 200)
  const previous = Object.fromEntries([
    'PLAN_LATTICE_CREDENTIAL_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'PLAN_LATTICE_FIXTURE_HOST_RUNTIME',
    'PLAN_LATTICE_EVAL_ATTEMPT_ID',
  ].map(name => [name, process.env[name]]))
  try {
    process.env.PLAN_LATTICE_CREDENTIAL_PROXY = '1'
    process.env.DEEPSEEK_API_KEY = proxy.token
    process.env.DEEPSEEK_BASE_URL = proxy.hostBaseURL
    process.env.PLAN_LATTICE_FIXTURE_HOST_RUNTIME = artifact.archive
    const result = await runHarnessTask({
      runtimeArtifacts: {
        hostHarness: {
          pathEnvironmentVariable: 'PLAN_LATTICE_FIXTURE_HOST_RUNTIME',
          sha256: artifact.digest,
        },
      },
      harnessCommit,
      attemptDir,
      workspace,
      prompt: 'Reply exactly REAL_DRIVER_OK and do not call tools.',
      arm: { id: 'native', plugin: 'none' },
      sessionId: 'plan-lattice-real-driver-fixture',
      timeoutMs: 60_000,
    })
    assert.equal(result.status, 0, JSON.stringify({
      status: result.status,
      signal: result.signal,
      timedOut: result.timedOut,
      sessionEvidenceError: result.sessionEvidenceError,
      stdout: result.stdout,
      stderr: result.stderr,
    }, null, 2))
    assert.match(result.stdout, /REAL_DRIVER_OK/)
    assert.equal(result.modelTurns, 1)
    assert.equal(result.inputTokens, 7)
    assert.equal(result.outputTokens, 2)
    assert.equal(result.clarificationQuestions, 0)
    assert.deepEqual(result.terminalReason, { kind: 'completed' })
    assert.equal(upstreamAuthorization, `Bearer ${upstreamSecret}`)
    const logs = `${await readFile(join(attemptDir, 'harness.stdout.log'), 'utf8')}\n${await readFile(join(attemptDir, 'harness.stderr.log'), 'utf8')}`
    assert.doesNotMatch(logs, new RegExp(upstreamSecret))
    assert.doesNotMatch(logs, new RegExp(proxy.token))
    const profileManifest = await readFile(join(attemptDir, 'dsh-home', 'profiles', 'headless', 'package.json'), 'utf8')
    assert.doesNotMatch(profileManifest, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(profileManifest, /host-harness-runtime.*dsh.*node_modules.*dsh-plan-lattice-eval-support/)
    await access(join(attemptDir, 'process-home'))
    await access(join(attemptDir, 'tmp'))

    upstreamMode = 'recovery'
    const recoveryAttemptDir = join(root, 'recovery-attempt')
    const recoveryWorkspace = join(root, 'recovery-workspace')
    await mkdir(recoveryAttemptDir, { recursive: true })
    await mkdir(recoveryWorkspace, { recursive: true })
    const recoveryAttemptId = 'real-driver-recovery-attempt'
    const rebound = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plan-lattice-control': proxy.controlToken },
      body: JSON.stringify({ attemptId: recoveryAttemptId }),
    })
    assert.equal(rebound.status, 200)
    process.env.PLAN_LATTICE_EVAL_ATTEMPT_ID = recoveryAttemptId
    const recoveryContainerId = 'a'.repeat(64)
    const recovered = await runPilotHarnessTask({
      runtimeArtifacts: {
        hostHarness: {
          pathEnvironmentVariable: 'PLAN_LATTICE_FIXTURE_HOST_RUNTIME',
          sha256: artifact.digest,
        },
      },
      harnessCommit,
      attemptDir: recoveryAttemptDir,
      workspace: recoveryWorkspace,
      prompt: `Running container: \`${recoveryContainerId}\`. Reply exactly RECOVERY_DRIVER_OK and do not call tools.`,
      arm: { id: 'native', plugin: 'none', shellAdapter: 'icae-container' },
      sessionId: 'plan-lattice-real-driver-recovery-fixture',
      attemptId: recoveryAttemptId,
      timeoutMs: 60_000,
      maxRecoveryEpochs: 1,
    })
    assert.equal(recovered.status, 0, recovered.stderr)
    assert.equal(recovered.recoveryEpochs, 1)
    assert.equal(recoveryRequests, 2)
    assert.match(recovered.stdout, /RECOVERY_DRIVER_OK/)
    assert.deepEqual(recovered.terminalReason, { kind: 'completed' })
    const recoveryRows = (await readFile(join(recoveryAttemptDir, 'harness-recovery.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(recoveryRows.length, 1)
    assert.equal(recoveryRows[0].attemptId, recoveryAttemptId)
    assert.equal(recoveryRows[0].sessionId, 'plan-lattice-real-driver-recovery-fixture')
    assert.equal(recoveryRows[0].trigger, 'stream_closed')
    const sessionRows = (await readFile(recovered.files[0], 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    const humanMessages = sessionRows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user')
    const recoveryMessages = sessionRows.filter(row => row.type === 'user/message'
      && row.data?.source?.kind === 'plugin'
      && row.data?.source?.plugin === 'plan-lattice-pilot-support')
    assert.equal(humanMessages.length, 1)
    assert.equal(recoveryMessages.length, 1)
    assert.match(recoveryMessages[0].data.content[0].text, /same evaluation attempt/i)
    const recoveryProfile = await readFile(join(recoveryAttemptDir, 'dsh-home', 'profiles', 'headless', 'package.json'), 'utf8')
    assert.match(recoveryProfile, /dsh-plan-lattice-icae-native-wrapper/)
    assert.doesNotMatch(recoveryProfile, /dsh-plan-lattice-icae-wrapper"/)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await new Promise(resolveClose => proxy.server.close(resolveClose))
    await close(upstream)
    if (process.env.PLAN_LATTICE_KEEP_TEST_ARTIFACTS === '1') {
      process.stderr.write(`retained real-driver fixture at ${root}\n`)
    } else {
      await rm(root, { recursive: true, force: true })
    }
  }
})
