import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, verify } from 'node:crypto'
import http from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseEvoVerifierOutput, resolveRuntimeArtifact, summarizeEvoRounds } from '../driver/lib/evocode.mjs'
import { startModelProxy } from '../driver/model-proxy.mjs'
import { armPluginConfig, configureProfile } from '../driver/lib/profile.mjs'
import { classifyHarnessFailure, resolveDshBin, sanitized } from '../driver/lib/runtime.mjs'
import { parseSessionMetrics } from '../driver/lib/session-metrics.mjs'
import { gradeSimpleTask, materializeSimpleTask } from '../driver/lib/simple-grader.mjs'
import { readJson, sha256 } from '../lib/canonical.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = join(root, '..', '..')
const simpleTasks = (await readJson(join(root, 'simple-tasks.json'))).tasks
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT ?? '/Users/xin/Documents/openclaw开源贡献/deepseek-harness'
const harnessBuilt = await access(join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')).then(() => true, () => false)

async function canBindLoopback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', error => {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') resolve(false)
      else reject(error)
    })
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

const loopbackAvailable = await canBindLoopback()

test('arm configuration preserves the registered ablation semantics', () => {
  assert.equal(armPluginConfig({ plugin: 'none' }), undefined)
  assert.deepEqual(armPluginConfig({ plugin: 'v0.3.0' }), { intakeMode: 'off' })
  assert.deepEqual(armPluginConfig({
    plugin: 'v0.4.0-candidate',
    activationMode: 'always',
    clarificationPolicy: 'critical',
    controlCeiling: 'contract',
  }), {
    activationMode: 'always',
    clarificationPolicy: 'critical',
    controlCeiling: 'contract',
  })
})

test('support plugin forces the frozen model without embedding credentials', async () => {
  const source = await readFile(join(root, 'driver', 'support-plugin', 'index.js'), 'utf8')
  assert.match(source, /deepseek-v4-flash/)
  assert.match(source, /temperature:\s*0/)
  assert.match(source, /questionDigest/)
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{16,}/)
  const harborAgent = await readFile(join(root, 'driver', 'harbor_plan_lattice_agent.py'), 'utf8')
  assert.match(harborAgent, /"DSH_PERMISSION_MODE": "workspace-write"/)
  assert.doesNotMatch(harborAgent, /"DSH_PERMISSION_MODE": "danger-full-access"/)
})

test('driver log sanitization removes agent and Oracle proxy tokens', () => {
  const priorAgent = process.env.DEEPSEEK_API_KEY
  const priorOracle = process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN
  try {
    process.env.DEEPSEEK_API_KEY = 'plan-lattice-agent-test-token'
    process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN = 'plan-lattice-oracle-test-token'
    const output = sanitized('agent=plan-lattice-agent-test-token oracle=plan-lattice-oracle-test-token Authorization: Bearer third-token')
    assert.equal(output, 'agent=[REDACTED] oracle=[REDACTED] Authorization: Bearer [REDACTED]')
  } finally {
    if (priorAgent === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = priorAgent
    if (priorOracle === undefined) delete process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN
    else process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN = priorOracle
  }
})

test('credential proxy keeps the upstream key out of the model-facing request', { skip: !loopbackAvailable }, async () => {
  const auditRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-proxy-audit-'))
  const auditPath = join(auditRoot, 'requests.jsonl')
  const signingLedgerPath = join(auditRoot, 'signing.jsonl')
  let observedAuthorization
  const upstream = http.createServer((request, response) => {
    observedAuthorization = request.headers.authorization
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"usage":{"prompt_tokens":12,"completion_tokens":3}}')
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  const address = upstream.address()
  if (typeof address !== 'object' || address === null) throw new Error('test upstream did not bind')
  const upstreamURL = `http://127.0.0.1:${address.port}`
  const signingKeys = generateKeyPairSync('ed25519')
  const signingPrivateKeyBase64 = signingKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const signingPublicKeyBase64 = signingKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const proxy = await startModelProxy({
    apiKey: 'test-upstream-secret',
    baseURL: upstreamURL,
    auditPath,
    signingPrivateKeyBase64,
    signingLedgerPath,
  })
  try {
    const hiddenHealth = await fetch(`${proxy.hostBaseURL}/__plan_lattice_health`)
    assert.equal(hiddenHealth.status, 401)
    const healthResponse = await fetch(`${proxy.hostBaseURL}/__plan_lattice_health`, {
      headers: { 'x-plan-lattice-control': proxy.controlToken },
    })
    assert.equal(healthResponse.status, 200)
    assert.deepEqual(await healthResponse.json(), {
      pid: process.pid,
      upstreamEndpointDigest: sha256(upstreamURL),
      auditPathDigest: sha256(auditPath),
      signingPublicKeyDigest: sha256(Buffer.from(signingPublicKeyBase64, 'base64')),
    })
    const recordDigest = 'a'.repeat(64)
    const signed = await fetch(`${proxy.hostBaseURL}/__plan_lattice_sign`, {
      method: 'POST',
      headers: { 'x-plan-lattice-control': proxy.controlToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: 'signed-attempt-1',
        runId: 'run-1',
        attempt: 1,
        manifestDigest: 'b'.repeat(64),
        previousRecordDigest: '0'.repeat(64),
        recordDigest,
      }),
    })
    assert.equal(signed.status, 200)
    const { signature } = await signed.json()
    assert.equal(verify(null, Buffer.from(recordDigest, 'hex'), signingKeys.publicKey, Buffer.from(signature, 'base64')), true)
    const stale = await fetch(`${proxy.hostBaseURL}/__plan_lattice_sign`, {
      method: 'POST',
      headers: { 'x-plan-lattice-control': proxy.controlToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: 'signed-attempt-2',
        runId: 'run-1',
        attempt: 1,
        manifestDigest: 'b'.repeat(64),
        previousRecordDigest: '0'.repeat(64),
        recordDigest: 'c'.repeat(64),
      }),
    })
    assert.equal(stale.status, 400)
    assert.equal((await readFile(signingLedgerPath, 'utf8')).trim().split(/\r?\n/).length, 1)
    const restarted = await startModelProxy({
      apiKey: 'test-upstream-secret',
      baseURL: upstreamURL,
      auditPath,
      signingPrivateKeyBase64,
      signingLedgerPath,
    })
    try {
      const replay = await fetch(`${restarted.hostBaseURL}/__plan_lattice_sign`, {
        method: 'POST',
        headers: { 'x-plan-lattice-control': restarted.controlToken, 'content-type': 'application/json' },
        body: JSON.stringify({
          attemptId: 'signed-attempt-replay',
          runId: 'run-1',
          attempt: 1,
          manifestDigest: 'b'.repeat(64),
          previousRecordDigest: '0'.repeat(64),
          recordDigest: 'd'.repeat(64),
        }),
      })
      assert.equal(replay.status, 400)
    } finally {
      await new Promise(resolve => restarted.server.close(resolve))
    }
    const activated = await fetch(`${proxy.hostBaseURL}/__plan_lattice_attempt`, {
      method: 'POST',
      headers: { 'x-plan-lattice-control': proxy.controlToken, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-test-1' }),
    })
    assert.equal(activated.status, 200)
    const rejected = await fetch(`${proxy.hostBaseURL}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })
    assert.equal(rejected.status, 401)
    const wrongModel = await fetch(`${proxy.hostBaseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.token}`,
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'plan-lattice-test-session',
      },
      body: JSON.stringify({ model: 'other-model', temperature: 0, max_tokens: 32768, stream: true, stream_options: { include_usage: true } }),
    })
    assert.equal(wrongModel.status, 400)
    const accepted = await fetch(`${proxy.hostBaseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.token}`,
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'plan-lattice-test-session',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        temperature: 0,
        max_tokens: 32768,
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
    assert.equal(accepted.status, 200)
    assert.equal(observedAuthorization, 'Bearer test-upstream-secret')
    assert.notEqual(proxy.token, 'test-upstream-secret')
    const audit = (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).map(row => JSON.parse(row))
    assert.equal(audit.some(entry => entry.event === 'request' && entry.contractValid === false), true)
    assert.equal(audit.some(entry => entry.event === 'request' && entry.contractValid === true && entry.attemptId === 'attempt-test-1'), true)
    assert.equal(audit.some(entry => entry.event === 'response' && entry.usage?.promptTokens === 12 && entry.usage?.completionTokens === 3), true)
  } finally {
    await new Promise(resolve => proxy.server.close(resolve))
    await new Promise(resolve => upstream.close(resolve))
    await rm(auditRoot, { recursive: true, force: true })
  }
})

test('Linux runtime identity prevents one arm tarball from impersonating another', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-lattice-runtime-id-'))
  const runtimeRoot = join(directory, 'installed-agent', 'runtime')
  await mkdir(runtimeRoot, { recursive: true })
  const imageDigest = 'b'.repeat(64)
  const harnessCommit = 'c'.repeat(40)
  const nativeArm = { id: 'native', plugin: 'none' }
  const support = {
    package: '{"name":"test-support"}\n',
    patch: '- insert: []\n',
    source: 'export default {}\n',
  }
  const profilePatch = '- id: session-persistence-jsonl\n'
  const metadata = {
    schemaVersion: 1,
    arm: nativeArm,
    armDigest: sha256(nativeArm),
    harnessCommit,
    pluginCommit: null,
    pluginPackageDigest: null,
    baseImage: `node:22-bookworm@sha256:${imageDigest}`,
    supportDigest: sha256(support),
    profilePatchDigest: sha256(profilePatch),
  }
  await mkdir(join(runtimeRoot, 'packages', 'support'), { recursive: true })
  await mkdir(join(runtimeRoot, 'home', 'profiles', 'headless'), { recursive: true })
  await writeFile(join(runtimeRoot, 'packages', 'support', 'package.json'), support.package, 'utf8')
  await writeFile(join(runtimeRoot, 'packages', 'support', 'cordis.patch.yml'), support.patch, 'utf8')
  await writeFile(join(runtimeRoot, 'packages', 'support', 'index.js'), support.source, 'utf8')
  await writeFile(join(runtimeRoot, 'home', 'profiles', 'headless', 'cordis.patch.yml'), profilePatch, 'utf8')
  await writeFile(join(runtimeRoot, 'runtime.json'), JSON.stringify(metadata), 'utf8')
  const archive = join(directory, 'runtime.tgz')
  const packed = spawnSync('tar', ['-czf', archive, '-C', directory, 'installed-agent/runtime'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  const envName = 'PLAN_LATTICE_TEST_RUNTIME'
  process.env[envName] = archive
  const spec = {
    run: { arm: nativeArm },
    sourceCommits: { harness: harnessCommit },
    pluginCommits: { 'v0.3.0': 'd'.repeat(40), 'v0.4.0Candidate': 'e'.repeat(40) },
    runtimeArtifacts: {
      baseImage: { reference: 'node:22-bookworm', digest: imageDigest },
      artifacts: {
        native: {
          pathEnvironmentVariable: envName,
          sha256: sha256(await readFile(archive)),
          metadataDigest: sha256(metadata),
        },
      },
    },
  }
  try {
    assert.equal((await resolveRuntimeArtifact(spec)).metadata.arm.id, 'native')
    await writeFile(join(runtimeRoot, 'packages', 'support', 'index.js'), 'export default { tampered: true }\n', 'utf8')
    const tamperedArchive = join(directory, 'runtime-tampered.tgz')
    const repacked = spawnSync('tar', ['-czf', tamperedArchive, '-C', directory, 'installed-agent/runtime'], { encoding: 'utf8' })
    assert.equal(repacked.status, 0, repacked.stderr)
    process.env[envName] = tamperedArchive
    const tamperedSpec = {
      ...spec,
      runtimeArtifacts: {
        ...spec.runtimeArtifacts,
        artifacts: {
          native: { ...spec.runtimeArtifacts.artifacts.native, sha256: sha256(await readFile(tamperedArchive)) },
        },
      },
    }
    await assert.rejects(resolveRuntimeArtifact(tamperedSpec), /installed support or profile bytes/)
    process.env[envName] = archive
    const impersonated = {
      ...spec,
      run: { arm: { id: 'v0.4-lattice', plugin: 'v0.4.0-candidate', activationMode: 'always', clarificationPolicy: 'critical', controlCeiling: 'lattice' } },
      runtimeArtifacts: { ...spec.runtimeArtifacts, artifacts: { 'v0.4-lattice': spec.runtimeArtifacts.artifacts.native } },
    }
    await assert.rejects(resolveRuntimeArtifact(impersonated), /identity does not match/)
  } finally {
    delete process.env[envName]
    await rm(directory, { recursive: true, force: true })
  }
})

test('real Harness composes the support plugin in an isolated profile', { skip: !harnessBuilt }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-lattice-harness-profile-'))
  const dshBin = resolveDshBin(harnessRoot)
  await configureProfile({
    dshBin,
    dshHome: directory,
    supportPlugin: join(root, 'driver', 'support-plugin'),
    arm: { id: 'native', plugin: 'none' },
  })
  const env = { ...process.env, DSH_HOME: directory }
  delete env.DEEPSEEK_API_KEY
  const result = spawnSync(process.execPath, [dshBin, '--profile', 'headless', '--dump-config'], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /id: plan-lattice-eval-support/)
  assert.match(result.stdout, /id: session-persistence-jsonl/)
  assert.match(result.stdout, /id: session-title-llm[\s\S]*?disabled: true/)
  await rm(directory, { recursive: true, force: true })
})

test('session metrics use persistent events and include cache tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-lattice-session-'))
  const session = join(directory, 'session.jsonl')
  await writeFile(session, [
    { type: 'session', id: 'metrics-session', createdAt: 1 },
    { type: 'user/message', seq: 0, time: 1000, data: {} },
    { type: 'assistant/message', seq: 1, time: 1500, data: { usage: { inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 4 } } },
    { type: 'assistant/message', seq: 2, time: 2200, data: { usage: { inputTokens: 7, outputTokens: 5 } } },
    { type: 'compaction/summary', seq: 3, time: 2300, data: { usage: { inputTokens: 11, outputTokens: 6 } } },
  ].map(JSON.stringify).join('\n') + '\n', 'utf8')
  const metrics = await parseSessionMetrics(directory)
  assert.deepEqual({
    modelTurns: metrics.modelTurns,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    transcriptDurationMs: metrics.transcriptDurationMs,
  }, { modelTurns: 3, inputTokens: 33, outputTokens: 15, transcriptDurationMs: 1300 })
  await rm(directory, { recursive: true, force: true })
})

test('container metrics count durable compaction usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-lattice-container-session-'))
  const sessionRoot = join(directory, 'sessions', 'one')
  await mkdir(sessionRoot, { recursive: true })
  await writeFile(join(sessionRoot, 'session.jsonl'), [
    { type: 'session', id: 'container-session', createdAt: 1 },
    { type: 'assistant/message', seq: 0, time: 100, data: { usage: { inputTokens: 4, outputTokens: 2 } } },
    { type: 'compaction/summary', seq: 1, time: 200, data: { usage: { inputTokens: 6, cacheReadTokens: 1, outputTokens: 3 } } },
  ].map(JSON.stringify).join('\n') + '\n', 'utf8')
  const questions = join(directory, 'questions.jsonl')
  await writeFile(questions, '', 'utf8')
  const result = spawnSync(process.execPath, [
    join(root, 'driver', 'container-session-metrics.mjs'),
    join(directory, 'sessions'),
    questions,
    'container-session',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    modelTurns: 2,
    inputTokens: 11,
    outputTokens: 5,
    clarificationQuestions: 0,
    transcriptDurationMs: 100,
  })
  await rm(directory, { recursive: true, force: true })
})

test('an unproven zero-turn Harness exit cannot authorize a rerun', () => {
  assert.deepEqual(classifyHarnessFailure({
    timedOut: false,
    stderr: 'profile composition failed',
    stdout: '',
    modelTurns: 0,
    status: 1,
    signal: null,
  }), {
    classification: 'task',
    code: 'agent_error',
    message: 'Harness exited after execution began without a durable model response; inspect the retained sanitized logs',
  })
})

test('EvoCode case identities count each historical regression once', () => {
  const round1 = parseEvoVerifierOutput(`
CASE_RESULT case_id=a origin_step=1 requirement_ref=old-a case_type=core status=success intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_RESULT case_id=b origin_step=1 requirement_ref=old-b case_type=core status=success intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_SUMMARY total_cases=2 success_count=2 fail_count=0
`, 1)
  const round2 = parseEvoVerifierOutput(`
CASE_RESULT case_id=a origin_step=1 requirement_ref=old-a case_type=core status=fail intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_RESULT case_id=b origin_step=1 requirement_ref=old-b case_type=core status=success intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_RESULT case_id=c origin_step=2 requirement_ref=new-c case_type=core status=success intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_SUMMARY total_cases=3 success_count=2 fail_count=1
`, 2)
  const round3 = parseEvoVerifierOutput(`
CASE_RESULT case_id=a origin_step=1 requirement_ref=old-a case_type=core status=fail intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_RESULT case_id=b origin_step=1 requirement_ref=old-b case_type=core status=fail intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_RESULT case_id=c origin_step=2 requirement_ref=new-c case_type=core status=success intent="" scenario="" input="" expected="" actual="" failure_reason=""
CASE_SUMMARY total_cases=3 success_count=1 fail_count=2
`, 3)
  const summary = summarizeEvoRounds([round3, round1, round2])
  assert.equal(summary.historicalRequirementRegressions, 2)
  assert.ok(Math.abs(summary.cumulativeCaseScore - 66.66666666666667) < 1e-9)
  assert.throws(() => summarizeEvoRounds([{ round: 1, total: 1, successes: 1, failures: 0, cases: [] }]), /missing CASE_RESULT/)
})

const solutions = {
  'simple-js-clamp': `export function clamp(value, min, max) { if (min > max) throw new RangeError('bounds'); return Math.min(max, Math.max(min, value)) }\n`,
  'simple-ts-slugify': `export function slugify(input: string): string { return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }\n`,
  'simple-python-whitespace': `def normalize_whitespace(value: str) -> str:\n    return ' '.join(value.split())\n`,
  'simple-go-dedupe': `package dedupe\n\nfunc DedupeStable(values []string) []string {\n\tif values == nil { return nil }\n\tout := make([]string, 0, len(values))\n\tseen := map[string]bool{}\n\tfor _, value := range values { if !seen[value] { seen[value] = true; out = append(out, value) } }\n\treturn out\n}\n`,
  'simple-js-parse-port': `export function parsePort(value) { if (typeof value !== 'string') throw new TypeError('string'); const text = value.trim(); if (!/^[0-9]+$/.test(text)) throw new RangeError('port'); const port = Number(text); if (port < 1 || port > 65535) throw new RangeError('port'); return port }\n`,
  'simple-python-chunks': `def chunks(items, size):\n    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:\n        raise ValueError('size')\n    return [list(items[i:i + size]) for i in range(0, len(items), size)]\n`,
}

const targets = {
  'simple-js-clamp': 'src/clamp.js',
  'simple-ts-slugify': 'src/slugify.ts',
  'simple-python-whitespace': 'text_utils.py',
  'simple-go-dedupe': 'dedupe.go',
  'simple-js-parse-port': 'src/port.js',
  'simple-python-chunks': 'chunks.py',
}

for (const task of simpleTasks) {
  const goAvailable = spawnSync('go', ['version']).status === 0
  test(`hidden simple grader accepts a complete ${task.id} solution`, { skip: task.language === 'Go' && !goAvailable }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), `${task.id}-`))
    await materializeSimpleTask(task, workspace)
    await writeFile(join(workspace, targets[task.id]), solutions[task.id], 'utf8')
    const grade = await gradeSimpleTask(task, workspace)
    assert.equal(grade.score, grade.maxScore)
    assert.match(grade.graderDigest, /^[0-9a-f]{64}$/)
    await rm(workspace, { recursive: true, force: true })
  })

  test(`hidden simple grader rejects the initial ${task.id} stub`, { skip: task.language === 'Go' && !goAvailable }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), `${task.id}-bad-`))
    await materializeSimpleTask(task, workspace)
    const grade = await gradeSimpleTask(task, workspace)
    assert.ok(grade.score < grade.maxScore)
    await rm(workspace, { recursive: true, force: true })
  })
}

test('driver preflight reports the retained blind-gate failure without a key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-lattice-preflight-'))
  const manifest = await readJson(join(root, 'frozen-manifest.json'))
  const lock = await readJson(join(root, 'benchmark-lock.json'))
  const runtimeArtifacts = await readJson(join(root, 'runtime-artifacts.json'))
  const run = manifest.infrastructureRuns.find((entry) => entry.suite === 'simple' && entry.arm.id === 'native')
  const spec = {
    run,
    model: manifest.model,
    pluginCommits: manifest.pluginCommits,
    sourceCommits: manifest.sourceCommits,
    runtimeArtifacts,
    routerBlindResultDigest: manifest.routerBlindResultDigest,
    expectedProvenance: {
      harnessCommit: manifest.sourceCommits.harness,
      modelId: manifest.model.modelId,
      modelConfigDigest: sha256(manifest.model),
      runtimePolicyDigest: sha256(manifest.runtimePolicy),
      endpointDigest: sha256('provider-default'),
      sourceLockDigest: manifest.sourceLockDigest,
      runtimeArtifactsDigest: manifest.runtimeArtifactsDigest,
      driverSourceDigest: manifest.driverSourceDigest,
      pluginCommit: null,
    },
    simpleTask: simpleTasks[0],
    benchmarkRoots: {
      harness: '/Users/xin/Documents/openclaw开源贡献/deepseek-harness',
      harbor: '/Users/xin/Documents/openclaw开源贡献/benchmarks/harbor',
      icae: '/Users/xin/Documents/openclaw开源贡献/benchmarks/ICAE-EVAL',
      evocode: '/Users/xin/Documents/openclaw开源贡献/benchmarks/EvoCodeBench',
    },
  }
  const path = join(directory, 'spec.json')
  await writeFile(path, JSON.stringify(spec), 'utf8')
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  const result = spawnSync(process.execPath, [join(root, 'driver', 'dsh-driver.mjs'), '--preflight', path], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.checks.find((entry) => entry.name === 'router-blind-release-gate').ok, false)
  assert.equal(payload.checks.find((entry) => entry.name === 'api-key-environment').ok, false)
  await rm(directory, { recursive: true, force: true })
})

test('driver source does not contain credential-shaped literals', async () => {
  const source = await readFile(join(root, 'driver', 'dsh-driver.mjs'), 'utf8')
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(source, /DEEPSEEK_API_KEY\s*[:=]\s*['"][^'"]+/)
  assert.ok(repositoryRoot)
})

test('evaluation entrypoints bind the repository driver and a frozen Harness runtime', async () => {
  const runSource = await readFile(join(root, 'run.mjs'), 'utf8')
  const runtimeSource = await readFile(join(root, 'driver', 'lib', 'runtime.mjs'), 'utf8')
  assert.match(runSource, /must resolve to the frozen repository-owned driver/)
  assert.match(runSource, /driverSourceDigest/)
  assert.match(runtimeSource, /materializeFrozenHarnessRuntime/)
  assert.match(runtimeSource, /DSH_PERMISSION_MODE: 'workspace-write'/)
  assert.match(runtimeSource, /forbiddenReadRoots/)
  const ignored = spawnSync('git', ['-C', repositoryRoot, 'check-ignore', 'eval/v0.4/driver/lib/preflight.mjs'])
  assert.notEqual(ignored.status, 0)
})

test('ICAE question relay enforces its private capability and one agent call', { skip: !loopbackAvailable }, () => {
  const script = `
import importlib.util, pathlib, tempfile, urllib.error, urllib.request
path = pathlib.Path(${JSON.stringify(join(root, 'driver', 'icae_adapter.py'))})
spec = importlib.util.spec_from_file_location('icae_adapter_under_test', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    relay = module.QuestionRelay('append', 'task', pathlib.Path(directory) / 'audit.jsonl')
    with relay:
        request = urllib.request.Request(relay.url, data=b'{}', method='POST')
        try:
            urllib.request.urlopen(request, timeout=5)
            raise AssertionError('relay accepted a request without its capability')
        except urllib.error.HTTPError as error:
            assert error.code == 401
print('ok')
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'ok')
  const source = spawnSync('python3', ['-c', `print(open(${JSON.stringify(join(root, 'driver', 'icae_adapter.py'))}).read())`], { encoding: 'utf8' })
  assert.equal(source.status, 0, source.stderr)
  assert.match(source.stdout, /statistics service did not complete/)
  assert.match(source.stdout, /statistics omitted missed_constraints/)
})

test('analysis remains blocked when the candidate and runtime artifacts are unresolved', () => {
  const result = spawnSync(process.execPath, [join(root, 'analyze.mjs')], { encoding: 'utf8' })
  assert.equal(result.status, 3, result.stderr)
  const analysis = JSON.parse(result.stdout)
  assert.equal(analysis.releaseAllowed, false)
  assert.equal(analysis.integrity.gates.find(gate => gate.name.includes('controller, manifest'))?.passed, false)
})
