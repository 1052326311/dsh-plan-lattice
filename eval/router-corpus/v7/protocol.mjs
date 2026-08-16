#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '..', '..', '..')
export const codeFreezeCommit = '3d34a2e'
export const runtimeFiles = ['src/router.ts', 'src/task-invariants.ts']
export const routes = ['bypass', 'contract', 'lattice', 'probe']
export const languages = ['en', 'zh']
export const longTaskThreshold = 8
export const reliabilityGates = {
  routeKappaMin: 0.75,
  routeAc1Min: 0.75,
  routeUnanimousMin: 0.8,
  primitiveKappaMin: 0.7,
  primitiveAc1Min: 0.8,
  primitiveUnanimousMin: 0.85,
}
export const releaseGates = {
  simpleFalseActivationRateMax: 0.05,
  complexCriticalRecallMin: 0.9,
  outcomeCriticalBypassMax: 0,
  exactAccuracyMin: 0.8,
  macroF1Min: 0.8,
  latticeRecallMin: 0.9,
  probeRecallMin: 0.85,
  probeFalsePositiveRateMax: 0.1,
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

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

export function resolvedCodeFreezeCommit() {
  return git(['rev-parse', codeFreezeCommit]).trim()
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
  const exact = resolvedCodeFreezeCommit()
  try {
    git(['merge-base', '--is-ancestor', exact, 'HEAD'])
  } catch {
    throw new Error(`V7 code freeze ${exact} is not an ancestor of HEAD`)
  }
  const frozenDigest = runtimeDigestAtCommit(exact)
  if (await runtimeDigestFromWorktree() !== frozenDigest) {
    throw new Error(`router runtime differs from V7 code freeze ${exact}`)
  }
  return { exactCommit: exact, runtimeDigest: frozenDigest }
}

export async function writeExclusive(path, body) {
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${path} already exists; V7 evidence is immutable`)
    throw error
  }
}

export async function assertArtifactsAbsent(paths, stage) {
  for (const path of paths) {
    try {
      await access(path)
      throw new Error(`${stage} output already exists: ${path}; refusing to overwrite evidence`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
