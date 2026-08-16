import { readFile } from 'node:fs/promises'
import {
  buildSourceInventory,
  canonicalPrompt,
  fiveShingles,
  normalizeRepository,
  normalizeUrl,
  shingleJaccard,
} from '../v10/source-isolation.mjs'
import {
  frozenPriorExposureInventory,
  predecessorCutoff,
  sha256,
  staticInventoryDigest,
  staticRegistryDigest,
} from './prior-exposure-registry.mjs'

export {
  canonicalPrompt,
  fiveShingles,
  frozenPriorExposureInventory,
  normalizeRepository,
  normalizeUrl,
  shingleJaccard,
  staticInventoryDigest,
  staticRegistryDigest,
}

export const NEAR_DUPLICATE_THRESHOLD = 0.85
export const priorInventoryDigest = frozenPriorExposureInventory.inventoryDigest
export const frozenV10IsolationSha256 = '68815d5e209fce517b5c325e89fda46639d4f37fd25e59780a6599a8a768d4dc'

if (priorInventoryDigest !== staticInventoryDigest) {
  throw new Error('V12 prior exposure inventory was not frozen before current source parsing')
}
if (sha256(await readFile(new URL('../v10/source-isolation.mjs', import.meta.url))) !== frozenV10IsolationSha256) {
  throw new Error('V12 source isolation helper differs from the exact frozen commit')
}

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function scalarValues(value) {
  if (Array.isArray(value)) return value.flatMap(scalarValues)
  if (['string', 'number'].includes(typeof value)) {
    const normalized = String(value).trim()
    return normalized === '' ? [] : [normalized]
  }
  return []
}

function collectExplicitIds(value, output) {
  if (Array.isArray(value)) {
    for (const child of value) collectExplicitIds(child, output)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key)
    if (['sourcefamilyid', 'familyid'].includes(normalized)) {
      for (const item of scalarValues(child)) output.familyIds.add(item.toLowerCase())
    }
    if (['objectid', 'issueid', 'pullrequestid'].includes(normalized)) {
      for (const item of scalarValues(child)) output.objectIds.add(item.toLowerCase())
    }
    if (['eventid', 'eventids', 'openedeventid'].includes(normalized)) {
      for (const item of scalarValues(child)) output.eventIds.add(item)
    }
    if (['commitid', 'commitsha', 'commitoid', 'headsha', 'before', 'head'].includes(normalized)) {
      for (const item of scalarValues(child)) if (/^[a-f0-9]{7,40}$/iu.test(item)) output.commits.add(item.toLowerCase())
    }
    collectExplicitIds(child, output)
  }
}

function familyIdentity(value) {
  const match = String(value ?? '').trim().match(/^github:([^:]+\/[^:]+):(issue|pull):(\d+)$/iu)
  if (match === null) return undefined
  return {
    familyId: `github:${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3]}`,
    repository: match[1].toLowerCase(),
    objectType: match[2].toLowerCase(),
    number: match[3],
  }
}

function candidateInventory(row) {
  const base = buildSourceInventory([row])
  const explicit = {
    familyIds: new Set(),
    objectIds: new Set(),
    eventIds: new Set(),
    commits: new Set(base.commits ?? []),
  }
  collectExplicitIds(row, explicit)
  const identity = familyIdentity(row?.sourceFamilyId ?? row?.familyId)
  const pullRequests = new Set(base.pullRequests ?? [])
  if (identity !== undefined) {
    explicit.familyIds.add(identity.familyId)
    explicit.objectIds.add(identity.familyId)
    if (identity.objectType === 'pull') pullRequests.add(`${identity.repository}#${identity.number}`)
  }
  return {
    repositories: new Set(base.repositories ?? []),
    networkMembers: new Set(base.networkMembers ?? base.repositories ?? []),
    familyIds: explicit.familyIds,
    objectIds: explicit.objectIds,
    eventIds: explicit.eventIds,
    urls: new Set(base.urls ?? []),
    nodeIds: new Set(base.nodeIds ?? []),
    pullRequests,
    commits: explicit.commits,
    duplicateReferences: new Set(base.duplicateReferences ?? []),
    entityReferences: new Set(base.entityReferences ?? []),
    promptDigests: new Set(base.promptDigests ?? []),
    canonicalDigests: new Set(base.canonicalDigests ?? base.canonicalPromptDigests ?? []),
    promptRecords: (base.promptRecords ?? []).map(record => ({ ...record, shingles: fiveShingles(record.text) })),
  }
}

function asSet(value, fallback = []) {
  return value instanceof Set ? value : new Set(value ?? fallback)
}

function preparePrior(inventory) {
  const prompts = (inventory.promptRecords ?? []).map((record, index) => ({
    id: record.id ?? `prior:${index}`,
    path: record.path,
    shingles: fiveShingles(record.text),
  }))
  const shingleIndex = new Map()
  prompts.forEach((record, index) => {
    for (const shingle of record.shingles) {
      const indexes = shingleIndex.get(shingle) ?? []
      indexes.push(index)
      shingleIndex.set(shingle, indexes)
    }
  })
  return {
    inventory,
    repositories: new Set([...asSet(inventory.repositories)].map(normalizeRepository).filter(Boolean)),
    networkMembers: new Set([...asSet(inventory.networkMembers, inventory.repositories)].map(normalizeRepository).filter(Boolean)),
    familyIds: new Set([...asSet(inventory.familyIds)].map(value => String(value).toLowerCase())),
    objectIds: new Set([...asSet(inventory.objectIds)].map(value => String(value).toLowerCase())),
    eventIds: new Set([...asSet(inventory.eventIds)].map(String)),
    urls: new Set([...asSet(inventory.urls)].map(normalizeUrl)),
    nodeIds: asSet(inventory.nodeIds),
    pullRequests: new Set([...asSet(inventory.pullRequests)].map(value => String(value).toLowerCase())),
    commits: new Set([...asSet(inventory.commits)].map(value => String(value).toLowerCase())),
    duplicateReferences: asSet(inventory.duplicateReferences),
    entityReferences: asSet(inventory.entityReferences),
    promptDigests: asSet(inventory.promptDigests),
    canonicalDigests: asSet(inventory.canonicalDigests, inventory.canonicalPromptDigests),
    prompts,
    shingleIndex,
  }
}

function firstOverlap(left, right) {
  for (const value of left) if (right.has(value)) return value
  return undefined
}

function temporalReason(row) {
  const objectCreatedAt = Date.parse(row?.objectCreatedAt ?? '')
  const eventCreatedAt = Date.parse(row?.eventCreatedAt ?? '')
  const cutoff = Date.parse(predecessorCutoff)
  if (!Number.isFinite(objectCreatedAt) || !Number.isFinite(eventCreatedAt)) return 'temporal-proof-missing'
  if (objectCreatedAt <= cutoff || eventCreatedAt <= cutoff) return 'prior-temporal-frame'
  if (eventCreatedAt < objectCreatedAt) return 'invalid-event-order'
  return undefined
}

function nearDuplicate(candidate, prior) {
  for (const prompt of candidate.promptRecords) {
    const indexes = new Set()
    for (const shingle of prompt.shingles) {
      for (const index of prior.shingleIndex.get(shingle) ?? []) indexes.add(index)
    }
    for (const index of indexes) {
      const similarity = shingleJaccard(prompt.shingles, prior.prompts[index].shingles)
      if (similarity >= NEAR_DUPLICATE_THRESHOLD) return { value: prior.prompts[index].id, similarity }
    }
  }
  return undefined
}

function overlapReason(row, prior) {
  const temporal = temporalReason(row)
  if (temporal !== undefined) return { reason: temporal }
  if (typeof row?.text !== 'string' || row.text.trim() === '') return { reason: 'prompt-missing' }
  if (row.promptDigest !== undefined && row.promptDigest !== sha256(row.text)) return { reason: 'prompt-digest-invalid' }

  const candidate = candidateInventory(row)
  for (const [dimension, reason] of [
    ['repositories', 'prior-repository'],
    ['networkMembers', 'prior-network'],
    ['familyIds', 'prior-family-id'],
    ['objectIds', 'prior-object-id'],
    ['eventIds', 'prior-event-id'],
    ['urls', 'prior-url'],
    ['nodeIds', 'prior-node-id'],
    ['pullRequests', 'prior-pull-request'],
    ['commits', 'prior-commit'],
    ['promptDigests', 'prior-prompt-digest'],
    ['canonicalDigests', 'prior-canonical-digest'],
  ]) {
    const value = firstOverlap(candidate[dimension], prior[dimension])
    if (value !== undefined) return { reason, value }
  }
  const duplicateTargets = new Set([...prior.duplicateReferences, ...prior.entityReferences])
  const duplicate = firstOverlap(candidate.duplicateReferences, duplicateTargets)
  if (duplicate !== undefined) return { reason: 'prior-duplicate-chain', value: duplicate }
  const near = nearDuplicate(candidate, prior)
  if (near !== undefined) return { reason: 'prior-near-duplicate', ...near }
  return undefined
}

function inventoryDigestFor(inventory) {
  if (typeof inventory.inventoryDigest === 'string') return inventory.inventoryDigest
  const fields = [
    'repositories', 'networkMembers', 'familyIds', 'objectIds', 'eventIds', 'urls', 'nodeIds',
    'pullRequests', 'commits', 'promptDigests', 'canonicalDigests',
  ]
  const summary = Object.fromEntries(fields.map(name => [name, [...asSet(inventory[name])].sort()]))
  summary.promptRecords = (inventory.promptRecords ?? []).map(record => ({ id: record.id, path: record.path, text: record.text }))
  return sha256(JSON.stringify(summary))
}

export async function filterPriorExposure(rows, inventory = frozenPriorExposureInventory) {
  if (!Array.isArray(rows)) throw new Error('V12 sources must be an array')
  const prior = preparePrior(inventory)
  const accepted = []
  const rejected = []
  for (const row of rows) {
    const match = overlapReason(row, prior)
    if (match === undefined) accepted.push(row)
    else rejected.push({ stableSourceId: row?.stableSourceId, ...match })
  }
  return {
    accepted,
    rejected,
    inventoryDigest: inventoryDigestFor(inventory),
    registryDigest: inventory.registryDigest ?? staticRegistryDigest,
  }
}

function currentOverlapReason(row, accepted) {
  const candidate = candidateInventory(row)
  for (const priorRow of accepted) {
    const prior = candidateInventory(priorRow)
    for (const [dimension, reason] of [
      ['familyIds', 'current-family-id'],
      ['objectIds', 'current-object-id'],
      ['eventIds', 'current-event-id'],
      ['urls', 'current-url'],
      ['nodeIds', 'current-node-id'],
      ['pullRequests', 'current-pull-request'],
      ['commits', 'current-commit'],
      ['promptDigests', 'current-prompt-digest'],
      ['canonicalDigests', 'current-canonical-digest'],
    ]) {
      const value = firstOverlap(candidate[dimension], prior[dimension])
      if (value !== undefined) return { reason, value, duplicateOf: priorRow.stableSourceId }
    }
    for (const left of candidate.promptRecords) {
      for (const right of prior.promptRecords) {
        const similarity = shingleJaccard(left.shingles, right.shingles)
        if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
          return { reason: 'current-near-duplicate', similarity, duplicateOf: priorRow.stableSourceId }
        }
      }
    }
  }
  return undefined
}

export function removeCurrentNearDuplicates(rows) {
  if (!Array.isArray(rows)) throw new Error('V12 current sources must be an array')
  const accepted = []
  const rejected = []
  for (const row of rows) {
    const match = currentOverlapReason(row, accepted)
    if (match === undefined) accepted.push(row)
    else rejected.push({ stableSourceId: row?.stableSourceId, ...match })
  }
  return { accepted, rejected }
}

export async function assertSourceDisjoint(rows, inventory = frozenPriorExposureInventory) {
  const prior = await filterPriorExposure(rows, inventory)
  if (prior.rejected.length > 0) {
    const first = prior.rejected[0]
    throw new Error(`V12 source ${first.stableSourceId ?? '<unknown>'} overlaps prior exposure by ${first.reason}: ${first.value ?? ''}`.trim())
  }
  const current = removeCurrentNearDuplicates(prior.accepted)
  if (current.rejected.length > 0) {
    const first = current.rejected[0]
    throw new Error(`V12 source ${first.stableSourceId ?? '<unknown>'} overlaps the current frame by ${first.reason}: ${first.value ?? ''}`.trim())
  }
  return { inventoryDigest: prior.inventoryDigest, registryDigest: prior.registryDigest, accepted: current.accepted }
}
