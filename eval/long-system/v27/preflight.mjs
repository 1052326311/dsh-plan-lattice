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
  inspectSigningPrivateKey,
  inspectTaskCheckout,
  repositoryRoot,
} from './freeze.mjs'
import {
  FROZEN_MANIFEST_PATH,
  V27_UPSTREAM_BASE_URL,
  V27_UPSTREAM_BASE_URL_SHA256,
  readV27FrozenManifest,
} from './manifest.mjs'
import { inspectV27PublicManifestCommit } from './public-anchor.mjs'
import { isolatedGit } from './git-safety.mjs'
import { assertV27CheckoutIntegrity } from './checkout-integrity.mjs'

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
  const raw = env.DEEPSEEK_BASE_URL ?? V27_UPSTREAM_BASE_URL
  let endpointValid = false
  let endpoint
  try {
    const parsed = new URL(raw)
    const normalizedPath = parsed.pathname.replace(/\/+$/u, '')
    endpoint = `${parsed.origin}${normalizedPath}`
    endpointValid = parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && parsed.protocol === 'https:'
      && endpoint === V27_UPSTREAM_BASE_URL
  } catch {}
  return {
    credentialPresent,
    endpointValid,
    endpoint: endpointValid ? endpoint : null,
    endpointSha256: endpointValid ? sha256(endpoint) : null,
  }
}

function frozenDriverCheck(manifest, manifestPath, manifestCommit, root = repositoryRoot) {
  const anchor = inspectV27PublicManifestCommit({
    manifest,
    manifestPath,
    manifestCommit,
    root,
    requireExactHead: true,
  })
  const commit = manifest.driver.commit
  isolatedGit(root, ['cat-file', '-e', `${commit}^{commit}`])
  isolatedGit(root, ['merge-base', '--is-ancestor', commit, 'HEAD'])
  const changed = isolatedGit(root, [
    'diff', '--name-only', commit, 'HEAD', '--',
    'eval/long-system/v27',
    'eval/long-system/driver/model-proxy.mjs',
    'eval/pilots/driver/budget-proxy.mjs',
    'eval/v0.4/driver/lib',
    'eval/v0.4/lib/canonical.mjs',
  ]).split(/\r?\n/).filter(Boolean)
  const allowed = new Set(['eval/long-system/v27/frozen-manifest.json'])
  if (changed.some(path => !allowed.has(path))) {
    throw new Error(`execution sources changed after driver freeze: ${changed.filter(path => !allowed.has(path)).join(', ')}`)
  }
  const status = isolatedGit(root, ['status', '--porcelain', '--untracked-files=all'])
  if (status !== '') throw new Error('execution requires a clean committed checkout')
  const integrity = assertV27CheckoutIntegrity({ root, commit: manifestCommit })
  const objects = Object.fromEntries(Object.keys(manifest.driver.sourceObjects).map(path => [
    path,
    isolatedGit(root, ['rev-parse', `${commit}:${path}`]),
  ]))
  if (sha256(objects) !== manifest.driver.sourceDigest) throw new Error('frozen driver source digest mismatch')
  return {
    head: isolatedGit(root, ['rev-parse', 'HEAD']),
    anchor,
    integrity: { fileCount: integrity.fileCount, recordsSha256: integrity.recordsSha256 },
  }
}

export async function preflightV27({
  manifestPath = FROZEN_MANIFEST_PATH,
  env = process.env,
  root = repositoryRoot,
} = {}) {
  const checks = []
  const add = (name, passed, detail) => checks.push({ name, passed: passed === true, detail })
  let manifest
  try {
    manifest = await readV27FrozenManifest(manifestPath)
    add('frozen-manifest', true, manifest.manifestDigest)
  } catch (error) {
    add('frozen-manifest', false, String(error?.message ?? error))
  }

  const model = inspectModelEnvironment(env)
  add('credential-environment', model.credentialPresent,
    model.credentialPresent ? 'DEEPSEEK_API_KEY is present in process environment' : 'DEEPSEEK_API_KEY is missing or invalid')
  add('model-endpoint', model.endpointValid,
    model.endpointValid
      ? `${model.endpoint} (${model.endpointSha256})`
      : `DEEPSEEK_BASE_URL must resolve exactly to ${V27_UPSTREAM_BASE_URL}`)

  if (manifest) {
    const endpointMatchesManifest = model.endpoint === manifest.model.upstreamBaseUrl
      && model.endpointSha256 === manifest.model.upstreamBaseUrlSha256
      && model.endpointSha256 === V27_UPSTREAM_BASE_URL_SHA256
    add('frozen-model-endpoint', endpointMatchesManifest,
      endpointMatchesManifest ? model.endpointSha256 : 'model endpoint differs from the frozen manifest')

    try {
      const manifestCommit = env[manifest.publicationAnchor.commitEnvironmentVariable]
      const checkout = frozenDriverCheck(manifest, manifestPath, manifestCommit, root)
      add('public-manifest-commit', true, `${checkout.anchor.manifestCommit}:${checkout.anchor.manifestBlob}`)
      add('driver-checkout', true, `${checkout.head} contains frozen driver ${manifest.driver.commit}`)
    } catch (error) {
      add('driver-checkout', false, String(error?.message ?? error))
    }

    try {
      const keyPath = env[manifest.evidenceSigning.privateKeyPathEnvironmentVariable]
      if (!keyPath) throw new Error(`${manifest.evidenceSigning.privateKeyPathEnvironmentVariable} is not set`)
      const signing = await inspectSigningPrivateKey(keyPath)
      const passed = signing.publicKeyBase64 === manifest.evidenceSigning.publicKeyBase64
        && signing.publicKeySha256 === manifest.evidenceSigning.publicKeySha256
      add('evidence-signing-key', passed,
        passed ? signing.publicKeySha256 : 'signing private key does not match the frozen public key')
    } catch (error) {
      add('evidence-signing-key', false, String(error?.message ?? error))
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
        && candidate.sourceProvenanceSha256 === manifest.candidate.sourceProvenanceSha256
      add('candidate-package', passed, passed ? candidate.sha256 : 'candidate package differs from frozen manifest')
    } catch (error) {
      add('candidate-package', false, String(error?.message ?? error))
    }

    try {
      const taskRoot = env[manifest.task.rootPathEnvironmentVariable]
      const datasetRoot = env[manifest.task.datasetPathEnvironmentVariable]
      const archivePath = env[manifest.task.archivePathEnvironmentVariable]
      const zstdPath = env[manifest.task.decompressorPathEnvironmentVariable]
      if (!taskRoot || !datasetRoot || !archivePath || !zstdPath) {
        throw new Error('V27 task, dataset, archive, and decompressor paths must be configured')
      }
      const task = await inspectTaskCheckout({ taskRoot, datasetRoot, archivePath, zstdPath })
      const passed = task.assetSha256 === manifest.task.assetSha256
        && task.archiveSha256 === manifest.task.archiveSha256
        && task.datasetTree === manifest.task.datasetTree
        && task.archivePointerBlob === manifest.task.archivePointerBlob
        && task.archiveBytes === manifest.task.archiveBytes
        && task.decompressorSha256 === manifest.task.decompressorSha256
        && task.decompressorVersion === manifest.task.decompressorVersion
        && task.taskTreeSha256 === manifest.task.taskTreeSha256
        && task.taskFileCount === manifest.task.taskFileCount
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
    add('darwin-sandbox', process.platform === 'darwin', process.platform === 'darwin' ? sandbox : 'V27 runner requires Darwin sandbox-exec')
  } catch {
    add('darwin-sandbox', false, `${sandbox} is unavailable`)
  }

  const outputRoot = env.PLAN_LATTICE_LONG_SYSTEM_V27_OUTPUT_ROOT
  const outputValid = typeof outputRoot === 'string'
    && isAbsolute(outputRoot)
    && !within(root, outputRoot)
    && manifest?.outputPolicy?.absoluteRoot === resolve(outputRoot)
  add('output-root', outputValid,
    outputValid ? resolve(outputRoot) : 'output root must exactly match the frozen absolute path outside the source repository')

  const readyForTrial = manifest !== undefined && checks.every(check => check.passed)
  return {
    schemaVersion: 2,
    protocolId: manifest?.protocolId ?? 'plan-lattice-rc7-evocode-jobforge-v27',
    manifestDigest: manifest?.manifestDigest ?? null,
    credentialPresent: model.credentialPresent,
    modelEndpoint: model.endpoint,
    modelEndpointSha256: model.endpointSha256,
    manifestCommit: manifest === undefined
      ? null
      : env[manifest.publicationAnchor.commitEnvironmentVariable] ?? null,
    readyForTrial,
    readyForNative: readyForTrial,
    readyForCandidateInfrastructure: readyForTrial,
    candidateExecutionAllowed: readyForTrial,
    checks,
  }
}

async function main() {
  const report = await preflightV27()
  process.stdout.write(canonicalJson(report))
  if (process.argv.includes('--require-credentials') && !report.readyForTrial) process.exitCode = 3
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
