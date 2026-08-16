#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '..', '..', '..')
export const protocolId = 'observable-authorization-v11'
export const cutoff = '2026-08-15T23:59:59Z'
export const selectionSeedCommitment = 'bc4b973e64fe9065ab3e956425a4c16193e1d6613c458b5aa5801c0ac6b1301a'
export const constructionFamilies = ['bounded', 'decision', 'continuity', 'repository-contingent']
export const familyPriority = new Map([
  ['continuity', 0],
  ['decision', 1],
  ['repository-contingent', 2],
  ['bounded', 3],
  ['natural', 4],
])

export class ProtocolFailure extends Error {
  constructor(failureClass, message, details = {}) {
    super(message)
    this.name = 'ProtocolFailure'
    this.failureClass = failureClass
    this.stage = details.stage ?? 'unknown'
    this.operation = details.operation
    this.rateLimit = details.rateLimit
    this.details = details.details
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function stableLines(values) {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`
}

export function parseJsonLines(text, name) {
  if (text.trim() === '') return []
  return text.trim().split('\n').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new ProtocolFailure('invalid-jsonl', `${name}:${index + 1} is not valid JSON`, {
        stage: 'input-validation',
      })
    }
  })
}

export function option(name, argv = process.argv) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

export async function writeExclusive(path, body) {
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ProtocolFailure('output-reuse', `${path} already exists; V11 evidence is immutable`, {
        stage: 'artifact-write',
        operation: path,
      })
    }
    throw error
  }
}

export async function assertArtifactsAbsent(paths, stage) {
  for (const path of paths) {
    try {
      await access(path)
      throw new ProtocolFailure('output-reuse', `${stage} output already exists: ${path}`, {
        stage,
        operation: path,
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
}

export function validateSpec(spec, v10Spec, v10SpecBytes) {
  if (spec?.schemaVersion !== 1 || spec.protocol !== protocolId || spec.cutoff !== cutoff) {
    throw new Error('source-frame spec does not match the frozen V11 protocol')
  }
  if (spec.selectionSeedAccess !== 'forbidden-during-exposure-recovery-and-source-frame-collection') {
    throw new Error('V11 source stages must forbid selection-seed access')
  }
  if (spec.selectionSeedCommitment !== selectionSeedCommitment) {
    throw new Error('V11 trimmed selection-seed commitment mismatch')
  }
  if (sha256(v10SpecBytes) !== spec.v10.specSha256) throw new Error('frozen V10 source-frame spec digest mismatch')
  if (v10Spec.protocol !== spec.v10.protocol || v10Spec.cutoff !== spec.cutoff) {
    throw new Error('V10 query source does not match the V11 cutoff and protocol binding')
  }
  if (v10Spec.searches?.length !== spec.v10.expectedSearchCount) throw new Error('frozen V10 search count mismatch')
  const ids = new Set()
  for (const search of v10Spec.searches) {
    if (ids.has(search.id)) throw new Error(`duplicate frozen search id ${search.id}`)
    ids.add(search.id)
    if (!['en', 'zh'].includes(search.language) || !familyPriority.has(search.family)) {
      throw new Error(`invalid frozen search ${search.id}`)
    }
    if (!search.query.includes('updated:<=2026-08-15')) throw new Error(`search ${search.id} does not bind the cutoff`)
  }
  positiveInteger(spec.v10.exposureSearchPage, 'v10.exposureSearchPage')
  positiveInteger(spec.searchFrame.firstPage, 'searchFrame.firstPage')
  positiveInteger(spec.searchFrame.lastPage, 'searchFrame.lastPage')
  positiveInteger(spec.searchFrame.resultsPerPage, 'searchFrame.resultsPerPage')
  positiveInteger(spec.searchFrame.githubAccessibleResultLimit, 'searchFrame.githubAccessibleResultLimit')
  positiveInteger(spec.searchFrame.maximumCandidatesPerSearch, 'searchFrame.maximumCandidatesPerSearch')
  positiveInteger(spec.limits.graphqlBatchSize, 'limits.graphqlBatchSize')
  if (spec.v10.exposureSearchPage !== 1 || spec.searchFrame.firstPage !== 2 || spec.searchFrame.lastPage !== 10) {
    throw new Error('V11 must register V10 page 1 and collect only pages 2 through 10')
  }
  if (spec.searchFrame.resultsPerPage !== 100 || spec.searchFrame.githubAccessibleResultLimit !== 1000) {
    throw new Error('V11 search frame must bind GitHub 100-item pages and the 1,000-result ceiling')
  }
  return spec
}

export async function loadFrozenInputs() {
  const specPath = resolve(here, 'source-frame-spec.json')
  const specBytes = await readFile(specPath)
  const spec = JSON.parse(specBytes)
  const v10SpecPath = resolve(here, spec.v10.specPath)
  const v10SpecBytes = await readFile(v10SpecPath)
  const v10Spec = JSON.parse(v10SpecBytes)
  validateSpec(spec, v10Spec, v10SpecBytes)
  return { spec, specBytes, specPath, v10Spec, v10SpecBytes, v10SpecPath }
}

export function sanitizedFailure(error, context = {}) {
  const failure = error instanceof ProtocolFailure
    ? error
    : new ProtocolFailure('unexpected-source-stage-error', error?.message ?? String(error), {
        stage: context.stage ?? 'unknown',
      })
  return {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'retired-before-seed-reveal',
    seedAccessed: false,
    stage: failure.stage,
    failureClass: failure.failureClass,
    message: String(failure.message).replace(/gh[pousr]_[A-Za-z0-9_]+/gu, '<redacted>'),
    ...(failure.operation === undefined ? {} : { operation: failure.operation }),
    ...(failure.rateLimit === undefined ? {} : { rateLimit: failure.rateLimit }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
    ...context,
  }
}
