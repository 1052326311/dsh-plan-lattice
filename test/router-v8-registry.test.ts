import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const v8 = join(root, 'eval/router-corpus/v8')

function scopeSources() {
  return (['en', 'zh'] as const).flatMap(language => Array.from({ length: 36 }, (_, index) => ({
    repository: `${language}-org-${index}/${language}-repo-${index}`,
    nativeLanguage: language,
    ecosystem: `ecosystem-${index % 8}`,
  })))
}

function snapshots(sources: ReturnType<typeof scopeSources>) {
  return sources.map((source, index) => ({
    requestedRepository: source.repository,
    fullName: source.repository,
    nodeId: `repository-node-${index}`,
    owner: source.repository.split('/')[0],
    archived: false,
    disabled: false,
    hasIssues: true,
    hasDiscussions: index % 2 === 0,
    fork: false,
    sourceFullName: null,
    sourceNodeId: null,
  }))
}

describe('V8 source registry freeze', () => {
  it('keeps the archived registry byte-bound to its pre-candidate freeze evidence', async () => {
    const protocol = await import(`${pathToFileURL(join(v8, 'protocol.mjs')).href}?t=${Date.now()}`)
    const assembly = await import(`${pathToFileURL(join(v8, 'assemble-candidates.mjs')).href}?t=${Date.now()}`)
    const [registryText, manifestText, scopeText, collectorText] = await Promise.all([
      readFile(join(v8, 'source-registry.frozen.json'), 'utf8'),
      readFile(join(v8, 'source-registry-freeze-manifest.json'), 'utf8'),
      readFile(join(v8, 'source-registry-scope.json'), 'utf8'),
      readFile(join(v8, 'freeze-source-registry.mjs'), 'utf8'),
    ])
    const registry = assembly.validateRegistry(JSON.parse(registryText))
    const manifest = JSON.parse(manifestText)

    expect(registry.sources).toHaveLength(81)
    expect(manifest.evidenceStatus).toBe('source-registry-frozen-before-candidate-materialization')
    expect(manifest.registrySha256).toBe(protocol.sha256(registryText))
    expect(manifest.input.scopeSha256).toBe(protocol.sha256(scopeText))
    expect(manifest.input.collectorSha256).toBe(protocol.sha256(collectorText))
  })

  it('derives only predeclared object capabilities from strict repository metadata', async () => {
    const protocol = await import(`${pathToFileURL(join(v8, 'protocol.mjs')).href}?t=${Date.now()}`)
    const freezer = await import(`${pathToFileURL(join(v8, 'freeze-source-registry.mjs')).href}?t=${Date.now()}`)
    const sources = scopeSources()
    const repositorySnapshots = snapshots(sources)
    const categories = new Map(repositorySnapshots.filter(row => row.hasDiscussions)
      .map(row => [row.fullName.toLowerCase(), [`category-${row.nodeId}`]]))
    const registry = freezer.createRegistry({
      schemaVersion: 1,
      protocol: protocol.protocolId,
      cutoff: protocol.cutoff,
      sources,
    }, repositorySnapshots, categories)

    expect(registry.sources).toHaveLength(72)
    expect(registry.sources[0].objectTypes).toContain('pull-review')
    expect(registry.sources.some((row: { objectTypes: string[] }) => row.objectTypes.includes('discussion'))).toBe(true)
    expect(JSON.stringify(registry)).not.toMatch(/title|body|label|route|expected/i)
  })

  it('rejects unregistered response fields instead of reading candidate-like metadata', async () => {
    const freezer = await import(`${pathToFileURL(join(v8, 'freeze-source-registry.mjs')).href}?t=${Date.now()}`)
    const [source] = scopeSources()
    const [snapshot] = snapshots([source])
    expect(() => freezer.validateRepositorySnapshot({ ...snapshot, body: 'candidate text' })).toThrow('must contain exactly')
  })

  it('rejects archived sources, unresolved fork roots, and prior network reuse', async () => {
    const protocol = await import(`${pathToFileURL(join(v8, 'protocol.mjs')).href}?t=${Date.now()}`)
    const freezer = await import(`${pathToFileURL(join(v8, 'freeze-source-registry.mjs')).href}?t=${Date.now()}`)
    const sources = scopeSources()
    const repositorySnapshots = snapshots(sources)
    const scope = { schemaVersion: 1, protocol: protocol.protocolId, cutoff: protocol.cutoff, sources }
    expect(() => freezer.createRegistry(scope, [{ ...repositorySnapshots[0], archived: true }, ...repositorySnapshots.slice(1)], new Map()))
      .toThrow('archived or disabled')
    expect(() => freezer.validateRepositorySnapshot({ ...repositorySnapshots[0], fork: true }))
      .toThrow('canonical source identity')

    const registry = freezer.createRegistry(scope, repositorySnapshots, new Map())
    expect(() => freezer.assertRegistrySourceIsolation(registry, repositorySnapshots, {
      repositories: [registry.sources[0].repository.toLowerCase()],
      networkMembers: [],
      nodeIds: [],
    })).toThrow('reuses a V1-V7 network')
  })
})
