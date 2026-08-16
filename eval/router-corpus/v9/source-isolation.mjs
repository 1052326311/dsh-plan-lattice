#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SHINGLE_SIZE = 5
export const NEAR_DUPLICATE_THRESHOLD = 0.85

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../../..')
const corpusRoot = join(repositoryRoot, 'eval/router-corpus')
const priorVersions = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']
const historyName = /(source|candidate|calibration)/i

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase()
}

export function normalizeRepository(value) {
  if (value === null || value === undefined) return undefined
  let candidate = String(value).trim()
  const ssh = candidate.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)
  if (ssh !== null) candidate = ssh[1]
  try {
    const parsed = new URL(candidate)
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (hostname === 'api.github.com' && parts[0]?.toLowerCase() === 'repos') parts.splice(0, 1)
    if (hostname !== 'github.com' && hostname !== 'api.github.com') return undefined
    candidate = parts.slice(0, 2).join('/')
  } catch {
    // A plain owner/name pair is the normal representation in corpus records.
  }
  candidate = candidate.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  const parts = candidate.split('/')
  if (parts.length !== 2 || parts.some(part => part.length === 0 || /\s/.test(part))) return undefined
  return parts.join('/').toLowerCase()
}

export function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value).trim())
    parsed.hash = ''
    parsed.search = ''
    parsed.protocol = parsed.protocol.toLowerCase()
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\.(?=github\.com$)/, '')
    const apiMatch = parsed.hostname === 'api.github.com'
      ? parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls|commits)\/([^/]+)\/?$/i)
      : null
    if (apiMatch !== null) {
      const [, owner, repository, kind, identifier] = apiMatch
      const webKind = kind.toLowerCase() === 'pulls' ? 'pull' : kind.toLowerCase() === 'commits' ? 'commit' : 'issues'
      return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}/${webKind}/${identifier.toLowerCase()}`
    }
    if (parsed.hostname === 'github.com') parsed.pathname = parsed.pathname.toLowerCase()
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return String(value ?? '').trim()
  }
}

function repositoryFromUrl(value) {
  try {
    const parsed = new URL(String(value))
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (hostname === 'api.github.com' && parts[0]?.toLowerCase() === 'repos') parts.shift()
    if (hostname !== 'github.com' && hostname !== 'api.github.com') return undefined
    return normalizeRepository(parts.slice(0, 2).join('/'))
  } catch {
    return undefined
  }
}

function urlValue(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return undefined
  return normalizeUrl(value)
}

function repositoryRefs(value, output = new Set()) {
  if (typeof value === 'string') {
    const repository = normalizeRepository(value) ?? repositoryFromUrl(value)
    if (repository !== undefined) output.add(repository)
    return output
  }
  if (Array.isArray(value)) {
    for (const child of value) repositoryRefs(child, output)
    return output
  }
  if (value === null || typeof value !== 'object') return output
  for (const [key, child] of Object.entries(value)) {
    if (['repository', 'repo', 'fullname', 'namewithowner', 'url', 'htmlurl', 'cloneurl'].includes(normalizedKey(key))) {
      repositoryRefs(child, output)
    }
  }
  return output
}

function githubReference(value) {
  const url = urlValue(value)
  if (url === undefined) return undefined
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)$/i)
  return match === null ? undefined : `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`
}

function pullRequestFromUrl(value) {
  const url = urlValue(value)
  if (url === undefined) return undefined
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i)
  return match === null ? undefined : `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`
}

function commitFromUrl(value) {
  const url = urlValue(value)
  if (url === undefined) return undefined
  const match = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/([a-f0-9]{7,40})$/i)
  return match?.[1].toLowerCase()
}

function relationValues(value, repositories, kind, output) {
  const addReference = reference => output.add(kind === 'duplicate' ? `issue:${reference}` : reference)
  if (Array.isArray(value)) {
    for (const child of value) relationValues(child, repositories, kind, output)
    return
  }
  if (value === null || value === undefined) return
  if (typeof value === 'number') {
    if ((kind === 'pull' || kind === 'duplicate') && Number.isInteger(value)) {
      for (const repository of repositories) addReference(`${repository}#${value}`)
    }
    return
  }
  if (typeof value === 'string') {
    if (kind === 'commit') {
      const commit = commitFromUrl(value) ?? (/^[a-f0-9]{7,40}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined)
      if (commit !== undefined) output.add(commit)
      return
    }
    const reference = kind === 'pull' ? pullRequestFromUrl(value) : githubReference(value)
    if (reference !== undefined) addReference(reference)
    const normalizedUrl = urlValue(value)
    if (kind === 'duplicate' && normalizedUrl !== undefined) output.add(`url:${normalizedUrl}`)
    const short = value.trim().match(/^#?(\d+)$/)
    if (short !== null) for (const repository of repositories) addReference(`${repository}#${short[1]}`)
    const qualified = value.trim().match(/^([^/\s]+\/[^#\s]+)#(\d+)$/)
    if (qualified !== null) {
      const repository = normalizeRepository(qualified[1])
      if (repository !== undefined) addReference(`${repository}#${qualified[2]}`)
    }
    return
  }
  if (typeof value !== 'object') return
  const explicitRepositories = repositoryRefs(value)
  const nestedRepositories = explicitRepositories.size > 0 ? explicitRepositories : repositories
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key)
    if (kind === 'commit' && ['sha', 'oid', 'commitsha', 'commitoid', 'url', 'htmlurl'].includes(normalized)) {
      relationValues(child, nestedRepositories, kind, output)
    } else if ((kind === 'pull' || kind === 'duplicate')
      && ['number', 'issuenumber', 'pullrequestnumber', 'url', 'htmlurl'].includes(normalized)) {
      relationValues(child, nestedRepositories, kind, output)
    } else if (kind === 'duplicate' && normalized === 'nodeid' && ['string', 'number'].includes(typeof child)) {
      output.add(`node:${String(child).trim()}`)
    } else if (typeof child === 'object' && child !== null) {
      relationValues(child, nestedRepositories, kind, output)
    }
  }
}

function createState() {
  return {
    repositories: new Set(),
    urls: new Set(),
    nodeIds: new Set(),
    promptDigests: new Set(),
    canonicalDigests: new Set(),
    pullRequests: new Set(),
    commits: new Set(),
    duplicateReferences: new Set(),
    entityReferences: new Set(),
    networkEdges: [],
    explicitNetworkRoots: new Set(),
    sourceNetworkRoots: new Set(),
    promptRecords: [],
    promptSequence: 0,
  }
}

const repositoryKeys = new Set(['repository', 'repo', 'fullname', 'namewithowner'])
const lineageKeys = new Set(['parent', 'source', 'networkroot'])
const pullKeys = /^(?:(?:associated|linked|related))?(?:pr|prs|pullrequest|pullrequests)$/
const commitKeys = /^(?:(?:associated|linked|related))?(?:commit|commits|commitsha|commitshas|commitoid|commitoids)$/
const duplicateKeys = /^(?:duplicate|duplicates|duplicateof|duplicatedby|duplicatechain|canonicalissue|supersedes|supersededby)$/

function collectObject(value, state, metadata, context = {}) {
  if (Array.isArray(value)) {
    for (const child of value) collectObject(child, state, metadata, context)
    return
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      const url = urlValue(value)
      if (url !== undefined) {
        state.urls.add(url)
        state.entityReferences.add(`url:${url}`)
        const pull = pullRequestFromUrl(url)
        const commit = commitFromUrl(url)
        const reference = githubReference(url)
        if (pull !== undefined) state.pullRequests.add(pull)
        if (commit !== undefined) state.commits.add(commit)
        if (reference !== undefined) state.entityReferences.add(`issue:${reference}`)
        if (!context.suppressRepository) {
          const repository = repositoryFromUrl(url)
          if (repository !== undefined) state.repositories.add(repository)
        }
      }
    }
    return
  }

  const entries = Object.entries(value)
  const directRepositories = new Set()
  for (const [key, child] of entries) {
    const normalized = normalizedKey(key)
    if (repositoryKeys.has(normalized)) repositoryRefs(child, directRepositories)
    if (['url', 'htmlurl'].includes(normalized) && typeof child === 'string') {
      const repository = repositoryFromUrl(child)
      if (repository !== undefined) directRepositories.add(repository)
    }
  }
  if (!context.suppressRepository) {
    for (const repository of directRepositories) state.repositories.add(repository)
  }

  const lineage = []
  for (const [key, child] of entries) {
    const normalized = normalizedKey(key)
    if (!lineageKeys.has(normalized)) continue
    const references = [...repositoryRefs(child)]
    lineage.push(...references)
    if (normalized === 'networkroot') for (const repository of references) state.explicitNetworkRoots.add(repository)
    if (normalized === 'source') for (const repository of references) state.sourceNetworkRoots.add(repository)
  }
  const networkMembers = [...new Set([...directRepositories, ...lineage])]
  if (!context.suppressRepository) {
    for (const repository of directRepositories) state.networkEdges.push([repository])
    if (networkMembers.length > 1) state.networkEdges.push(networkMembers)
  }

  for (const [key, child] of entries) {
    const normalized = normalizedKey(key)
    if (normalized === 'nodeid' && ['string', 'number'].includes(typeof child)) {
      const nodeId = String(child).trim()
      if (nodeId.length > 0) {
        state.nodeIds.add(nodeId)
        state.entityReferences.add(`node:${nodeId}`)
      }
    }
    if (normalized === 'promptdigest' && typeof child === 'string' && child.trim().length > 0) {
      state.promptDigests.add(child.trim().toLowerCase())
    }
    if (['canonicalpromptdigest', 'canonicaldigest'].includes(normalized)
      && typeof child === 'string' && child.trim().length > 0) {
      state.canonicalDigests.add(child.trim().toLowerCase())
    }
    if (pullKeys.test(normalized)) relationValues(child, directRepositories, 'pull', state.pullRequests)
    if (commitKeys.test(normalized)) relationValues(child, directRepositories, 'commit', state.commits)
    if (duplicateKeys.test(normalized)) relationValues(child, directRepositories, 'duplicate', state.duplicateReferences)
  }

  const issueNumber = entries.find(([key]) => normalizedKey(key) === 'issuenumber')?.[1]
  if (Number.isInteger(issueNumber)) {
    for (const repository of directRepositories) state.entityReferences.add(`issue:${repository}#${issueNumber}`)
  }
  const pullNumber = entries.find(([key]) => ['pullrequestnumber', 'prnumber'].includes(normalizedKey(key)))?.[1]
  if (Number.isInteger(pullNumber)) {
    for (const repository of directRepositories) state.pullRequests.add(`${repository}#${pullNumber}`)
  }

  for (const [key, child] of entries) {
    const normalized = normalizedKey(key)
    if (['text', 'prompt'].includes(normalized) && typeof child === 'string' && child.trim().length > 0) {
      const text = child.trim()
      const id = typeof value.id === 'string' && value.id.length > 0
        ? value.id
        : `${metadata.path ?? 'record'}:${state.promptSequence + 1}`
      state.promptSequence += 1
      state.promptRecords.push({ id, path: metadata.path, text })
      state.promptDigests.add(sha256(text))
      state.canonicalDigests.add(sha256(canonicalPrompt(text)))
    }
  }

  for (const [key, child] of entries) {
    const normalized = normalizedKey(key)
    const suppressRepository = context.suppressRepository || lineageKeys.has(normalized)
      || pullKeys.test(normalized) || commitKeys.test(normalized) || duplicateKeys.test(normalized)
    collectObject(child, state, metadata, { suppressRepository })
  }
}

function networkComponents(state) {
  const adjacency = new Map()
  const add = repository => {
    if (!adjacency.has(repository)) adjacency.set(repository, new Set())
  }
  for (const repository of state.repositories) add(repository)
  for (const edge of state.networkEdges) {
    for (const repository of edge) add(repository)
    for (let index = 1; index < edge.length; index += 1) {
      adjacency.get(edge[0]).add(edge[index])
      adjacency.get(edge[index]).add(edge[0])
    }
  }
  const seen = new Set()
  const networks = []
  for (const repository of [...adjacency.keys()].sort()) {
    if (seen.has(repository)) continue
    const stack = [repository]
    const members = []
    seen.add(repository)
    while (stack.length > 0) {
      const member = stack.pop()
      members.push(member)
      for (const neighbor of adjacency.get(member)) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        stack.push(neighbor)
      }
    }
    members.sort()
    const canonical = members.find(member => state.explicitNetworkRoots.has(member))
      ?? members.find(member => state.sourceNetworkRoots.has(member))
      ?? members[0]
    networks.push({ canonical, members })
  }
  return networks.sort((left, right) => left.canonical.localeCompare(right.canonical))
}

function sorted(values) {
  return [...values].filter(value => value !== undefined && value !== '').sort()
}

function finalizeState(state) {
  const networks = networkComponents(state)
  const canonicalDigests = sorted(state.canonicalDigests)
  return {
    repositories: sorted(state.repositories),
    canonicalNetworks: networks.map(network => network.canonical),
    networkMembers: sorted(new Set(networks.flatMap(network => network.members))),
    networks,
    urls: sorted(state.urls),
    nodeIds: sorted(state.nodeIds),
    promptDigests: sorted(state.promptDigests),
    canonicalDigests,
    canonicalPromptDigests: canonicalDigests,
    pullRequests: sorted(state.pullRequests),
    commits: sorted(state.commits),
    duplicateReferences: sorted(state.duplicateReferences),
    entityReferences: sorted(state.entityReferences),
    promptRecords: state.promptRecords,
  }
}

export function buildSourceInventory(records) {
  const state = createState()
  collectObject(records, state, {})
  return finalizeState(state)
}

function sourceVersion(path) {
  const first = relative(corpusRoot, path).split(sep)[0]
  return /^v[2-8]$/.test(first) ? first : 'v1'
}

function isHistoricalFile(path) {
  const first = relative(corpusRoot, path).split(sep)[0]
  const isPrior = !/^v\d+$/.test(first) || /^v[1-8]$/.test(first)
  return isPrior && historyName.test(basename(path)) && /\.jsonl?$/i.test(path)
}

async function walk(path) {
  const files = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await walk(child))
    else if (entry.isFile() && isHistoricalFile(child)) files.push(child)
  }
  return files
}

function parseHistoricalFile(text, path) {
  const displayPath = relative(repositoryRoot, path)
  if (!path.endsWith('.jsonl')) {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`${displayPath} is not valid JSON`, { cause: error })
    }
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim().length === 0) return []
    try {
      return [JSON.parse(line)]
    } catch (error) {
      throw new Error(`${displayPath}:${index + 1} is not valid JSON`, { cause: error })
    }
  })
}

export async function priorSourceInventory() {
  const paths = (await walk(corpusRoot)).sort()
  const state = createState()
  const files = []
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    const record = { path: relative(repositoryRoot, path), version: sourceVersion(path), digest: sha256(text) }
    collectObject(parseHistoricalFile(text, path), state, record)
    files.push(record)
  }
  const versions = Object.fromEntries(priorVersions.map(version => [
    version,
    files.filter(file => file.version === version).length,
  ]))
  for (const [version, count] of Object.entries(versions)) {
    if (count === 0) throw new Error(`no ${version} source, candidate, or calibration files were discovered`)
  }
  return { files, versions, ...finalizeState(state) }
}

function firstOverlap(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right ?? [])
  return [...left].find(value => rightSet.has(value))
}

function labelFor(row, index) {
  return typeof row?.id === 'string' && row.id.length > 0 ? row.id : `row ${index + 1}`
}

function rowInventories(rows) {
  return rows.map((row, index) => ({ row, index, label: labelFor(row, index), inventory: buildSourceInventory([row]) }))
}

export function assertSourceDisjoint(rows, inventory) {
  if (!Array.isArray(rows)) throw new Error('V9 sources must be an array')
  const prior = {
    repositories: new Set(inventory.repositories ?? []),
    networkMembers: new Set(inventory.networkMembers ?? inventory.repositories ?? []),
    urls: new Set(inventory.urls ?? []),
    nodeIds: new Set(inventory.nodeIds ?? []),
    promptDigests: new Set(inventory.promptDigests ?? []),
    canonicalDigests: new Set(inventory.canonicalDigests ?? inventory.canonicalPromptDigests ?? []),
    pullRequests: new Set(inventory.pullRequests ?? []),
    commits: new Set(inventory.commits ?? []),
    duplicateReferences: new Set(inventory.duplicateReferences ?? []),
    entityReferences: new Set(inventory.entityReferences ?? []),
  }
  const current = rowInventories(rows)
  const seen = {
    urls: new Set(), nodeIds: new Set(), promptDigests: new Set(), canonicalDigests: new Set(),
    pullRequests: new Set(), commits: new Set(), duplicateReferences: new Set(),
  }
  const allCurrentEntities = current.map(entry => new Set(entry.inventory.entityReferences))

  for (const entry of current) {
    const candidate = entry.inventory
    let overlap = firstOverlap(candidate.repositories, prior.repositories)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 repository in ${entry.label}: ${overlap}`)
    overlap = firstOverlap(candidate.networkMembers, prior.networkMembers)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 canonical fork network in ${entry.label}: ${overlap}`)
    overlap = firstOverlap(candidate.nodeIds, prior.nodeIds)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 nodeId in ${entry.label}: ${overlap}`)
    overlap = firstOverlap(candidate.pullRequests, prior.pullRequests)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 associated pull request in ${entry.label}: ${overlap}`)
    overlap = firstOverlap(candidate.commits, prior.commits)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 associated commit in ${entry.label}: ${overlap}`)
    overlap = firstOverlap(candidate.duplicateReferences, new Set([...prior.entityReferences, ...prior.duplicateReferences]))
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 duplicate chain in ${entry.label}: ${overlap}`)
    for (const [otherIndex, entities] of allCurrentEntities.entries()) {
      if (otherIndex === entry.index) continue
      overlap = firstOverlap(candidate.duplicateReferences, entities)
      if (overlap !== undefined) throw new Error(`V9 duplicate chain links ${entry.label} to another V9 source: ${overlap}`)
    }
    overlap = firstOverlap(candidate.urls, prior.urls)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 URL in ${entry.label}: ${overlap}`)
    overlap = firstOverlap(candidate.promptDigests, prior.promptDigests)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 prompt digest in ${entry.label}: ${overlap}`)
    overlap = firstOverlap(candidate.canonicalDigests, prior.canonicalDigests)
    if (overlap !== undefined) throw new Error(`V9 reuses a V1-V8 canonical digest in ${entry.label}: ${overlap}`)

    for (const [name, display] of [
      ['urls', 'URL'], ['nodeIds', 'nodeId'], ['promptDigests', 'prompt digest'],
      ['canonicalDigests', 'canonical digest'], ['pullRequests', 'associated pull request'],
      ['commits', 'associated commit'], ['duplicateReferences', 'duplicate-chain reference'],
    ]) {
      overlap = firstOverlap(candidate[name], seen[name])
      if (overlap !== undefined) throw new Error(`V9 duplicates ${display} in ${entry.label}: ${overlap}`)
      for (const value of candidate[name]) seen[name].add(value)
    }
  }

  const currentPrompts = current.flatMap(entry => entry.inventory.promptRecords.map(record => ({
    ...record, id: `${entry.label}:${record.id}`, origin: 'current', shingles: fiveShingles(record.text),
  })))
  const priorPrompts = (inventory.promptRecords ?? []).map((record, index) => ({
    ...record,
    id: `prior:${record.path ?? index}:${record.id ?? index}`,
    origin: 'prior',
    shingles: fiveShingles(record.text),
  }))
  const priorShingleIndex = indexShingles(priorPrompts)
  for (const left of currentPrompts) {
    for (const rightIndex of candidateIndexes(left.shingles, priorShingleIndex)) {
      const right = priorPrompts[rightIndex]
      const similarity = shingleJaccard(left.shingles, right.shingles)
      if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
        throw new Error(`V9 near-duplicate prompt ${left.id} matches ${right.id} (5-shingle Jaccard ${similarity.toFixed(3)} >= 0.85)`)
      }
    }
  }
  const clusters = nearDuplicateClusters(currentPrompts)
  if (clusters.length > 0) {
    throw new Error(`V9 contains a near-duplicate prompt cluster: ${clusters[0].members.join(', ')}`)
  }

  const combined = buildSourceInventory(rows)
  return {
    repositories: new Set(combined.repositories),
    canonicalNetworks: new Set(combined.canonicalNetworks),
    urls: new Set(combined.urls),
    nodeIds: new Set(combined.nodeIds),
    promptDigests: new Set(combined.promptDigests),
    canonicalDigests: new Set(combined.canonicalDigests),
  }
}

export function canonicalPrompt(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/\S+/gu, ' url ')
    .replace(/\p{N}+/gu, ' # ')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function promptTokens(value) {
  return canonicalPrompt(value).match(/\p{Script=Han}|[\p{L}\p{N}#]+/gu) ?? []
}

export function fiveShingles(value) {
  const tokens = promptTokens(value)
  if (tokens.length === 0) return new Set()
  if (tokens.length < SHINGLE_SIZE) return new Set([tokens.join('\u0001')])
  const shingles = new Set()
  for (let index = 0; index <= tokens.length - SHINGLE_SIZE; index += 1) {
    shingles.add(tokens.slice(index, index + SHINGLE_SIZE).join('\u0001'))
  }
  return shingles
}

export function shingleJaccard(left, right) {
  const leftSet = left instanceof Set ? left : fiveShingles(left)
  const rightSet = right instanceof Set ? right : fiveShingles(right)
  if (leftSet.size === 0 || rightSet.size === 0) return 0
  if (Math.min(leftSet.size, rightSet.size) / Math.max(leftSet.size, rightSet.size) < NEAR_DUPLICATE_THRESHOLD) return 0
  const smaller = leftSet.size <= rightSet.size ? leftSet : rightSet
  const larger = smaller === leftSet ? rightSet : leftSet
  let intersection = 0
  for (const shingle of smaller) if (larger.has(shingle)) intersection += 1
  return intersection / (leftSet.size + rightSet.size - intersection)
}

function indexShingles(records) {
  const index = new Map()
  records.forEach((record, recordIndex) => {
    for (const shingle of record.shingles) {
      if (!index.has(shingle)) index.set(shingle, [])
      index.get(shingle).push(recordIndex)
    }
  })
  return index
}

function candidateIndexes(shingles, index) {
  const candidates = new Set()
  for (const shingle of shingles) {
    for (const recordIndex of index.get(shingle) ?? []) candidates.add(recordIndex)
  }
  return candidates
}

export function nearDuplicateClusters(records) {
  const prompts = records.map((record, index) => ({
    id: typeof record?.id === 'string' && record.id.length > 0 ? record.id : `row ${index + 1}`,
    index,
    shingles: fiveShingles(record?.text ?? record?.prompt ?? ''),
  })).filter(record => record.shingles.size > 0)
  const parents = prompts.map((_, index) => index)
  const find = index => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]]
      index = parents[index]
    }
    return index
  }
  const edges = []
  const shingleIndex = new Map()
  for (let right = 0; right < prompts.length; right += 1) {
    for (const left of candidateIndexes(prompts[right].shingles, shingleIndex)) {
      const similarity = shingleJaccard(prompts[left].shingles, prompts[right].shingles)
      if (similarity < NEAR_DUPLICATE_THRESHOLD) continue
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
      edges.push({ left: prompts[left].id, right: prompts[right].id, similarity })
    }
    for (const shingle of prompts[right].shingles) {
      if (!shingleIndex.has(shingle)) shingleIndex.set(shingle, [])
      shingleIndex.get(shingle).push(right)
    }
  }
  const groups = new Map()
  for (let index = 0; index < prompts.length; index += 1) {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(prompts[index].id)
  }
  return [...groups.entries()].filter(([, members]) => members.length > 1).map(([root, members]) => {
    const memberSet = new Set(members)
    return {
      members,
      pairs: edges.filter(edge => memberSet.has(edge.left) && memberSet.has(edge.right)),
      root: prompts[root].id,
    }
  })
}

function capFor(caps, dimension) {
  const title = dimension[0].toUpperCase() + dimension.slice(1)
  return caps[dimension] ?? caps[`per${title}`] ?? caps[`maxPer${title}`]
    ?? caps[`maximumPer${title}`] ?? caps[`per${title}PerStratum`] ?? caps[`${dimension}Share`]
}

function scalarIdentity(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).trim().toLowerCase()
    return normalized.length > 0 ? normalized : undefined
  }
  if (value !== null && typeof value === 'object') {
    for (const key of ['login', 'name', 'slug', 'id']) {
      const identity = scalarIdentity(value[key])
      if (identity !== undefined) return identity
    }
  }
  return undefined
}

function dimensionValue(row, dimension) {
  if (dimension === 'author') {
    return scalarIdentity(row.author ?? row.authorLogin ?? row.reporter ?? row.user)
  }
  if (dimension === 'repository') {
    return [...repositoryRefs(row.repository ?? row.repo ?? row.repositoryUrl)][0]
  }
  if (dimension === 'organization') {
    const explicit = scalarIdentity(row.organization ?? row.organisation ?? row.org ?? row.owner)
    if (explicit !== undefined) return explicit
    return dimensionValue(row, 'repository')?.split('/')[0]
  }
  return scalarIdentity(row.ecosystem)
}

export function assertDiversityCaps(rows, caps) {
  if (!Array.isArray(rows)) throw new Error('diversity rows must be an array')
  if (caps === null || typeof caps !== 'object') throw new Error('diversity caps must be supplied')
  const counts = {}
  for (const dimension of ['author', 'repository', 'organization', 'ecosystem']) {
    const cap = capFor(caps, dimension)
    const countCap = Number.isInteger(cap) && cap >= 0
    const shareCap = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && cap < 1
    if (!countCap && !shareCap) {
      throw new Error(`${dimension} cap must be a non-negative integer count or a share between zero and one`)
    }
    const limit = shareCap ? Math.floor(rows.length * cap) : cap
    const dimensionCounts = new Map()
    rows.forEach((row, index) => {
      const value = dimensionValue(row, dimension)
      if (value === undefined) throw new Error(`V9 ${labelFor(row, index)} is missing ${dimension} for diversity validation`)
      const count = (dimensionCounts.get(value) ?? 0) + 1
      dimensionCounts.set(value, count)
      if (count > limit) {
        const basis = shareCap ? `${cap} share (${limit} of ${rows.length})` : String(cap)
        throw new Error(`V9 ${dimension} cap ${basis} exceeded by ${value}: ${count}`)
      }
    })
    counts[dimension] = Object.fromEntries([...dimensionCounts.entries()].sort(([left], [right]) => left.localeCompare(right)))
  }
  return counts
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const inventory = await priorSourceInventory()
  const { promptRecords, ...summary } = inventory
  console.log(JSON.stringify({ ...summary, promptRecordCount: promptRecords.length }, null, 2))
}
