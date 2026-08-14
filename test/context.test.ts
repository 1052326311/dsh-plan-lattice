import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectContext, validateContextPaths } from '../src/context.js'

describe('project context contract', () => {
  it('returns complete document content with an order-independent digest', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-context-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'LATTICE_SENTINEL\n', 'utf8')
      await writeFile(join(workspace, 'ARCHITECTURE.md'), 'State lives under .dsh.\n', 'utf8')
      const first = await readProjectContext(workspace, ['PRODUCT.md', 'ARCHITECTURE.md'], 1_024)
      const second = await readProjectContext(workspace, ['ARCHITECTURE.md', 'PRODUCT.md'], 1_024)

      expect(first.documents.map(document => document.content).join('')).toContain('LATTICE_SENTINEL')
      expect(first.digest).toBe(second.digest)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed for an escaping or oversized contract instead of truncating it', async () => {
    expect(() => validateContextPaths(['../outside.md'])).toThrow('escapes the workspace')
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-context-'))
    try {
      await writeFile(join(workspace, 'PRODUCT.md'), 'x'.repeat(32), 'utf8')
      await expect(readProjectContext(workspace, ['PRODUCT.md'], 16)).rejects.toThrow('exceeds 16 bytes')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
