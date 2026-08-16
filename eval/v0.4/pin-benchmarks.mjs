#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, readJson } from './lib/canonical.mjs'
import { validateBenchmarkLock } from './lib/validation.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const lockPath = join(root, 'benchmark-lock.json')
const lock = await readJson(lockPath)
const args = new Set(process.argv.slice(2))

function remoteHead(repository) {
  const output = execFileSync('git', ['ls-remote', repository, 'HEAD'], { encoding: 'utf8' }).trim()
  const commit = output.split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`could not resolve HEAD for ${repository}`)
  return commit
}

function localHead(path) {
  return execFileSync('git', ['-C', resolve(path), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function parseIcaeRegistry(path) {
  const lines = readFileSync(join(resolve(path), 'harness', 'repos.yaml'), 'utf8').split(/\r?\n/)
  const rows = []
  let current
  for (const line of lines) {
    const id = line.match(/^\s*- repo_id:\s*(.+)$/)
    if (id) {
      if (current) rows.push(current)
      current = { repoId: id[1].trim() }
      continue
    }
    const language = line.match(/^\s+language:\s*(.+)$/)
    if (language && current) current.language = language[1].trim()
  }
  if (current) rows.push(current)
  return rows
}

validateBenchmarkLock(lock)

if (args.has('--resolve-heads')) {
  const proposed = structuredClone(lock)
  proposed.resolvedAt = new Date().toISOString()
  for (const name of ['harness', 'harbor', 'icae', 'evocode']) {
    const source = proposed.sources[name]
    source.ref = remoteHead(source.repository)
    source.commit = source.ref
  }
  if (args.has('--write')) {
    await writeFile(lockPath, canonicalJson(proposed), 'utf8')
    console.log(`updated ${lockPath}`)
  } else {
    process.stdout.write(canonicalJson(proposed))
  }
  process.exit(0)
}

const roots = {
  harness: process.env.DEEPSEEK_HARNESS_ROOT,
  harbor: process.env.HARBOR_ROOT,
  icae: process.env.ICAE_EVAL_ROOT,
  evocode: process.env.EVOCODE_BENCH_ROOT,
}
let checked = 0
for (const [name, path] of Object.entries(roots)) {
  if (!path) continue
  const actual = localHead(path)
  const expected = lock.sources[name].commit
  if (actual !== expected) throw new Error(`${name} checkout mismatch: expected ${expected}, got ${actual}`)
  checked += 1
  console.log(`${name}: ${actual} ok`)
  if (name === 'icae') {
    const registry = parseIcaeRegistry(path)
    const salt = lock.sources.icae.selection.salt
    const buckets = [
      ['JavaScript+TypeScript', ['JavaScript', 'TypeScript']],
      ['Python', ['Python']],
      ['Go', ['Go']],
    ]
    const selected = buckets.flatMap(([, languages]) => registry
      .filter((entry) => languages.includes(entry.language))
      .map((entry) => ({
        ...entry,
        selectionHash: createHash('sha256').update(`${salt}:${entry.repoId}`).digest('hex'),
      }))
      .sort((left, right) => left.selectionHash.localeCompare(right.selectionHash))
      .slice(0, 2))
    const pinned = lock.sources.icae.selectedTasks.map(({ repoId, language, selectionHash }) => ({ repoId, language, selectionHash }))
    if (JSON.stringify(selected) !== JSON.stringify(pinned)) throw new Error('ICAE selected tasks do not match the preregistered hash rule')
    console.log('icae task selection: 6/6 ok')
  }
  if (name === 'evocode') {
    for (const task of lock.sources.evocode.selectedTasks) {
      const path = join(resolve(roots.evocode), 'docs', 'data', 'tasks', `${task.id}.json`)
      await readFile(path, 'utf8')
    }
    console.log('evocode task selection: 3/3 ok')
  }
}
if (checked === 0) {
  console.log('benchmark lock is structurally valid; set DEEPSEEK_HARNESS_ROOT, HARBOR_ROOT, ICAE_EVAL_ROOT, and EVOCODE_BENCH_ROOT to verify local checkouts')
}

// Keep a direct read in this script so checksum audits cover the exact lock bytes.
await readFile(lockPath, 'utf8')
