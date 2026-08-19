#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../v0.4/lib/canonical.mjs'
import { CANDIDATE_COMMIT, HARNESS_COMMIT, verifyV11Manifest } from './freeze.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function command(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { ok: result.status === 0, detail: (result.stderr || result.stdout || '').trim() }
}

async function main() {
  const checks = []
  const add = (name, passed, detail) => checks.push({ name, passed, detail })
  let manifest
  try {
    manifest = await verifyV11Manifest()
    add('frozen-manifest', true, manifest.manifestDigest)
  } catch (error) {
    add('frozen-manifest', false, String(error?.message ?? error))
  }

  const head = command('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])
  add('driver-head', head.ok, head.ok ? head.detail : `unable to resolve driver head: ${head.detail}`)
  const clean = command('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'])
  add('driver-clean', clean.ok && clean.detail === '', clean.ok && clean.detail === '' ? 'clean' : 'execution requires a committed clean driver checkout')
  const candidate = command('git', ['-C', repositoryRoot, 'cat-file', '-e', `${CANDIDATE_COMMIT}^{commit}`])
  add('candidate-present', candidate.ok, candidate.ok ? CANDIDATE_COMMIT : candidate.detail)
  const ancestor = command('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', CANDIDATE_COMMIT, 'HEAD'])
  add('candidate-ancestor', ancestor.ok, ancestor.ok ? 'candidate precedes the driver' : 'candidate must precede the frozen driver')

  const runtimePath = process.env.PLAN_LATTICE_LONG_SYSTEM_V11_HOST_RUNTIME
  if (runtimePath === undefined || runtimePath === '') {
    add('host-runtime', false, 'PLAN_LATTICE_LONG_SYSTEM_V11_HOST_RUNTIME is not set')
  } else if (!existsSync(runtimePath)) {
    add('host-runtime', false, 'configured host runtime path does not exist')
  } else if (manifest === undefined) {
    add('host-runtime', false, 'manifest is unavailable')
  } else {
    const digest = sha256(await readFile(runtimePath))
    add('host-runtime', digest === manifest.harness.hostRuntimeSha256,
      digest === manifest.harness.hostRuntimeSha256 ? `${HARNESS_COMMIT} runtime digest matches` : 'configured host runtime digest differs from the frozen manifest')
  }
  const node = command(process.execPath, ['--version'])
  add('node', node.ok, node.ok ? node.detail : node.detail)
  const pnpm = command('pnpm', ['--version'])
  add('pnpm', pnpm.ok, pnpm.ok ? pnpm.detail : pnpm.detail)

  const credentialPresent = typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.length > 0
  const readyForExecution = checks.every(check => check.passed) && credentialPresent
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    protocolId: 'plan-lattice-rc7-native-long-system-v11',
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
