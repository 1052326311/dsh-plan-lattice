#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../lib/canonical.mjs'
import { withoutEvaluationCapabilities } from './lib/environment.mjs'
import { prepareHarnessRuntimeRoot } from './prepare-harness-runtime-root.mjs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const harnessRoot = resolve(option('--harness-root') ?? '')
const output = resolve(option('--output') ?? '')
const commit = option('--harness-commit')
if (!harnessRoot || !output || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  throw new Error('usage: build-host-harness-runtime.mjs --harness-root <path> --harness-commit <sha> --output <tgz>')
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result
}

run('git', ['-C', harnessRoot, 'cat-file', '-e', `${commit}^{commit}`])
const scratch = await mkdtemp(join(tmpdir(), 'plan-lattice-host-harness-'))
const archive = join(scratch, 'source.tar')
const checkout = join(scratch, 'checkout')
const runtime = join(scratch, 'runtime')
const tooling = join(scratch, 'tooling')
await mkdir(checkout)
await mkdir(runtime)
run('git', ['-C', harnessRoot, 'archive', '--format=tar', '-o', archive, commit])
run('tar', ['-xf', archive, '-C', checkout])
const buildEnvironment = { ...withoutEvaluationCapabilities(), CI: '1' }
run('npm', ['install', '--prefix', tooling, '--ignore-scripts', '--no-audit', '--no-fund', 'pnpm@11.7.0'], { env: buildEnvironment })
const pnpmBin = join(tooling, 'node_modules', '.bin', 'pnpm')
const pnpmVersion = run(pnpmBin, ['--version'], { env: buildEnvironment }).stdout.trim()
if (pnpmVersion !== '11.7.0') throw new Error(`expected pnpm 11.7.0, got ${pnpmVersion}`)
const preparedRuntimeClosure = await prepareHarnessRuntimeRoot(checkout)
const runtimeClosure = {
  dependencyCount: preparedRuntimeClosure.dependencyCount,
  reachableWorkspacePackages: preparedRuntimeClosure.reachableWorkspacePackages,
  sha256: preparedRuntimeClosure.sha256,
}
run(pnpmBin, ['install', '--no-frozen-lockfile'], { cwd: checkout, env: buildEnvironment })
run(pnpmBin, ['install', '--frozen-lockfile'], { cwd: checkout, env: buildEnvironment })
run(pnpmBin, ['exec', 'tsx', 'scripts/verify-runtime-closure.ts', '--manifest', preparedRuntimeClosure.relativePath], { cwd: checkout, env: buildEnvironment })
run(pnpmBin, ['build'], { cwd: checkout, env: buildEnvironment })
run(process.execPath, [
  join(dirname(fileURLToPath(import.meta.url)), 'stage-harness-cli.mjs'),
  '--harness-root', checkout,
  '--output', join(runtime, 'dsh'),
  '--pnpm', pnpmBin,
], { env: buildEnvironment })
await writeFile(join(runtime, 'runtime.json'), `${JSON.stringify({
  schemaVersion: 1,
  harnessCommit: commit,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  pnpm: pnpmVersion,
  runtimeClosure,
}, null, 2)}\n`, 'utf8')
await mkdir(dirname(output), { recursive: true })
run('tar', ['-czf', output, '-C', runtime, '.'])
process.stdout.write(`${JSON.stringify({
  path: output,
  sha256: sha256(await readFile(output)),
  harnessCommit: commit,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  pnpm: pnpmVersion,
  runtimeClosure,
})}\n`)
