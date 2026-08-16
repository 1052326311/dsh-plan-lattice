import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { consumeGzipJsonLines, downloadRawArchive } from '../eval/router-corpus/v13/archive-stream.mjs'
import { selectSourceFrame } from '../eval/router-corpus/v13/collect-source-frame.mjs'
import { createTimelineBuilder } from '../eval/router-corpus/v13/constructors.mjs'
import { assertRouterFreeze, loadSpec } from '../eval/router-corpus/v13/protocol.mjs'
import { scoreRouterRows } from '../eval/router-corpus/v13/statistics.mjs'

function eventBase(type: string, id: string, createdAt = '2026-08-17T00:15:00Z') {
  return {
    id,
    type,
    created_at: createdAt,
    actor: { login: 'reporter', type: 'User' },
    repo: { name: `fresh-org/repository-${id}` },
  }
}

function issue(number: number, title: string, body: string) {
  return {
    number,
    title,
    body,
    created_at: '2026-08-17T00:10:00Z',
    html_url: `https://github.com/fresh-org/repository-${number}/issues/${number}`,
    node_id: `I_${number}`,
    user: { login: `reporter-${number}`, type: 'User' },
  }
}

describe('V13 prospective source protocol', () => {
  it('binds the complete future archive window and exact published router source', async () => {
    const { spec } = await loadSpec()
    expect(spec.archive.hours).toEqual(Array.from({ length: 24 }, (_, hour) => `2026-08-17-${hour}`))
    expect(spec.archive.formationHours).toEqual(spec.archive.hours.slice(0, 12))
    expect(spec.archive.followupHours).toEqual(spec.archive.hours.slice(12))
    expect(spec.routerFreeze.commit).toBe('b5971547af8c733312d2efce888cdf2573cc379d')
    await expect(assertRouterFreeze(spec)).resolves.toBe(spec.routerFreeze.sourceDigest)
  })

  it('binds raw download metadata and exact compressed bytes before parsing', async () => {
    const { spec } = await loadSpec()
    const event = eventBase('IssuesEvent', '1')
    const compressed = gzipSync(`${JSON.stringify(event)}\n`)
    const digest = createHash('sha256').update(compressed).digest('hex')
    const headers = {
      'content-length': String(compressed.length),
      etag: '"immutable-etag"',
      'last-modified': 'Mon, 17 Aug 2026 01:05:00 GMT',
      'x-goog-generation': '1786928700000000',
      'x-goog-hash': 'md5=frozen',
    }
    const fetchImpl = vi.fn(async () => new Response(compressed, { status: 200, headers }))
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v13-archive-test-'))
    try {
      const destination = join(root, 'hour.json.gz')
      const downloaded = await downloadRawArchive({
        hour: '2026-08-17-0', spec, destination, fetchImpl,
      })
      expect(downloaded).toMatchObject({
        compressedBytes: compressed.length,
        compressedSha256: digest,
        headers,
      })
      expect(await readFile(destination)).toEqual(compressed)

      const observed: unknown[] = []
      await expect(consumeGzipJsonLines({
        stream: Readable.from(compressed),
        expectedLength: compressed.length,
        expectedSha256: digest,
        maximumLength: compressed.length,
        hour: '2026-08-17-0',
        onRecord(value) { observed.push(value) },
      })).resolves.toMatchObject({ recordCount: 1, compressedSha256: digest })
      expect(observed).toEqual([event])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('constructs labels from a complete event timeline without assigning routes', async () => {
    const { spec } = await loadSpec()
    const rootIssue = issue(10, 'Bug: parser returns duplicate values', [
      'Steps to reproduce: call parse twice with the same exact input.',
      'Expected behavior: one normalized value is returned.',
      'Actual behavior: the second value is duplicated and breaks the caller.',
    ].join('\n\n'))
    const timeline = createTimelineBuilder(spec)
    timeline.observe({
      ...eventBase('IssuesEvent', '10'),
      payload: { action: 'opened', issue: rootIssue },
    }, '2026-08-17-0')
    timeline.observe({
      ...eventBase('IssueCommentEvent', '11', '2026-08-17T12:15:00Z'),
      repo: { name: 'fresh-org/repository-10' },
      payload: {
        action: 'created',
        issue: rootIssue,
        comment: {
          body: 'Should the parser preserve the existing duplicate form, or should it always normalize to one value?',
          author_association: 'MEMBER',
          user: { login: 'maintainer', type: 'User' },
        },
      },
    }, '2026-08-17-12')

    const rows = timeline.finish()
    expect(rows.find(row => row.constructor === 'bounded')).toBeDefined()
    expect(rows.find(row => row.constructor === 'decision')).toBeDefined()
    expect(rows.every(row => !Object.hasOwn(row, 'route'))).toBe(true)
  })

  it('fails closed when either language lacks the frozen source capacity', async () => {
    const { spec } = await loadSpec()
    const local = structuredClone(spec)
    local.limits.minimumCandidatesPerLanguage = 2
    local.limits.minimumRepositoriesPerLanguage = 2
    local.limits.maximumCandidatesPerLanguageConstructor = 4
    const rows = ['en', 'zh'].flatMap(language => [1, 2].map(index => ({
      stableSourceId: `${language}-${index}`,
      sourceFamilyId: `${language}-family-${index}`,
      language,
      constructor: 'natural',
      repository: `${language}-org/repo-${index}`,
      text: `${language} source ${index}`,
    })))
    expect(selectSourceFrame(rows, local).selected).toHaveLength(4)
    expect(() => selectSourceFrame(rows.filter(row => row.language === 'en'), local))
      .toThrow(expect.objectContaining({ failureClass: 'source-capacity-insufficient' }))
  })

  it('requires all eight preregistered release gates', async () => {
    const { spec } = await loadSpec()
    const rows = [
      { expected: 'bypass', actual: 'bypass', outcomeCritical: false },
      { expected: 'contract', actual: 'contract', outcomeCritical: true },
      { expected: 'lattice', actual: 'lattice', outcomeCritical: false },
      { expected: 'probe', actual: 'probe', outcomeCritical: false },
    ]
    const passing = scoreRouterRows(rows, spec.releaseGates)
    expect(passing.releaseGatePassed).toBe(true)
    expect(Object.keys(passing.checks)).toHaveLength(8)

    const criticalBypass = rows.map(row => row.expected === 'contract' ? { ...row, actual: 'bypass' } : row)
    expect(scoreRouterRows(criticalBypass, spec.releaseGates).checks.outcomeCriticalBypass).toBe(false)
    const probeFalsePositive = rows.map(row => row.expected === 'contract' ? { ...row, actual: 'probe' } : row)
    expect(scoreRouterRows(probeFalsePositive, spec.releaseGates).checks.probeFalsePositiveRate).toBe(false)
  })
})
