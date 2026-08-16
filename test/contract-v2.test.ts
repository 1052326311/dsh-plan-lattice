import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTRACT_DOCUMENT_PATH,
  persistContract,
  readContractSync,
  verifyContract,
} from '../src/contract.js'

const workspaces: string[] = []

function framing() {
  return {
    requestSummary: 'Build a support application from an incomplete request.',
    estimatedSteps: 6,
    systemBoundary: 'This repository only.',
    timeHorizon: 'One implementation cycle.',
    desiredOutcome: 'Operators can resolve a support case.',
    confirmedFacts: ['The repository uses TypeScript.'],
    decisions: [],
    invariants: ['Existing cases remain readable.'],
    changeables: ['UI layout.'],
    forces: ['Requirements may evolve.'],
    keyVariables: ['Case correctness.'],
    assumptions: ['Local storage is acceptable until clarified.'],
    unknowns: ['Authoritative case source.'],
    readiness: 'conditional' as const,
    readinessRationale: 'Keep storage reversible until the truth source is known.',
  }
}

describe('v2 execution contracts', () => {
  afterEach(async () => Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true }))))

  it('binds answers into typed contract facts and detects tampering', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-v2-'))
    workspaces.push(workspace)
    const persisted = await persistContract({
      workspace,
      sessionId: 'root',
      controlLevel: 'contract',
      clarificationPolicy: 'critical',
      framing: framing(),
      questions: [{ id: 'truth', question: 'What is the authoritative case source?' }],
      answers: [{ id: 'truth', selected: ['PostgreSQL'] }],
      answerBindings: [{ questionId: 'truth', target: 'decision', statement: 'PostgreSQL is the authoritative case source.' }],
    })

    expect(persisted.receipt.schemaVersion).toBe(2)
    expect(persisted.record.framing.decisions).toContain('PostgreSQL is the authoritative case source.')
    expect(readContractSync(workspace)?.documentDigest).toBe(persisted.receipt.documentDigest)
    expect((await verifyContract({ workspace, sessionId: 'root', receiptId: persisted.receipt.id })).revision).toBe(1)
    const markdown = await readFile(join(workspace, CONTRACT_DOCUMENT_PATH), 'utf8')
    expect(markdown).toContain('Raw answer: PostgreSQL')
    expect(markdown).toContain('[decision] PostgreSQL')

    await writeFile(join(workspace, CONTRACT_DOCUMENT_PATH), '# tampered\n', 'utf8')
    expect(() => readContractSync(workspace)).toThrow('changed after confirmation')
    await expect(verifyContract({ workspace, sessionId: 'root' })).rejects.toThrow('changed after confirmation')
  })

  it('writes v2 without rewriting an existing v1 intake', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-v1-v2-'))
    workspaces.push(workspace)
    const v1 = join(workspace, '.dsh/plan-lattice/v1/INTAKE.md')
    await mkdir(join(workspace, '.dsh/plan-lattice/v1'), { recursive: true })
    await writeFile(v1, 'legacy contract\n', 'utf8')
    await persistContract({
      workspace,
      sessionId: 'root',
      controlLevel: 'lattice',
      clarificationPolicy: 'never',
      framing: framing(),
      questions: [],
      answers: [],
      answerBindings: [],
    })
    expect(await readFile(v1, 'utf8')).toBe('legacy contract\n')
  })
})
