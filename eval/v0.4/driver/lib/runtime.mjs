import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../lib/canonical.mjs'
import { configureProfile } from './profile.mjs'
import { inheritedRuntimeEnvironment, withoutEvaluationCapabilities } from './environment.mjs'
import { requireProxyCapabilities } from './proxy-capability.mjs'
import { countClarificationQuestions, parseSessionMetrics } from './session-metrics.mjs'

const driverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repositoryRoot = resolve(driverRoot, '..', '..', '..')
export const supportPluginRoot = join(driverRoot, 'support-plugin')

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

function runBuffered(command, args, options = {}) {
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let overflow
    let forceTimer
    const signalTree = (signal) => {
      if (child.pid === undefined) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    const terminate = () => {
      signalTree('SIGTERM')
      forceTimer ??= setTimeout(() => { signalTree('SIGKILL') }, 5_000)
    }
    const append = (target, chunk, stream) => {
      const bytes = Buffer.byteLength(chunk)
      if (stream === 'stdout') stdoutBytes += bytes
      else stderrBytes += bytes
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        overflow = Object.assign(new Error(`${stream} exceeded maxBuffer`), { code: 'ENOBUFS' })
        terminate()
        return
      }
      target.push(Buffer.from(chunk))
    }
    child.stdout.on('data', chunk => append(stdout, chunk, 'stdout'))
    child.stderr.on('data', chunk => append(stderr, chunk, 'stderr'))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      rejectRun(error)
    })
    const timer = options.timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeout)
    child.once('close', (status, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolveRun({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString(options.encoding ?? 'utf8'),
        stderr: Buffer.concat(stderr).toString(options.encoding ?? 'utf8'),
        error: overflow ?? (timedOut
          ? Object.assign(new Error('process timed out'), { code: 'ETIMEDOUT' })
          : undefined),
      })
    })
  })
}

export function gitHead(root) {
  return run('git', ['-C', root, 'rev-parse', 'HEAD']).stdout.trim()
}

export function assertExactCheckout(root, expected, name) {
  if (!root) throw new Error(`${name} root is not configured`)
  const actual = gitHead(resolve(root))
  if (actual !== expected) throw new Error(`${name} checkout mismatch: expected ${expected}, got ${actual}`)
  const status = spawnSync('git', ['-C', resolve(root), 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
  if (status.status !== 0 || status.stdout.trim() !== '') throw new Error(`${name} checkout is not clean`)
  return resolve(root)
}

export function resolveDshBin(harnessRoot) {
  const path = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const result = spawnSync(process.execPath, [path, '--version'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`built Harness CLI is unavailable at ${path}`)
  return path
}

async function materializeFrozenHarnessRuntime(runtimeArtifacts, harnessCommit, attemptDir) {
  const artifact = runtimeArtifacts?.hostHarness
  const artifactPath = artifact?.pathEnvironmentVariable ? process.env[artifact.pathEnvironmentVariable] : undefined
  if (!artifactPath) throw new Error('frozen host Harness runtime path is not configured')
  const bytes = await readFile(resolve(artifactPath))
  if (sha256(bytes) !== artifact.sha256) throw new Error('frozen host Harness runtime digest mismatch')
  const runtimeRoot = join(attemptDir, 'host-harness-runtime')
  await mkdir(runtimeRoot, { recursive: true })
  run('tar', ['-xzf', resolve(artifactPath), '-C', runtimeRoot])
  const metadata = JSON.parse(await readFile(join(runtimeRoot, 'runtime.json'), 'utf8'))
  if (metadata.harnessCommit !== harnessCommit
    || metadata.platform !== process.platform
    || metadata.architecture !== process.arch
    || metadata.node !== process.version) {
    throw new Error('frozen host Harness runtime metadata does not match this execution host')
  }
  const closureText = await readFile(join(runtimeRoot, 'dsh', 'package.json'), 'utf8')
  const closureManifest = JSON.parse(closureText)
  if (sha256(closureText) !== metadata.runtimeClosure?.sha256
    || Object.keys(closureManifest.dependencies ?? {}).length !== metadata.runtimeClosure?.dependencyCount
    || closureManifest.planLatticeRuntimeClosure?.reachableWorkspacePackages !== metadata.runtimeClosure?.reachableWorkspacePackages) {
    throw new Error('frozen host Harness runtime closure does not match its identity metadata')
  }
  const bin = join(runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('frozen host Harness runtime is not executable')
  return bin
}

export async function digestTree(root, filter = () => true) {
  const hash = createHash('sha256')
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const relative = path.slice(root.length + 1)
      if (!filter(relative, entry)) continue
      if (entry.isDirectory()) await visit(path)
      else {
        hash.update(relative)
        hash.update('\0')
        hash.update(await readFile(path))
        hash.update('\0')
      }
    }
  }
  await visit(root)
  return hash.digest('hex')
}

export async function packagePluginAtCommit(commit, outputRoot) {
  const current = gitHead(repositoryRoot)
  if (current !== commit) {
    const exists = spawnSync('git', ['-C', repositoryRoot, 'cat-file', '-e', `${commit}^{commit}`])
    if (exists.status !== 0) throw new Error(`plugin commit ${commit} is unavailable in the local repository`)
  }
  const source = await mkdtemp(join(tmpdir(), `plan-lattice-${commit.slice(0, 8)}-`))
  try {
    const archive = join(source, 'source.tar')
    run('git', ['-C', repositoryRoot, 'archive', '--format=tar', '-o', archive, commit])
    const checkout = join(source, 'checkout')
    await mkdir(checkout)
    run('tar', ['-xf', archive, '-C', checkout])
    const buildEnvironment = { ...withoutEvaluationCapabilities(), CI: '1' }
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout, env: buildEnvironment })
    run('pnpm', ['build'], { cwd: checkout, env: buildEnvironment })
    await mkdir(outputRoot, { recursive: true })
    const packed = run('pnpm', ['pack', '--pack-destination', outputRoot], { cwd: checkout, env: buildEnvironment }).stdout.trim().split(/\r?\n/).at(-1)
    if (!packed) throw new Error(`pnpm pack produced no tarball for ${commit}`)
    const path = resolve(checkout, packed)
    const destination = join(outputRoot, `dsh-plan-lattice-${commit}.tgz`)
    await import('node:fs/promises').then(({ copyFile }) => copyFile(path, destination))
    return { path: destination, digest: sha256(await readFile(destination)) }
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}

export function sanitized(text) {
  let scrubbed = text ?? ''
  for (const secret of [process.env.DEEPSEEK_API_KEY, process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN].filter(Boolean)) {
    scrubbed = scrubbed.split(secret).join('[REDACTED]')
  }
  return scrubbed.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
}

export async function runHarnessTask({
  runtimeArtifacts,
  harnessCommit,
  attemptDir,
  workspace,
  prompt,
  arm,
  pluginCommit,
  sessionId,
  oracle,
  forbiddenReadRoots = [],
  forbiddenNetworkPorts = [],
  timeoutMs,
}) {
  const proxy = requireProxyCapabilities(process.env)
  const dshBin = await materializeFrozenHarnessRuntime(runtimeArtifacts, harnessCommit, attemptDir)
  const dshHome = join(attemptDir, 'dsh-home')
  const processHome = join(attemptDir, 'process-home')
  const processTmp = join(attemptDir, 'tmp')
  const sessionsRoot = join(attemptDir, 'sessions')
  const oracleAudit = join(attemptDir, 'oracle-questions.jsonl')
  const packageRoot = join(attemptDir, 'packages')
  await Promise.all([
    mkdir(packageRoot, { recursive: true }),
    mkdir(processHome, { recursive: true }),
    mkdir(processTmp, { recursive: true }),
  ])
  const pluginPackage = pluginCommit ? (await packagePluginAtCommit(pluginCommit, packageRoot)).path : undefined
  await configureProfile({ dshBin, dshHome, supportPlugin: supportPluginRoot, pluginPackage, arm })
  const env = {
    ...inheritedRuntimeEnvironment(),
    HOME: processHome,
    TMPDIR: processTmp,
    DEEPSEEK_API_KEY: proxy.agentCapability,
    DEEPSEEK_BASE_URL: proxy.hostBaseURL,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TOOLS_MODE: 'native',
    DSH_PLAN_LATTICE_EVAL_SESSION_ID: sessionId,
    DSH_PLAN_LATTICE_SESSION_ROOT: sessionsRoot,
    DSH_PLAN_LATTICE_ORACLE_AUDIT_PATH: oracleAudit,
  }
  if (oracle) {
    env.DSH_PLAN_LATTICE_ORACLE_URL = oracle.url
    env.DSH_PLAN_LATTICE_ORACLE_TOKEN = oracle.token
  }
  const started = Date.now()
  const harnessArgs = [dshBin, '--profile', 'headless', prompt]
  let command = process.execPath
  let commandArgs = harnessArgs
  {
    if (process.platform !== 'darwin') throw new Error('host Harness process isolation is currently implemented only for the frozen Darwin host')
    const workspaceRoot = resolve(workspace)
    const roots = [...new Set([repositoryRoot, ...forbiddenReadRoots].map(path => resolve(path)))]
    if (roots.some(path => workspaceRoot === path || workspaceRoot.startsWith(`${path}/`))) {
      throw new Error('sandbox forbidden roots must not contain the agent workspace')
    }
    const escaped = roots.map(path => path.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))
    const deniedPorts = forbiddenNetworkPorts.map(port => {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('sandbox denied ports must be valid TCP ports')
      return `(remote tcp "*:${port}")`
    })
    // macOS 26 traps CoreFoundation/libdispatch initialization when process-info*
    // is denied. The upstream key is absent from every child environment and
    // argv, so filesystem and network boundaries are the relevant controls.
    const profile = `(version 1)\n(allow default)\n${escaped.map(path => `(deny file-read* (subpath "${path}"))\n(deny file-write* (subpath "${path}"))`).join('\n')}\n${deniedPorts.length === 0 ? '' : `(deny network-outbound ${deniedPorts.join(' ')})`}\n`
    command = '/usr/bin/sandbox-exec'
    commandArgs = ['-p', profile, process.execPath, ...harnessArgs]
  }
  const result = await runBuffered(command, commandArgs, {
    cwd: workspace,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  const durationMs = Date.now() - started
  const stdout = sanitized(result.stdout)
  const stderr = sanitized(result.stderr)
  await writeFile(join(attemptDir, 'harness.stdout.log'), stdout, 'utf8')
  await writeFile(join(attemptDir, 'harness.stderr.log'), stderr, 'utf8')
  let metrics
  let clarificationQuestions = 0
  let sessionEvidenceError
  try {
    metrics = await parseSessionMetrics(sessionsRoot, { expectedSessionId: sessionId })
    clarificationQuestions = await countClarificationQuestions(oracleAudit)
  } catch (error) {
    sessionEvidenceError = String(error?.message ?? error)
    metrics = {
      files: [],
      modelTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      transcriptDurationMs: 0,
      terminalReason: undefined,
      missingUsageEvents: 0,
    }
  }
  const timedOut = result.error?.code === 'ETIMEDOUT'
  if (result.status === 0 && !timedOut) {
    if (sessionEvidenceError) throw new Error(`successful Harness run has invalid durable session evidence: ${sessionEvidenceError}`)
    if (metrics.modelTurns < 1) throw new Error('successful Harness run recorded no durable model turn')
    if (metrics.missingUsageEvents !== 0) throw new Error('successful Harness run has model events without durable token usage')
    if (metrics.terminalReason?.kind !== 'completed') throw new Error('successful Harness run has no durable completed turn')
  }
  return {
    status: result.status,
    signal: result.signal,
    timedOut,
    stdout,
    stderr,
    durationMs,
    clarificationQuestions,
    sessionEvidenceError,
    ...metrics,
  }
}

export function classifyHarnessFailure(result) {
  if (result.timedOut) return { classification: 'task', code: 'model_timeout', message: 'Harness exceeded the frozen run timeout' }
  if (result.sessionEvidenceError) {
    return { classification: 'task', code: 'session_evidence_invalid', message: 'Harness failed without complete durable session evidence' }
  }
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.modelTurns === 0 && /(enospc|no space left)/.test(detail)) {
    return { classification: 'infrastructure', code: 'filesystem_capacity', message: 'Host filesystem capacity was exhausted before a model response' }
  }
  if (result.modelTurns === 0 && /(econnrefused|enotfound|dns|network is unreachable|socket hang up)/.test(detail)) {
    return { classification: 'infrastructure', code: 'host_network_outage', message: 'Model endpoint was unreachable before a model response' }
  }
  if (result.modelTurns === 0 && result.signal) {
    return { classification: 'task', code: 'agent_process_terminated', message: 'Harness terminated after execution began without a durable model response' }
  }
  if (result.modelTurns === 0 && result.status !== 0) {
    return { classification: 'task', code: 'agent_error', message: 'Harness exited after execution began without a durable model response; inspect the retained sanitized logs' }
  }
  return { classification: 'task', code: 'agent_error', message: 'Harness agent execution failed' }
}
