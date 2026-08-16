import { describe, expect, it } from 'vitest'
import {
  assertSourceDisjoint,
  filterPriorExposure,
  frozenPriorExposureInventory,
  removeCurrentNearDuplicates,
  staticInventoryDigest,
  staticRegistryDigest,
} from '../eval/router-corpus/v12/source-isolation.mjs'
import { sha256, staticPriorExposureRegistry } from '../eval/router-corpus/v12/prior-exposure-registry.mjs'

function prior(overrides: Record<string, unknown> = {}) {
  return {
    registryDigest: 'test-registry',
    repositories: [], networkMembers: [], familyIds: [], objectIds: [], eventIds: [],
    urls: [], nodeIds: [], pullRequests: [], commits: [], duplicateReferences: [], entityReferences: [],
    promptDigests: [], canonicalDigests: [], promptRecords: [],
    ...overrides,
  }
}

function row(overrides: Record<string, unknown> = {}) {
  const base = {
    stableSourceId: 'github:fresh-org/fresh-repo:issue:77:natural:evt-77',
    sourceFamilyId: 'github:fresh-org/fresh-repo:issue:77',
    repository: 'fresh-org/fresh-repo',
    url: 'https://github.com/fresh-org/fresh-repo/issues/77',
    nodeId: 'I_fresh_77',
    eventIds: ['evt-77'],
    objectCreatedAt: '2026-08-17T01:00:00Z',
    eventCreatedAt: '2026-08-17T01:00:01Z',
    text: 'Implement a focused parser correction with a deterministic regression test and explicit expected output.',
  }
  return { ...base, ...overrides }
}

async function rejectionReason(candidate: Record<string, unknown>, inventory: Record<string, unknown>) {
  const result = await filterPriorExposure([candidate], inventory)
  expect(result.accepted).toHaveLength(0)
  return result.rejected[0].reason
}

describe('V12 static V1-V11 exposure registry', () => {
  it('binds the full prior inventory and explicit V10/V11 failures before current parsing', () => {
    expect(frozenPriorExposureInventory.coveredVersions).toEqual([
      'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11',
    ])
    expect(frozenPriorExposureInventory.inventoryDigest).toBe(staticInventoryDigest)
    expect(frozenPriorExposureInventory.registryDigest).toBe(staticRegistryDigest)
    expect(staticPriorExposureRegistry.failedProtocols).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocol: 'observable-authorization-v10', observedRepository: 'shup2399/gg' }),
      expect.objectContaining({ protocol: 'observable-authorization-v11', failedQueryId: 'bounded-en-fix', failedRank: 21 }),
    ]))
    expect(frozenPriorExposureInventory.repositories).toContain('shup2399/gg')
    expect(frozenPriorExposureInventory.temporalProof).toMatchObject({
      predecessorCutoff: '2026-08-15T23:59:59Z',
      prospectiveWindowStart: '2026-08-17T00:00:00Z',
    })
  })

  it('rejects old objects even when their unavailable V10/V11 identities cannot be enumerated', async () => {
    await expect(rejectionReason(row({
      repository: 'never-seen/example',
      url: 'https://github.com/never-seen/example/issues/1',
      sourceFamilyId: 'github:never-seen/example:issue:1',
      objectCreatedAt: '2026-08-15T23:59:59Z',
    }), prior())).resolves.toBe('prior-temporal-frame')
  })
})

describe('V12 overlap dimensions', () => {
  it.each([
    ['repository', prior({ repositories: ['fresh-org/fresh-repo'] }), row(), 'prior-repository'],
    ['network', prior({ networkMembers: ['upstream/root'] }), row({ networkRoot: 'upstream/root' }), 'prior-network'],
    ['family', prior({ familyIds: ['github:fresh-org/fresh-repo:issue:77'] }), row(), 'prior-family-id'],
    ['object', prior({ objectIds: ['github:fresh-org/fresh-repo:issue:77'] }), row(), 'prior-object-id'],
    ['event', prior({ eventIds: ['evt-77'] }), row(), 'prior-event-id'],
    ['URL', prior({ urls: ['https://github.com/fresh-org/fresh-repo/issues/77'] }), row(), 'prior-url'],
    ['node ID', prior({ nodeIds: ['I_fresh_77'] }), row(), 'prior-node-id'],
    ['pull request', prior({ pullRequests: ['fresh-org/fresh-repo#77'] }), row({
      sourceFamilyId: 'github:fresh-org/fresh-repo:pull:77',
      url: 'https://github.com/fresh-org/fresh-repo/pull/77',
    }), 'prior-pull-request'],
    ['commit', prior({ commits: ['0123456789abcdef0123456789abcdef01234567'] }), row({
      headSha: '0123456789abcdef0123456789abcdef01234567',
    }), 'prior-commit'],
    ['exact prompt', prior({ promptDigests: [sha256(row().text as string)] }), row(), 'prior-prompt-digest'],
  ])('rejects prior %s overlap', async (_name, inventory, candidate, reason) => {
    await expect(rejectionReason(candidate, inventory)).resolves.toBe(reason)
  })

  it('rejects canonical prompt identity independently of exact bytes', async () => {
    const candidate = row({ text: 'IMPLEMENT a focused parser correction, with a deterministic regression test and explicit expected output!!!' })
    const canonicalDigest = sha256('implement a focused parser correction with a deterministic regression test and explicit expected output')
    await expect(rejectionReason(candidate, prior({ canonicalDigests: [canonicalDigest] }))).resolves.toBe('prior-canonical-digest')
  })

  it('rejects a >=0.85 five-shingle duplicate with different exact and canonical text', async () => {
    const original = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega final stable release'
    const candidate = row({ text: `${original} extension` })
    await expect(rejectionReason(candidate, prior({ promptRecords: [{ id: 'prior-long', text: original }] }))).resolves.toBe('prior-near-duplicate')
  })

  it('rejects duplicate current family, event and near-duplicate prompt identities', () => {
    const family = removeCurrentNearDuplicates([row(), row({ stableSourceId: 'second', eventIds: ['evt-78'] })])
    expect(family.rejected[0].reason).toBe('current-family-id')

    const event = removeCurrentNearDuplicates([row(), row({
      stableSourceId: 'second',
      sourceFamilyId: 'github:another/repo:issue:88',
      repository: 'another/repo',
      url: 'https://github.com/another/repo/issues/88',
      nodeId: 'I_another_88',
    })])
    expect(event.rejected[0].reason).toBe('current-event-id')

    const near = removeCurrentNearDuplicates([row(), row({
      stableSourceId: 'third',
      sourceFamilyId: 'github:third/repo:issue:99',
      repository: 'third/repo',
      url: 'https://github.com/third/repo/issues/99',
      nodeId: 'I_third_99',
      eventIds: ['evt-99'],
      text: `${row().text as string} now`,
    })])
    expect(near.rejected[0].reason).toMatch(/^current-(?:canonical-digest|near-duplicate)$/u)
  })

  it('accepts a post-cutoff source with no prior or current overlap', async () => {
    await expect(assertSourceDisjoint([row()], prior())).resolves.toMatchObject({ accepted: [row()] })
  })
})
