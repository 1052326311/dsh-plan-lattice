#!/usr/bin/env node
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertArtifactsAbsent,
  collectionSeedCommitment,
  cutoff,
  languages,
  protocolId,
  sha256,
  sourceObjectTypes,
  writeExclusive,
} from './protocol.mjs'
import { validateRegistry } from './assemble-candidates.mjs'
import { priorSourceInventory } from './source-isolation.mjs'

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(import.meta.url)
const here = dirname(scriptPath)
const githubApiVersion = '2022-11-28'
const minimumNetworksPerLanguage = 36
const repositorySnapshotKeys = [
  'requestedRepository', 'fullName', 'nodeId', 'owner', 'archived', 'disabled',
  'hasIssues', 'hasDiscussions', 'fork', 'sourceFullName', 'sourceNodeId',
]

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

export function validateScope(value) {
  exactKeys(value, ['schemaVersion', 'protocol', 'cutoff', 'sources'], 'source scope')
  if (value.schemaVersion !== 1 || value.protocol !== protocolId || value.cutoff !== cutoff) {
    throw new Error('source scope protocol identity is invalid')
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) throw new Error('source scope has no sources')
  const repositories = new Set()
  for (const [index, source] of value.sources.entries()) {
    exactKeys(source, ['repository', 'nativeLanguage', 'ecosystem'], `source scope sources[${index}]`)
    const repository = nonEmpty(source.repository, `source scope sources[${index}].repository`)
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error(`source scope sources[${index}] repository is invalid`)
    if (!languages.includes(source.nativeLanguage)) throw new Error(`source scope sources[${index}] language is invalid`)
    nonEmpty(source.ecosystem, `source scope sources[${index}].ecosystem`)
    const identity = repository.toLowerCase()
    if (repositories.has(identity)) throw new Error(`source scope duplicates ${repository}`)
    repositories.add(identity)
  }
  return value
}

export function validateRepositorySnapshot(value, context = 'repository snapshot') {
  exactKeys(value, repositorySnapshotKeys, context)
  for (const key of ['requestedRepository', 'fullName', 'nodeId', 'owner']) nonEmpty(value[key], `${context}.${key}`)
  for (const key of ['archived', 'disabled', 'hasIssues', 'hasDiscussions', 'fork']) {
    if (typeof value[key] !== 'boolean') throw new Error(`${context}.${key} must be boolean`)
  }
  for (const key of ['sourceFullName', 'sourceNodeId']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key].trim() === '')) {
      throw new Error(`${context}.${key} must be null or a non-empty string`)
    }
  }
  if (value.fork && (value.sourceFullName === null || value.sourceNodeId === null)) {
    throw new Error(`${context} fork is missing its canonical source identity`)
  }
  return value
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

export function createRegistry(scope, snapshots, discussionCategoryIdsByRepository) {
  validateScope(scope)
  if (!Array.isArray(snapshots)) throw new Error('repository snapshots must be an array')
  const byRequestedRepository = new Map(snapshots.map((snapshot, index) => {
    validateRepositorySnapshot(snapshot, `repository snapshots[${index}]`)
    return [snapshot.requestedRepository.toLowerCase(), snapshot]
  }))
  if (byRequestedRepository.size !== snapshots.length) throw new Error('repository snapshots duplicate requestedRepository')
  if (byRequestedRepository.size !== scope.sources.length) throw new Error('repository snapshot count differs from source scope')

  const sources = scope.sources.map((declared, index) => {
    const snapshot = byRequestedRepository.get(declared.repository.toLowerCase())
    if (snapshot === undefined) throw new Error(`source scope sources[${index}] has no repository snapshot`)
    if (snapshot.archived || snapshot.disabled) throw new Error(`${snapshot.fullName} is archived or disabled`)
    const categoryIds = sortedUnique(discussionCategoryIdsByRepository.get(snapshot.fullName.toLowerCase()) ?? [])
    if (categoryIds.some(id => typeof id !== 'string' || id.trim() === '')) {
      throw new Error(`${snapshot.fullName} has an invalid discussion category ID`)
    }
    if (!snapshot.hasDiscussions && categoryIds.length > 0) {
      throw new Error(`${snapshot.fullName} returned discussion categories while discussions are disabled`)
    }
    const objectTypes = ['pull-review']
    if (snapshot.hasIssues) objectTypes.push('issue', 'issue-comment-request')
    if (snapshot.hasDiscussions && categoryIds.length > 0) objectTypes.push('discussion')
    if (objectTypes.some(type => !sourceObjectTypes.includes(type))) throw new Error('collector emitted an unknown object type')
    return {
      platform: 'github',
      repository: snapshot.fullName,
      repositoryNodeId: snapshot.nodeId,
      networkRoot: snapshot.fork ? snapshot.sourceFullName : snapshot.fullName,
      organization: snapshot.owner,
      ecosystem: declared.ecosystem,
      nativeLanguage: declared.nativeLanguage,
      objectTypes: sortedUnique(objectTypes),
      discussionCategoryIds: categoryIds,
    }
  }).sort((left, right) => (
    left.nativeLanguage.localeCompare(right.nativeLanguage) || left.repository.localeCompare(right.repository)
  ))

  const registry = {
    schemaVersion: 1,
    protocol: protocolId,
    cutoff,
    seedCommitment: collectionSeedCommitment,
    minimumNetworksPerLanguage,
    platformApiVersions: {
      githubGraphql: 'current-schema-with-X-GitHub-Api-Version-2022-11-28',
      githubRest: githubApiVersion,
    },
    sources,
  }
  return registry
}

export function assertRegistrySourceIsolation(registry, snapshots, prior) {
  const priorRepositories = new Set([...(prior.repositories ?? []), ...(prior.networkMembers ?? [])].map(value => value.toLowerCase()))
  const priorNodeIds = new Set(prior.nodeIds ?? [])
  const snapshotsByNode = new Map(snapshots.map(snapshot => [snapshot.nodeId, snapshot]))
  for (const source of registry.sources) {
    const snapshot = snapshotsByNode.get(source.repositoryNodeId)
    if (snapshot === undefined) throw new Error(`${source.repository} has no matching repository snapshot`)
    for (const repository of [source.repository, source.networkRoot]) {
      if (priorRepositories.has(repository.toLowerCase())) throw new Error(`source registry reuses a V1-V7 network: ${repository}`)
    }
    for (const nodeId of [source.repositoryNodeId, snapshot.sourceNodeId].filter(Boolean)) {
      if (priorNodeIds.has(nodeId)) throw new Error(`source registry reuses a V1-V7 node ID: ${nodeId}`)
    }
  }
}

async function ghJson(args) {
  const { stdout } = await execFileAsync('gh', ['api', '-H', 'Accept: application/vnd.github+json', '-H', `X-GitHub-Api-Version: ${githubApiVersion}`, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

async function fetchRepositorySnapshot(requestedRepository) {
  const value = await ghJson([
    `repos/${requestedRepository}`,
    '--jq',
    '{requestedRepository:"' + requestedRepository.replaceAll('"', '\\"') + '",fullName:.full_name,nodeId:.node_id,owner:.owner.login,archived:.archived,disabled:.disabled,hasIssues:.has_issues,hasDiscussions:.has_discussions,fork:.fork,sourceFullName:(.source.full_name // null),sourceNodeId:(.source.node_id // null)}',
  ])
  return validateRepositorySnapshot(value, `GitHub REST ${requestedRepository}`)
}

function graphqlString(value) {
  return JSON.stringify(value)
}

async function fetchDiscussionCategoryBatch(snapshots) {
  const fields = snapshots.map((snapshot, index) => {
    const [owner, name] = snapshot.fullName.split('/')
    return `r${index}:repository(owner:${graphqlString(owner)},name:${graphqlString(name)}){discussionCategories(first:100){nodes{id} pageInfo{hasNextPage}}}`
  }).join('\n')
  const response = await ghJson(['graphql', '-f', `query=query RegistryCategories {${fields}}`])
  const result = new Map()
  for (const [index, snapshot] of snapshots.entries()) {
    const repository = response.data?.[`r${index}`]
    if (repository === null || repository === undefined) throw new Error(`GraphQL could not resolve ${snapshot.fullName}`)
    if (repository.discussionCategories.pageInfo.hasNextPage) throw new Error(`${snapshot.fullName} has more than 100 discussion categories`)
    result.set(snapshot.fullName.toLowerCase(), repository.discussionCategories.nodes.map(node => node.id))
  }
  return result
}

async function fetchDiscussionCategories(snapshots) {
  const result = new Map()
  const enabled = snapshots.filter(snapshot => snapshot.hasDiscussions)
  for (let index = 0; index < enabled.length; index += 20) {
    const batch = await fetchDiscussionCategoryBatch(enabled.slice(index, index + 20))
    for (const [repository, ids] of batch) result.set(repository, ids)
  }
  return result
}

async function main() {
  const scopePath = resolve(option('--scope') ?? resolve(here, 'source-registry-scope.json'))
  const outputPath = option('--output')
  const manifestPath = option('--manifest')
  if (outputPath === undefined || manifestPath === undefined) {
    throw new Error('usage: freeze-source-registry.mjs --output <external-registry.json> --manifest <external-manifest.json> [--scope <scope.json>]')
  }
  const resolvedOutput = resolve(outputPath)
  const resolvedManifest = resolve(manifestPath)
  await assertArtifactsAbsent([resolvedOutput, resolvedManifest], 'V8 source registry freeze')
  const scopeText = await readFile(scopePath, 'utf8')
  const scope = validateScope(JSON.parse(scopeText))
  const snapshots = []
  for (const source of scope.sources) snapshots.push(await fetchRepositorySnapshot(source.repository))
  const categories = await fetchDiscussionCategories(snapshots)
  const registry = createRegistry(scope, snapshots, categories)
  validateRegistry(registry)
  const prior = await priorSourceInventory()
  assertRegistrySourceIsolation(registry, snapshots, prior)

  const registryText = `${JSON.stringify(registry, null, 2)}\n`
  const scriptText = await readFile(scriptPath, 'utf8')
  const { stdout: ghVersionText } = await execFileAsync('gh', ['--version'], { encoding: 'utf8' })
  const redirects = snapshots.filter(snapshot => snapshot.requestedRepository.toLowerCase() !== snapshot.fullName.toLowerCase())
    .map(snapshot => ({ requested: snapshot.requestedRepository, resolved: snapshot.fullName }))
  const counts = Object.fromEntries(languages.map(language => {
    const rows = registry.sources.filter(source => source.nativeLanguage === language)
    return [language, {
      networks: new Set(rows.map(source => source.networkRoot.toLowerCase())).size,
      repositories: rows.length,
      objectTypes: Object.fromEntries(sourceObjectTypes.map(type => [type, rows.filter(source => source.objectTypes.includes(type)).length])),
    }]
  }))
  const manifest = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'source-registry-frozen-before-candidate-materialization',
    cutoff,
    frozenAt: new Date().toISOString(),
    input: {
      scope: basename(scopePath),
      scopeSha256: sha256(scopeText),
      collectorSha256: sha256(scriptText),
      priorInventorySha256: sha256(JSON.stringify(prior.files)),
    },
    runtime: {
      node: process.version,
      gh: ghVersionText.trim().split('\n')[0],
      githubRestApiVersion: githubApiVersion,
      githubGraphqlApiVersionHeader: githubApiVersion,
    },
    counts,
    redirects,
    registrySha256: sha256(registryText),
  }
  await writeExclusive(resolvedOutput, registryText)
  await writeExclusive(resolvedManifest, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({ output: resolvedOutput, manifest: resolvedManifest, counts, redirects }, null, 2))
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
