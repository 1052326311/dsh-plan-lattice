#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '..', '..', '..')
export const codeFreezeCommit = 'e5020a07f6e059a4bae9c1f972569e6c484475df'
export const runtimeFiles = [
  'src/router.ts',
  'src/task-invariants.ts',
  'src/router-classifier.ts',
  'src/router-features.ts',
  'src/router-model.ts',
]
export const routes = ['bypass', 'contract', 'lattice']
export const languages = ['en', 'zh']
export const targetPerLanguage = { bypass: 30, contract: 18, lattice: 12 }
export const expectedCounts = {
  total: 120,
  english: 60,
  chinese: 60,
  bypass: 60,
  contract: 36,
  lattice: 24,
}
export const releaseGates = {
  simpleFalseActivationRateMax: 0.05,
  complexCriticalRecallMin: 0.9,
  outcomeCriticalBypassMax: 0,
  exactAccuracyMin: 0.8,
  macroF1Min: 0.8,
  latticeRecallMin: 0.75,
  probeRateMax: 0.1,
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function lines(values) {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`
}

export function parseJsonLines(text, name) {
  const trimmed = text.trim()
  if (trimmed === '') return []
  return trimmed.split('\n').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${name}:${index + 1} is not valid JSON`, { cause: error })
    }
  })
}

export async function loadJsonLines(name, { allowEmpty = false } = {}) {
  const text = await readFile(join(here, name), 'utf8')
  const rows = parseJsonLines(text, name)
  if (!allowEmpty && rows.length === 0) throw new Error(`${name} is empty`)
  return { text, rows }
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

export function currentCommit() {
  return git(['rev-parse', 'HEAD']).trim()
}

export function runtimeDigestAtCommit(commit = codeFreezeCommit) {
  const digests = runtimeFiles.map(path => sha256(git(['show', `${commit}:${path}`], { encoding: 'buffer' })))
  return sha256(digests.join('\n'))
}

export async function runtimeDigestFromWorktree() {
  const bodies = await Promise.all(runtimeFiles.map(path => readFile(join(repositoryRoot, path))))
  return sha256(bodies.map(body => sha256(body)).join('\n'))
}

export async function assertFrozenRuntime() {
  git(['cat-file', '-e', `${codeFreezeCommit}^{commit}`])
  try {
    git(['merge-base', '--is-ancestor', codeFreezeCommit, 'HEAD'])
  } catch {
    throw new Error(`V5 code freeze ${codeFreezeCommit} is not an ancestor of ${currentCommit()}`)
  }
  const frozenDigest = runtimeDigestAtCommit()
  const worktreeDigest = await runtimeDigestFromWorktree()
  if (worktreeDigest !== frozenDigest) {
    throw new Error(`router runtime differs from V5 code freeze ${codeFreezeCommit}`)
  }
  return frozenDigest
}

export async function writeExclusive(path, body) {
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`${path} already exists; the V5 first reveal is immutable`)
    }
    throw error
  }
}

export async function assertArtifactsAbsent(paths, stage) {
  for (const path of paths) {
    try {
      await access(path)
      throw new Error(`${stage} output already exists: ${path}; refusing to overwrite immutable evidence`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
