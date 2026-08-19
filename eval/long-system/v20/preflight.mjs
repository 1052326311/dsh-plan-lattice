#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../v0.4/lib/canonical.mjs'
import { CANDIDATE_COMMIT, HARNESS_COMMIT } from './manifest.mjs'
import { verifyV20Manifest } from './freeze.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function command(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { ok: result.status === 0, detail: (result.stderr || result.stdout || '').trim() }
}

async function main() {
  const checks = []
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail })
  let manifest
  try {
    manifest = await verifyV20Manifest()
    add('frozen-manifest', true, manifest.manifestDigest)
  } catch (error) {
    add('frozen-manifest', false, String(error?.message ?? error))
  }

  const head = command('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])
  add('driver-head', head.ok && /^[0-9a-f]{40}$/.test(head.detail), head.detail)
  const clean = command('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'])
  add('driver-clean', clean.ok && clean.detail === '', clean.ok && clean.detail === '' ? 'clean' : 'execution requires a committed clean checkout')
  const candidate = command('git', ['-C', repositoryRoot, 'cat-file', '-e', `${CANDIDATE_COMMIT}^{commit}`])
  add('candidate-present', candidate.ok, candidate.ok ? CANDIDATE_COMMIT : candidate.detail)
  const candidateAncestor = command('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', CANDIDATE_COMMIT, 'HEAD'])
  add('candidate-ancestor', candidateAncestor.ok, candidateAncestor.ok ? 'candidate precedes the execution checkout' : candidateAncestor.detail)
  if (manifest !== undefined) {
    const driverAncestor = command('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', manifest.driver.commit, 'HEAD'])
    add('frozen-driver-ancestor', driverAncestor.ok,
      driverAncestor.ok ? `${manifest.driver.commit} precedes the lock commit` : driverAncestor.detail)
  }

  const runtimePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V20_HOST_RUNTIME
  if (!runtimePath) {
    add('host-runtime', false, 'PLAN_LATTICE_LONG_SYSTEM_V20_HOST_RUNTIME is not set')
  } else if (!existsSync(runtimePath)) {
    add('host-runtime', false, 'configured host runtime path does not exist')
  } else if (manifest === undefined) {
    add('host-runtime', false, 'manifest is unavailable')
  } else {
    const digest = sha256(await readFile(runtimePath))
    add('host-runtime', digest === manifest.harness.hostRuntimeSha256,
      digest === manifest.harness.hostRuntimeSha256
        ? `${HARNESS_COMMIT} runtime digest matches`
        : `runtime digest mismatch: ${digest}`)
  }

  const node = command(process.execPath, ['--version'])
  add('node', node.ok && node.detail === 'v22.23.0', node.detail)
  const pnpm = command('pnpm', ['--version'])
  add('pnpm', pnpm.ok, pnpm.detail)
  const credentialPresent = typeof process.env.DEEPSEEK_API_KEY === 'string'
    && process.env.DEEPSEEK_API_KEY.length > 0
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  let baseUrlValid = false
  try {
    const parsed = new URL(baseUrl)
    baseUrlValid = parsed.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(parsed.hostname)
  } catch {}
  add('model-endpoint', baseUrlValid, baseUrlValid ? baseUrl : 'DEEPSEEK_BASE_URL is not an allowed endpoint')

  const checksPassed = checks.every(check => check.passed)
  const readyForExecution = checksPassed && credentialPresent
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    protocolId: manifest?.protocolId ?? 'plan-lattice-rc7-native-foreground-long-system-v20',
    readyForExecution,
    credentialPresent,
    checks,
  }, null, 2)}\n`)
  process.exitCode = readyForExecution || !process.argv.includes('--require-credentials') ? 0 : 3
}

main().catch(error => {
  process.stderr.write(`${String(error?.message ?? error)}\n`)
  process.exitCode = 1
})
