import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const v9 = join(process.cwd(), 'eval/router-corpus/v9')

function rows() {
  return Array.from({ length: 24 }, (_, index) => ({
    stableSourceId: `source-${index}`,
    repository: `org-${index % 8}/repo-${index % 12}`,
    organization: `org-${index % 8}`,
    authorId: `author-${index}`,
    ecosystem: `ecosystem-${index % 6}`,
    objectType: ['issue', 'discussion', 'issue-comment-request', 'pull-review'][index % 4],
    sourceFamilyId: `family-${index}`,
  }))
}

describe('V9 deterministic candidate assembly', () => {
  it('selects the same source IDs regardless of source-frame order', async () => {
    const assembly = await import(`${pathToFileURL(join(v9, 'assemble-candidates.mjs')).href}?t=${Date.now()}`)
    const caps = { author: 1, repository: 2, organization: 4, ecosystem: 4, objectType: 3 }
    const forward = assembly.selectWithCaps(rows(), 12, 'external-seed', 'natural', 'en', caps)
    const reverse = assembly.selectWithCaps(rows().reverse(), 12, 'external-seed', 'natural', 'en', caps)
    expect(forward.map((row: { stableSourceId: string }) => row.stableSourceId))
      .toEqual(reverse.map((row: { stableSourceId: string }) => row.stableSourceId))
  })

  it('fails closed when deterministic caps cannot fill a frozen stratum', async () => {
    const assembly = await import(`${pathToFileURL(join(v9, 'assemble-candidates.mjs')).href}?t=${Date.now()}`)
    const insufficient = rows().slice(0, 3).map(row => ({ ...row, authorId: 'one-author' }))
    expect(() => assembly.selectWithCaps(
      insufficient,
      2,
      'external-seed',
      'natural',
      'en',
      { author: 1 },
    )).toThrow('selected 1; requires 2')
  })

  it('treats repeated turns from one task family as one capacity unit', async () => {
    const assembly = await import(`${pathToFileURL(join(v9, 'assemble-candidates.mjs')).href}?t=${Date.now()}`)
    const repeated = rows().slice(0, 3).map(row => ({ ...row, sourceFamilyId: 'same-issue' }))
    expect(() => assembly.selectWithCaps(
      repeated,
      2,
      'external-seed',
      'natural',
      'en',
      { sourceFamily: 1 },
    )).toThrow('selected 1; requires 2')
  })
})
