#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '..', '..', '..')
export const protocolId = 'observable-authorization-v10'
export const runtimeCommit = '3d34a2e6fe71870caedb0bedecd53cfdb38195ef'
export const cutoff = '2026-08-15T23:59:59Z'
export const collectionSeedCommitment = '61a2d0ced07ddcaf4c5deb963e9be6997a1203c741ba7010ddb5c9cdaa5a965c'
export const routes = ['bypass', 'contract', 'lattice', 'probe']
export const languages = ['en', 'zh']
export const sourceObjectTypes = ['issue', 'issue-comment-request', 'pull-review']
export const challengeFamilies = ['bounded', 'decision', 'continuity', 'repository-contingent']
export const queueCounts = {
  naturalPerLanguage: 400,
  challengePerFamilyPerLanguage: 60,
  naturalTotal: 800,
  challengeTotal: 480,
  total: 1280,
}
export const diversityCaps = {
  natural: {
    perRepository: 10,
    perOrganization: 20,
    perAuthor: 2,
    ecosystemShare: 0.15,
    objectTypeShare: 0.25,
  },
  challenge: {
    perRepositoryPerStratum: 4,
    perOrganizationPerStratum: 8,
    perEcosystemPerStratum: 12,
    minimumRepositoriesPerStratum: 15,
    minimumOrganizationsPerStratum: 8,
  },
  nearDuplicateJaccard: 0.85,
}
export const reliabilityGates = {
  kappaMin: 0.75,
  ac1Min: 0.80,
  unanimousMin: 0.85,
  rarePositiveJaccardMin: 0.60,
  rarePositivePerLanguageMin: 40,
}
export const releaseGates = {
  confidence: 0.95,
  bypassFalseActivationUpperMax: 0.05,
  contractRecallLowerMin: 0.85,
  latticeRecallLowerMin: 0.90,
  probeRecallLowerMin: 0.85,
  outcomeCriticalBypassMax: 0,
  probeFalsePositiveUpperMax: 0.10,
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function stableLines(values) {
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

export function assertBeforeCutoff(value, label) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is not an ISO timestamp`)
  if (timestamp > Date.parse(cutoff)) throw new Error(`${label} is later than the frozen cutoff`)
  return value
}

export function deterministicKey(seed, queue, stratum, stableSourceId) {
  if (![seed, queue, stratum, stableSourceId].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('deterministic selection requires non-empty seed, queue, stratum, and stableSourceId')
  }
  return sha256(`${seed}\n${queue}\n${stratum}\n${stableSourceId}`)
}

export function assertCandidateShape(candidate) {
  const keys = Object.keys(candidate).sort()
  if (JSON.stringify(keys) !== JSON.stringify(['id', 'language', 'queue', 'text'])) {
    throw new Error(`candidate ${candidate.id ?? '<unknown>'} exposes forbidden fields`)
  }
  if (!languages.includes(candidate.language)) throw new Error(`candidate ${candidate.id} has invalid language`)
  if (!['natural', 'challenge'].includes(candidate.queue)) throw new Error(`candidate ${candidate.id} has invalid queue`)
  if (typeof candidate.text !== 'string' || candidate.text.trim().length < 80) {
    throw new Error(`candidate ${candidate.id} is missing usable request text`)
  }
  for (const forbidden of ['route', 'expected', 'outcomeCritical', 'constructionFamily', 'sourceTier', 'modelScore']) {
    if (Object.hasOwn(candidate, forbidden)) throw new Error(`candidate ${candidate.id} leaks ${forbidden}`)
  }
  return candidate
}

export async function writeExclusive(path, body) {
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${path} already exists; V10 evidence is immutable`)
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

export async function digestFiles(paths) {
  const entries = []
  for (const path of [...paths].sort()) {
    entries.push({ path, sha256: sha256(await readFile(path)) })
  }
  return entries
}
