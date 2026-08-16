#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { sha256 } from '../lib/canonical.mjs'

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
await mkdir(checkout)
await mkdir(runtime)
run('git', ['-C', harnessRoot, 'archive', '--format=tar', '-o', archive, commit])
run('tar', ['-xf', archive, '-C', checkout])
run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout, env: { ...process.env, CI: '1' } })
run('pnpm', ['build'], { cwd: checkout })
run('pnpm', ['--filter', '@deepseek-ai/dsh', 'deploy', '--prod', join(runtime, 'dsh')], { cwd: checkout })
await writeFile(join(runtime, 'runtime.json'), `${JSON.stringify({
  schemaVersion: 1,
  harnessCommit: commit,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
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
})}\n`)
