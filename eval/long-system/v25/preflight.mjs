#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import {
  inspectCandidatePackage,
  inspectDockerImage,
  inspectHarnessRuntime,
  inspectTaskCheckout,
  repositoryRoot,
} from './freeze.mjs'
import { FROZEN_MANIFEST_PATH, readV25FrozenManifest } from './manifest.mjs'

function command(commandName, args) {
  const result = spawnSync(commandName, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${commandName} failed`).trim())
  return result.stdout.trim()
}

function within(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function inspectModelEnvironment(env = process.env) {
  const credentialPresent = typeof env.DEEPSEEK_API_KEY === 'string'
    && env.DEEPSEEK_API_KEY.length > 0
    && !/[\r\n]/.test(env.DEEPSEEK_API_KEY)
  const raw = env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  let endpointValid = false
  let endpoint
  try {
    const parsed = new URL(raw)
    endpointValid = parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && (parsed.protocol === 'https:'
        || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)))
    if (endpointValid) endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {}
  return {
    credentialPresent,
    endpointValid,
    endpoint: endpoint ?? null,
  }
}

function frozenDriverCheck(manifest, root = repositoryRoot) {
  const commit = manifest.driver.commit
  command('git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`])
  command('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD'])
  const changed = command('git', [
    '-C', root, 'diff', '--name-only', commit, 'HEAD', '--',
    'eval/long-system/v25',
    'eval/long-system/driver/model-proxy.mjs',
    'eval/pilots/driver/budget-proxy.mjs',
    'eval/v0.4/driver/lib',
    'eval/v0.4/lib/canonical.mjs',
  ]).split(/\r?\n/).filter(Boolean)
  const allowed = new Set(['eval/long-system/v25/frozen-manifest.json'])
  if (changed.some(path => !allowed.has(path))) {
    throw new Error(`execution sources changed after driver freeze: ${changed.filter(path => !allowed.has(path)).join(', ')}`)
  }
  const status = command('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'])
  if (status !== '') throw new Error('execution requires a clean committed checkout')
  const objects = Object.fromEntries(Object.keys(manifest.driver.sourceObjects).map(path => [
    path,
    command('git', ['-C', root, 'rev-parse', `${commit}:${path}`]),
  ]))
  if (sha256(objects) !== manifest.driver.sourceDigest) throw new Error('frozen driver source digest mismatch')
  return command('git', ['-C', root, 'rev-parse', 'HEAD'])
}

export async function preflightV25({
  manifestPath = FROZEN_MANIFEST_PATH,
  env = process.env,
  root = repositoryRoot,
} = {}) {
  const checks = []
  const add = (name, passed, detail) => checks.push({ name, passed: passed === true, detail })
  let manifest
  try {
    manifest = await readV25FrozenManifest(manifestPath)
    add('frozen-manifest', true, manifest.manifestDigest)
  } catch (error) {
    add('frozen-manifest', false, String(error?.message ?? error))
  }

  const model = inspectModelEnvironment(env)
  add('credential-environment', model.credentialPresent,
    model.credentialPresent ? 'DEEPSEEK_API_KEY is present in process environment' : 'DEEPSEEK_API_KEY is missing or invalid')
  add('model-endpoint', model.endpointValid,
    model.endpointValid ? model.endpoint : 'DEEPSEEK_BASE_URL must be HTTPS or loopback HTTP without embedded credentials')

  if (manifest) {
    try {
      const head = frozenDriverCheck(manifest, root)
      add('driver-checkout', true, `${head} contains frozen driver ${manifest.driver.commit}`)
    } catch (error) {
      add('driver-checkout', false, String(error?.message ?? error))
    }

    try {
      const runtimePath = env[manifest.harness.runtimePathEnvironmentVariable]
      if (!runtimePath) throw new Error(`${manifest.harness.runtimePathEnvironmentVariable} is not set`)
      const runtime = await inspectHarnessRuntime(runtimePath)
      const passed = runtime.sha256 === manifest.harness.runtimeSha256
        && runtime.metadataSha256 === manifest.harness.runtimeMetadataSha256
        && runtime.platform === manifest.harness.platform
        && runtime.architecture === manifest.harness.architecture
        && runtime.node === manifest.harness.node
      add('harness-runtime', passed, passed ? runtime.sha256 : 'Harness runtime identity differs from frozen manifest')
    } catch (error) {
      add('harness-runtime', false, String(error?.message ?? error))
    }

    try {
      const packagePath = env[manifest.candidate.packagePathEnvironmentVariable]
      if (!packagePath) throw new Error(`${manifest.candidate.packagePathEnvironmentVariable} is not set`)
      const candidate = await inspectCandidatePackage(packagePath)
      const passed = candidate.sha256 === manifest.candidate.tarballSha256
        && candidate.manifestSha256 === manifest.candidate.packageManifestSha256
      add('candidate-package', passed, passed ? candidate.sha256 : 'candidate package differs from frozen manifest')
    } catch (error) {
      add('candidate-package', false, String(error?.message ?? error))
    }

    try {
      const taskRoot = env[manifest.task.rootPathEnvironmentVariable]
      const datasetRoot = env[manifest.task.datasetPathEnvironmentVariable]
      const archivePath = env[manifest.task.archivePathEnvironmentVariable]
      if (!taskRoot || !datasetRoot || !archivePath) {
        throw new Error('V25 task, dataset root, and original archive paths must be configured')
      }
      const task = await inspectTaskCheckout({ taskRoot, datasetRoot, archivePath })
      const passed = task.assetSha256 === manifest.task.assetSha256
        && task.archiveSha256 === manifest.task.archiveSha256
        && canonicalJson(task.digests) === canonicalJson(manifest.task.digests)
      add('evocode-task', passed, passed ? `${task.datasetCommit}:${task.assetSha256}` : 'task bytes differ from frozen manifest')
    } catch (error) {
      add('evocode-task', false, String(error?.message ?? error))
    }

    try {
      const image = inspectDockerImage(manifest.image.reference)
      const passed = image.manifestSha256 === manifest.image.manifestSha256
        && image.configSha256 === manifest.image.configSha256
      add('docker-image', passed, passed ? image.reference : 'Docker image differs from frozen manifest')
    } catch (error) {
      add('docker-image', false, String(error?.message ?? error))
    }

    const hostMatches = process.platform === manifest.harness.platform
      && process.arch === manifest.harness.architecture
      && process.version === manifest.harness.node
    add('execution-host', hostMatches,
      `${process.platform}/${process.arch}/${process.version}; expected ${manifest.harness.platform}/${manifest.harness.architecture}/${manifest.harness.node}`)
  }

  const sandbox = '/usr/bin/sandbox-exec'
  try {
    await access(sandbox)
    add('darwin-sandbox', process.platform === 'darwin', process.platform === 'darwin' ? sandbox : 'V25 runner requires Darwin sandbox-exec')
  } catch {
    add('darwin-sandbox', false, `${sandbox} is unavailable`)
  }

  const outputRoot = env.PLAN_LATTICE_LONG_SYSTEM_V25_OUTPUT_ROOT
  const outputValid = typeof outputRoot === 'string'
    && isAbsolute(outputRoot)
    && !within(root, outputRoot)
  add('output-root', outputValid,
    outputValid ? resolve(outputRoot) : 'output root must be an absolute path outside the source repository')

  const readyForNative = manifest !== undefined && checks.every(check => check.passed)
  return {
    schemaVersion: 1,
    protocolId: manifest?.protocolId ?? 'plan-lattice-rc7-evocode-jobforge-v25',
    manifestDigest: manifest?.manifestDigest ?? null,
    credentialPresent: model.credentialPresent,
    readyForNative,
    readyForCandidateInfrastructure: readyForNative,
    candidateExecutionAllowed: false,
    checks,
  }
}

async function main() {
  const report = await preflightV25()
  process.stdout.write(canonicalJson(report))
  if (process.argv.includes('--require-credentials') && !report.readyForNative) process.exitCode = 3
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
