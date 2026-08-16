#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function copyPackage(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  const nestedNodeModules = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
  })
}

async function restoreDirectDependencies(manifestPath, sourceNodeModules, targetNodeModules) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(targetNodeModules, dependency)
    if (await exists(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!await exists(source)) {
      throw new Error(`deployed dependency ${dependency} is absent from both ${destination} and ${source}`)
    }
    await copyPackage(source, destination)
  }
}

async function firstSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await firstSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

export async function materializeLinks(directory) {
  let link = await firstSymlink(directory)
  while (link !== undefined) {
    if (link.split(sep).includes('.bin')) {
      await rm(link, { force: true })
    } else {
      const source = await realpath(link)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(link, { recursive: true, force: true })
      await cp(source, link, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
      })
    }
    link = await firstSymlink(directory)
  }
}

export async function stageHarnessCli({ harnessRoot, output, pnpm = 'pnpm', node = process.execPath }) {
  await mkdir(dirname(output), { recursive: true })
  await rm(output, { recursive: true, force: true })

  const deployArgs = [
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
  ]
  run(pnpm, ['--filter', 'dsh-plan-lattice-eval-runtime', ...deployArgs, output], { cwd: harnessRoot })

  await restoreDirectDependencies(
    join(output, 'package.json'),
    join(harnessRoot, 'apps', 'dsh-plan-lattice-eval-runtime', 'node_modules'),
    join(output, 'node_modules'),
  )
  await materializeLinks(join(output, 'node_modules'))

  const remaining = await firstSymlink(join(output, 'node_modules'))
  if (remaining !== undefined) throw new Error(`staged Harness runtime contains symlink ${remaining}`)
  const smoke = run(node, [join(output, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'])
  return { version: smoke.stdout.trim() }
}

function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

async function main() {
  const args = process.argv.slice(2)
  const harnessRoot = resolve(option(args, '--harness-root') ?? '')
  const output = resolve(option(args, '--output') ?? '')
  const pnpm = option(args, '--pnpm') ?? 'pnpm'
  const node = option(args, '--node') ?? process.execPath
  if (!harnessRoot || !output) {
    throw new Error('usage: stage-harness-cli.mjs --harness-root <path> --output <path> [--pnpm <path>] [--node <path>]')
  }
  process.stdout.write(`${JSON.stringify(await stageHarnessCli({ harnessRoot, output, pnpm, node }))}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
