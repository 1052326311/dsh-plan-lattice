import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from './canonical.mjs'

export const evaluationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repositoryRoot = resolve(evaluationRoot, '..', '..')

async function walk(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

export async function digestTree(directory, filter = () => true) {
  const files = (await walk(directory))
    .map((path) => ({ path, relative: relative(directory, path) }))
    .filter(({ relative: name }) => filter(name))
    .sort((left, right) => left.relative.localeCompare(right.relative))
  return sha256(await Promise.all(files.map(async ({ path, relative: name }) => ({
    path: name,
    digest: sha256(await readFile(path)),
  }))))
}

export async function driverSourceDigest() {
  return digestTree(join(evaluationRoot, 'driver'), name => !name.includes('__pycache__') && !name.endsWith('.pyc'))
}

export async function renderProtocolChecksums() {
  const checksumPath = join(evaluationRoot, 'checksums.sha256')
  const candidates = [
    join(repositoryRoot, 'EVAL_PROTOCOL.md'),
    ...await walk(join(repositoryRoot, 'eval', 'router-corpus')),
    ...await walk(evaluationRoot),
  ]
  const files = candidates
    .map((path) => relative(repositoryRoot, path))
    .filter((path) => path !== relative(repositoryRoot, checksumPath))
    .sort()
  const lines = []
  for (const path of files) lines.push(`${sha256(await readFile(join(repositoryRoot, path)))}  ${path}`)
  return { rendered: `${lines.join('\n')}\n`, files }
}

export async function verifyProtocolChecksums() {
  const expected = await readFile(join(evaluationRoot, 'checksums.sha256'), 'utf8')
  const current = await renderProtocolChecksums()
  if (expected !== current.rendered) throw new Error('protocol checksum mismatch; execution and analysis are locked')
  return current.files.length
}

export function assertCandidateCheckout(candidate) {
  if (!/^[0-9a-f]{40}$/.test(candidate ?? '')) throw new Error('v0.4 candidate commit is not frozen')
  const object = spawnSync('git', ['-C', repositoryRoot, 'cat-file', '-e', `${candidate}^{commit}`])
  if (object.status !== 0) throw new Error('frozen v0.4 candidate commit is unavailable')
  const ancestor = spawnSync('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', candidate, 'HEAD'])
  if (ancestor.status !== 0) throw new Error('frozen v0.4 candidate is not an ancestor of the evaluation lock commit')
  const status = spawnSync('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
  if (status.status !== 0 || status.stdout.trim() !== '') throw new Error('v0.4 candidate checkout is not clean')
}
