import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const v8 = join(process.cwd(), 'eval/router-corpus/v8')
const beforeCutoff = '2026-08-10T00:00:00Z'

function source(language: 'en' | 'zh' = 'en') {
  return {
    platform: 'github',
    repository: `${language}-org/repository`,
    repositoryNodeId: `${language}-repository-node`,
    networkRoot: `${language}-org/repository`,
    organization: `${language}-org`,
    ecosystem: 'test-ecosystem',
    nativeLanguage: language,
    objectTypes: ['discussion', 'issue', 'issue-comment-request', 'pull-review'],
    discussionCategoryIds: ['category-1'],
  }
}

function issue(number: number) {
  return {
    id: `issue-node-${number}`,
    number,
    url: `https://github.com/en-org/repository/issues/${number}`,
    title: 'Choose the correct implementation for the existing parser state',
    body: 'If the current implementation already stores normalized values, keep that path; otherwise update `src/parser.ts` and add the focused regression test.',
    createdAt: beforeCutoff,
    updatedAt: beforeCutoff,
    lastEditedAt: null,
    authorAssociation: 'NONE',
    author: { login: `author-${number}` },
    duplicateOf: null,
    closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  }
}

describe('V8 source-frame collector', () => {
  it('binds the committed spec and keeps collection independent of the selection seed', async () => {
    const collector = await import(`${pathToFileURL(join(v8, 'collect-source-frame.mjs')).href}?t=${Date.now()}`)
    const specText = await readFile(join(v8, 'source-frame-spec.json'), 'utf8')
    const collectorText = await readFile(join(v8, 'collect-source-frame.mjs'), 'utf8')
    const spec = collector.validateSpec(JSON.parse(specText))
    expect(spec.selectionSeedAccess).toBe('forbidden-during-source-frame-collection')
    expect(collectorText).not.toMatch(/seed-file|v8-selection-seed/i)
    expect(collector.issueQuery).not.toMatch(/labels|stateReason/i)
    expect(collector.discussionQuery).not.toMatch(/answer|upvote|labels/i)
  })

  it('assigns each source family before content and emits at most one issue episode', async () => {
    const collector = await import(`${pathToFileURL(join(v8, 'collect-source-frame.mjs')).href}?t=${Date.now()}`)
    const spec = collector.validateSpec(JSON.parse(await readFile(join(v8, 'source-frame-spec.json'), 'utf8')))
    const candidateIssues = Array.from({ length: 300 }, (_, index) => issue(index + 1))
    const result = collector.buildIssueRows(source(), candidateIssues, [], 'a'.repeat(40), spec)
    const families = result.output.map((pair: { row: { sourceFamilyId: string } }) => pair.row.sourceFamilyId)
    expect(new Set(families).size).toBe(families.length)
    expect(result.output.every((pair: { row: { queue: string; constructionFamily: string | null } }) => (
      pair.row.queue === 'natural' || pair.row.constructionFamily === 'repository-contingent'
    ))).toBe(true)
  })

  it('constructs continuity only from a requested-change, intervening commit, and later review', async () => {
    const collector = await import(`${pathToFileURL(join(v8, 'collect-source-frame.mjs')).href}?t=${Date.now()}`)
    const spec = collector.validateSpec(JSON.parse(await readFile(join(v8, 'source-frame-spec.json'), 'utf8')))
    let number = 1
    while (collector.partitionFor('pull-request', `github:en-repository-node:pull:${number}`) !== 'continuity') number += 1
    const pull = {
      id: `pull-node-${number}`,
      number,
      url: `https://github.com/en-org/repository/pull/${number}`,
      title: 'Keep the parser contract current across both review rounds',
      body: 'Implement the parser correction and retain all accepted behavior while the review feedback evolves.',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-05T00:00:00Z',
      lastEditedAt: null,
      baseRefOid: 'base',
      author: { login: 'contributor' },
      reviews: { pageInfo: { hasNextPage: false }, nodes: [
        { id: 'review-1', url: 'https://example.test/r1', body: 'Please replace the stale parser branch and prove the normalized output.', state: 'CHANGES_REQUESTED', submittedAt: '2026-08-02T00:00:00Z', createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z', lastEditedAt: null, authorAssociation: 'MEMBER', author: { login: 'maintainer-a' }, commit: { oid: 'old' } },
        { id: 'review-2', url: 'https://example.test/r2', body: 'Now preserve the explicit fallback while keeping the first correction intact.', state: 'COMMENTED', submittedAt: '2026-08-04T00:00:00Z', createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z', lastEditedAt: null, authorAssociation: 'COLLABORATOR', author: { login: 'maintainer-b' }, commit: { oid: 'new' } },
      ] },
      commits: { pageInfo: { hasNextPage: false }, nodes: [{ commit: { oid: 'between', committedDate: '2026-08-03T00:00:00Z' } }] },
    }
    const result = collector.buildContinuityRow(source(), pull, spec)
    expect(result.output).toHaveLength(1)
    expect(result.output[0].row.constructionFamily).toBe('continuity')
    expect(result.output[0].row.relatedCommits).toEqual(['between'])

    const missingCommit = collector.buildContinuityRow(source(), { ...pull, commits: { pageInfo: { hasNextPage: false }, nodes: [] } }, spec)
    expect(missingCommit.output).toHaveLength(0)
    expect(missingCommit.ledger[0].reason).toBe('continuity-chain-missing')
  })

  it('removes exact and near duplicates without counting repeated turns as new tasks', async () => {
    const collector = await import(`${pathToFileURL(join(v8, 'collect-source-frame.mjs')).href}?t=${Date.now()}`)
    const isolation = await import(`${pathToFileURL(join(v8, 'source-isolation.mjs')).href}?t=${Date.now()}`)
    const text = 'Implement the current parser correction, preserve the accepted fallback, and prove the exact behavior with a focused regression test.'
    const pairs = ['one', 'two'].map(id => ({
      row: { stableSourceId: id, sourceFamilyId: `family-${id}`, text, promptDigest: '', canonicalPromptDigest: '' },
      audit: { id },
    }))
    const protocol = await import(`${pathToFileURL(join(v8, 'protocol.mjs')).href}?t=${Date.now()}`)
    for (const pair of pairs) {
      pair.row.promptDigest = protocol.sha256(pair.row.text)
      pair.row.canonicalPromptDigest = protocol.sha256(isolation.canonicalPrompt(pair.row.text))
    }
    const result = collector.removePromptDuplicates(pairs, {
      promptDigests: [], canonicalDigests: [], promptRecords: [],
    })
    expect(result.pairs).toHaveLength(1)
    expect(result.rejected).toHaveLength(1)
  })
})
