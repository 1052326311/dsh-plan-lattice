#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exposureMatch, loadExposureArtifacts, sourceFamilyId } from './exposure-registry.mjs'
import { createGraphqlClient, createRestSearchClient, githubToken } from './github-api.mjs'
import { githubGraphqlQuery, graphqlVariables, materializeCandidate } from './graphql-source.mjs'
import {
  ProtocolFailure,
  assertArtifactsAbsent,
  constructionFamilies,
  cutoff,
  familyPriority,
  loadFrozenInputs,
  option,
  protocolId,
  sanitizedFailure,
  sha256,
  stableLines,
  writeExclusive,
} from './protocol.mjs'
import {
  assertSourceDisjoint,
  fiveShingles,
  priorSourceInventory,
  shingleJaccard,
} from './source-isolation.mjs'

const cutoffTimestamp = Date.parse(cutoff)

function repositoryFromApiUrl(value) {
  const match = String(value ?? '').match(/\/repos\/([^/]+\/[^/]+)$/u)
  if (match === null) throw new Error(`cannot derive repository from ${value}`)
  return match[1].toLowerCase()
}

function deterministicOrder(context, identity) {
  return sha256(`${protocolId}\n${context}\n${identity}`)
}

function queryCandidate(search, item) {
  return { search, item, language: search.language, familyId: sourceFamilyId(item) }
}

function validateSearchItem(item, search, page) {
  if (typeof item?.node_id !== 'string' || item.node_id === '' || !Number.isInteger(item.number)
    || typeof item.repository_url !== 'string' || typeof item.html_url !== 'string') {
    throw new ProtocolFailure('search-item-identity-missing', `${search.id} page ${page} returned an item without stable identity`, {
      stage: 'search', operation: `${search.id} page=${page}`,
    })
  }
  repositoryFromApiUrl(item.repository_url)
  const expectsPull = ['bounded', 'continuity'].includes(search.family)
  if ((item.pull_request !== undefined) !== expectsPull) {
    throw new ProtocolFailure('search-object-type-drift', `${search.id} page ${page} returned the wrong object type`, {
      stage: 'search', operation: `${search.id} page=${page}`,
    })
  }
  for (const field of ['created_at', 'updated_at']) {
    const value = Date.parse(item[field])
    if (!Number.isFinite(value) || value > cutoffTimestamp) {
      throw new ProtocolFailure('search-cutoff-drift', `${search.id} page ${page} returned post-cutoff ${field}`, {
        stage: 'search', operation: `${search.id} page=${page}`,
      })
    }
  }
}

export async function collectSearchFrame({ frozen, exposure, search }) {
  const snapshotById = new Map(exposure.manifest.querySnapshots.map(snapshot => [snapshot.queryId, snapshot]))
  const candidates = []
  const ledger = []
  const querySnapshots = []
  for (const definition of [...frozen.v10Spec.searches].sort((left, right) => left.id.localeCompare(right.id))) {
    const exposureSnapshot = snapshotById.get(definition.id)
    if (!exposureSnapshot || !Number.isInteger(exposureSnapshot.totalCount) || exposureSnapshot.totalCount < 0) {
      throw new ProtocolFailure('exposure-snapshot-missing', `missing page-1 snapshot for ${definition.id}`, {
        stage: 'search', operation: definition.id,
      })
    }
    const accessibleCount = Math.min(
      exposureSnapshot.totalCount,
      frozen.spec.searchFrame.githubAccessibleResultLimit,
    )
    const finalAvailablePage = Math.ceil(accessibleCount / frozen.spec.searchFrame.resultsPerPage)
    const finalPage = Math.min(frozen.spec.searchFrame.lastPage, finalAvailablePage)
    const items = []
    const seenNodes = new Set()
    const pages = []
    for (let page = frozen.spec.searchFrame.firstPage; page <= finalPage; page += 1) {
      const response = await search(definition.query, page, frozen.spec.searchFrame.resultsPerPage)
      if (response.data?.incomplete_results !== false) {
        throw new ProtocolFailure('search-results-incomplete', `${definition.id} page ${page} reported incomplete results`, {
          stage: 'search', operation: `${definition.id} page=${page}`, rateLimit: response.rateLimit,
        })
      }
      if (response.data.total_count !== exposureSnapshot.totalCount || !Array.isArray(response.data.items)) {
        throw new ProtocolFailure('search-snapshot-drift', `${definition.id} total_count changed after exposure recovery`, {
          stage: 'search', operation: `${definition.id} page=${page}`, rateLimit: response.rateLimit,
          details: { exposureTotalCount: exposureSnapshot.totalCount, observedTotalCount: response.data.total_count },
        })
      }
      const start = (page - 1) * frozen.spec.searchFrame.resultsPerPage
      const expectedCount = Math.max(0, Math.min(
        frozen.spec.searchFrame.resultsPerPage,
        accessibleCount - start,
      ))
      if (response.data.items.length !== expectedCount) {
        throw new ProtocolFailure('search-pagination-truncated', `${definition.id} page ${page} returned ${response.data.items.length}, expected ${expectedCount}`, {
          stage: 'search', operation: `${definition.id} page=${page}`, rateLimit: response.rateLimit,
        })
      }
      for (const item of response.data.items) {
        validateSearchItem(item, definition, page)
        if (seenNodes.has(item.node_id)) {
          throw new ProtocolFailure('search-pagination-duplicate', `${definition.id} repeated ${item.node_id} across pages`, {
            stage: 'search', operation: `${definition.id} page=${page}`, rateLimit: response.rateLimit,
          })
        }
        seenNodes.add(item.node_id)
        items.push(item)
      }
      pages.push({ page, itemCount: response.data.items.length, rateLimit: response.rateLimit })
    }
    const eligible = []
    for (const item of items) {
      const candidate = queryCandidate(definition, item)
      const match = exposureMatch(candidate, exposure.index)
      if (match !== undefined) {
        ledger.push({ sourceFamilyId: candidate.familyId, searchId: definition.id, accepted: false, reason: 'v10-exposure', match })
        continue
      }
      eligible.push(candidate)
    }
    eligible.sort((left, right) => deterministicOrder('search-candidate', `${definition.id}\n${left.familyId}\n${left.item.node_id}`)
      .localeCompare(deterministicOrder('search-candidate', `${definition.id}\n${right.familyId}\n${right.item.node_id}`)))
    const selected = eligible.slice(0, frozen.spec.searchFrame.maximumCandidatesPerSearch)
    candidates.push(...selected)
    querySnapshots.push({
      queryId: definition.id,
      query: definition.query,
      exposureTotalCount: exposureSnapshot.totalCount,
      accessibleCount,
      truncatedByGitHubCap: exposureSnapshot.totalCount > frozen.spec.searchFrame.githubAccessibleResultLimit,
      pages,
      page2PlusItemCount: items.length,
      exposureRejectedCount: items.length - eligible.length,
      selectedCount: selected.length,
    })
  }
  candidates.sort((left, right) => {
    const priority = familyPriority.get(left.search.family) - familyPriority.get(right.search.family)
    if (priority !== 0) return priority
    return deterministicOrder('candidate', `${left.search.id}\n${left.familyId}`)
      .localeCompare(deterministicOrder('candidate', `${right.search.id}\n${right.familyId}`))
  })
  return { candidates, ledger, querySnapshots }
}

function chunks(values, size) {
  const output = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

function graphqlRequirements(candidates) {
  const byNode = new Map()
  for (const candidate of candidates) {
    const id = candidate.item.node_id
    const current = byNode.get(id) ?? {
      id,
      isPull: candidate.item.pull_request !== undefined,
      includeIssueComments: false,
      includePullTimeline: false,
    }
    current.includeIssueComments ||= candidate.search.family === 'decision'
    current.includePullTimeline ||= ['bounded', 'continuity'].includes(candidate.search.family)
    byNode.set(id, current)
  }
  return [...byNode.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function validateGraphqlNodes(requests, nodes) {
  if (!Array.isArray(nodes) || nodes.length !== requests.length) {
    throw new ProtocolFailure('graphql-node-set-incomplete', 'GraphQL did not return one slot per requested node', {
      stage: 'graphql', operation: `nodes=${requests.length}`,
    })
  }
  const requested = new Set(requests.map(request => request.id))
  const observed = new Set()
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !requested.has(node.id) || observed.has(node.id)) {
      throw new ProtocolFailure('graphql-node-set-incomplete', 'GraphQL returned a missing, unexpected, or duplicate node', {
        stage: 'graphql', operation: `nodes=${requests.length}`,
      })
    }
    observed.add(node.id)
  }
}

export async function fetchGraphqlSources(candidates, graphql, spec) {
  const requirements = graphqlRequirements(candidates)
  const groups = new Map()
  for (const request of requirements) {
    const key = request.isPull ? 'pull' : request.includeIssueComments ? 'issue-comments' : 'issue-basic'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(request)
  }
  const nodeMap = new Map()
  const rateLimits = []
  for (const [key, requests] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const batchSize = key === 'pull' ? 1 : spec.limits.graphqlBatchSize
    for (const batch of chunks(requests, batchSize)) {
      const variables = graphqlVariables(spec, {
        includeIssueComments: key === 'issue-comments',
        includePullTimeline: key === 'pull',
      })
      const response = await graphql(batch.map(request => request.id), variables)
      validateGraphqlNodes(batch, response.nodes)
      for (const node of response.nodes) nodeMap.set(node.id, node)
      rateLimits.push({ group: key, nodeCount: batch.length, ...response.rateLimit })
    }
  }
  return { nodeMap, rateLimits }
}

function firstCurrentNearDuplicate(row, accepted) {
  const shingles = fiveShingles(row.text)
  for (const other of accepted) {
    if (shingleJaccard(shingles, other.shingles) >= 0.85) return other.row.stableSourceId
  }
  return undefined
}

export function countFrame(rows, spec) {
  const counts = { natural: { en: 0, zh: 0 }, challenge: {} }
  const failures = []
  for (const language of ['en', 'zh']) {
    counts.natural[language] = rows.filter(row => row.queue === 'natural' && row.language === language).length
    if (counts.natural[language] < spec.capacity.naturalPerLanguage) failures.push(`natural/${language} has ${counts.natural[language]}`)
    for (const family of constructionFamilies) {
      const stratum = rows.filter(row => row.queue === 'challenge' && row.language === language && row.constructionFamily === family)
      const key = `${language}/${family}`
      counts.challenge[key] = {
        rows: stratum.length,
        repositories: new Set(stratum.map(row => row.repository)).size,
        organizations: new Set(stratum.map(row => row.organization)).size,
      }
      if (stratum.length < spec.capacity.challengePerLanguageAndFamily) failures.push(`challenge/${key} has ${stratum.length}`)
      if (counts.challenge[key].repositories < spec.capacity.minimumRepositoriesPerChallengeStratum) {
        failures.push(`challenge/${key} has fewer than ${spec.capacity.minimumRepositoriesPerChallengeStratum} repositories`)
      }
      if (counts.challenge[key].organizations < spec.capacity.minimumOrganizationsPerChallengeStratum) {
        failures.push(`challenge/${key} has fewer than ${spec.capacity.minimumOrganizationsPerChallengeStratum} organizations`)
      }
    }
  }
  return { counts, failures }
}

export async function buildSourceFrame({ frozen, exposure, search, graphql, inventory = undefined }) {
  const prior = inventory ?? await priorSourceInventory()
  const priorNetworks = new Set([...(prior.repositories ?? []), ...(prior.networkMembers ?? [])])
  const searched = await collectSearchFrame({ frozen, exposure, search })
  const ledger = [...searched.ledger]
  const candidates = searched.candidates.filter(candidate => {
    const repository = repositoryFromApiUrl(candidate.item.repository_url)
    if (!priorNetworks.has(repository)) return true
    ledger.push({ sourceFamilyId: candidate.familyId, searchId: candidate.search.id, accepted: false, reason: 'prior-repository', repository })
    return false
  })
  const resolved = await fetchGraphqlSources(candidates, graphql, frozen.spec)
  const materialized = []
  for (const candidate of candidates) {
    const result = materializeCandidate(candidate, resolved.nodeMap.get(candidate.item.node_id), frozen.spec)
    if (result.rejection) {
      ledger.push({ sourceFamilyId: candidate.familyId, searchId: candidate.search.id, accepted: false, ...result.rejection })
      continue
    }
    if (priorNetworks.has(result.row.networkRoot)) {
      ledger.push({ sourceFamilyId: candidate.familyId, searchId: candidate.search.id, accepted: false, reason: 'prior-network-root', networkRoot: result.row.networkRoot })
      continue
    }
    try {
      assertSourceDisjoint([result.row], prior, exposure.index)
    } catch (error) {
      ledger.push({ sourceFamilyId: candidate.familyId, searchId: candidate.search.id, accepted: false, reason: 'prior-or-exposed-source-isolation', detail: error.message })
      continue
    }
    const { __auditEvidence, ...row } = result.row
    materialized.push({
      row,
      audit: {
        stableSourceId: row.stableSourceId,
        searchId: candidate.search.id,
        sourceContentDigest: row.sourceContentDigest,
        evidence: __auditEvidence,
      },
    })
  }

  const byFamily = new Map()
  for (const pair of materialized) {
    if (!byFamily.has(pair.row.sourceFamilyId)) byFamily.set(pair.row.sourceFamilyId, [])
    byFamily.get(pair.row.sourceFamilyId).push(pair)
  }
  const collapsed = [...byFamily.values()].map(values => values.sort((left, right) => {
    const priority = familyPriority.get(left.row.constructionFamily ?? 'natural') - familyPriority.get(right.row.constructionFamily ?? 'natural')
    if (priority !== 0) return priority
    return deterministicOrder('family-collapse', left.row.stableSourceId)
      .localeCompare(deterministicOrder('family-collapse', right.row.stableSourceId))
  })[0])

  const accepted = []
  const seenPrompt = new Set()
  const seenCanonical = new Set()
  for (const pair of collapsed.sort((left, right) => deterministicOrder('near-duplicate-collapse', left.row.stableSourceId)
    .localeCompare(deterministicOrder('near-duplicate-collapse', right.row.stableSourceId)))) {
    if (seenPrompt.has(pair.row.promptDigest) || seenCanonical.has(pair.row.canonicalPromptDigest)) {
      ledger.push({ stableSourceId: pair.row.stableSourceId, accepted: false, reason: 'current-exact-duplicate' })
      continue
    }
    const nearDuplicate = firstCurrentNearDuplicate(pair.row, accepted)
    if (nearDuplicate !== undefined) {
      ledger.push({ stableSourceId: pair.row.stableSourceId, accepted: false, reason: 'current-near-duplicate', duplicateOf: nearDuplicate })
      continue
    }
    seenPrompt.add(pair.row.promptDigest)
    seenCanonical.add(pair.row.canonicalPromptDigest)
    accepted.push({ ...pair, shingles: fiveShingles(pair.row.text) })
    ledger.push({ stableSourceId: pair.row.stableSourceId, sourceFamilyId: pair.row.sourceFamilyId, searchId: pair.row.searchId, accepted: true, reason: pair.row.construction })
  }
  const rows = accepted.map(pair => pair.row).sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId))
  assertSourceDisjoint(rows, prior, exposure.index)
  return {
    rows,
    audit: accepted.map(pair => pair.audit).sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId)),
    ledger: ledger.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    searchSnapshots: searched.querySnapshots,
    graphqlRateLimits: resolved.rateLimits,
    prior,
  }
}

async function main() {
  const framePath = option('--frame')
  const auditPath = option('--audit')
  const ledgerPath = option('--ledger')
  const manifestPath = option('--manifest')
  const failurePath = option('--failure-manifest')
  const exposureRegistryPath = option('--exposure-registry')
  const exposureManifestPath = option('--exposure-manifest')
  if ([framePath, auditPath, ledgerPath, manifestPath, failurePath, exposureRegistryPath, exposureManifestPath]
    .some(value => value === undefined)) {
    throw new Error('usage: collect-source-frame.mjs --exposure-registry <jsonl> --exposure-manifest <json> --frame <private.jsonl> --audit <private.jsonl> --ledger <private.jsonl> --manifest <json> --failure-manifest <json>')
  }
  const outputs = [framePath, auditPath, ledgerPath, manifestPath, failurePath].map(path => resolve(path))
  await assertArtifactsAbsent(outputs, 'V11 source-frame collection')
  let frozen
  let exposure
  try {
    frozen = await loadFrozenInputs()
    exposure = await loadExposureArtifacts(resolve(exposureRegistryPath), resolve(exposureManifestPath), frozen)
    const token = githubToken()
    const search = createRestSearchClient({
      token,
      apiVersion: frozen.spec.githubApiVersion,
      minimumRemaining: frozen.spec.limits.searchMinimumRemaining,
    })
    const graphql = createGraphqlClient({
      token,
      minimumRemaining: frozen.spec.limits.graphqlMinimumRemaining,
      query: githubGraphqlQuery(frozen.spec),
    })
    const built = await buildSourceFrame({ frozen, exposure, search, graphql })
    const frameText = stableLines(built.rows)
    const auditText = stableLines(built.audit)
    const ledgerText = stableLines(built.ledger)
    const capacity = countFrame(built.rows, frozen.spec)
    const collectorBytes = await readFile(fileURLToPath(import.meta.url))
    const graphqlBytes = await readFile(new URL('./graphql-source.mjs', import.meta.url))
    const baseManifest = {
      schemaVersion: 1,
      protocol: frozen.spec.protocol,
      cutoff: frozen.spec.cutoff,
      seedAccessed: false,
      exposureCount: exposure.rows.length,
      searchCount: frozen.v10Spec.searches.length,
      searchSnapshots: built.searchSnapshots,
      graphqlRateLimits: built.graphqlRateLimits,
      counts: capacity.counts,
      digests: {
        v10Spec: sha256(frozen.v10SpecBytes),
        v11Spec: sha256(frozen.specBytes),
        exposureRegistry: sha256(exposure.registryText),
        exposureManifest: sha256(await readFile(resolve(exposureManifestPath))),
        collector: sha256(collectorBytes),
        graphqlSource: sha256(graphqlBytes),
        priorInventoryFiles: sha256(built.prior.files),
        sourceFrame: sha256(frameText),
        privateAudit: sha256(auditText),
        rejectionLedger: sha256(ledgerText),
      },
    }
    await writeExclusive(resolve(framePath), frameText)
    await writeExclusive(resolve(auditPath), auditText)
    await writeExclusive(resolve(ledgerPath), ledgerText)
    if (capacity.failures.length > 0) {
      const failure = {
        ...baseManifest,
        evidenceStatus: 'retired-before-seed-reveal',
        failureClass: 'source-capacity-or-diversity-failure',
        capacityFailures: capacity.failures,
      }
      await writeExclusive(resolve(failurePath), `${JSON.stringify(failure, null, 2)}\n`)
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`)
      process.exitCode = 2
      return
    }
    const manifest = {
      ...baseManifest,
      evidenceStatus: 'source-frame-capacity-passed',
      capacityFailures: [],
    }
    await writeExclusive(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    const failure = sanitizedFailure(error, {
      stage: error?.stage ?? 'source-frame-collection',
      digests: frozen === undefined ? undefined : {
        v10Spec: sha256(frozen.v10SpecBytes),
        v11Spec: sha256(frozen.specBytes),
        exposureRegistry: exposure === undefined ? undefined : sha256(exposure.registryText),
      },
    })
    await writeExclusive(resolve(failurePath), `${JSON.stringify(failure, null, 2)}\n`)
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`)
    process.exitCode = 2
  }
}

if (basename(process.argv[1] ?? '') === basename(fileURLToPath(import.meta.url))) await main()
