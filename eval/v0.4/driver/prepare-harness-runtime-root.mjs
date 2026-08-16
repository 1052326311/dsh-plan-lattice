#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_NAME = 'dsh-plan-lattice-eval-runtime'
const RUNTIME_RELATIVE_PATH = join('apps', RUNTIME_NAME, 'package.json')

async function packageManifestPaths(root) {
  const paths = []
  for (const parent of ['vendor', 'apps']) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(root, parent, entry.name, 'package.json'))
    }
  }
  for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(root, 'packages', group.name, entry.name, 'package.json'))
    }
  }
  return paths.sort()
}

async function loadWorkspace(root) {
  const workspace = new Map()
  for (const path of await packageManifestPaths(root)) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (typeof manifest.name === 'string') workspace.set(manifest.name, { manifest, path })
  }
  return workspace
}

export async function buildHarnessRuntimeManifest(harnessRoot) {
  const workspace = await loadWorkspace(harnessRoot)
  const entry = '@deepseek-ai/dsh'
  if (!workspace.has(entry)) throw new Error(`Harness workspace does not contain ${entry}`)
  const rootDependencies = new Set([entry])
  const visited = new Set()
  const queue = [entry]

  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index]
    if (visited.has(name)) continue
    visited.add(name)
    const current = workspace.get(name)?.manifest
    if (current === undefined) continue
    const peerMeta = current.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(current.peerDependencies ?? {}).sort()) {
      if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
      rootDependencies.add(peer)
      if (!visited.has(peer)) queue.push(peer)
    }
    const dependencies = { ...current.dependencies, ...current.optionalDependencies }
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!workspace.has(dependency)) continue
      rootDependencies.add(dependency)
      if (!visited.has(dependency)) queue.push(dependency)
    }
  }

  return {
    name: RUNTIME_NAME,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([...rootDependencies].sort().map(name => [name, 'workspace:^'])),
    planLatticeRuntimeClosure: {
      entry,
      reachableWorkspacePackages: visited.size,
    },
  }
}

export async function prepareHarnessRuntimeRoot(harnessRoot) {
  const manifest = await buildHarnessRuntimeManifest(harnessRoot)
  const path = join(harnessRoot, RUNTIME_RELATIVE_PATH)
  const rendered = `${JSON.stringify(manifest, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, rendered, 'utf8')
  return {
    path,
    relativePath: RUNTIME_RELATIVE_PATH,
    dependencyCount: Object.keys(manifest.dependencies).length,
    reachableWorkspacePackages: manifest.planLatticeRuntimeClosure.reachableWorkspacePackages,
    sha256: createHash('sha256').update(rendered).digest('hex'),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const index = args.indexOf('--harness-root')
  const rawRoot = index === -1 ? undefined : args[index + 1]
  if (!rawRoot) throw new Error('usage: prepare-harness-runtime-root.mjs --harness-root <path>')
  process.stdout.write(`${JSON.stringify(await prepareHarnessRuntimeRoot(resolve(rawRoot)))}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
