#!/usr/bin/env node

import { access, link, mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { archiveMerkleRoot } from './acquire-archives.mjs'
import { consumeArchiveFile, verifyRawArchiveFile } from './archive-stream.mjs'
import { constructorRank, createTimelineBuilder } from './constructors.mjs'
import { filterPriorExposure, removeCurrentNearDuplicates } from './source-isolation.mjs'
import {
  ProtocolFailure,
  assertProtocolFreeze,
  assertRouterFreeze,
  here,
  hourBounds,
  languages,
  loadSpec,
  protocolId,
  sanitizedFailure,
  sha256,
  stableLines,
  writeExclusive,
} from './protocol.mjs'

function failure(failureClass, message, stage, operation, details) {
  return new ProtocolFailure(failureClass, message, { stage, operation, details })
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount)
}

function publicRank(row) {
  return sha256(`v12-public-source-rank\n${row.stableSourceId}`)
}

function metadataIdentity(record) {
  return JSON.stringify({
    compressedBytes: record.compressedBytes,
    compressedSha256: record.compressedSha256,
    headers: record.headers,
    url: record.url,
  })
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateArchiveRecord(record, hour, spec) {
  if (record === null || typeof record !== 'object' || Array.isArray(record) || record.hour !== hour
    || record.url !== `${spec.archive.baseUrl}/${hour}.json.gz`
    || !Number.isSafeInteger(record.compressedBytes) || record.compressedBytes <= 0
    || record.compressedBytes > spec.archive.maximumCompressedBytesPerHour
    || !/^[a-f0-9]{64}$/u.test(record.compressedSha256 ?? '')
    || record.contentAddress !== `${record.compressedSha256}.json.gz`
    || record.independentDownloads !== spec.archive.requiredIndependentDownloads) {
    throw failure('archive-manifest-record-invalid', `${hour} has an invalid archive manifest record`, 'archive-manifest-verification', hour)
  }
  if (record.headers === null || typeof record.headers !== 'object' || Array.isArray(record.headers)) {
    throw failure('archive-manifest-record-invalid', `${hour} has no frozen response metadata`, 'archive-manifest-verification', hour)
  }
  for (const name of spec.archive.requiredHeaders) {
    if (typeof record.headers[name] !== 'string' || record.headers[name].trim() === '') {
      throw failure('archive-metadata-incomplete', `${hour} is missing frozen response header ${name}`, 'archive-manifest-verification', hour)
    }
  }
  if (record.headers['content-length'].trim() !== String(record.compressedBytes)) {
    throw failure('archive-content-length-invalid', `${hour} frozen content-length differs from compressed bytes`, 'archive-manifest-verification', hour)
  }
  if (record.matchingDownloadMetadataSha256 !== sha256(metadataIdentity(record))) {
    throw failure('archive-download-evidence-mismatch', `${hour} matching-download evidence does not bind its metadata`, 'archive-manifest-verification', hour)
  }
  return record
}

export function validateArchiveManifest(manifest, manifestBytes, spec, specBytes, protocolFreeze) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 1 || manifest.protocol !== protocolId
    || manifest.evidenceStatus !== 'frozen-raw-archive-manifest'
    || manifest.bodyAccessed !== false || manifest.selectionBeaconAccessed !== false
    || !sameArray(manifest.protocolFreeze, protocolFreeze)
    || !sameArray(manifest.archiveHours, spec.archive.hours)
    || !Array.isArray(manifest.archives) || manifest.archives.length !== 24
    || manifest.archives.length !== spec.archive.hours.length
    || manifest.digests?.spec !== sha256(specBytes)) {
    throw failure('archive-manifest-invalid', 'raw archive manifest does not match the frozen V12 protocol', 'archive-manifest-verification', 'archive-manifest')
  }
  const records = manifest.archives.map((record, index) => validateArchiveRecord(record, spec.archive.hours[index], spec))
  if (manifest.archiveMerkleRoot !== archiveMerkleRoot(records)) {
    throw failure('archive-merkle-root-mismatch', 'raw archive manifest Merkle root is invalid', 'archive-manifest-verification', 'archive-merkle-root')
  }
  return {
    manifest,
    records,
    manifestSha256: sha256(manifestBytes),
  }
}

async function readArchiveManifest(path, spec, specBytes, protocolFreeze) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw failure('archive-manifest-unavailable', `frozen raw archive manifest is unavailable: ${error?.message ?? String(error)}`, 'archive-manifest-verification', path)
  }
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw failure('archive-manifest-json-invalid', 'frozen raw archive manifest is not valid JSON', 'archive-manifest-verification', path)
  }
  return validateArchiveManifest(manifest, bytes, spec, specBytes, protocolFreeze)
}

function validateArchiveEvent(event, eventIds, hour, lineNumber) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)
    || typeof event.id !== 'string' || event.id.trim() === ''
    || typeof event.type !== 'string' || event.type.trim() === ''
    || typeof event.created_at !== 'string') {
    throw failure('archive-event-invalid', `${hour}:${lineNumber} is not a valid GH Archive event`, 'archive-parse', `${hour}:${lineNumber}`)
  }
  if (eventIds.has(event.id)) {
    throw failure('archive-event-duplicate', `${hour}:${lineNumber} duplicates event ${event.id}`, 'archive-parse', `${hour}:${lineNumber}`)
  }
  const bounds = hourBounds(hour)
  const timestamp = Date.parse(event.created_at)
  if (!Number.isFinite(timestamp) || timestamp < bounds.startMs || timestamp >= bounds.endMs) {
    throw failure('archive-event-outside-hour', `${hour}:${lineNumber} has timestamp outside its archive hour`, 'archive-parse', `${hour}:${lineNumber}`)
  }
  eventIds.add(event.id)
}

async function collectArchiveCandidatesImpl({ spec, specBytes, archiveManifestPath, cacheRoot }) {
  if (typeof cacheRoot !== 'string' || cacheRoot.trim() === '') {
    throw failure('archive-cache-unconfigured', `${spec.archive.archiveCacheEnvironmentVariable} is required`, 'archive-cache-verification', spec.archive.archiveCacheEnvironmentVariable)
  }
  let protocolFreeze
  try {
    protocolFreeze = assertProtocolFreeze(spec)
  } catch (error) {
    throw failure('protocol-freeze-invalid', error?.message ?? String(error), 'protocol-freeze-verification', spec.protocolFreeze.publicRef)
  }
  const frozen = await readArchiveManifest(archiveManifestPath, spec, specBytes, protocolFreeze)
  const paths = frozen.records.map(record => resolve(cacheRoot, record.contentAddress))

  // Verify every frozen object before any decompression or semantic event access begins.
  for (let index = 0; index < frozen.records.length; index += 1) {
    const record = frozen.records[index]
    await verifyRawArchiveFile({
      path: paths[index],
      expectedLength: record.compressedBytes,
      expectedSha256: record.compressedSha256,
      maximumLength: spec.archive.maximumCompressedBytesPerHour,
      hour: record.hour,
    })
  }

  const timeline = createTimelineBuilder(spec)
  const eventIds = new Set()
  const eventTypeCounts = new Map()
  const archiveRecords = []
  const allowedEventTypes = new Set(spec.archive.allowedEventTypes)
  for (let index = 0; index < frozen.records.length; index += 1) {
    const record = frozen.records[index]
    const parsed = await consumeArchiveFile({
      path: paths[index],
      expectedLength: record.compressedBytes,
      expectedSha256: record.compressedSha256,
      maximumLength: spec.archive.maximumCompressedBytesPerHour,
      hour: record.hour,
      async onRecord(event, lineNumber) {
        validateArchiveEvent(event, eventIds, record.hour, lineNumber)
        increment(eventTypeCounts, event.type)
        if (allowedEventTypes.has(event.type)) timeline.observe(event, record.hour)
      },
    })
    archiveRecords.push({
      hour: record.hour,
      compressedBytes: parsed.compressedBytes,
      compressedSha256: parsed.compressedSha256,
      recordCount: parsed.recordCount,
      headers: record.headers,
      contentAddress: record.contentAddress,
    })
  }
  return {
    candidates: timeline.finish(),
    archives: archiveRecords,
    archiveManifestSha256: frozen.manifestSha256,
    archiveMerkleRoot: frozen.manifest.archiveMerkleRoot,
    protocolFreeze,
    totalEvents: eventIds.size,
    eventTypeCounts,
  }
}

export async function collectArchiveCandidates(options) {
  try {
    return await collectArchiveCandidatesImpl(options)
  } catch (error) {
    if (error instanceof ProtocolFailure) throw error
    throw failure('unexpected-offline-collection-error', error?.message ?? String(error), 'offline-source-collection', 'collect-archive-candidates')
  }
}

function chooseFamilyRepresentatives(rows, spec) {
  const byFamily = new Map()
  for (const row of rows) {
    const current = byFamily.get(row.sourceFamilyId)
    if (current === undefined
      || constructorRank(row.constructor, spec) < constructorRank(current.constructor, spec)
      || constructorRank(row.constructor, spec) === constructorRank(current.constructor, spec)
        && row.stableSourceId.localeCompare(current.stableSourceId) < 0) {
      byFamily.set(row.sourceFamilyId, row)
    }
  }
  return [...byFamily.values()]
}

export function selectSourceFrame(rows, spec) {
  const constructorCaps = new Map()
  const repositoryCaps = new Map()
  const selected = []
  const rejected = []
  const ordered = [...rows].sort((left, right) => publicRank(left).localeCompare(publicRank(right)) || left.stableSourceId.localeCompare(right.stableSourceId))
  for (const row of ordered) {
    const constructorKey = `${row.language}/${row.constructor}`
    const repositoryKey = `${constructorKey}/${row.repository.toLowerCase()}`
    if ((constructorCaps.get(constructorKey) ?? 0) >= spec.limits.maximumCandidatesPerLanguageConstructor) {
      rejected.push({ stableSourceId: row.stableSourceId, reason: 'constructor-cap' })
      continue
    }
    if ((repositoryCaps.get(repositoryKey) ?? 0) >= spec.limits.maximumPerRepositoryPerConstructor) {
      rejected.push({ stableSourceId: row.stableSourceId, reason: 'repository-constructor-cap' })
      continue
    }
    selected.push(row)
    increment(constructorCaps, constructorKey)
    increment(repositoryCaps, repositoryKey)
  }
  for (const language of languages) {
    const languageRows = selected.filter(row => row.language === language)
    if (languageRows.length < spec.limits.minimumCandidatesPerLanguage) {
      throw failure('source-capacity-insufficient', `${language} has ${languageRows.length} candidates; requires ${spec.limits.minimumCandidatesPerLanguage}`, 'source-capacity', language)
    }
    const repositories = new Set(languageRows.map(row => row.repository.toLowerCase()))
    if (repositories.size < spec.limits.minimumRepositoriesPerLanguage) {
      throw failure('source-diversity-insufficient', `${language} has ${repositories.size} repositories; requires ${spec.limits.minimumRepositoriesPerLanguage}`, 'source-capacity', language)
    }
  }
  return { selected, rejected }
}

function artifactPaths(outputDirectory) {
  return {
    frame: resolve(outputDirectory, 'source-frame.jsonl'),
    manifest: resolve(outputDirectory, 'source-frame.manifest.json'),
    rejections: resolve(outputDirectory, 'source-frame.rejections.json'),
    failure: resolve(outputDirectory, 'source-frame.failure.json'),
  }
}

async function assertAbsent(paths) {
  for (const path of Object.values(paths)) {
    try {
      await access(path)
      throw failure('output-reuse', `V12 output already exists: ${path}`, 'preflight', path)
    } catch (error) {
      if (error instanceof ProtocolFailure) throw error
      if (error?.code !== 'ENOENT') throw failure('output-preflight-failed', `V12 output path cannot be checked: ${path}`, 'preflight', path)
    }
  }
}

async function publishSourceArtifacts(paths, artifacts, outputDirectory) {
  const stagingDirectory = await mkdtemp(resolve(outputDirectory, '.v12-source-frame-staging-'))
  const staged = {
    frame: resolve(stagingDirectory, 'source-frame.jsonl'),
    rejections: resolve(stagingDirectory, 'source-frame.rejections.json'),
    manifest: resolve(stagingDirectory, 'source-frame.manifest.json'),
  }
  const published = []
  try {
    await writeExclusive(staged.frame, artifacts.frame)
    await writeExclusive(staged.rejections, artifacts.rejections)
    await writeExclusive(staged.manifest, artifacts.manifest)
    for (const name of ['frame', 'rejections', 'manifest']) {
      try {
        await link(staged[name], paths[name])
      } catch (error) {
        if (error?.code === 'EEXIST') throw failure('output-reuse', `immutable V12 output already exists: ${paths[name]}`, 'artifact-write', paths[name])
        throw failure('artifact-publish-failed', `V12 output could not be published: ${paths[name]}`, 'artifact-write', paths[name])
      }
      published.push(paths[name])
    }
  } catch (error) {
    for (const path of published.reverse()) await unlink(path).catch(() => {})
    throw error
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

async function collectSourceFrameImpl({ outputDirectory, archiveManifestPath, cacheRoot }) {
  await mkdir(outputDirectory, { recursive: true })
  const paths = artifactPaths(outputDirectory)
  await assertAbsent(paths)
  const { spec, bytes: specBytes } = await loadSpec()
  let protocolFreeze
  try {
    protocolFreeze = assertProtocolFreeze(spec)
  } catch (error) {
    throw failure('protocol-freeze-invalid', error?.message ?? String(error), 'protocol-freeze-verification', spec.protocolFreeze.publicRef)
  }
  const routerSourceDigest = await assertRouterFreeze(spec)
  const archive = await collectArchiveCandidates({ spec, specBytes, archiveManifestPath, cacheRoot })
  if (!sameArray(archive.protocolFreeze, protocolFreeze)) {
    throw failure('protocol-freeze-changed', 'public protocol freeze changed during offline collection', 'protocol-freeze-verification', spec.protocolFreeze.publicRef)
  }
  const representatives = chooseFamilyRepresentatives(archive.candidates, spec)
  const prior = await filterPriorExposure(representatives)
  const current = removeCurrentNearDuplicates(prior.accepted.sort((left, right) => publicRank(left).localeCompare(publicRank(right))))
  const source = selectSourceFrame(current.accepted, spec)
  const selected = source.selected.sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId))
  const frameText = stableLines(selected)
  const rejectionRows = [...prior.rejected, ...current.rejected, ...source.rejected].sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId))
  const rejectionText = `${JSON.stringify({
    schemaVersion: 1,
    protocol: protocolId,
    counts: Object.fromEntries([...new Set(rejectionRows.map(row => row.reason))].sort().map(reason => [reason, rejectionRows.filter(row => row.reason === reason).length])),
    rows: rejectionRows,
  }, null, 2)}\n`
  const manifest = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'immutable-post-cutoff-source-frame',
    selectionBeaconAccessed: false,
    protocolFreeze,
    routerCommit: spec.routerFreeze.commit,
    routerSourceDigest,
    predecessorCutoff: spec.predecessor.cutoff,
    archiveManifestSha256: archive.archiveManifestSha256,
    archiveMerkleRoot: archive.archiveMerkleRoot,
    archives: archive.archives,
    archiveHours: spec.archive.hours,
    totalEvents: archive.totalEvents,
    eventTypeCounts: Object.fromEntries([...archive.eventTypeCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    rawCandidateCount: archive.candidates.length,
    familyRepresentativeCount: representatives.length,
    selectedCount: selected.length,
    selectedByLanguageConstructor: Object.fromEntries(languages.flatMap(language => spec.constructors.precedence.map(constructor => [
      `${language}/${constructor}`,
      selected.filter(row => row.language === language && row.constructor === constructor).length,
    ]))),
    distinctRepositories: Object.fromEntries(languages.map(language => [language, new Set(selected.filter(row => row.language === language).map(row => row.repository.toLowerCase())).size])),
    digests: {
      spec: sha256(specBytes),
      frame: sha256(frameText),
      rejections: sha256(rejectionText),
      priorInventory: prior.inventoryDigest,
      collector: sha256(await readFile(fileURLToPath(import.meta.url))),
      archiveStream: sha256(await readFile(resolve(here, 'archive-stream.mjs'))),
      constructors: sha256(await readFile(resolve(here, 'constructors.mjs'))),
    },
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  await publishSourceArtifacts(paths, { frame: frameText, rejections: rejectionText, manifest: manifestText }, outputDirectory)
  return { frame: selected, manifest, rejections: rejectionRows }
}

export async function collectSourceFrame({
  outputDirectory = here,
  archiveManifestPath = resolve(here, 'archive-manifest.json'),
  cacheRoot,
} = {}) {
  try {
    const resolvedCacheRoot = cacheRoot ?? process.env.PLAN_LATTICE_V12_ARCHIVE_CACHE
    return await collectSourceFrameImpl({ outputDirectory, archiveManifestPath, cacheRoot: resolvedCacheRoot })
  } catch (error) {
    if (error instanceof ProtocolFailure) throw error
    throw failure('unexpected-source-collection-error', error?.message ?? String(error), 'source-collection', 'collect-source-frame')
  }
}

async function main() {
  const paths = artifactPaths(here)
  try {
    const result = await collectSourceFrame()
    console.log(JSON.stringify({ selected: result.frame.length, byConstructor: result.manifest.selectedByLanguageConstructor }, null, 2))
  } catch (error) {
    const failureArtifact = sanitizedFailure(error, {
      stage: error?.stage ?? 'source-collection',
      bindings: {
        specSha256: sha256((await loadSpec()).bytes),
        collectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      },
    })
    try {
      await writeExclusive(paths.failure, `${JSON.stringify(failureArtifact, null, 2)}\n`)
    } catch (writeError) {
      if (writeError?.failureClass !== 'output-reuse') throw writeError
    }
    console.error(JSON.stringify(failureArtifact, null, 2))
    process.exitCode = 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
