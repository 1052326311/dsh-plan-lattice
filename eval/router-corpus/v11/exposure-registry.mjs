#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { normalizeUrl } from '../v10/source-isolation.mjs'
import { ProtocolFailure, cutoff, parseJsonLines, protocolId, sha256 } from './protocol.mjs'

const cutoffTimestamp = Date.parse(cutoff)
const registryKeys = [
  'nodeId',
  'number',
  'objectType',
  'protocol',
  'query',
  'queryId',
  'rank',
  'repository',
  'schemaVersion',
  'searchFamily',
  'searchPage',
  'sourceFamilyId',
  'url',
]

function repositoryFromApiUrl(value) {
  const match = String(value ?? '').match(/\/repos\/([^/]+\/[^/]+)$/u)
  if (match === null) throw new Error(`cannot derive repository from ${value}`)
  return match[1].toLowerCase()
}

export function sourceFamilyId(item) {
  const repository = repositoryFromApiUrl(item.repository_url)
  return `github:${repository}:${item.pull_request ? 'pull' : 'issue'}:${item.number}`
}

function validateSearchItem(item, search, rank) {
  if (typeof item?.node_id !== 'string' || item.node_id === '') throw new Error(`${search.id} rank ${rank} lacks node_id`)
  if (!Number.isInteger(item.number) || item.number <= 0) throw new Error(`${search.id} rank ${rank} lacks number`)
  if (typeof item.html_url !== 'string' || item.html_url === '') throw new Error(`${search.id} rank ${rank} lacks html_url`)
  repositoryFromApiUrl(item.repository_url)
  const expectsPull = ['bounded', 'continuity'].includes(search.family)
  if ((item.pull_request !== undefined) !== expectsPull) {
    throw new ProtocolFailure('search-object-type-drift', `${search.id} rank ${rank} has the wrong object type`, {
      stage: 'exposure-recovery',
      operation: `${search.id} page=1`,
    })
  }
  for (const field of ['created_at', 'updated_at']) {
    const timestamp = Date.parse(item[field])
    if (!Number.isFinite(timestamp) || timestamp > cutoffTimestamp) {
      throw new ProtocolFailure('exposure-cutoff-uncertain', `${search.id} rank ${rank} has invalid ${field}`, {
        stage: 'exposure-recovery',
        operation: `${search.id} page=1`,
      })
    }
  }
}

export function buildExposureRows(search, result, spec) {
  if (result?.incomplete_results !== false) {
    throw new ProtocolFailure('search-results-incomplete', `${search.id} page 1 reported incomplete results`, {
      stage: 'exposure-recovery', operation: `${search.id} page=1`,
    })
  }
  if (!Number.isInteger(result.total_count) || result.total_count < 0 || !Array.isArray(result.items)) {
    throw new ProtocolFailure('search-response-invalid', `${search.id} page 1 has invalid search metadata`, {
      stage: 'exposure-recovery', operation: `${search.id} page=1`,
    })
  }
  if (result.items.length > spec.searchFrame.resultsPerPage) {
    throw new ProtocolFailure('search-page-overflow', `${search.id} page 1 exceeds the frozen page size`, {
      stage: 'exposure-recovery', operation: `${search.id} page=1`,
    })
  }
  const expectedCount = Math.min(result.total_count, spec.searchFrame.resultsPerPage)
  if (result.items.length !== expectedCount) {
    throw new ProtocolFailure('search-pagination-truncated', `${search.id} page 1 returned ${result.items.length}, expected ${expectedCount}`, {
      stage: 'exposure-recovery', operation: `${search.id} page=1`,
    })
  }
  return result.items.map((item, index) => {
    const rank = index + 1
    validateSearchItem(item, search, rank)
    return {
      schemaVersion: 1,
      protocol: protocolId,
      nodeId: item.node_id,
      sourceFamilyId: sourceFamilyId(item),
      repository: repositoryFromApiUrl(item.repository_url),
      url: normalizeUrl(item.html_url),
      objectType: item.pull_request ? 'pull' : 'issue',
      number: item.number,
      searchFamily: search.family,
      queryId: search.id,
      query: search.query,
      searchPage: spec.v10.exposureSearchPage,
      rank,
    }
  })
}

function validateRegistryRow(row, searches, spec, index) {
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...registryKeys].sort())) {
    throw new Error(`exposure registry row ${index + 1} has forbidden or missing fields`)
  }
  const search = searches.get(row.queryId)
  if (search === undefined || row.query !== search.query || row.searchFamily !== search.family) {
    throw new Error(`exposure registry row ${index + 1} does not match its frozen query`)
  }
  if (row.protocol !== protocolId || row.schemaVersion !== 1 || row.searchPage !== spec.v10.exposureSearchPage) {
    throw new Error(`exposure registry row ${index + 1} has invalid protocol metadata`)
  }
  if (!['issue', 'pull'].includes(row.objectType) || !Number.isInteger(row.number) || row.number <= 0) {
    throw new Error(`exposure registry row ${index + 1} has invalid object identity`)
  }
  if (![row.nodeId, row.sourceFamilyId, row.repository, row.url].every(value => typeof value === 'string' && value !== '')) {
    throw new Error(`exposure registry row ${index + 1} has incomplete identity`)
  }
  const expectedFamily = `github:${row.repository}:${row.objectType}:${row.number}`
  if (row.sourceFamilyId !== expectedFamily || row.url !== normalizeUrl(row.url)) {
    throw new Error(`exposure registry row ${index + 1} has noncanonical identity`)
  }
}

export function exposureIndex(rows) {
  return {
    nodeIds: new Set(rows.map(row => row.nodeId)),
    sourceFamilyIds: new Set(rows.map(row => row.sourceFamilyId)),
    urls: new Set(rows.map(row => normalizeUrl(row.url))),
  }
}

export function exposureMatch(candidate, index) {
  if (index.nodeIds.has(candidate.item?.node_id ?? candidate.nodeId)) return 'node-id'
  if (index.sourceFamilyIds.has(candidate.familyId ?? candidate.sourceFamilyId)) return 'source-family-id'
  const url = candidate.item?.html_url ?? candidate.url
  if (url && index.urls.has(normalizeUrl(url))) return 'url'
  return undefined
}

export async function loadExposureArtifacts(registryPath, manifestPath, frozen) {
  const [registryText, manifestText, recoveryBytes] = await Promise.all([
    readFile(registryPath, 'utf8'),
    readFile(manifestPath, 'utf8'),
    readFile(new URL('./recover-v10-exposure-registry.mjs', import.meta.url)),
  ])
  const rows = parseJsonLines(registryText, registryPath)
  const manifest = JSON.parse(manifestText)
  const searches = new Map(frozen.v10Spec.searches.map(search => [search.id, search]))
  rows.forEach((row, index) => validateRegistryRow(row, searches, frozen.spec, index))
  if (manifest?.protocol !== protocolId || manifest.stage !== 'v10-exposure-recovery'
    || manifest.evidenceStatus !== 'v10-exposure-registry-frozen' || manifest.seedAccessed !== false) {
    throw new Error('exposure registry manifest has invalid protocol metadata')
  }
  const expected = {
    v10Spec: sha256(frozen.v10SpecBytes),
    v11Spec: sha256(frozen.specBytes),
    recovery: sha256(recoveryBytes),
    registry: sha256(registryText),
  }
  for (const [name, digest] of Object.entries(expected)) {
    if (manifest.digests?.[name] !== digest) throw new Error(`exposure registry ${name} digest mismatch`)
  }
  if (!Array.isArray(manifest.querySnapshots) || manifest.querySnapshots.length !== searches.size) {
    throw new Error('exposure registry manifest does not cover every frozen query')
  }
  if (manifest.exposureCount !== rows.length || manifest.queryCount !== searches.size) {
    throw new Error('exposure registry manifest count mismatch')
  }
  const rowCounts = new Map()
  const ranks = new Map()
  for (const row of rows) {
    rowCounts.set(row.queryId, (rowCounts.get(row.queryId) ?? 0) + 1)
    if (!ranks.has(row.queryId)) ranks.set(row.queryId, new Set())
    if (ranks.get(row.queryId).has(row.rank)) throw new Error(`duplicate exposure rank for ${row.queryId}`)
    ranks.get(row.queryId).add(row.rank)
  }
  const seenSnapshots = new Set()
  for (const snapshot of manifest.querySnapshots) {
    const search = searches.get(snapshot.queryId)
    if (search === undefined || seenSnapshots.has(snapshot.queryId)
      || snapshot.query !== search.query || snapshot.page !== 1
      || !Number.isInteger(snapshot.totalCount) || snapshot.totalCount < 0
      || snapshot.incompleteResults !== false) {
      throw new Error(`invalid exposure snapshot ${snapshot.queryId ?? '<unknown>'}`)
    }
    seenSnapshots.add(snapshot.queryId)
    if (snapshot.itemCount !== (rowCounts.get(snapshot.queryId) ?? 0)) {
      throw new Error(`exposure snapshot count mismatch for ${snapshot.queryId}`)
    }
    if (snapshot.itemCount !== Math.min(snapshot.totalCount, frozen.spec.searchFrame.resultsPerPage)) {
      throw new Error(`exposure snapshot pagination mismatch for ${snapshot.queryId}`)
    }
    const expectedRanks = Array.from({ length: snapshot.itemCount }, (_, index) => index + 1)
    if (JSON.stringify([...(ranks.get(snapshot.queryId) ?? [])].sort((left, right) => left - right)) !== JSON.stringify(expectedRanks)) {
      throw new Error(`exposure registry ranks are not contiguous for ${snapshot.queryId}`)
    }
  }
  if (seenSnapshots.size !== searches.size) throw new Error('exposure registry manifest omits a frozen query')
  return { rows, manifest, index: exposureIndex(rows), registryText }
}
