#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { access, link, mkdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { downloadRawArchive, verifyRawArchiveFile } from './archive-stream.mjs'
import { ProtocolFailure, assertProtocolFreeze, here, loadSpec, protocolId, sanitizedFailure, sha256, writeExclusive } from './protocol.mjs'

function failure(failureClass, message, stage, operation, details) {
  return new ProtocolFailure(failureClass, message, { stage, operation, details })
}

function metadataIdentity(record) {
  return JSON.stringify({
    compressedBytes: record.compressedBytes,
    compressedSha256: record.compressedSha256,
    headers: record.headers,
    url: record.url,
  })
}

async function assertAbsent(path) {
  try {
    await access(path)
    throw failure('output-reuse', `V12 archive manifest already exists: ${path}`, 'archive-acquisition', path)
  } catch (error) {
    if (error instanceof ProtocolFailure) throw error
    if (error?.code !== 'ENOENT') {
      throw failure('archive-manifest-preflight-failed', `V12 archive manifest path cannot be checked: ${path}`, 'archive-acquisition', path)
    }
  }
}

async function safeUnlink(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function retainContentAddressed({ temporaryPath, contentPath, record, spec }) {
  try {
    await link(temporaryPath, contentPath)
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw failure('archive-cache-publish-failed', `${record.hour} could not be retained content-addressed`, 'archive-acquisition', record.hour)
    }
    await verifyRawArchiveFile({
      path: contentPath,
      expectedLength: record.compressedBytes,
      expectedSha256: record.compressedSha256,
      maximumLength: spec.archive.maximumCompressedBytesPerHour,
      hour: record.hour,
    })
  }
  await safeUnlink(temporaryPath)
}

async function publishManifest(outputPath, body) {
  const temporaryPath = `${outputPath}.${randomUUID()}.partial`
  try {
    await writeExclusive(temporaryPath, body)
    try {
      await link(temporaryPath, outputPath)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw failure('output-reuse', `V12 archive manifest already exists: ${outputPath}`, 'archive-acquisition', outputPath)
      }
      throw failure('archive-manifest-publish-failed', `V12 archive manifest could not be published: ${outputPath}`, 'archive-acquisition', outputPath)
    }
  } finally {
    await safeUnlink(temporaryPath)
  }
}

export function archiveMerkleRoot(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw failure('archive-manifest-records-invalid', 'archive Merkle tree requires at least one record', 'archive-acquisition', 'archive-merkle-root')
  }
  let level = records.map(record => sha256(`${record.hour}\0${record.compressedSha256}\0${record.compressedBytes}`))
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level.at(-1))
    const next = []
    for (let index = 0; index < level.length; index += 2) next.push(sha256(`${level[index]}${level[index + 1]}`))
    level = next
  }
  return level[0]
}

async function acquireArchivesImpl({ cacheRoot, outputPath, fetchImpl, now }) {
  const { spec, bytes: specBytes } = await loadSpec()
  const protocolFreeze = assertProtocolFreeze(spec)
  if (now < Date.parse(spec.archive.prospectiveWindowEnd) + 15 * 60 * 1000) {
    throw failure('archive-window-not-mature', 'V12 archive window has not matured plus the frozen 15-minute delay', 'archive-acquisition', 'maturity-check')
  }
  if (typeof cacheRoot !== 'string' || cacheRoot.trim() === '') {
    throw failure('archive-cache-unconfigured', `${spec.archive.archiveCacheEnvironmentVariable} is required`, 'archive-acquisition', spec.archive.archiveCacheEnvironmentVariable)
  }
  await assertAbsent(outputPath)
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const records = []
  for (const hour of spec.archive.hours) {
    const nonce = randomUUID()
    const firstPath = resolve(cacheRoot, `.v12-${hour}-${nonce}-first.partial`)
    const secondPath = resolve(cacheRoot, `.v12-${hour}-${nonce}-second.partial`)
    try {
      const first = await downloadRawArchive({ hour, spec, destination: firstPath, fetchImpl })
      const second = await downloadRawArchive({ hour, spec, destination: secondPath, fetchImpl })
      if (metadataIdentity(first) !== metadataIdentity(second)) {
        throw failure('archive-independent-download-mismatch', `${hour} independent downloads disagree`, 'archive-acquisition', hour, {
          firstMetadataSha256: sha256(metadataIdentity(first)),
          secondMetadataSha256: sha256(metadataIdentity(second)),
        })
      }
      const contentAddress = `${first.compressedSha256}.json.gz`
      await retainContentAddressed({
        temporaryPath: firstPath,
        contentPath: resolve(cacheRoot, contentAddress),
        record: first,
        spec,
      })
      await safeUnlink(secondPath)
      records.push({
        ...first,
        contentAddress,
        independentDownloads: spec.archive.requiredIndependentDownloads,
        matchingDownloadMetadataSha256: sha256(metadataIdentity(first)),
      })
    } finally {
      await safeUnlink(firstPath)
      await safeUnlink(secondPath)
    }
  }
  if (records.length !== 24 || records.length !== spec.archive.hours.length) {
    throw failure('archive-hour-coverage-invalid', 'V12 acquisition did not retain all 24 frozen hours', 'archive-acquisition', 'hour-coverage')
  }
  const manifest = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'frozen-raw-archive-manifest',
    bodyAccessed: false,
    selectionBeaconAccessed: false,
    protocolFreeze,
    archiveHours: spec.archive.hours,
    archives: records,
    archiveMerkleRoot: archiveMerkleRoot(records),
    digests: { spec: sha256(specBytes) },
  }
  await publishManifest(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function acquireArchives({
  cacheRoot,
  outputPath = resolve(here, 'archive-manifest.json'),
  fetchImpl = globalThis.fetch,
  now = Date.now(),
}) {
  try {
    return await acquireArchivesImpl({ cacheRoot, outputPath, fetchImpl, now })
  } catch (error) {
    if (error instanceof ProtocolFailure) throw error
    throw failure('unexpected-archive-acquisition-error', error?.message ?? String(error), 'archive-acquisition', 'acquire-archives')
  }
}

async function main() {
  try {
    const { spec } = await loadSpec()
    const manifest = await acquireArchives({
      cacheRoot: process.env[spec.archive.archiveCacheEnvironmentVariable],
      outputPath: resolve(here, 'archive-manifest.json'),
    })
    console.log(JSON.stringify({ archives: manifest.archives.length, archiveMerkleRoot: manifest.archiveMerkleRoot }, null, 2))
  } catch (error) {
    console.error(JSON.stringify(sanitizedFailure(error, { stage: 'raw-archive-acquisition' }), null, 2))
    process.exitCode = 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
