#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, readJson } from './lib/canonical.mjs'
import { buildManifest } from './lib/design.mjs'
import { driverSourceDigest } from './lib/integrity.mjs'
import { validateBenchmarkLock, validateManifest, validatePreregistration } from './lib/validation.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const output = join(root, 'frozen-manifest.json')
const args = new Set(process.argv.slice(2))
const preregistration = await readJson(join(root, 'preregistration.json'))
const benchmarkLock = await readJson(join(root, 'benchmark-lock.json'))
const simpleTasks = await readJson(join(root, 'simple-tasks.json'))
const runtimeArtifacts = await readJson(join(root, 'runtime-artifacts.json'))
const routerBlindResult = await readJson(join(root, '..', 'router-corpus', 'blind-real-results.json'))
validatePreregistration(preregistration)
validateBenchmarkLock(benchmarkLock)
const manifest = buildManifest(preregistration, benchmarkLock, simpleTasks, runtimeArtifacts, routerBlindResult, await driverSourceDigest())
validateManifest(manifest)
const rendered = canonicalJson(manifest)

if (args.has('--write')) {
  await writeFile(output, rendered, 'utf8')
  console.log(`wrote ${output}`)
} else if (args.has('--print')) {
  process.stdout.write(rendered)
} else {
  try {
    await access(output)
    const existing = await readFile(output, 'utf8')
    if (existing !== rendered) throw new Error('frozen-manifest.json differs from the deterministic design; use --write only before preregistration freeze')
    console.log(`manifest ok: ${manifest.manifestDigest} (${manifest.counts.statistical} statistical + ${manifest.counts.infrastructure} infrastructure)`)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('frozen-manifest.json is missing; generate it once with --write')
    throw error
  }
}
