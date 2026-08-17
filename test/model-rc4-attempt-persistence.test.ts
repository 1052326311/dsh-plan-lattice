import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson } from '../eval/v0.4/lib/canonical.mjs'
import { canonicalRecord, digestResultRecord } from '../eval/v0.4/lib/attempt-integrity.mjs'
import {
  acquireResultsLock,
  appendDurable,
  openAttemptJournal,
  persistPendingResult,
  recoverPendingResults,
  reserveAttempt,
} from '../prospective/model-rc4-study/attempt-persistence.mjs'

const roots: string[] = []
const binding = {
  signingLedgerId: 'plan-lattice-rc4-test-ledger',
  executionEnvelopeDigest: 'a'.repeat(64),
  manifestDigest: 'b'.repeat(64),
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'model-rc4-persistence-'))
  roots.push(root)
  const journal = await openAttemptJournal(root, binding)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const record: any = {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    runId: 'run-1',
    attempt: 1,
    phase: 'infrastructure',
    suite: 'simple',
    armId: 'native',
    status: 'failed',
    failure: { classification: 'infrastructure', code: 'runner_crash_before_model_call', message: 'fixture' },
    manifestDigest: binding.manifestDigest,
    artifactDigest: 'c'.repeat(64),
    driverPayloadDigest: 'd'.repeat(64),
    driverStdoutDigest: 'e'.repeat(64),
    previousRecordDigest: '0'.repeat(64),
    controllerReceiptDigest: 'f'.repeat(64),
    startedAt: '2026-08-17T00:00:00.000Z',
    finishedAt: '2026-08-17T00:00:01.000Z',
  }
  record.recordDigest = digestResultRecord(record)
  await reserveAttempt(journal, {
    attemptId: record.attemptId,
    runId: record.runId,
    attempt: record.attempt,
    previousRecordDigest: record.previousRecordDigest,
  })
  await persistPendingResult(journal, record)
  return { root, journal, record, privateKey, publicKeySpkiBase64, resultsPath: join(root, 'results.jsonl') }
}

describe('RC.4 attempt persistence', () => {
  it('recovers the same digest when the signer committed before the controller crashed', async () => {
    const current = await fixture()
    let durableSignature = ''
    await expect(recoverPendingResults({
      journal: current.journal,
      records: [],
      resultsPath: current.resultsPath,
      publicKeySpkiBase64: current.publicKeySpkiBase64,
      signRecord: async (record: any) => {
        durableSignature = sign(null, Buffer.from(record.recordDigest, 'hex'), current.privateKey).toString('base64')
        throw new Error('controller crashed after remote signing')
      },
    })).rejects.toThrow('controller crashed')

    const records: any[] = []
    const recovered = await recoverPendingResults({
      journal: current.journal,
      records,
      resultsPath: current.resultsPath,
      publicKeySpkiBase64: current.publicKeySpkiBase64,
      signRecord: async (record: any) => {
        expect(record.recordDigest).toBe(current.record.recordDigest)
        return durableSignature
      },
    })
    expect(recovered.recovered).toBe(1)
    expect(records[0]).toMatchObject({ recordDigest: current.record.recordDigest, recordSignature: durableSignature })
    const events = (await readFile(current.journal.path, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(events.map(event => event.type)).toEqual(['genesis', 'reserved', 'completed'])
    expect(events.every(event => event.signingLedgerId === binding.signingLedgerId
      && event.executionEnvelopeDigest === binding.executionEnvelopeDigest
      && event.manifestDigest === binding.manifestDigest)).toBe(true)
  })

  it('repairs a crash after results append without requesting another signature', async () => {
    const current = await fixture()
    const signature = sign(null, Buffer.from(current.record.recordDigest, 'hex'), current.privateKey).toString('base64')
    const signed = { ...current.record, recordSignature: signature }
    await appendDurable(current.resultsPath, canonicalRecord(signed))
    let signingCalls = 0
    const records = [signed]
    const recovered = await recoverPendingResults({
      journal: current.journal,
      records,
      resultsPath: current.resultsPath,
      publicKeySpkiBase64: current.publicKeySpkiBase64,
      signRecord: async () => { signingCalls += 1; return signature },
    })
    expect(recovered.recovered).toBe(0)
    expect(signingCalls).toBe(0)
    expect((await readFile(current.resultsPath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('allows only one live controller and rejects another envelope binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-rc4-lock-'))
    roots.push(root)
    const attempts = await Promise.allSettled([
      acquireResultsLock(root, binding),
      acquireResultsLock(root, binding),
    ])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner: any = attempts.find(result => result.status === 'fulfilled')
    await openAttemptJournal(root, binding)
    await winner.value.release()

    await expect(openAttemptJournal(root, {
      ...binding,
      executionEnvelopeDigest: '9'.repeat(64),
    })).rejects.toThrow('binding')
  })
})
