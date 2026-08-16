import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFile = promisify(execFileCallback)

export const exactCommit = 'b5971547af8c733312d2efce888cdf2573cc379d'
export const exactTree = '7d8798ba46ed239848716309af63cd32d332587d'
export const predecessorCutoff = '2026-08-15T23:59:59Z'
export const prospectiveWindowStart = '2026-08-17T00:00:00Z'
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const exposureArtifacts = [
  {
    path: 'eval/router-corpus/v10/source-frame-spec.json',
    sha256: 'aeb7269404e225545a41ed2f1b97aca1c279000f880011bd75c4b2e4d7da8de4',
    role: 'v10-search-frame',
  },
  {
    path: 'eval/router-corpus/v10/source-frame-runtime-failure.json',
    sha256: '8bd213bd7e8e5ff18e25a3636c03e7530d454e4a1f8bdb3f1138dc651dc876a3',
    role: 'v10-observed-failure',
  },
  {
    path: 'eval/router-corpus/v10/source-frame-runtime-failure-correction.json',
    sha256: '2cbb50f6ad505b2ea7ef993a42e24823b254f938ad026b1675a5605a7c952fe7',
    role: 'v10-failure-correction',
  },
  {
    path: 'eval/router-corpus/v11/source-frame-spec.json',
    sha256: 'ccfd4e33ff20b76709268361f3ddd961ee1c9bc8da1bef65d3d8440b59573c2c',
    role: 'v11-recovery-frame',
  },
  {
    path: 'eval/router-corpus/v11/exposure-recovery-failure.json',
    sha256: 'fdf02197fd6320647b682e1dab98304d201837c1ec8ea33647827789ac4f7ae0',
    role: 'v11-observed-failure',
  },
]

export const staticPriorExposureRegistry = Object.freeze({
  schemaVersion: 1,
  kind: 'dsh-plan-lattice-v12-prior-exposure-registry',
  exactCommit,
  exactTree,
  coveredVersions: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11'],
  exposureArtifacts,
  failedProtocols: [
    {
      protocol: 'observable-authorization-v10',
      disposition: 'retired-before-seed-reveal',
      exposure: 'all first-page results from 42 frozen searches plus the observed failing repository',
      observedRepository: 'shup2399/gg',
      observedUrl: 'https://github.com/shup2399/gg',
    },
    {
      protocol: 'observable-authorization-v11',
      disposition: 'retired-before-seed-reveal',
      exposure: 'V10 first-page recovery through bounded-en-fix rank 21 before fail-closed retirement',
      failedQueryId: 'bounded-en-fix',
      failedRank: 21,
    },
  ],
  temporalProof: {
    predecessorCutoff,
    prospectiveWindowStart,
    priorPredicate: 'every V10/V11 search includes updated:<=2026-08-15',
    currentPredicate: 'every V12 root object has objectCreatedAt > predecessorCutoff',
    invariant: 'for one immutable GitHub issue or pull request, created_at <= updated_at',
    conclusion: 'a V12 root object cannot be any V10/V11 search result even when old result identities are unavailable',
  },
})

// These constants make the prior frame a preregistered input rather than a value chosen after V12 source parsing.
export const staticRegistryDigest = '4d34b9cef26695e3a0e34ea0400319e14efc148bd553b4dbcfc01a517c906cf0'
export const staticInventoryDigest = '74002b76b42ca4c4aedcfa30640f8b2fb4c729f41f7ec37ad6eb06810878928d'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sorted(values) {
  return [...new Set(values)].filter(value => value !== undefined && value !== '').sort()
}

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function parseData(text, path) {
  if (!path.endsWith('.jsonl')) return JSON.parse(text)
  return text.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim() === '') return []
    try {
      return [JSON.parse(line)]
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not valid JSON`, { cause: error })
    }
  })
}

async function priorDataPaths(corpusRoot) {
  const paths = []
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        const first = childRelative.split('/')[0]
        const version = first.match(/^v(\d+)$/u)
        if (version !== null && Number(version[1]) > 11) continue
        await visit(child, childRelative)
      } else if (entry.isFile() && /\.jsonl?$/iu.test(entry.name)) {
        paths.push(childRelative)
      }
    }
  }
  await visit(corpusRoot)
  return paths.sort()
}

function versionForDataPath(path) {
  const match = path.split('/')[0].match(/^v(\d+)$/u)
  return match === null ? 'v1' : `v${match[1]}`
}

function collectExplicitIds(value, output) {
  if (Array.isArray(value)) {
    for (const child of value) collectExplicitIds(child, output)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key)
    const values = Array.isArray(child) ? child : [child]
    if (['sourcefamilyid', 'familyid'].includes(normalized)) {
      for (const item of values) if (['string', 'number'].includes(typeof item)) output.familyIds.add(String(item).trim().toLowerCase())
    }
    if (['objectid', 'issueid', 'pullrequestid'].includes(normalized)) {
      for (const item of values) if (['string', 'number'].includes(typeof item)) output.objectIds.add(String(item).trim().toLowerCase())
    }
    if (['eventid', 'eventids', 'openedeventid'].includes(normalized)) {
      for (const item of values) if (['string', 'number'].includes(typeof item)) output.eventIds.add(String(item).trim())
    }
    collectExplicitIds(child, output)
  }
}

function mergeBaseInventories(...inventories) {
  const dimensions = [
    'repositories', 'canonicalNetworks', 'networkMembers', 'urls', 'nodeIds', 'promptDigests',
    'canonicalDigests', 'pullRequests', 'commits', 'duplicateReferences', 'entityReferences',
  ]
  const merged = Object.fromEntries(dimensions.map(name => [name, sorted(inventories.flatMap(value => value[name] ?? []))]))
  merged.promptRecords = inventories.flatMap(value => value.promptRecords ?? [])
  merged.networks = inventories.flatMap(value => value.networks ?? [])
  return merged
}

async function run(command, args, cwd = repositoryRoot) {
  return execFile(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

async function assertGitIdentity() {
  const [{ stdout: commit }, { stdout: tree }] = await Promise.all([
    run('git', ['rev-parse', '--verify', `${exactCommit}^{commit}`]),
    run('git', ['rev-parse', '--verify', `${exactCommit}^{tree}`]),
  ])
  if (commit.trim() !== exactCommit || tree.trim() !== exactTree) throw new Error('V12 prior exposure Git identity changed')
}

function assertTemporalFrame(v10Spec, v11Spec) {
  if (v10Spec.cutoff !== predecessorCutoff || v11Spec.cutoff !== predecessorCutoff) {
    throw new Error('V10/V11 predecessor cutoff differs from the static V12 exposure boundary')
  }
  if (!Array.isArray(v10Spec.searches) || v10Spec.searches.length !== 42) {
    throw new Error('V10 search exposure frame is incomplete')
  }
  for (const search of v10Spec.searches) {
    if (!search.query.endsWith('updated:<=2026-08-15')) {
      throw new Error(`V10 search ${search.id} lacks the frozen temporal upper bound`)
    }
  }
  if (v11Spec.v10?.specSha256 !== exposureArtifacts[0].sha256 || v11Spec.v10?.expectedSearchCount !== 42) {
    throw new Error('V11 does not bind the complete V10 search exposure frame')
  }
}

function serializableInventory(inventory) {
  return {
    registryDigest: inventory.registryDigest,
    exactCommit: inventory.exactCommit,
    exactTree: inventory.exactTree,
    cutoff: inventory.cutoff,
    coveredVersions: inventory.coveredVersions,
    files: inventory.files,
    repositories: inventory.repositories,
    canonicalNetworks: inventory.canonicalNetworks,
    networkMembers: inventory.networkMembers,
    urls: inventory.urls,
    nodeIds: inventory.nodeIds,
    familyIds: inventory.familyIds,
    objectIds: inventory.objectIds,
    eventIds: inventory.eventIds,
    promptDigests: inventory.promptDigests,
    canonicalDigests: inventory.canonicalDigests,
    pullRequests: inventory.pullRequests,
    commits: inventory.commits,
    duplicateReferences: inventory.duplicateReferences,
    entityReferences: inventory.entityReferences,
    promptRecords: inventory.promptRecords,
    temporalProof: inventory.temporalProof,
  }
}

export async function loadPriorExposureInventory({ verifyDigest = true } = {}) {
  await assertGitIdentity()
  const calculatedRegistryDigest = sha256(canonical(staticPriorExposureRegistry))
  if (verifyDigest && calculatedRegistryDigest !== staticRegistryDigest) {
    throw new Error(`V12 static prior registry digest mismatch: ${calculatedRegistryDigest}`)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v12-prior-'))
  try {
    const archivePath = join(temporaryRoot, 'commit.tar')
    const checkout = join(temporaryRoot, 'checkout')
    await mkdir(checkout)
    await run('git', ['archive', '--format=tar', '--output', archivePath, exactCommit])
    await run('tar', ['-xf', archivePath, '-C', checkout])

    const archivedIsolationUrl = `${pathToFileURL(join(checkout, 'eval/router-corpus/v10/source-isolation.mjs')).href}?commit=${exactCommit}`
    const archivedIsolation = await import(archivedIsolationUrl)
    const priorV1V9 = await archivedIsolation.priorSourceInventory()
    const archivedCorpusRoot = join(checkout, 'eval/router-corpus')
    const completePriorRecords = []
    const completePriorFiles = []
    for (const relativePath of await priorDataPaths(archivedCorpusRoot)) {
      const path = `eval/router-corpus/${relativePath}`
      const bytes = await readFile(join(archivedCorpusRoot, ...relativePath.split('/')))
      completePriorRecords.push(parseData(bytes.toString('utf8'), path))
      completePriorFiles.push({
        path,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        version: versionForDataPath(relativePath),
        role: 'complete-prior-data',
      })
    }
    const completePriorInventory = archivedIsolation.buildSourceInventory(completePriorRecords)
    const artifactRecords = []
    const artifactFiles = []
    let v10Spec
    let v11Spec
    for (const artifact of exposureArtifacts) {
      const bytes = await readFile(join(checkout, ...artifact.path.split('/')))
      const digest = sha256(bytes)
      if (digest !== artifact.sha256) throw new Error(`V12 prior exposure artifact changed: ${artifact.path}`)
      const parsed = parseData(bytes.toString('utf8'), artifact.path)
      artifactRecords.push(parsed)
      artifactFiles.push({ ...artifact, bytes: bytes.byteLength })
      if (artifact.role === 'v10-search-frame') v10Spec = parsed
      if (artifact.role === 'v11-recovery-frame') v11Spec = parsed
    }
    assertTemporalFrame(v10Spec, v11Spec)

    const v10v11PromptRecords = v10Spec.searches.map(search => ({
      id: `v10-search:${search.id}`,
      path: 'eval/router-corpus/v10/source-frame-spec.json',
      text: search.query,
    }))
    const v10v11 = archivedIsolation.buildSourceInventory([
      ...artifactRecords,
      ...v10v11PromptRecords.map(record => ({ id: record.id, text: record.text })),
      { repository: 'shup2399/gg', url: 'https://github.com/shup2399/gg' },
    ])
    v10v11.promptRecords = v10v11PromptRecords

    const explicit = { familyIds: new Set(), objectIds: new Set(), eventIds: new Set() }
    for (const record of completePriorRecords) collectExplicitIds(record, explicit)
    for (const record of artifactRecords) collectExplicitIds(record, explicit)

    const merged = mergeBaseInventories(priorV1V9, completePriorInventory, v10v11)
    const fileMap = new Map(completePriorFiles.map(file => [file.path, file]))
    for (const artifact of artifactFiles) fileMap.set(artifact.path, artifact)
    const inventory = {
      registryDigest: calculatedRegistryDigest,
      exactCommit,
      exactTree,
      cutoff: predecessorCutoff,
      coveredVersions: [...staticPriorExposureRegistry.coveredVersions],
      files: [...fileMap.values()].sort((left, right) => left.path.localeCompare(right.path)),
      ...merged,
      familyIds: sorted(explicit.familyIds),
      objectIds: sorted(explicit.objectIds),
      eventIds: sorted(explicit.eventIds),
      temporalProof: staticPriorExposureRegistry.temporalProof,
    }
    inventory.inventoryDigest = sha256(canonical(serializableInventory(inventory)))
    if (verifyDigest && inventory.inventoryDigest !== staticInventoryDigest) {
      throw new Error(`V12 static prior inventory digest mismatch: ${inventory.inventoryDigest}`)
    }
    return inventory
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

// Top-level resolution happens before a collector can begin parsing any current source body.
export const frozenPriorExposureInventory = await loadPriorExposureInventory()
