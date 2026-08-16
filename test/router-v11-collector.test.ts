import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'eval/router-corpus/v11')
const beforeCutoff = '2026-08-10T00:00:00Z'

async function moduleAt(name: string) {
  return import(`${pathToFileURL(join(root, name)).href}?test=${Date.now()}-${Math.random()}`)
}

function searchItem(index: number, pull = false) {
  const repository = `fresh-org/repository-${index}`
  return {
    node_id: `${pull ? 'PR' : 'I'}_node_${index}`,
    number: index,
    html_url: `https://github.com/${repository}/${pull ? 'pull' : 'issues'}/${index}`,
    repository_url: `https://api.github.com/repos/${repository}`,
    created_at: beforeCutoff,
    updated_at: beforeCutoff,
    title: 'content must never enter the exposure registry',
    body: 'private source content for the later materialization stage',
    ...(pull ? { pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${index}` } } : {}),
  }
}

function issueNode(id: string, number: number, overrides: Record<string, unknown> = {}) {
  const repository = `fresh-org/repository-${number}`
  return {
    __typename: 'Issue',
    id,
    number,
    url: `https://github.com/${repository}/issues/${number}`,
    title: 'Update the existing parser only after inspecting repository state',
    body: 'If the current implementation in `src/parser.ts` already preserves normalized values, keep it; otherwise update the parser and add a focused regression test.',
    createdAt: beforeCutoff,
    updatedAt: beforeCutoff,
    lastEditedAt: null,
    author: { __typename: 'User', login: 'reporter' },
    repository: {
      id: `R_${number}`,
      nameWithOwner: repository,
      owner: { login: 'fresh-org' },
      primaryLanguage: { name: 'TypeScript' },
      isFork: false,
      parent: null,
      defaultBranchRef: null,
    },
    ...overrides,
  }
}

function candidate(index: number, family = 'natural', pull = false) {
  const item = searchItem(index, pull)
  return {
    search: { id: `${family}-en`, family, language: 'en', query: 'frozen query updated:<=2026-08-15' },
    item,
    language: 'en',
    familyId: `github:fresh-org/repository-${index}:${pull ? 'pull' : 'issue'}:${index}`,
  }
}

describe('V11 exposure registry and source-frame collector', () => {
  it('binds the frozen V10 spec and keeps both stages independent of router labels and seed files', async () => {
    const protocol = await moduleAt('protocol.mjs')
    const frozen = await protocol.loadFrozenInputs()
    expect(frozen.spec.protocol).toBe('observable-authorization-v11')
    expect(frozen.v10Spec.searches).toHaveLength(42)
    expect(frozen.spec.searchFrame).toMatchObject({ firstPage: 2, lastPage: 10, resultsPerPage: 100 })
    expect(protocol.sha256(frozen.v10SpecBytes)).toBe(frozen.spec.v10.specSha256)
    expect(frozen.spec.selectionSeedCommitment).toBe('bc4b973e64fe9065ab3e956425a4c16193e1d6613c458b5aa5801c0ac6b1301a')

    const sources = await Promise.all([
      'recover-v10-exposure-registry.mjs',
      'collect-source-frame.mjs',
      'graphql-source.mjs',
    ].map(file => readFile(join(root, file), 'utf8')))
    for (const source of sources) {
      expect(source).not.toMatch(/v1[01]-selection-seed|seed-file|router-model|blind.*labels/iu)
      expect(source).not.toContain('/Users/xin/.local/share/dsh-plan-lattice-eval/v11-selection-seed')
    }
  })

  it('registers every page-1 hit with identity provenance and no source content', async () => {
    const exposure = await moduleAt('exposure-registry.mjs')
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    const search = { id: 'bounded-en-fix', family: 'bounded', language: 'en', query: 'is:pr fix updated:<=2026-08-15' }
    const rows = exposure.buildExposureRows(search, {
      total_count: 2,
      incomplete_results: false,
      items: [searchItem(1, true), searchItem(2, true)],
    }, spec)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      nodeId: 'PR_node_1',
      sourceFamilyId: 'github:fresh-org/repository-1:pull:1',
      repository: 'fresh-org/repository-1',
      searchFamily: 'bounded',
      query: search.query,
      searchPage: 1,
      rank: 1,
    })
    expect(JSON.stringify(rows)).not.toContain('content must never enter')
    expect(JSON.stringify(rows)).not.toContain('private source content')
    expect(() => exposure.buildExposureRows(search, {
      total_count: 2,
      incomplete_results: false,
      items: [searchItem(1, true)],
    }, spec)).toThrow('returned 1, expected 2')
    expect(() => exposure.buildExposureRows(search, {
      total_count: 1,
      incomplete_results: false,
      items: [searchItem(1, false)],
    }, spec)).toThrow('wrong object type')
  })

  it('verifies registry bytes and exactly one page-1 snapshot per frozen query', async () => {
    const protocol = await moduleAt('protocol.mjs')
    const exposure = await moduleAt('exposure-registry.mjs')
    const frozen = await protocol.loadFrozenInputs()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-v11-registry-'))
    const registryPath = join(directory, 'registry.jsonl')
    const manifestPath = join(directory, 'manifest.json')
    const registryText = '\n'
    const recoveryBytes = await readFile(join(root, 'recover-v10-exposure-registry.mjs'))
    const querySnapshots = frozen.v10Spec.searches.map((search: { id: string; query: string }) => ({
      queryId: search.id,
      query: search.query,
      page: 1,
      totalCount: 0,
      itemCount: 0,
      incompleteResults: false,
      truncatedByGitHubCap: false,
      rateLimit: { resource: 'search', remaining: 30 },
    }))
    const manifest = {
      schemaVersion: 1,
      protocol: frozen.spec.protocol,
      stage: 'v10-exposure-recovery',
      evidenceStatus: 'v10-exposure-registry-frozen',
      seedAccessed: false,
      queryCount: querySnapshots.length,
      exposureCount: 0,
      querySnapshots,
      digests: {
        v10Spec: protocol.sha256(frozen.v10SpecBytes),
        v11Spec: protocol.sha256(frozen.specBytes),
        recovery: protocol.sha256(recoveryBytes),
        registry: protocol.sha256(registryText),
      },
    }
    try {
      await writeFile(registryPath, registryText)
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
      await expect(exposure.loadExposureArtifacts(registryPath, manifestPath, frozen))
        .resolves.toMatchObject({ rows: [] })
      manifest.querySnapshots[1] = { ...manifest.querySnapshots[0] }
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
      await expect(exposure.loadExposureArtifacts(registryPath, manifestPath, frozen))
        .rejects.toThrow('invalid exposure snapshot')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('starts at page 2, covers every accessible page, and excludes V10-exposed objects', async () => {
    const collector = await moduleAt('collect-source-frame.mjs')
    const exposureModule = await moduleAt('exposure-registry.mjs')
    const searchDefinition = { id: 'natural-en', family: 'natural', language: 'en', query: 'is:issue updated:<=2026-08-15' }
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    spec.searchFrame.maximumCandidatesPerSearch = 500
    const exposed = searchItem(150)
    const exposureRows = [{
      nodeId: exposed.node_id,
      sourceFamilyId: `github:fresh-org/repository-150:issue:150`,
      url: exposed.html_url,
    }]
    const calls: number[] = []
    const frozen = { spec, v10Spec: { searches: [searchDefinition] } }
    const exposure = {
      manifest: { querySnapshots: [{ queryId: searchDefinition.id, query: searchDefinition.query, totalCount: 202 }] },
      index: exposureModule.exposureIndex(exposureRows),
    }
    const result = await collector.collectSearchFrame({
      frozen,
      exposure,
      search: async (_query: string, page: number) => {
        calls.push(page)
        const items = page === 2
          ? Array.from({ length: 100 }, (_, offset) => searchItem(101 + offset))
          : [searchItem(201), searchItem(202)]
        return { data: { total_count: 202, incomplete_results: false, items }, rateLimit: { remaining: 20 } }
      },
    })
    expect(calls).toEqual([2, 3])
    expect(result.candidates).toHaveLength(101)
    expect(result.candidates.some((entry: { item: { node_id: string } }) => entry.item.node_id === exposed.node_id)).toBe(false)
    expect(result.ledger).toContainEqual(expect.objectContaining({ reason: 'v10-exposure', match: 'node-id' }))
  })

  it('fails closed when page totals drift or a page is truncated', async () => {
    const collector = await moduleAt('collect-source-frame.mjs')
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    const searchDefinition = { id: 'natural-en', family: 'natural', language: 'en', query: 'is:issue updated:<=2026-08-15' }
    const input = {
      frozen: { spec, v10Spec: { searches: [searchDefinition] } },
      exposure: {
        manifest: { querySnapshots: [{ queryId: searchDefinition.id, query: searchDefinition.query, totalCount: 101 }] },
        index: { nodeIds: new Set(), sourceFamilyIds: new Set(), urls: new Set() },
      },
    }
    await expect(collector.collectSearchFrame({
      ...input,
      search: async () => ({ data: { total_count: 102, incomplete_results: false, items: [searchItem(101)] }, rateLimit: { remaining: 20 } }),
    })).rejects.toMatchObject({ failureClass: 'search-snapshot-drift' })
    await expect(collector.collectSearchFrame({
      ...input,
      search: async () => ({ data: { total_count: 101, incomplete_results: false, items: [] }, rateLimit: { remaining: 20 } }),
    })).rejects.toMatchObject({ failureClass: 'search-pagination-truncated' })
  })

  it('turns an empty repository base into an explicit rejection instead of throwing', async () => {
    const graphql = await moduleAt('graphql-source.mjs')
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    const task = candidate(1, 'repository-contingent')
    expect(graphql.materializeCandidate(task, issueNode(task.item.node_id, 1), spec)).toEqual({
      rejection: { reason: 'cutoff-base-commit-unavailable' },
    })
  })

  it('rejects incomplete timeline pagination without accepting partial comments', async () => {
    const graphql = await moduleAt('graphql-source.mjs')
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    const task = candidate(2, 'decision')
    const node = issueNode(task.item.node_id, 2, {
      comments: {
        totalCount: 101,
        pageInfo: { hasNextPage: true, endCursor: 'cursor' },
        nodes: [],
      },
    })
    expect(graphql.materializeCandidate(task, node, spec)).toEqual({
      rejection: { reason: 'timeline-pagination-truncated', detail: 'issue-comments' },
    })
  })

  it('batches issue nodes but isolates pull timelines and records requirement flags', async () => {
    const collector = await moduleAt('collect-source-frame.mjs')
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    const tasks = [candidate(1, 'natural'), candidate(2, 'decision'), candidate(3, 'bounded', true)]
    const calls: Array<{ ids: string[]; variables: Record<string, unknown> }> = []
    const result = await collector.fetchGraphqlSources(tasks, async (ids: string[], variables: Record<string, unknown>) => {
      calls.push({ ids, variables })
      return { nodes: ids.map(id => ({ id })), rateLimit: { cost: 1, remaining: 4999, resetAt: beforeCutoff } }
    }, spec)
    expect(result.nodeMap.size).toBe(3)
    expect(calls).toHaveLength(3)
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ ids: ['I_node_1'], variables: expect.objectContaining({ includeIssueComments: false, includePullTimeline: false }) }),
      expect.objectContaining({ ids: ['I_node_2'], variables: expect.objectContaining({ includeIssueComments: true, includePullTimeline: false }) }),
      expect.objectContaining({ ids: ['PR_node_3'], variables: expect.objectContaining({ includeIssueComments: false, includePullTimeline: true }) }),
    ]))
  })

  it('retains precise REST rate-limit state in fail-closed errors', async () => {
    const github = await moduleAt('github-api.mjs')
    const client = github.createRestSearchClient({
      token: 'test-token',
      apiVersion: '2022-11-28',
      minimumRemaining: 2,
      fetchImpl: async () => new Response('rate limited', {
        status: 403,
        headers: {
          'x-ratelimit-resource': 'search',
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-used': '30',
          'x-ratelimit-reset': '1786900000',
        },
      }),
    })
    await expect(client('is:issue', 2, 100)).rejects.toMatchObject({
      failureClass: 'search-rate-limit-exhausted',
      stage: 'search',
      rateLimit: expect.objectContaining({ resource: 'search', remaining: 0, used: 30 }),
    })
  })

  it('uses GraphQL nodes, cutoff history, and explicit pagination signals', async () => {
    const graphql = await moduleAt('graphql-source.mjs')
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    const query = graphql.githubGraphqlQuery(spec)
    expect(query).toContain('nodes(ids: $ids)')
    expect(query).toContain('history(first: 1, until: $cutoff)')
    expect(query).toContain('pageInfo { hasNextPage endCursor }')
    expect(query).toContain('@include(if: $includeIssueComments)')
    expect(query).toContain('@include(if: $includePullTimeline)')
  })

  it('extends committed source isolation through V9 and adds the V10 exposure boundary', async () => {
    const isolation = await moduleAt('source-isolation.mjs')
    const inventory = await isolation.priorSourceInventory()
    expect(Object.keys(inventory.versions)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'])
    expect(Object.values(inventory.versions).every((count: unknown) => Number(count) > 0)).toBe(true)
    expect(() => isolation.assertSourceDisjoint([{
      sourceFamilyId: 'github:new/repository:issue:1',
      repository: 'new/repository',
      networkRoot: 'new/repository',
      nodeId: 'exposed-node',
      url: 'https://github.com/new/repository/issues/1',
      text: 'A sufficiently long independent prompt that does not overlap any historical source record in the existing evaluation corpus.',
    }], inventory, {
      nodeIds: new Set(['exposed-node']),
      sourceFamilyIds: new Set(),
      urls: new Set(),
    })).toThrow('V10-exposed source')
  })
})
