import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson, sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import { repositoryRoot, studyProtectedPaths } from './protocol.mjs'

function git(args, { binary = false } = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed while verifying RC.4 execution integrity`)
  return result.stdout
}

export function resolveCommit(ref, context) {
  const commit = git(['rev-parse', `${ref}^{commit}`]).trim()
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error(`${context} is not an exact commit`)
  return commit
}

export function digestGitPaths(commit, paths) {
  const exact = resolveCommit(commit, 'source digest commit')
  const names = git(['ls-tree', '-r', '--name-only', exact, '--', ...paths])
    .trim().split('\n').filter(Boolean).sort()
  if (names.length === 0) throw new Error('source digest path set is empty')
  const records = names.map(path => {
    const body = git(['show', `${exact}:${path}`], { binary: true })
    return `${path}\0${createHash('sha256').update(body).digest('hex')}`
  })
  return { commit: exact, files: names, digest: sha256(`${records.join('\n')}\n`) }
}

export function studySourceDigest(studyProtocolCommit) {
  return digestGitPaths(studyProtocolCommit, studyProtectedPaths)
}

export function assertExecutionFreeze(envelope, studySpec) {
  const studyCommit = resolveCommit(studySpec.studyProtocolFreeze.publicRef, 'study protocol tag')
  if (studyCommit !== envelope.studyProtocolCommit) throw new Error('execution envelope uses another study protocol commit')
  const executionCommit = resolveCommit(studySpec.executionFreeze.futurePublicRef, 'execution freeze tag')
  const ancestry = spawnSync('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', studyCommit, executionCommit])
  if (ancestry.status !== 0) throw new Error('execution freeze does not descend from the study freeze')
  const frozenBody = git(['show', `${executionCommit}:${studySpec.executionFreeze.evidencePath}`])
  let frozen
  try {
    frozen = JSON.parse(frozenBody)
  } catch {
    throw new Error('execution freeze envelope is not valid JSON')
  }
  if (canonicalJson(frozen) !== canonicalJson(envelope)) throw new Error('execution envelope differs from its public freeze')
  const source = studySourceDigest(studyCommit)
  if (source.digest !== envelope.controllerSourceDigest) throw new Error('study source digest differs from the execution envelope')
  return { studyCommit, executionCommit, sourceDigest: source.digest, files: source.files.length }
}

export async function loadExecutionEnvelope(path, studySpec) {
  const bytes = await readFile(resolve(path))
  const envelope = JSON.parse(bytes)
  const freeze = assertExecutionFreeze(envelope, studySpec)
  return { envelope, bytes, path: resolve(path), digest: sha256(bytes), freeze }
}
