#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../v0.4/lib/canonical.mjs'
import { configureProfile } from '../../v0.4/driver/lib/profile.mjs'
import { inheritedRuntimeEnvironment } from '../../v0.4/driver/lib/environment.mjs'
import { packagePluginAtCommit } from './driver/runtime.mjs'
import { verifyV7Manifest } from './freeze.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const runtimePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V7_HOST_RUNTIME

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

if (!runtimePath) throw new Error('PLAN_LATTICE_LONG_SYSTEM_V7_HOST_RUNTIME is required')

const manifest = await verifyV7Manifest()
const bytes = await readFile(resolve(runtimePath))
assert.equal(sha256(bytes), manifest.harness.hostRuntimeSha256, 'host runtime digest mismatch')

const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v7-smoke-'))
try {
  const runtimeRoot = join(root, 'runtime')
  const packages = join(root, 'packages')
  await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(packages, { recursive: true })])
  run('tar', ['-xzf', resolve(runtimePath), '-C', runtimeRoot])
  const dshBin = join(runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  run(process.execPath, [dshBin, '--version'], { env: inheritedRuntimeEnvironment() })

  const candidate = await packagePluginAtCommit(manifest.candidate.commit, packages)
  const support = join(repositoryRoot, 'eval/long-system/v7/driver/support-plugin')
  const common = {
    dshBin,
    supportPlugin: support,
    pluginPackage: candidate.path,
    arm: {
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
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
  assert.match(firstPatch, /- id: plan-lattice\n  config:\n    activationMode: always/)

  const check = run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'list'], {
    env: { ...inheritedRuntimeEnvironment(), DSH_HOME: join(root, 'dsh-home-a') },
  })
  assert.match(`${check.stdout}\n${check.stderr}`, /dsh-plan-lattice@0\.4\.0-rc\.7/)
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    protocolId: manifest.protocolId,
    candidateCommit: manifest.candidate.commit,
    candidatePackageSha256: candidate.digest,
    hostRuntimeSha256: manifest.harness.hostRuntimeSha256,
    installation: 'passed',
    modelRequests: 0,
  }, null, 2)}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
