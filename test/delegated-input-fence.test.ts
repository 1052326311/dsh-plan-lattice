import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DelegatedInputFenceError,
  DurableDelegatedInputFenceStore,
  type DelegatedInputContractBasis,
  type DelegatedInputFenceInput,
} from '../src/delegated-input-fence.js'
import { persistContractAnchor } from '../src/contract-anchor.js'
import { CONTRACT_DOCUMENT_PATH, type ContractRecord } from '../src/contract.js'

const roots: string[] = []
const CONTRACT_A = 'a'.repeat(64)
const CONTRACT_B = 'b'.repeat(64)
const MESSAGE_A = 'c'.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function anchorRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delegated-input-fence-'))
  roots.push(root)
  return root
}

function basis(overrides: Partial<DelegatedInputContractBasis> = {}): DelegatedInputContractBasis {
  return {
    rootSessionId: 'root-session-1',
    contractId: 'contract-1',
    contractRevision: 1,
    contractDigest: CONTRACT_A,
    ...overrides,
  }
}

function input(overrides: Partial<DelegatedInputFenceInput> = {}): DelegatedInputFenceInput {
  return {
    ...basis(),
    delegatedSessionId: 'child-session-1',
    messageId: 'message-1',
    messageDigest: MESSAGE_A,
    reason: 'Human input delivered to a delegated session requires root-contract revision.',
    createdAt: '2026-08-17T12:00:00.000Z',
    ...overrides,
  }
}

function contractRecord(adopted: DelegatedInputContractBasis): ContractRecord {
  const createdAt = '2026-08-17T11:00:00.000Z'
  return {
    id: adopted.contractId,
    schemaVersion: 2,
    sessionId: adopted.rootSessionId,
    controlLevel: 'lattice',
    clarificationPolicy: 'critical',
    estimatedSteps: 8,
    documentPath: CONTRACT_DOCUMENT_PATH,
    documentDigest: adopted.contractDigest,
    revision: adopted.contractRevision,
    createdAt,
    updatedAt: createdAt,
    framing: {
      requestSummary: 'Adopt delegated human input.',
      estimatedSteps: 8,
      systemBoundary: 'The root task and its delegated sessions.',
      timeHorizon: 'Current execution session.',
      desiredOutcome: 'Every delegated input is adopted before execution resumes.',
      confirmedFacts: [],
      decisions: [],
      invariants: [],
      changeables: [],
      forces: [],
      keyVariables: [],
      assumptions: [],
      unknowns: [],
      readiness: 'ready',
      readinessRationale: 'The new contract formally adopts the delegated input.',
    },
    questions: [],
    answers: [],
    answerBindings: [],
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

describe('durable delegated-input fence store', () => {
  it('restores and verifies exact delegated input after a process-style restart', async () => {
    const root = await anchorRoot()
    const first = new DurableDelegatedInputFenceStore(root)
    const persisted = await first.record(input())

    expect(persisted.created).toBe(true)
    expect(persisted.fence).toMatchObject({
      rootSessionId: 'root-session-1',
      contractId: 'contract-1',
      contractRevision: 1,
      contractDigest: CONTRACT_A,
      delegatedSessionId: 'child-session-1',
      messageId: 'message-1',
      messageDigest: MESSAGE_A,
      createdAt: '2026-08-17T12:00:00.000Z',
    })

    const restarted = new DurableDelegatedInputFenceStore(root)
    expect(restarted.readSync('root-session-1')).toEqual([persisted.fence])
    expect(restarted.verifySync(basis())).toEqual([persisted.fence])
    await expect(restarted.read('root-session-1')).resolves.toEqual([persisted.fence])
    await expect(restarted.verify(basis())).resolves.toEqual([persisted.fence])
    await expect(restarted.verify(basis({ contractDigest: CONTRACT_B })))
      .rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' })
  })

  it('records the same message idempotently and rejects changed retry content', async () => {
    const root = await anchorRoot()
    const store = new DurableDelegatedInputFenceStore(root)

    const first = await store.record(input())
    const repeated = await store.record(input())
    expect(first.created).toBe(true)
    expect(repeated).toEqual({ created: false, fence: first.fence })
    await expect(store.read('root-session-1')).resolves.toHaveLength(1)

    await expect(store.record(input({ reason: 'A different reason for the same durable message.' })))
      .rejects.toMatchObject({ code: 'FENCE_CONFLICT' })
    await expect(store.read('root-session-1')).resolves.toEqual([first.fence])
  })

  it('keeps one durable record when concurrent first writes choose different timestamps', async () => {
    const root = await anchorRoot()
    const first = new DurableDelegatedInputFenceStore(root, { now: () => Date.parse('2026-08-17T12:00:00.000Z') })
    const second = new DurableDelegatedInputFenceStore(root, { now: () => Date.parse('2026-08-17T12:00:01.000Z') })

    const results = await Promise.all([
      first.record(input({ createdAt: undefined })),
      second.record(input({ createdAt: undefined })),
    ])

    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results[0]!.fence).toEqual(results[1]!.fence)
    const rootHash = createHash('sha256').update('root-session-1').digest('hex')
    const records = join(root, 'delegated-input-fences', 'v1', rootHash, 'records')
    await expect(readdir(records)).resolves.toHaveLength(1)
  })

  it('fails closed after a self-consistent direct record rewrite', async () => {
    const root = await anchorRoot()
    const store = new DurableDelegatedInputFenceStore(root)
    await store.record(input())

    const rootHash = createHash('sha256').update('root-session-1').digest('hex')
    const records = join(root, 'delegated-input-fences', 'v1', rootHash, 'records')
    const [recordName] = (await readdir(records)).filter(name => name.endsWith('.json'))
    const recordPath = join(records, recordName!)
    const envelope = JSON.parse(await readFile(recordPath, 'utf8')) as {
      record: Record<string, unknown>
      recordDigest: string
    }
    envelope.record.reason = 'Directly rewritten reason.'
    envelope.recordDigest = createHash('sha256').update(canonicalJson(envelope.record)).digest('hex')
    await writeFile(recordPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')

    await expect(new DurableDelegatedInputFenceStore(root).read('root-session-1'))
      .rejects.toMatchObject({ code: 'CORRUPT_FENCE' })
  })

  it('clears only after the exact newer durable contract anchor is adopted', async () => {
    const root = await anchorRoot()
    const store = new DurableDelegatedInputFenceStore(root)
    await store.record(input())

    await persistContractAnchor(root, contractRecord(basis()))
    await expect(store.clearAfterContractAdoption(basis()))
      .rejects.toMatchObject({ code: 'ADOPTION_MISMATCH' })
    await expect(store.read('root-session-1')).resolves.toHaveLength(1)

    const adopted = basis({ contractId: 'contract-2', contractRevision: 2, contractDigest: CONTRACT_B })
    await persistContractAnchor(root, contractRecord(adopted))
    await expect(store.clearAfterContractAdoption({ ...adopted, contractDigest: 'd'.repeat(64) }))
      .rejects.toMatchObject({ code: 'ADOPTION_MISMATCH' })
    await expect(store.read('root-session-1')).resolves.toHaveLength(1)

    await expect(store.clearAfterContractAdoption(adopted)).resolves.toBe(1)
    await expect(new DurableDelegatedInputFenceStore(root).read('root-session-1')).resolves.toEqual([])
    await expect(store.clearAfterContractAdoption(adopted)).resolves.toBe(0)
  })

  it('surfaces typed corruption errors', () => {
    expect(new DelegatedInputFenceError('broken', 'CORRUPT_FENCE')).toMatchObject({
      name: 'DelegatedInputFenceError',
      code: 'CORRUPT_FENCE',
    })
  })
})
