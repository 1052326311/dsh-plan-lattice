import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson } from '../eval/v0.4/lib/canonical.mjs'
import { canonicalRecord, digestResultRecord } from '../eval/v0.4/lib/attempt-integrity.mjs'
import {
  acquireResultsLock,
  appendDurable,
  commitModelInvocation,
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
  await commitModelInvocation(journal, record.attemptId)
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
    expect(events.map(event => event.type)).toEqual([
      'genesis',
      'reserved',
      'invocation-committed',
      'response-persisted',
      'completed',
    ])
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

  it('records a retryable failure when the controller crashes before committing a model call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-rc4-before-call-'))
    roots.push(root)
    const journal = await openAttemptJournal(root, binding)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    await reserveAttempt(journal, {
      attemptId: 'before-call',
      runId: 'run-before-call',
      attempt: 1,
      previousRecordDigest: '0'.repeat(64),
      reservedAt: '2026-08-17T00:00:00.000Z',
    })
    const recoveredJournal = await openAttemptJournal(root, binding)
    let recoveryCalls = 0
    const records: any[] = []
    const recovered = await recoverPendingResults({
      journal: recoveredJournal,
      records,
      resultsPath: join(root, 'results.jsonl'),
      publicKeySpkiBase64,
      signRecord: async (record: any) => sign(null, Buffer.from(record.recordDigest, 'hex'), privateKey).toString('base64'),
      recoverAbandonedAttempt: async ({ reservation, recovery }: any) => {
        recoveryCalls += 1
        expect(recovery.stage).toBe('before-invocation')
        const record: any = {
          schemaVersion: 1,
          attemptId: reservation.attemptId,
          runId: reservation.runId,
          attempt: reservation.attempt,
          phase: 'infrastructure',
          suite: 'simple',
          armId: 'native',
          status: 'failed',
          failure: { classification: 'infrastructure', code: 'runner_crash_before_model_call', message: 'crashed before call commit' },
          manifestDigest: binding.manifestDigest,
          artifactDigest: '1'.repeat(64),
          driverPayloadDigest: '2'.repeat(64),
          driverStdoutDigest: '3'.repeat(64),
          previousRecordDigest: reservation.previousRecordDigest,
          controllerReceiptDigest: '4'.repeat(64),
          startedAt: reservation.reservedAt,
          finishedAt: recovery.recoveryAt,
        }
        record.recordDigest = digestResultRecord(record)
        return record
      },
    })
    expect(recovered.recovered).toBe(1)
    expect(recoveryCalls).toBe(1)
    expect(records[0].failure).toMatchObject({ classification: 'infrastructure', code: 'runner_crash_before_model_call' })
    expect(recoveredJournal.events.map(event => event.type)).toEqual([
      'genesis', 'reserved', 'recovery-started', 'response-persisted', 'completed',
    ])
  })

  it('records a non-rerunnable failure when a committed model call crashes without a result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-rc4-during-call-'))
    roots.push(root)
    const journal = await openAttemptJournal(root, binding)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    await reserveAttempt(journal, {
      attemptId: 'during-call',
      runId: 'run-during-call',
      attempt: 1,
      previousRecordDigest: '0'.repeat(64),
    })
    await commitModelInvocation(journal, 'during-call')
    const recoveredJournal = await openAttemptJournal(root, binding)
    let recoveryCalls = 0
    let signingCalls = 0
    const records: any[] = []
    const resultsPath = join(root, 'results.jsonl')
    const recoverAbandonedAttempt = async ({ reservation, recovery }: any) => {
      recoveryCalls += 1
      expect(recovery.stage).toBe('invocation-uncertain')
      const record: any = {
        schemaVersion: 1,
        attemptId: reservation.attemptId,
        runId: reservation.runId,
        attempt: reservation.attempt,
        phase: 'statistical',
        suite: 'icae',
        armId: 'contract',
        status: 'failed',
        failure: { classification: 'task', code: 'controller_crash_after_model_call_committed', message: 'outcome unknown; never rerun' },
        manifestDigest: binding.manifestDigest,
        artifactDigest: '5'.repeat(64),
        driverPayloadDigest: '6'.repeat(64),
        driverStdoutDigest: '7'.repeat(64),
        previousRecordDigest: reservation.previousRecordDigest,
        controllerReceiptDigest: '8'.repeat(64),
        startedAt: reservation.reservedAt,
        finishedAt: recovery.recoveryAt,
      }
      record.recordDigest = digestResultRecord(record)
      return record
    }
    const signRecord = async (record: any) => {
      signingCalls += 1
      return sign(null, Buffer.from(record.recordDigest, 'hex'), privateKey).toString('base64')
    }
    await recoverPendingResults({ journal: recoveredJournal, records, resultsPath, publicKeySpkiBase64, signRecord, recoverAbandonedAttempt })
    const reopenedAgain = await openAttemptJournal(root, binding)
    await recoverPendingResults({ journal: reopenedAgain, records, resultsPath, publicKeySpkiBase64, signRecord, recoverAbandonedAttempt })
    expect(recoveryCalls).toBe(1)
    expect(signingCalls).toBe(1)
    expect(records).toHaveLength(1)
    expect(records[0].failure).toMatchObject({ classification: 'task', code: 'controller_crash_after_model_call_committed' })
  })

  it('reuses the durable recovery decision when recovery itself crashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-rc4-recovery-restart-'))
    roots.push(root)
    const journal = await openAttemptJournal(root, binding)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    await reserveAttempt(journal, {
      attemptId: 'recovery-restart',
      runId: 'run-recovery-restart',
      attempt: 1,
      previousRecordDigest: '0'.repeat(64),
    })
    await commitModelInvocation(journal, 'recovery-restart')
    let recoveryIdentity: string | undefined
    await expect(recoverPendingResults({
      journal: await openAttemptJournal(root, binding),
      records: [],
      resultsPath: join(root, 'results.jsonl'),
      publicKeySpkiBase64,
      signRecord: async () => { throw new Error('signer must not run') },
      recoverAbandonedAttempt: async ({ recovery }: any) => {
        recoveryIdentity = `${recovery.eventDigest}:${recovery.recoveryAt}`
        throw new Error('crashed while materializing recovery')
      },
    })).rejects.toThrow('crashed while materializing recovery')

    const records: any[] = []
    await recoverPendingResults({
      journal: await openAttemptJournal(root, binding),
      records,
      resultsPath: join(root, 'results.jsonl'),
      publicKeySpkiBase64,
      signRecord: async (record: any) => sign(null, Buffer.from(record.recordDigest, 'hex'), privateKey).toString('base64'),
      recoverAbandonedAttempt: async ({ reservation, recovery }: any) => {
        expect(`${recovery.eventDigest}:${recovery.recoveryAt}`).toBe(recoveryIdentity)
        const record: any = {
          schemaVersion: 1,
          attemptId: reservation.attemptId,
          runId: reservation.runId,
          attempt: reservation.attempt,
          phase: 'statistical',
          suite: 'evocode',
          armId: 'lattice',
          status: 'failed',
          failure: { classification: 'task', code: 'controller_crash_after_model_call_committed', message: 'durable recovery decision' },
          manifestDigest: binding.manifestDigest,
          artifactDigest: '9'.repeat(64),
          driverPayloadDigest: 'a'.repeat(64),
          driverStdoutDigest: 'b'.repeat(64),
          previousRecordDigest: reservation.previousRecordDigest,
          controllerReceiptDigest: 'c'.repeat(64),
          startedAt: reservation.reservedAt,
          finishedAt: recovery.recoveryAt,
        }
        record.recordDigest = digestResultRecord(record)
        return record
      },
    })
    expect(records).toHaveLength(1)
    expect(records[0].failure.code).toBe('controller_crash_after_model_call_committed')
  })

  it('rejects a response before invocation permission is durably committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-rc4-invalid-transition-'))
    roots.push(root)
    const journal = await openAttemptJournal(root, binding)
    const record: any = {
      schemaVersion: 1,
      attemptId: 'invalid-transition',
      runId: 'run-invalid-transition',
      attempt: 1,
      phase: 'infrastructure',
      suite: 'simple',
      armId: 'native',
      status: 'failed',
      failure: { classification: 'infrastructure', code: 'runner_crash_before_model_call', message: 'invalid direct response' },
      manifestDigest: binding.manifestDigest,
      artifactDigest: 'd'.repeat(64),
      driverPayloadDigest: 'e'.repeat(64),
      driverStdoutDigest: 'f'.repeat(64),
      previousRecordDigest: '0'.repeat(64),
      controllerReceiptDigest: '1'.repeat(64),
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
    await expect(persistPendingResult(journal, record)).rejects.toThrow('before invocation or crash recovery')
  })

  it('discards only recognized torn-write temporaries during pending recovery', async () => {
    const current = await fixture()
    const pendingRoot = join(current.root, 'pending-results')
    await writeFile(join(pendingRoot, 'attempt-2.json.tmp.12345.00000000-0000-4000-8000-000000000000'), 'partial')
    const records: any[] = []
    await recoverPendingResults({
      journal: await openAttemptJournal(current.root, binding),
      records,
      resultsPath: current.resultsPath,
      publicKeySpkiBase64: current.publicKeySpkiBase64,
      signRecord: async (record: any) => sign(null, Buffer.from(record.recordDigest, 'hex'), current.privateKey).toString('base64'),
    })
    expect(records).toHaveLength(1)
  })

  it('finalizes the exact immutable response after a crash without invoking recovery synthesis', async () => {
    const current = await fixture()
    const journalLines = (await readFile(current.journal.path, 'utf8')).trim().split('\n')
    expect(JSON.parse(journalLines.at(-1)!).type).toBe('response-persisted')
    await writeFile(current.journal.path, `${journalLines.slice(0, -1).join('\n')}\n`)
    const recoveredJournal = await openAttemptJournal(current.root, binding)
    let recoveryCalls = 0
    const records: any[] = []
    const recovered = await recoverPendingResults({
      journal: recoveredJournal,
      records,
      resultsPath: current.resultsPath,
      publicKeySpkiBase64: current.publicKeySpkiBase64,
      signRecord: async (record: any) => sign(null, Buffer.from(record.recordDigest, 'hex'), current.privateKey).toString('base64'),
      recoverAbandonedAttempt: async () => { recoveryCalls += 1; throw new Error('must not synthesize') },
    })
    expect(recovered.recovered).toBe(1)
    expect(recoveryCalls).toBe(0)
    expect(records[0].recordDigest).toBe(current.record.recordDigest)
    expect(recoveredJournal.events.map(event => event.type)).toEqual([
      'genesis', 'reserved', 'invocation-committed', 'response-persisted', 'completed',
    ])
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
