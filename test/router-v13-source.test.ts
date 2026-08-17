import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../eval/router-corpus/v13/protocol.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../eval/router-corpus/v13/protocol.mjs')>()
  return {
    ...actual,
    assertProtocolFreeze: vi.fn(() => ({
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      ref: 'refs/tags/router-v13-protocol-freeze-v2',
    })),
  }
})

import { acquireArchives, archiveMerkleRoot } from '../eval/router-corpus/v13/acquire-archives.mjs'
import { consumeGzipJsonLines } from '../eval/router-corpus/v13/archive-stream.mjs'
import { collectArchiveCandidates } from '../eval/router-corpus/v13/collect-source-frame.mjs'
import { loadSpec, protocolId, sha256 } from '../eval/router-corpus/v13/protocol.mjs'

const temporaryRoots: string[] = []
const protocolFreezeEvidence = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  ref: 'refs/tags/router-v13-protocol-freeze-v2',
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryRoot() {
  const path = await mkdtemp(join(tmpdir(), 'plan-lattice-v13-source-'))
  temporaryRoots.push(path)
  return path
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function metadataIdentity(record: Record<string, unknown>) {
  return JSON.stringify({
    compressedBytes: record.compressedBytes,
    compressedSha256: record.compressedSha256,
    headers: record.headers,
    url: record.url,
  })
}

function timestamp(hour: string, minute = 10) {
  const value = Number(hour.split('-').at(-1))
  return `2026-08-17T${String(value).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`
}

function event(hour: string, type: string, id: string, repository: string, payload: unknown, minute = 10) {
  return {
    id,
    type,
    created_at: timestamp(hour, minute),
    actor: { login: `actor-${id}`, type: 'User' },
    repo: { name: repository },
    payload,
  }
}

function issueObject(number: number, repository: string, createdAt: string) {
  return {
    number,
    title: `Choose durable export behavior for workflow ${number}`,
    body: 'Implement the existing report workflow while preserving saved output, documented callers, and deterministic behavior across every supported invocation path.',
    created_at: createdAt,
    html_url: `https://github.com/${repository}/issues/${number}`,
    node_id: `I_SYNTHETIC_${number}`,
    user: { login: `author-${number}`, type: 'User' },
  }
}

function pullObject(number: number, repository: string, createdAt: string, headSha: string, headRepository: string) {
  return {
    ...issueObject(number, repository, createdAt),
    html_url: `https://github.com/${repository}/pull/${number}`,
    node_id: `PR_SYNTHETIC_${number}`,
    head: { sha: headSha, ref: `feature-${number}`, repo: { full_name: headRepository } },
  }
}

async function writeArchiveSet({
  root,
  spec,
  specBytes,
  eventsByHour,
  rawLineByHour = new Map<string, string>(),
}: {
  root: string
  spec: Awaited<ReturnType<typeof loadSpec>>['spec']
  specBytes: Buffer
  eventsByHour: Map<string, unknown[]>
  rawLineByHour?: Map<string, string>
}) {
  const cacheRoot = join(root, 'cache')
  await mkdir(cacheRoot, { recursive: true })
  const records = []
  for (const [index, hour] of spec.archive.hours.entries()) {
    const fallback = event(hour, 'WatchEvent', `fallback-${index}`, `synthetic/default-${index}`, {}, 5)
    const text = rawLineByHour.get(hour) ?? `${(eventsByHour.get(hour) ?? [fallback]).map(value => JSON.stringify(value)).join('\n')}\n`
    const compressed = gzipSync(text)
    const compressedSha256 = digest(compressed)
    const headers = {
      'content-length': String(compressed.length),
      etag: `"synthetic-${index}"`,
      'last-modified': 'Mon, 17 Aug 2026 00:00:00 GMT',
      'x-goog-generation': String(2_000_000 + index),
      'x-goog-hash': `md5=synthetic-${index}`,
    }
    const record: Record<string, unknown> = {
      hour,
      url: `${spec.archive.baseUrl}/${hour}.json.gz`,
      headers,
      compressedBytes: compressed.length,
      compressedSha256,
      contentAddress: `${compressedSha256}.json.gz`,
      independentDownloads: 2,
    }
    record.matchingDownloadMetadataSha256 = sha256(metadataIdentity(record))
    records.push(record)
    await writeFile(join(cacheRoot, record.contentAddress as string), compressed)
  }
  const manifest = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'frozen-raw-archive-manifest',
    bodyAccessed: false,
    selectionBeaconAccessed: false,
    protocolFreeze: protocolFreezeEvidence,
    archiveHours: spec.archive.hours,
    archives: records,
    archiveMerkleRoot: archiveMerkleRoot(records),
    digests: { spec: sha256(specBytes) },
  }
  const manifestPath = join(root, 'archive-manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { cacheRoot, manifestPath, manifest, records }
}

describe('V13 raw archive acquisition', () => {
  it('downloads all 24 objects twice with identity encoding and publishes only a frozen raw manifest', async () => {
    const root = await temporaryRoot()
    const cacheRoot = join(root, 'cache')
    const outputPath = join(root, 'archive-manifest.json')
    const { spec } = await loadSpec()
    const compressedByHour = new Map(spec.archive.hours.map((hour, index) => [hour, gzipSync(`{"synthetic":${index}}\n`)]))
    const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
      const hour = url.split('/').at(-1)!.replace(/\.json\.gz$/u, '')
      const compressed = compressedByHour.get(hour)!
      const headers = {
        'content-length': String(compressed.length),
        etag: `"${hour}"`,
        'last-modified': 'Mon, 17 Aug 2026 00:00:00 GMT',
        'x-goog-generation': `generation-${hour}`,
        'x-goog-hash': `md5=${hour}`,
      }
      expect(options).toMatchObject({ redirect: 'error', headers: { accept: 'application/gzip', 'accept-encoding': 'identity' } })
      return new Response(compressed, { status: 200, headers })
    })

    const manifest = await acquireArchives({
      cacheRoot,
      outputPath,
      fetchImpl,
      now: Date.parse('2026-08-18T00:15:00Z'),
    })

    expect(fetchImpl).toHaveBeenCalledTimes(48)
    expect(manifest).toMatchObject({
      protocol: 'observable-authorization-v13',
      evidenceStatus: 'frozen-raw-archive-manifest',
      bodyAccessed: false,
      selectionBeaconAccessed: false,
      protocolFreeze: protocolFreezeEvidence,
    })
    expect(manifest.archives).toHaveLength(24)
    expect(await readdir(root)).toEqual(['archive-manifest.json', 'cache'])
    expect((await readdir(cacheRoot)).filter(name => name.endsWith('.partial'))).toEqual([])
    expect(await readdir(cacheRoot)).toHaveLength(24)
    for (const record of manifest.archives) {
      const bytes = await readFile(join(cacheRoot, record.contentAddress))
      expect(bytes).toEqual(compressedByHour.get(record.hour))
      expect(record.independentDownloads).toBe(2)
      expect(record.matchingDownloadMetadataSha256).toBe(sha256(metadataIdentity(record)))
    }
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(manifest)
  })

  it('rejects disagreeing independent metadata without publishing a manifest or partial file', async () => {
    const root = await temporaryRoot()
    const cacheRoot = join(root, 'cache')
    const outputPath = join(root, 'archive-manifest.json')
    const compressed = gzipSync('{"synthetic":true}\n')
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      return new Response(compressed, {
        status: 200,
        headers: {
          'content-length': String(compressed.length),
          etag: call === 1 ? '"first"' : '"second"',
          'last-modified': 'Mon, 17 Aug 2026 00:00:00 GMT',
          'x-goog-generation': 'generation',
          'x-goog-hash': 'md5=synthetic',
        },
      })
    })

    await expect(acquireArchives({
      cacheRoot,
      outputPath,
      fetchImpl,
      now: Date.parse('2026-08-18T00:15:00Z'),
    })).rejects.toMatchObject({ name: 'ProtocolFailure', failureClass: 'archive-independent-download-mismatch' })
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(cacheRoot)).filter(name => name.includes('.partial'))).toEqual([])
  })
})

describe('V13 offline source collection', () => {
  it('uses one 24-hour timeline for unanswered decisions and complete review-to-push continuity', async () => {
    const root = await temporaryRoot()
    const { spec, bytes: specBytes } = await loadSpec()
    const hours = spec.archive.hours
    const baseRepository = 'synthetic/base'
    const headRepository = 'synthetic/head'
    const oldHead = '1'.repeat(40)
    const newHead = '2'.repeat(40)
    const incompleteOldHead = '3'.repeat(40)
    const incompleteNewHead = '4'.repeat(40)
    const issueOne = issueObject(1, baseRepository, timestamp(hours[0], 2))
    const issueTwo = issueObject(2, baseRepository, timestamp(hours[0], 3))
    const followupIssue = issueObject(3, baseRepository, timestamp(hours[12], 2))
    const pullFour = pullObject(4, baseRepository, timestamp(hours[2], 2), oldHead, headRepository)
    const pullFive = pullObject(5, baseRepository, timestamp(hours[2], 3), incompleteOldHead, headRepository)
    const questionBody = 'Should the implementation preserve the existing JSON export, or should it replace JSON with a separate CSV-only option for every caller?'
    const reviewBody = '- First preserve the existing parser fallback, otherwise cached requests become stale and fail.\n- Then update the route after compatibility checks pass.'
    const commitMessage = 'Update the parser fallback after requested review and preserve compatibility for every existing caller'
    const eventsByHour = new Map<string, unknown[]>([
      [hours[0], [
        event(hours[0], 'IssuesEvent', 'open-1', baseRepository, { action: 'opened', issue: issueOne }, 2),
        event(hours[0], 'IssuesEvent', 'open-2', baseRepository, { action: 'opened', issue: issueTwo }, 3),
      ]],
      [hours[1], [
        event(hours[1], 'IssueCommentEvent', 'question-1', baseRepository, {
          action: 'created', issue: issueOne,
          comment: { body: questionBody, author_association: 'MEMBER', user: { login: 'maintainer-1', type: 'User' } },
        }, 2),
        event(hours[1], 'IssueCommentEvent', 'question-2', baseRepository, {
          action: 'created', issue: issueTwo,
          comment: { body: questionBody, author_association: 'OWNER', user: { login: 'maintainer-2', type: 'User' } },
        }, 3),
      ]],
      [hours[2], [
        event(hours[2], 'PullRequestEvent', 'open-4', baseRepository, { action: 'opened', pull_request: pullFour }, 2),
        event(hours[2], 'PullRequestEvent', 'open-5', baseRepository, { action: 'opened', pull_request: pullFive }, 3),
      ]],
      [hours[3], [
        event(hours[3], 'PullRequestReviewEvent', 'review-4', baseRepository, {
          action: 'created', pull_request: pullFour,
          review: { state: 'changes_requested', body: reviewBody, author_association: 'OWNER', user: { login: 'reviewer-4', type: 'User' }, commit_id: oldHead },
        }, 2),
        event(hours[3], 'PullRequestReviewEvent', 'review-5', baseRepository, {
          action: 'created', pull_request: pullFive,
          review: { state: 'changes_requested', body: reviewBody, author_association: 'MEMBER', user: { login: 'reviewer-5', type: 'User' }, commit_id: incompleteOldHead },
        }, 3),
      ]],
      [hours[12], [event(hours[12], 'IssuesEvent', 'late-open-3', baseRepository, { action: 'opened', issue: followupIssue }, 2)]],
      [hours[13], [
        event(hours[13], 'PushEvent', 'push-4', headRepository, {
          size: 1, before: oldHead, head: newHead, ref: 'refs/heads/feature-4', commits: [{ sha: newHead, message: commitMessage }],
        }, 2),
        event(hours[13], 'PushEvent', 'push-5', headRepository, {
          size: 2, before: incompleteOldHead, head: incompleteNewHead, ref: 'refs/heads/feature-5', commits: [{ sha: incompleteNewHead, message: commitMessage }],
        }, 3),
      ]],
      [hours[14], [
        event(hours[14], 'PullRequestEvent', 'sync-4', baseRepository, {
          action: 'synchronize', pull_request: { ...pullFour, head: { sha: newHead, ref: 'feature-4', repo: { full_name: headRepository } } },
        }, 2),
        event(hours[14], 'PullRequestEvent', 'sync-5', baseRepository, {
          action: 'synchronize', pull_request: { ...pullFive, head: { sha: incompleteNewHead, ref: 'feature-5', repo: { full_name: headRepository } } },
        }, 3),
      ]],
      [hours[23], [event(hours[23], 'IssueCommentEvent', 'answer-2', baseRepository, {
        action: 'created', issue: issueTwo,
        comment: { body: 'Keep both formats as separate options.', author_association: 'NONE', user: { login: 'author-2', type: 'User' } },
      }, 50)]],
    ])
    const frozen = await writeArchiveSet({ root, spec, specBytes, eventsByHour })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access is forbidden'))

    const result = await collectArchiveCandidates({
      spec,
      specBytes,
      archiveManifestPath: frozen.manifestPath,
      cacheRoot: frozen.cacheRoot,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.archives).toHaveLength(24)
    expect(result.candidates.filter(row => row.constructor === 'decision')).toHaveLength(1)
    expect(result.candidates.find(row => row.constructor === 'decision')?.sourceFamilyId).toBe('github:synthetic/base:issue:1')
    expect(result.candidates.filter(row => row.constructor === 'continuity')).toHaveLength(1)
    expect(result.candidates.find(row => row.constructor === 'continuity')).toMatchObject({
      sourceFamilyId: 'github:synthetic/base:pull:4',
      eventIds: ['open-4', 'review-4', 'sync-4', 'push-4'],
    })
    expect(result.candidates.some(row => row.sourceFamilyId.endsWith(':issue:3'))).toBe(false)
    expect(result.candidates.some(row => row.sourceFamilyId.endsWith(':pull:5') && row.constructor === 'continuity')).toBe(false)
  })

  it('verifies all 24 cached objects before decompressing the first archive', async () => {
    const root = await temporaryRoot()
    const { spec, bytes: specBytes } = await loadSpec()
    const rawLineByHour = new Map([[spec.archive.hours[0], 'not-json\n']])
    const frozen = await writeArchiveSet({ root, spec, specBytes, eventsByHour: new Map(), rawLineByHour })
    const finalRecord = frozen.records.at(-1)!
    const finalPath = join(frozen.cacheRoot, finalRecord.contentAddress as string)
    const tampered = await readFile(finalPath)
    tampered[Math.floor(tampered.length / 2)] ^= 0xff
    await writeFile(finalPath, tampered)

    await expect(collectArchiveCandidates({
      spec,
      specBytes,
      archiveManifestPath: frozen.manifestPath,
      cacheRoot: frozen.cacheRoot,
    })).rejects.toMatchObject({ name: 'ProtocolFailure', failureClass: 'archive-cache-digest-mismatch' })
  })

  it('rejects invalid UTF-8 and events outside their declared archive hour as ProtocolFailure', async () => {
    const invalidUtf8 = gzipSync(Buffer.from([0xff, 0x0a]))
    await expect(consumeGzipJsonLines({
      stream: Readable.from(invalidUtf8),
      expectedLength: invalidUtf8.length,
      expectedSha256: digest(invalidUtf8),
      maximumLength: invalidUtf8.length,
      hour: 'synthetic-hour',
      onRecord() {},
    })).rejects.toMatchObject({ name: 'ProtocolFailure', failureClass: 'archive-utf8-invalid' })

    const root = await temporaryRoot()
    const { spec, bytes: specBytes } = await loadSpec()
    const firstHour = spec.archive.hours[0]
    const outside = event(firstHour, 'WatchEvent', 'outside-hour', 'synthetic/outside', {}, 2)
    outside.created_at = timestamp(spec.archive.hours[1], 2)
    const frozen = await writeArchiveSet({ root, spec, specBytes, eventsByHour: new Map([[firstHour, [outside]]]) })
    await expect(collectArchiveCandidates({
      spec,
      specBytes,
      archiveManifestPath: frozen.manifestPath,
      cacheRoot: frozen.cacheRoot,
    })).rejects.toMatchObject({ name: 'ProtocolFailure', failureClass: 'archive-event-outside-hour' })
  })
})
