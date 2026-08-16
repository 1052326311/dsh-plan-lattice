import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mutationTargetFromTool,
  nodeExecutionPlan,
  normalizeMutationTarget,
  readMutationTargets,
  verifyMutationTargetSync,
} from '../src/mutation-context.js'
import type { LatticeState } from '../src/domain.js'

describe('authoritative mutation context', () => {
  it('binds existing and missing targets to their exact observed state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-target-'))
    try {
      await writeFile(join(workspace, 'existing.ts'), 'export const value = 1\n', 'utf8')
      const observed = await readMutationTargets(workspace, ['new.ts', 'existing.ts'], 1_024)
      expect(observed.targets.map(target => [target.path, target.state])).toEqual([
        ['existing.ts', 'file'],
        ['new.ts', 'missing'],
      ])
      expect(verifyMutationTargetSync(workspace, observed.targets[0]!)).toBeUndefined()
      expect(verifyMutationTargetSync(workspace, observed.targets[1]!)).toBeUndefined()

      await writeFile(join(workspace, 'existing.ts'), 'export const value = 2\n', 'utf8')
      await writeFile(join(workspace, 'new.ts'), 'created\n', 'utf8')
      expect(verifyMutationTargetSync(workspace, observed.targets[0]!)).toContain('changed since it was read')
      expect(verifyMutationTargetSync(workspace, observed.targets[1]!)).toContain('changed since it was read')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects escapes and symlink escapes for mutation targets', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-target-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside\n', 'utf8')
      await expect(readMutationTargets(workspace, ['../outside.txt'], 1_024)).rejects.toThrow('outside the workspace')
      await import('node:fs/promises').then(({ symlink }) => symlink(outside, join(workspace, 'escape')))
      await expect(readMutationTargets(workspace, ['escape/secret.txt'], 1_024)).rejects.toThrow('outside the workspace')
      expect(() => normalizeMutationTarget(workspace, '../outside.txt')).toThrow('outside the workspace')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('renders the complete root-to-leaf plan as the execution definition', () => {
    const state = {
      schemaVersion: 1,
      revision: 3,
      project: { title: 'Project', objective: 'Ship', contextPaths: ['PRODUCT.md'], createdAt: 1, updatedAt: 1 },
      nodes: {
        root: { id: 'root', title: 'Preserve intent', acceptanceCriteria: 'P0 holds', status: 'active', evidence: [], createdAt: 1, updatedAt: 1 },
        leaf: { id: 'leaf', parentId: 'root', title: 'Edit target', acceptanceCriteria: 'Focused test passes', status: 'active', evidence: [], createdAt: 2, updatedAt: 2 },
      },
    } satisfies LatticeState
    const plan = nodeExecutionPlan(state, 'leaf')
    expect(plan.lineage.map(node => node.id)).toEqual(['root', 'leaf'])
    expect(plan.lineage[0]?.acceptanceCriteria).toBe('P0 holds')
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('recognizes real Harness filesystem mutation targets without treating view as a write', () => {
    expect(mutationTargetFromTool('write', { file_path: 'a.ts' })).toEqual({ kind: 'mutation', path: 'a.ts' })
    expect(mutationTargetFromTool('edit', { file_path: 'a.ts' })).toEqual({ kind: 'mutation', path: 'a.ts' })
    expect(mutationTargetFromTool('str_replace_editor', { command: 'str_replace', path: '/repo/a.ts' }))
      .toEqual({ kind: 'mutation', path: '/repo/a.ts' })
    expect(mutationTargetFromTool('str_replace_editor', { command: 'view', path: '/repo/a.ts' }))
      .toEqual({ kind: 'read' })
  })
})
