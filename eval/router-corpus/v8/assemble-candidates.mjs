#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertArtifactsAbsent,
  assertBeforeCutoff,
  assertCandidateShape,
  challengeFamilies,
  collectionSeedCommitment,
  cutoff,
  deterministicKey,
  here,
  languages,
  parseJsonLines,
  protocolId,
  queueCounts,
  sha256,
  sourceObjectTypes,
  stableLines,
  writeExclusive,
} from './protocol.mjs'
import {
  assertDiversityCaps,
  assertSourceDisjoint,
  canonicalPrompt,
  priorSourceInventory,
} from './source-isolation.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function exactKeys(value, expected, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} must contain exactly ${expected.join(', ')}`)
  }
}

function nonEmpty(value, context) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} must be a non-empty string`)
  return value.trim()
}

function stringArray(value, context) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${context} must be an array of non-empty strings`)
  }
  return [...new Set(value.map(item => item.trim()))].sort()
}

const registryKeys = [
  'schemaVersion', 'protocol', 'cutoff', 'seedCommitment', 'minimumNetworksPerLanguage',
  'platformApiVersions', 'sources',
]
const registrySourceKeys = [
  'platform', 'repository', 'repositoryNodeId', 'networkRoot', 'organization',
  'ecosystem', 'nativeLanguage', 'objectTypes', 'discussionCategoryIds',
]

export function validateRegistry(value) {
  exactKeys(value, registryKeys, 'source registry')
  if (value.schemaVersion !== 1 || value.protocol !== protocolId || value.cutoff !== cutoff) {
    throw new Error('source registry protocol identity is invalid')
  }
  if (value.seedCommitment !== collectionSeedCommitment) throw new Error('source registry seed commitment mismatch')
  if (!Number.isInteger(value.minimumNetworksPerLanguage) || value.minimumNetworksPerLanguage < 36) {
    throw new Error('source registry requires at least 36 networks per language')
  }
  if (value.platformApiVersions === null || typeof value.platformApiVersions !== 'object' || Array.isArray(value.platformApiVersions)) {
    throw new Error('source registry platformApiVersions must be an object')
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) throw new Error('source registry has no sources')
  const identities = new Set()
  for (const [index, source] of value.sources.entries()) {
    exactKeys(source, registrySourceKeys, `source registry sources[${index}]`)
    for (const key of ['platform', 'repository', 'repositoryNodeId', 'networkRoot', 'organization', 'ecosystem']) {
      nonEmpty(source[key], `source registry sources[${index}].${key}`)
    }
    if (!languages.includes(source.nativeLanguage)) throw new Error(`source registry sources[${index}] has invalid nativeLanguage`)
    const objectTypes = stringArray(source.objectTypes, `source registry sources[${index}].objectTypes`)
    if (objectTypes.length === 0 || objectTypes.some(value => !sourceObjectTypes.includes(value))) {
      throw new Error(`source registry sources[${index}] has an invalid object type`)
    }
    stringArray(source.discussionCategoryIds, `source registry sources[${index}].discussionCategoryIds`)
    const identity = `${source.platform}:${source.repositoryNodeId}`
    if (identities.has(identity)) throw new Error(`source registry duplicates ${identity}`)
    identities.add(identity)
  }
  for (const language of languages) {
    const networks = new Set(value.sources.filter(source => source.nativeLanguage === language).map(source => source.networkRoot))
    if (networks.size < value.minimumNetworksPerLanguage) {
      throw new Error(`source registry ${language} has ${networks.size} networks; requires ${value.minimumNetworksPerLanguage}`)
    }
  }
  const forbidden = JSON.stringify(value)
  if (/"(?:route|expected|outcomeCritical|modelScore|routerPrediction|issueLabel)"\s*:/i.test(forbidden)) {
    throw new Error('source registry contains a forbidden route-like field')
  }
  return value
}

const frameKeys = [
  'stableSourceId', 'queue', 'constructionFamily', 'language', 'text', 'platform',
  'objectType', 'repository', 'repositoryNodeId', 'networkRoot', 'organization',
  'ecosystem', 'authorId', 'url', 'nodeId', 'createdAt', 'contentUpdatedAt',
  'immutableAtCutoff', 'sourceContentDigest', 'promptDigest', 'canonicalPromptDigest',
  'relatedPullRequests', 'relatedCommits', 'duplicateChain', 'sourceFamilyId',
]

export function validateFrameRow(row, index, registry) {
  exactKeys(row, frameKeys, `source frame:${index + 1}`)
  for (const key of [
    'stableSourceId', 'text', 'platform', 'objectType', 'repository', 'repositoryNodeId',
    'networkRoot', 'organization', 'ecosystem', 'authorId', 'url', 'nodeId',
    'sourceContentDigest', 'promptDigest', 'canonicalPromptDigest', 'sourceFamilyId',
  ]) nonEmpty(row[key], `source frame:${index + 1}.${key}`)
  if (!['natural', 'challenge'].includes(row.queue)) throw new Error(`source frame:${index + 1} has invalid queue`)
  if (!languages.includes(row.language)) throw new Error(`source frame:${index + 1} has invalid language`)
  if (row.queue === 'natural' && row.constructionFamily !== null) {
    throw new Error(`source frame:${index + 1} natural rows cannot carry a construction family`)
  }
  if (row.queue === 'challenge' && !challengeFamilies.includes(row.constructionFamily)) {
    throw new Error(`source frame:${index + 1} challenge row has invalid construction family`)
  }
  if (row.immutableAtCutoff !== true) throw new Error(`source frame:${index + 1} is not immutable at cutoff`)
  assertBeforeCutoff(row.createdAt, `source frame:${index + 1}.createdAt`)
  assertBeforeCutoff(row.contentUpdatedAt, `source frame:${index + 1}.contentUpdatedAt`)
  for (const key of ['relatedPullRequests', 'relatedCommits', 'duplicateChain']) {
    row[key] = stringArray(row[key], `source frame:${index + 1}.${key}`)
  }
  if (sha256(row.text) !== row.promptDigest) throw new Error(`source frame:${index + 1} prompt digest mismatch`)
  if (sha256(canonicalPrompt(row.text)) !== row.canonicalPromptDigest) {
    throw new Error(`source frame:${index + 1} canonical prompt digest mismatch`)
  }
  if (!/^[a-f0-9]{64}$/.test(row.sourceContentDigest)) throw new Error(`source frame:${index + 1} source digest is invalid`)
  const registered = registry.sources.find(source => (
    source.platform === row.platform && source.repositoryNodeId === row.repositoryNodeId
  ))
  if (registered === undefined) throw new Error(`source frame:${index + 1} is absent from the frozen registry`)
  for (const key of ['repository', 'networkRoot', 'organization', 'ecosystem']) {
    if (registered[key] !== row[key]) throw new Error(`source frame:${index + 1}.${key} differs from the frozen registry`)
  }
  if (registered.nativeLanguage !== row.language || !registered.objectTypes.includes(row.objectType)) {
    throw new Error(`source frame:${index + 1} language or object type differs from the frozen registry`)
  }
  const serialized = JSON.stringify(row)
  if (/"(?:route|expected|outcomeCritical|modelScore|routerPrediction|issueLabels?)"\s*:/i.test(serialized)) {
    throw new Error(`source frame:${index + 1} contains a forbidden route-like field`)
  }
  return row
}

function counterKey(row, dimension) {
  if (dimension === 'repository') return row.repository.toLowerCase()
  if (dimension === 'organization') return row.organization.toLowerCase()
  if (dimension === 'author') return row.authorId.toLowerCase()
  if (dimension === 'ecosystem') return row.ecosystem.toLowerCase()
  if (dimension === 'objectType') return row.objectType.toLowerCase()
  if (dimension === 'sourceFamily') return row.sourceFamilyId.toLowerCase()
  throw new Error(`unknown diversity dimension ${dimension}`)
}

export function selectWithCaps(rows, count, seed, queue, stratum, caps) {
  const ordered = [...rows].sort((left, right) => (
    deterministicKey(seed, queue, stratum, left.stableSourceId)
      .localeCompare(deterministicKey(seed, queue, stratum, right.stableSourceId))
  ))
  const selected = []
  const counters = Object.fromEntries(Object.keys(caps).map(key => [key, new Map()]))
  for (const row of ordered) {
    const allowed = Object.entries(caps).every(([dimension, cap]) => {
      const key = counterKey(row, dimension)
      return (counters[dimension].get(key) ?? 0) < cap
    })
    if (!allowed) continue
    selected.push(row)
    for (const dimension of Object.keys(caps)) {
      const key = counterKey(row, dimension)
      counters[dimension].set(key, (counters[dimension].get(key) ?? 0) + 1)
    }
    if (selected.length === count) break
  }
  if (selected.length !== count) throw new Error(`${queue}/${stratum} selected ${selected.length}; requires ${count}`)
  return selected
}

function validateSelectedDiversity(rows) {
  if (new Set(rows.map(row => row.sourceFamilyId)).size !== rows.length) {
    throw new Error('selected rows reuse a source task family')
  }
  for (const language of languages) {
    const natural = rows.filter(row => row.queue === 'natural' && row.language === language)
    assertDiversityCaps(natural, {
      author: 2,
      repository: 10,
      organization: 20,
      ecosystem: Math.floor(queueCounts.naturalPerLanguage * 0.15),
    })
    const objectTypes = new Map()
    for (const row of natural) objectTypes.set(row.objectType, (objectTypes.get(row.objectType) ?? 0) + 1)
    if ([...objectTypes.values()].some(count => count > queueCounts.naturalPerLanguage * 0.25)) {
      throw new Error(`natural/${language} exceeds the object-type share cap`)
    }
    for (const family of challengeFamilies) {
      const challenge = rows.filter(row => row.queue === 'challenge'
        && row.language === language && row.constructionFamily === family)
      assertDiversityCaps(challenge, { author: 60, repository: 4, organization: 8, ecosystem: 12 })
      if (new Set(challenge.map(row => row.repository)).size < 15) {
        throw new Error(`challenge/${language}/${family} has fewer than 15 repositories`)
      }
      if (new Set(challenge.map(row => row.organization)).size < 8) {
        throw new Error(`challenge/${language}/${family} has fewer than 8 organizations`)
      }
    }
  }
}

async function main() {
  const framePath = option('--frame')
  const registryPath = option('--registry')
  const seedPath = option('--seed-file')
  const outputDirectory = resolve(option('--output-dir') ?? here)
  if ([framePath, registryPath, seedPath].some(value => value === undefined)) {
    throw new Error('usage: assemble-candidates.mjs --frame <source-frame.jsonl> --registry <source-registry.json> --seed-file <seed>')
  }
  const outputPaths = {
    candidates: join(outputDirectory, 'candidates.jsonl'),
    sources: join(outputDirectory, 'sources.private.jsonl'),
    ledger: join(outputDirectory, 'selection-ledger.jsonl'),
    manifest: join(outputDirectory, 'candidate-manifest.json'),
    registry: join(outputDirectory, 'source-registry.archive.json'),
  }
  await assertArtifactsAbsent(Object.values(outputPaths), 'V8 candidate assembly')
  const [frameText, registryText, seedText] = await Promise.all([
    readFile(resolve(framePath), 'utf8'),
    readFile(resolve(registryPath), 'utf8'),
    readFile(resolve(seedPath), 'utf8'),
  ])
  const seed = seedText.trim()
  if (sha256(seed) !== collectionSeedCommitment) throw new Error('selection seed does not match the preregistered commitment')
  const registry = validateRegistry(JSON.parse(registryText))
  const frame = parseJsonLines(frameText, basename(framePath)).map((row, index) => validateFrameRow(row, index, registry))
  if (new Set(frame.map(row => row.stableSourceId)).size !== frame.length) throw new Error('source frame duplicates stableSourceId')
  const prior = await priorSourceInventory()
  assertSourceDisjoint(frame, prior)

  const selected = []
  for (const language of languages) {
    selected.push(...selectWithCaps(
      frame.filter(row => row.queue === 'natural' && row.language === language),
      queueCounts.naturalPerLanguage,
      seed,
      'natural',
      language,
      { author: 2, repository: 10, organization: 20, ecosystem: 60, objectType: 100, sourceFamily: 1 },
    ))
    for (const family of challengeFamilies) {
      selected.push(...selectWithCaps(
        frame.filter(row => row.queue === 'challenge'
          && row.language === language && row.constructionFamily === family),
        queueCounts.challengePerFamilyPerLanguage,
        seed,
        'challenge',
        `${language}/${family}`,
        { repository: 4, organization: 8, ecosystem: 12, sourceFamily: 1 },
      ))
    }
  }
  if (selected.length !== queueCounts.total) throw new Error(`selected ${selected.length}; requires ${queueCounts.total}`)
  validateSelectedDiversity(selected)

  const selectedIds = new Set(selected.map(row => row.stableSourceId))
  const candidates = selected.map(row => assertCandidateShape({
    id: `v8-${sha256(row.stableSourceId).slice(0, 16)}`,
    language: row.language,
    queue: row.queue,
    text: row.text,
  })).sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(candidates.map(row => row.id)).size !== candidates.length) throw new Error('candidate ID hash collision')
  const candidateIdBySource = new Map(selected.map(row => [row.stableSourceId, `v8-${sha256(row.stableSourceId).slice(0, 16)}`]))
  const sources = selected.map(row => ({ candidateId: candidateIdBySource.get(row.stableSourceId), ...row }))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  const ledger = frame.map(row => ({
    stableSourceId: row.stableSourceId,
    selected: selectedIds.has(row.stableSourceId),
    queue: row.queue,
    language: row.language,
    constructionFamily: row.constructionFamily,
    selectionKey: deterministicKey(seed, row.queue, row.queue === 'natural' ? row.language : `${row.language}/${row.constructionFamily}`, row.stableSourceId),
  })).sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId))

  const candidateText = stableLines(candidates)
  const sourceText = stableLines(sources)
  const ledgerText = stableLines(ledger)
  const manifest = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'frozen-before-annotation',
    cutoff,
    seed,
    seedCommitment: collectionSeedCommitment,
    counts: {
      frame: frame.length,
      selected: selected.length,
      natural: selected.filter(row => row.queue === 'natural').length,
      challenge: selected.filter(row => row.queue === 'challenge').length,
      languages: Object.fromEntries(languages.map(language => [language, selected.filter(row => row.language === language).length])),
    },
    digests: {
      sourceFrame: sha256(frameText),
      sourceRegistry: sha256(registryText),
      candidates: sha256(candidateText),
      sources: sha256(sourceText),
      selectionLedger: sha256(ledgerText),
      priorInventoryFiles: sha256(JSON.stringify(prior.files)),
    },
  }
  await Promise.all([
    writeExclusive(outputPaths.candidates, candidateText),
    writeExclusive(outputPaths.sources, sourceText),
    writeExclusive(outputPaths.ledger, ledgerText),
    writeExclusive(outputPaths.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
    writeExclusive(outputPaths.registry, registryText),
  ])
  console.log(JSON.stringify(manifest, null, 2))
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
