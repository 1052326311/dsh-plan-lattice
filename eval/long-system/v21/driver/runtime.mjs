import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, cp, mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import { configureProfile } from '../../../v0.4/driver/lib/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../../v0.4/driver/lib/environment.mjs'
import { requireProxyCapabilities } from '../../../v0.4/driver/lib/proxy-capability.mjs'
import { assertDurableNativeForegroundDelegation } from './foreground-lifecycle.mjs'
import { countClarificationQuestions, parseSessionMetrics } from './session-metrics.mjs'

const driverRoot = resolve(dirname(fileURLToPath(import.meta.url)))
export const repositoryRoot = resolve(driverRoot, '..', '..', '..', '..')
export const supportPluginRoot = resolve(driverRoot, 'support-plugin')

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
    const buildHome = join(source, 'build-home')
    const buildTmp = join(source, 'build-tmp')
    await Promise.all([mkdir(buildHome), mkdir(buildTmp)])
    const buildEnvironment = {
      ...inheritedRuntimeEnvironment(),
      HOME: buildHome,
      TMPDIR: buildTmp,
      CI: '1',
    }
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

export function sanitized(text, additionalSecrets = []) {
  let scrubbed = text ?? ''
  for (const secret of [
    process.env.DEEPSEEK_API_KEY,
    process.env.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN,
    ...additionalSecrets,
  ].filter(Boolean)) {
    scrubbed = scrubbed.split(secret).join('[REDACTED]')
  }
  return scrubbed.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
}

const harnessPermissionModes = new Set(['read-only', 'workspace-write', 'danger-full-access'])

export function resolveHarnessPermissionMode(permissionMode = 'workspace-write') {
  if (!harnessPermissionModes.has(permissionMode)) {
    throw new Error(`unsupported Harness permission mode: ${String(permissionMode)}`)
  }
  return permissionMode
}

export function recoverableHarnessTerminal(reason) {
  return reason?.kind === 'error' && reason.error?.code === 'STREAM_CLOSED'
    ? 'stream_closed'
    : reason?.kind === 'interrupted'
      ? 'interrupted'
      : undefined
}

async function appendDurableJsonl(path, record) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.write(`${JSON.stringify(record)}\n`, null, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function extractIcaeContainerId(prompt) {
  const matches = [...String(prompt).matchAll(/container ID is `([0-9a-f]{64})`|Running container: `([0-9a-f]{64})`/g)]
    .map(match => match[1] ?? match[2])
  const unique = [...new Set(matches)]
  if (unique.length !== 1) throw new Error('ICAE prompt must bind exactly one full container identity')
  return unique[0]
}

async function materializeIcaeWrapper(attemptDir, pluginPackage) {
  const candidate = pluginPackage !== undefined
  const source = join(driverRoot, candidate ? 'candidate-wrapper' : 'native-wrapper')
  const destination = join(attemptDir, 'eval-plugins', candidate ? 'plan-lattice-candidate-wrapper' : 'plan-lattice-native-wrapper')
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: true })
  if (!candidate) {
    for (const name of ['common-boundary.js', 'common-prompt.js', 'shell-adapter.js', 'tool-boundary.js']) {
      await copyFile(join(driverRoot, 'candidate-wrapper', name), join(destination, name))
    }
  }
  const manifestPath = join(destination, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (candidate) manifest.dependencies = { 'dsh-plan-lattice': `file:${resolve(pluginPackage)}` }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const packageRoot = join(attemptDir, 'packages')
  await mkdir(packageRoot, { recursive: true })
  const packEnvironment = {
    ...inheritedRuntimeEnvironment(),
    HOME: join(attemptDir, 'installer-home'),
    TMPDIR: join(attemptDir, 'tmp'),
    CI: '1',
  }
  await Promise.all([
    mkdir(packEnvironment.HOME, { recursive: true }),
    mkdir(packEnvironment.TMPDIR, { recursive: true }),
  ])
  const packed = run('pnpm', ['pack', '--pack-destination', packageRoot], {
    cwd: destination,
    env: packEnvironment,
  }).stdout.trim().split(/\r?\n/).at(-1)
  if (!packed) throw new Error('pnpm pack produced no ICAE matched-boundary wrapper tarball')
  const packedPath = resolve(destination, packed)
  const stablePath = join(packageRoot, candidate
    ? 'dsh-plan-lattice-icae-wrapper.tgz'
    : 'dsh-plan-lattice-icae-native-wrapper.tgz')
  await copyFile(packedPath, stablePath)
  return { path: stablePath, digest: sha256(await readFile(stablePath)) }
}

async function materializeLongSystemWrapper(attemptDir, pluginPackage) {
  const candidate = pluginPackage !== undefined
  const source = join(driverRoot, candidate ? 'candidate-wrapper' : 'native-wrapper')
  const destination = join(attemptDir, 'eval-plugins', candidate
    ? 'plan-lattice-long-system-candidate-wrapper'
    : 'plan-lattice-long-system-native-wrapper')
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: true })
  if (!candidate) {
    for (const name of ['common-boundary.js', 'common-prompt.js', 'tool-boundary.js', 'workspace-shell-adapter.js']) {
      await copyFile(join(driverRoot, 'candidate-wrapper', name), join(destination, name))
    }
  }
  const manifestPath = join(destination, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (candidate) manifest.dependencies = { 'dsh-plan-lattice': `file:${resolve(pluginPackage)}` }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const packageRoot = join(attemptDir, 'packages')
  await mkdir(packageRoot, { recursive: true })
  const packEnvironment = {
    ...inheritedRuntimeEnvironment(),
    HOME: join(attemptDir, 'installer-home'),
    TMPDIR: join(attemptDir, 'tmp'),
    CI: '1',
  }
  await Promise.all([
    mkdir(packEnvironment.HOME, { recursive: true }),
    mkdir(packEnvironment.TMPDIR, { recursive: true }),
  ])
  const packed = run('pnpm', ['pack', '--pack-destination', packageRoot], {
    cwd: destination,
    env: packEnvironment,
  }).stdout.trim().split(/\r?\n/).at(-1)
  if (!packed) throw new Error('pnpm pack produced no long-system matched-boundary wrapper tarball')
  const packedPath = resolve(destination, packed)
  const stablePath = join(packageRoot, candidate
    ? 'dsh-plan-lattice-long-system-wrapper.tgz'
    : 'dsh-plan-lattice-long-system-native-wrapper.tgz')
  await copyFile(packedPath, stablePath)
  return { path: stablePath, digest: sha256(await readFile(stablePath)) }
}

async function verifyInstalledCandidate({ profileDir, attemptDir, candidatePackage, candidateDigest, wrapperDigest, candidateCommit, wrapperName }) {
  const wrapperEntry = realpathSync(join(profileDir, 'node_modules', wrapperName, 'index.js'))
  const candidateEntry = realpathSync(createRequire(wrapperEntry).resolve('dsh-plan-lattice'))
  const candidateRoot = resolve(dirname(candidateEntry), '..')
  const manifest = JSON.parse(await readFile(join(candidateRoot, 'package.json'), 'utf8'))
  if (manifest.name !== 'dsh-plan-lattice') throw new Error('installed candidate package identity is invalid')
  const expectedRoot = join(attemptDir, 'expected-candidate-package')
  await rm(expectedRoot, { recursive: true, force: true })
  await mkdir(expectedRoot, { recursive: true })
  run('tar', ['-xzf', candidatePackage, '-C', expectedRoot])
  const includePayload = (relative, entry) => entry.isDirectory()
    ? relative === 'lib' || relative.startsWith('lib/')
    : relative === 'package.json' || relative.startsWith('lib/')
  const expectedPayloadDigest = await digestTree(join(expectedRoot, 'package'), includePayload)
  const loadedPayloadDigest = await digestTree(candidateRoot, includePayload)
  if (loadedPayloadDigest !== expectedPayloadDigest) {
    throw new Error('installed candidate payload does not match the frozen candidate tarball')
  }
  return {
    candidateCommit,
    candidateVersion: manifest.version,
    candidatePackageSha256: candidateDigest,
    candidatePayloadSha256: loadedPayloadDigest,
    wrapperPackageSha256: wrapperDigest,
  }
}

export async function runHarnessTask({
  runtimeArtifacts,
  harnessCommit,
  attemptDir,
  workspace,
  prompt,
  arm,
  pluginCommit,
  pluginPackagePath,
  pluginPackageDigest,
  sessionId,
  attemptId,
  oracle,
  forbiddenReadRoots = [],
  forbiddenNetworkPorts = [],
  permissionMode,
  timeoutMs,
  maxRecoveryEpochs = 1,
  stageProtocol,
}) {
  if (!Number.isSafeInteger(maxRecoveryEpochs) || maxRecoveryEpochs < 0 || maxRecoveryEpochs > 3) {
    throw new Error('maxRecoveryEpochs must be an integer from 0 to 3')
  }
  if (typeof attemptId !== 'string' || attemptId.length < 8) {
    throw new Error('attemptId must bind recovery to the active evaluation attempt')
  }
  if (stageProtocol !== undefined) {
    if (stageProtocol?.schemaVersion !== 1
      || !Array.isArray(stageProtocol.stages)
      || stageProtocol.stages.length < 2) {
      throw new Error('stageProtocol must contain at least two ordered stages')
    }
    const stageIds = new Set()
    for (const [index, stage] of stageProtocol.stages.entries()) {
      if (!stage || typeof stage.id !== 'string' || stage.id.length === 0 || stageIds.has(stage.id)
        || (stage.actor !== 'root' && stage.actor !== 'child')
        || (stage.actor === 'root' && (typeof stage.sessionId !== 'string' || stage.sessionId.length === 0))
        || (stage.actor === 'child' && stage.sessionId !== undefined)
        || (stage.source !== 'user' && stage.source !== 'plugin')
        || typeof stage.message !== 'string' || stage.message.trim() === '') {
        throw new Error(`stageProtocol stage ${index} is malformed or duplicated`)
      }
      if (stage.actor === 'root' && stage.sessionId !== sessionId) {
        throw new Error(`stageProtocol root stage ${stage.id} must use the root session`)
      }
      if (stage.actor === 'child' && stage.parentSessionId !== sessionId) {
        throw new Error(`stageProtocol child stage ${stage.id} must use the root as parent`)
      }
      stageIds.add(stage.id)
    }
  }
  const resolvedPermissionMode = resolveHarnessPermissionMode(permissionMode)
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
  let pluginPackage
  let resolvedPluginPackageDigest
  if (pluginPackagePath) {
    pluginPackage = resolve(pluginPackagePath)
    if (sha256(await readFile(pluginPackage)) !== pluginPackageDigest) {
      throw new Error('frozen host plugin package digest mismatch')
    }
    resolvedPluginPackageDigest = pluginPackageDigest
  } else if (pluginCommit) {
    const packaged = await packagePluginAtCommit(pluginCommit, packageRoot)
    pluginPackage = packaged.path
    resolvedPluginPackageDigest = packaged.digest
  }
  const wrapperPackage = arm.shellAdapter === 'icae-container'
    ? await materializeIcaeWrapper(attemptDir, pluginPackage)
    : arm.shellAdapter === 'workspace-tree'
      ? await materializeLongSystemWrapper(attemptDir, pluginPackage)
      : undefined
  const profilePluginPackage = wrapperPackage?.path ?? pluginPackage
  const { profileDir } = await configureProfile({ dshBin, dshHome, supportPlugin: supportPluginRoot, pluginPackage: profilePluginPackage, arm })
  await appendFile(join(profileDir, 'cordis.patch.yml'), [
    '- id: compaction-basic',
    '  config:',
    '    maxTokens: 1024',
    '',
  ].join('\n'), 'utf8')
  const pluginIdentity = wrapperPackage && pluginPackage && resolvedPluginPackageDigest && pluginCommit
    ? await verifyInstalledCandidate({
        profileDir,
        attemptDir,
        candidatePackage: pluginPackage,
        candidateDigest: resolvedPluginPackageDigest,
        wrapperDigest: wrapperPackage.digest,
        candidateCommit: pluginCommit,
        wrapperName: arm.shellAdapter === 'workspace-tree'
          ? 'dsh-plan-lattice-long-system-wrapper'
          : 'dsh-plan-lattice-icae-wrapper',
      })
    : undefined
  if (pluginIdentity) {
    await writeFile(join(attemptDir, 'candidate-installation.json'), `${JSON.stringify(pluginIdentity, null, 2)}\n`, 'utf8')
  }
  const env = {
    ...inheritedRuntimeEnvironment(),
    ...(process.env.PLAN_LATTICE_ICAE_DOCKER_HOST === undefined
      ? {}
      : { DOCKER_HOST: process.env.PLAN_LATTICE_ICAE_DOCKER_HOST }),
    HOME: processHome,
    TMPDIR: processTmp,
    DEEPSEEK_API_KEY: proxy.agentCapability,
    DEEPSEEK_BASE_URL: proxy.hostBaseURL,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: resolvedPermissionMode,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TOOLS_MODE: 'native',
    DSH_PLAN_LATTICE_EVAL_SESSION_ID: sessionId,
    DSH_PLAN_LATTICE_EVAL_ATTEMPT_ID: attemptId,
    DSH_PLAN_LATTICE_SESSION_ROOT: sessionsRoot,
    DSH_PLAN_LATTICE_ORACLE_AUDIT_PATH: oracleAudit,
    ...(arm.shellAdapter === 'icae-container'
      ? { DSH_PLAN_LATTICE_ICAE_CONTAINER_ID: extractIcaeContainerId(prompt) }
      : {}),
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
  const recoveryLedger = join(attemptDir, 'harness-recovery.jsonl')
  const epochResults = []
  const stages = stageProtocol?.stages ?? [{
    id: 'single-turn',
    actor: 'root',
    sessionId,
    source: 'user',
    message: prompt,
  }]
  let result
  let metrics
  let clarificationQuestions = 0
  let sessionEvidenceError
  const completedStages = []
  const foregroundDelegations = []
  for (const [stageIndex, stage] of stages.entries()) {
    let observedStageSessionId = stage.actor === 'root' ? sessionId : undefined
    for (let epoch = 0; epoch <= maxRecoveryEpochs; epoch += 1) {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - started))
      result = await runBuffered(command, commandArgs, {
        cwd: workspace,
        env: {
          ...env,
          DSH_PLAN_LATTICE_EVAL_RECOVERY_EPOCH: String(epoch),
          ...(stageProtocol === undefined ? {} : {
            DSH_PLAN_LATTICE_EVAL_STAGE_INDEX: String(stageIndex),
            DSH_PLAN_LATTICE_EVAL_STAGE_JSON: JSON.stringify(stage),
          }),
        },
        encoding: 'utf8',
        timeout: remainingMs,
        maxBuffer: 32 * 1024 * 1024,
      })
      const epochStdout = sanitized(result.stdout, [oracle?.token])
      const epochStderr = sanitized(result.stderr, [oracle?.token])
      const prefix = stageProtocol === undefined
        ? 'harness'
        : `harness.stage-${String(stageIndex).padStart(4, '0')}-${stage.id}`
      await writeFile(join(attemptDir, `${prefix}.epoch-${String(epoch).padStart(4, '0')}.stdout.log`), epochStdout, 'utf8')
      await writeFile(join(attemptDir, `${prefix}.epoch-${String(epoch).padStart(4, '0')}.stderr.log`), epochStderr, 'utf8')
      epochResults.push({ stageIndex, stageId: stage.id, actor: stage.actor, epoch, stdout: epochStdout, stderr: epochStderr })
      sessionEvidenceError = undefined
      try {
        const discovered = await parseSessionMetrics(sessionsRoot)
        if (!discovered.sessions.some(session => session.id === sessionId)) {
          throw new Error(`persistent sessions do not contain root session ${sessionId}`)
        }
        if (stage.actor === 'child') {
          const evidence = await assertDurableNativeForegroundDelegation({
            sessionsRoot,
            parentSessionId: sessionId,
          })
          observedStageSessionId = evidence.childSessionId
          if (!foregroundDelegations.some(item => item.callId === evidence.callId)) {
            foregroundDelegations.push({ stageId: stage.id, ...evidence })
          }
        }
        metrics = await parseSessionMetrics(sessionsRoot, { terminalSessionId: sessionId })
        clarificationQuestions = await countClarificationQuestions(oracleAudit)
      } catch (error) {
        sessionEvidenceError = String(error?.message ?? error)
        metrics = {
          files: [],
          sessions: [],
          modelTurns: 0,
          inputTokens: 0,
          outputTokens: 0,
          transcriptDurationMs: 0,
          terminalReason: undefined,
          missingUsageEvents: 0,
          compactionSummaries: 0,
          surfaceReplacements: 0,
          controlToolCalls: [],
          forbiddenAutomaticControlCalls: [],
        }
      }
      const trigger = result.error?.code === 'ETIMEDOUT' || sessionEvidenceError
        ? undefined
        : recoverableHarnessTerminal(metrics.terminalReason)
      if (result.status === 0 || trigger === undefined || epoch === maxRecoveryEpochs) break
      await appendDurableJsonl(recoveryLedger, {
        schemaVersion: 1,
        attemptId,
        sessionId,
        rootSessionId: sessionId,
        stageIndex,
        stageId: stage.id,
        workspace: realpathSync(workspace),
        recoveryEpoch: epoch + 1,
        trigger,
        terminalReason: metrics.terminalReason,
        promptDigest: sha256(stage.message),
        processStatus: result.status,
        processSignal: result.signal ?? null,
        modelTurnsObserved: metrics.modelTurns,
        inputTokensObserved: metrics.inputTokens,
        outputTokensObserved: metrics.outputTokens,
        recordedAt: new Date().toISOString(),
      })
    }
    if (result?.status !== 0 || result.error?.code === 'ETIMEDOUT' || sessionEvidenceError) break
    let snapshotPath
    if (stage.snapshotAfter === true) {
      snapshotPath = join(attemptDir, 'stage-snapshots', `${String(stageIndex).padStart(4, '0')}-${stage.id}`)
      await rm(snapshotPath, { recursive: true, force: true })
      await cp(workspace, snapshotPath, {
        recursive: true,
        force: true,
        filter: source => {
          const relative = source.slice(resolve(workspace).length).replace(/^\//, '')
          const top = relative.split('/')[0]
          return relative === '' || !['.dsh', '.git', 'node_modules'].includes(top)
        },
      })
    }
    completedStages.push({
      index: stageIndex,
      id: stage.id,
      actor: stage.actor,
      sessionId: observedStageSessionId ?? sessionId,
      compactBefore: stage.compactBefore === true,
      processRestartOrdinal: stageIndex + 1,
      terminalReason: metrics?.terminalReason,
      ...(snapshotPath === undefined ? {} : { snapshotPath }),
    })
  }
  if (result === undefined || metrics === undefined) throw new Error('Harness produced no execution epoch')
  const durationMs = Date.now() - started
  const stdout = epochResults.map(item => `=== STAGE ${item.stageIndex} ${item.stageId} / RECOVERY EPOCH ${item.epoch} ===\n${item.stdout}`).join('\n')
  const stderr = epochResults.map(item => `=== STAGE ${item.stageIndex} ${item.stageId} / RECOVERY EPOCH ${item.epoch} ===\n${item.stderr}`).join('\n')
  await writeFile(join(attemptDir, 'harness.stdout.log'), stdout, 'utf8')
  await writeFile(join(attemptDir, 'harness.stderr.log'), stderr, 'utf8')
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const allStagesCompleted = completedStages.length === stages.length
  if (stageProtocol !== undefined) {
    await writeFile(join(attemptDir, 'stage-protocol.json'), `${JSON.stringify(stageProtocol, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  if (result.status === 0 && !timedOut && allStagesCompleted) {
    if (sessionEvidenceError) throw new Error(`successful Harness run has invalid durable session evidence: ${sessionEvidenceError}`)
    if (metrics.modelTurns < 1) throw new Error('successful Harness run recorded no durable model turn')
    if (metrics.missingUsageEvents !== 0) throw new Error('successful Harness run has model events without durable token usage')
    if (metrics.terminalReason?.kind !== 'completed') throw new Error('successful Harness run has no durable completed turn')
  }
  return {
    status: allStagesCompleted ? result.status : (result.status === 0 ? 1 : result.status),
    signal: result.signal,
    timedOut,
    stdout,
    stderr,
    durationMs,
    clarificationQuestions,
    pluginIdentity,
    stages: completedStages,
    stageCount: stages.length,
    allStagesCompleted,
    processEpochs: epochResults.length,
    recoveryEpochs: epochResults.filter(item => item.epoch > 0).length,
    recoveryLedger: epochResults.some(item => item.epoch > 0) ? recoveryLedger : undefined,
    foregroundDelegations,
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
