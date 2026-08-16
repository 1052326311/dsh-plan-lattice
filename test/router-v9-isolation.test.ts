import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const sourcePath = join(root, 'eval/router-corpus/v9/source-isolation.mjs')

async function isolation() {
  return import(`${pathToFileURL(sourcePath).href}?test=${Date.now()}-${Math.random()}`)
}

const basePrompt = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'

describe('V9 source isolation and near-duplicate foundation', () => {
  it('read-only scans every V1-V8 source, candidate, and calibration artifact', async () => {
    const module = await isolation()
    const inventory = await module.priorSourceInventory()
    expect(Object.keys(inventory.versions)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'])
    expect(Object.values(inventory.versions).every((count: unknown) => Number(count) > 0)).toBe(true)
    expect(inventory.files.every((file: { path: string }) => !file.path.includes('/v9/'))).toBe(true)
    expect(inventory.files.every((file: { path: string }) => /(source|candidate|calibration)/i.test(file.path))).toBe(true)
    expect(inventory.repositories).toContain('microsoft/terminal')
    expect(inventory.promptRecords.some((record: { id: string }) => record.id === 'v7-001')).toBe(true)
    expect(inventory.canonicalDigests.length).toBeGreaterThan(0)
  })

  it('rejects exact identities, fork networks, renamed nodes, and prompt digests', async () => {
    const module = await isolation()
    const promptDigest = '1'.repeat(64)
    const canonicalDigest = '2'.repeat(64)
    const prior = module.buildSourceInventory([{
      repository: { full_name: 'legacy/tool', node_id: 'R_repo_identity' },
      parent: 'parent/tool',
      source: { full_name: 'upstream/tool' },
      networkRoot: 'root/tool',
      url: 'https://github.com/legacy/tool/issues/41?notification=1',
      documentationUrl: 'https://docs.example.com/source?id=41',
      promptDigest,
      canonicalPromptDigest: canonicalDigest,
    }])

    expect(() => module.assertSourceDisjoint([{ repository: 'LEGACY/tool', url: 'https://example.com/a' }], prior))
      .toThrow('V1-V8 repository')
    expect(() => module.assertSourceDisjoint([{
      repository: 'new/fork', networkRoot: 'root/tool', url: 'https://github.com/new/fork/issues/1',
    }], prior)).toThrow('canonical fork network')
    expect(() => module.assertSourceDisjoint([{
      repository: 'new/parent-fork', parent: 'parent/tool', url: 'https://github.com/new/parent-fork/issues/1',
    }], prior)).toThrow('canonical fork network')
    expect(() => module.assertSourceDisjoint([{
      repository: 'new/source-fork', source: 'upstream/tool', url: 'https://github.com/new/source-fork/issues/1',
    }], prior)).toThrow('canonical fork network')
    expect(() => module.assertSourceDisjoint([{
      repository: 'renamed/tool', nodeId: 'R_repo_identity', url: 'https://github.com/renamed/tool/issues/1',
    }], prior)).toThrow('nodeId')
    expect(() => module.assertSourceDisjoint([{
      repository: 'fresh/tool', url: 'https://docs.example.com/source#section',
    }], prior)).toThrow('V1-V8 URL')
    expect(() => module.assertSourceDisjoint([{
      repository: 'fresh/tool', url: 'https://example.com/digest', promptDigest,
    }], prior)).toThrow('prompt digest')
    expect(() => module.assertSourceDisjoint([{
      repository: 'fresh/tool', url: 'https://example.com/canonical', canonicalDigest,
    }], prior)).toThrow('canonical digest')
  })

  it('rejects associated pull requests, commits, and duplicate-chain reuse', async () => {
    const module = await isolation()
    const commit = 'a'.repeat(40)
    const prior = module.buildSourceInventory([{
      repository: 'old/project',
      issueNumber: 7,
      url: 'https://github.com/old/project/issues/7',
      relatedPullRequests: ['https://api.github.com/repos/old/project/pulls/19'],
      associatedCommits: [{ sha: commit }],
    }])

    expect(() => module.assertSourceDisjoint([{
      repository: 'fresh/project', url: 'https://example.com/pr',
      associatedPullRequest: 'old/project#19',
    }], prior)).toThrow('associated pull request')
    expect(() => module.assertSourceDisjoint([{
      repository: 'fresh/project', url: 'https://example.com/commit', linkedCommit: commit,
    }], prior)).toThrow('associated commit')
    expect(() => module.assertSourceDisjoint([{
      repository: 'fresh/project', url: 'https://example.com/duplicate',
      duplicateChain: [{ repository: 'old/project', issueNumber: 7 }],
    }], prior)).toThrow('duplicate chain')
  })

  it('forms deterministic connected clusters at fixed 5-shingle Jaccard >= 0.85', async () => {
    const module = await isolation()
    const near = `${basePrompt.replace(/twenty$/, 'twenty-one')}`
    const far = 'completely different words describe another independent report with no shared five token sequence'
    expect(module.SHINGLE_SIZE).toBe(5)
    expect(module.NEAR_DUPLICATE_THRESHOLD).toBe(0.85)
    expect(module.shingleJaccard(basePrompt, near)).toBeGreaterThanOrEqual(0.85)
    expect(module.shingleJaccard(basePrompt, far)).toBeLessThan(0.85)
    const twenty = new Set(Array.from({ length: 20 }, (_, index) => `s${index}`))
    const seventeen = new Set(Array.from({ length: 17 }, (_, index) => `s${index}`))
    expect(module.shingleJaccard(twenty, seventeen)).toBe(0.85)
    expect(module.nearDuplicateClusters([
      { id: 'base', text: basePrompt },
      { id: 'near', text: near },
      { id: 'far', text: far },
    ])).toMatchObject([{ members: ['base', 'near'] }])

    const prior = module.buildSourceInventory([{ id: 'old', text: basePrompt }])
    expect(() => module.assertSourceDisjoint([{ id: 'new', text: near }], prior)).toThrow('5-shingle Jaccard')
  })

  it('enforces author, repository, organization, and ecosystem caps', async () => {
    const module = await isolation()
    const rows = [
      { id: 'a', author: { login: 'alice' }, repository: 'org-a/one', ecosystem: 'node' },
      { id: 'b', authorLogin: 'alice', repository: 'org-a/two', ecosystem: 'node' },
      { id: 'c', user: { login: 'bob' }, repository: 'org-b/three', ecosystem: 'rust' },
    ]
    expect(module.assertDiversityCaps(rows, {
      author: 2, repository: 1, organization: 2, ecosystem: 2,
    })).toEqual({
      author: { alice: 2, bob: 1 },
      repository: { 'org-a/one': 1, 'org-a/two': 1, 'org-b/three': 1 },
      organization: { 'org-a': 2, 'org-b': 1 },
      ecosystem: { node: 2, rust: 1 },
    })
    expect(() => module.assertDiversityCaps(rows, {
      perAuthor: 2, perRepository: 1, perOrganization: 2, ecosystemShare: 0.5,
    })).toThrow('ecosystem cap 0.5 share (1 of 3) exceeded')
    expect(() => module.assertDiversityCaps(rows, {
      author: 1, repository: 1, organization: 2, ecosystem: 2,
    })).toThrow('author cap 1 exceeded')
    expect(() => module.assertDiversityCaps(rows, {
      author: 2, repository: 0, organization: 2, ecosystem: 2,
    })).toThrow('repository cap 0 exceeded')
    expect(() => module.assertDiversityCaps(rows, {
      author: 2, repository: 1, organization: 1, ecosystem: 2,
    })).toThrow('organization cap 1 exceeded')
    expect(() => module.assertDiversityCaps(rows, {
      author: 2, repository: 1, organization: 2, ecosystem: 1,
    })).toThrow('ecosystem cap 1 exceeded')
  })

  it('depends only on corpus data and Node built-ins', async () => {
    const source = await readFile(sourcePath, 'utf8')
    expect(source).not.toMatch(/from ['"](?:\.\.\/)+src\//)
    expect(source).not.toMatch(/from ['"](?:\.\.\/)+lib\//)
    expect(source).not.toContain('router.mjs')
  })
})
