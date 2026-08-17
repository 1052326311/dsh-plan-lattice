import { randomUUID, verify } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createPublicKey } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { canonicalJson, sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import {
  RESULT_CHAIN_GENESIS,
  canonicalRecord,
  digestResultRecord,
} from '../../eval/v0.4/lib/attempt-integrity.mjs'

const EVENT_CHAIN_GENESIS = '0'.repeat(64)
const LOCK_DIRECTORY = '.rc4-execution.lock'
const JOURNAL_NAME = 'attempt-reservations.jsonl'
const PENDING_DIRECTORY = 'pending-results'

function exactDigest(value, context) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) throw new Error(`${context} is invalid`)
  return value
}

function exactBinding(value) {
  if (!/^[a-z0-9][a-z0-9._-]{15,127}$/u.test(value?.signingLedgerId ?? '')) {
    throw new Error('attempt ledger signingLedgerId is invalid')
  }
  return {
    signingLedgerId: value.signingLedgerId,
    executionEnvelopeDigest: exactDigest(value.executionEnvelopeDigest, 'attempt ledger executionEnvelopeDigest'),
    manifestDigest: exactDigest(value.manifestDigest, 'attempt ledger manifestDigest'),
  }
}

function same(left, right, context) {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`${context} changed`)
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

async function syncDirectory(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

export async function appendDurable(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.write(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(path))
}

export async function writeDurable(path, bytes, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, exclusive ? 'wx' : 'w', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(path))
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function acquireResultsLock(resultsDir, binding, options = {}) {
  const root = resolve(resultsDir)
  const context = exactBinding(binding)
  const lockPath = join(root, LOCK_DIRECTORY)
  const ownerPath = join(lockPath, 'owner.json')
  const owner = {
    schemaVersion: 1,
    kind: 'plan-lattice-rc4-results-lock',
    ...context,
    token: options.token ?? randomUUID(),
    pid: options.pid ?? process.pid,
    acquiredAt: options.acquiredAt ?? new Date().toISOString(),
  }
  await mkdir(root, { recursive: true })

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockPath)
      try {
        await writeDurable(ownerPath, canonicalJson(owner), { exclusive: true })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      let released = false
      const release = async () => {
        if (released) return
        const current = JSON.parse(await readFile(ownerPath, 'utf8'))
        if (current.token !== owner.token) throw new Error('results lock ownership changed before release')
        await rm(lockPath, { recursive: true, force: false })
        released = true
        await syncDirectory(root)
      }
      const releaseSync = () => {
        if (released) return
        const current = JSON.parse(readFileSync(ownerPath, 'utf8'))
        if (current.token !== owner.token) return
        released = true
        rmSync(lockPath, { recursive: true, force: false })
      }
      return { root, lockPath, owner, release, releaseSync }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let current
      try {
        current = JSON.parse(await readFile(ownerPath, 'utf8'))
      } catch {
        throw new Error('results directory contains an unreadable execution lock')
      }
      if (processAlive(current.pid)) {
        throw new Error(`results directory is already locked by live controller pid ${current.pid}`)
      }
      const stalePath = join(root, `.rc4-execution.lock.stale.${current.token ?? randomUUID()}`)
      try {
        await rename(lockPath, stalePath)
        await syncDirectory(root)
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') throw renameError
      }
    }
  }
  throw new Error('unable to acquire the exclusive results directory lock')
}

function eventCore(event) {
  const { eventDigest: _eventDigest, ...core } = event
  return core
}

function validateJournalEvents(events, binding) {
  const context = exactBinding(binding)
  let previous = EVENT_CHAIN_GENESIS
  const reservations = new Map()
  const completions = new Map()
  for (const [index, event] of events.entries()) {
    if (event?.schemaVersion !== 1 || event.sequence !== index) throw new Error(`attempt ledger sequence ${index} is invalid`)
    same({
      signingLedgerId: event.signingLedgerId,
      executionEnvelopeDigest: event.executionEnvelopeDigest,
      manifestDigest: event.manifestDigest,
    }, context, `attempt ledger binding at sequence ${index}`)
    if (event.previousEventDigest !== previous) throw new Error(`attempt ledger predecessor changed at sequence ${index}`)
    if (event.eventDigest !== sha256(eventCore(event))) throw new Error(`attempt ledger digest changed at sequence ${index}`)
    if (index === 0 && event.type !== 'genesis') throw new Error('attempt ledger must begin with genesis')
    if (index > 0 && event.type === 'genesis') throw new Error('attempt ledger contains a second genesis')
    if (event.type === 'reserved') {
      if (reservations.has(event.attemptId)) throw new Error(`attempt ${event.attemptId} was reserved more than once`)
      exactDigest(event.previousRecordDigest, 'reserved previousRecordDigest')
      if (!Number.isSafeInteger(event.attempt) || event.attempt < 1 || typeof event.runId !== 'string') {
        throw new Error(`attempt reservation at sequence ${index} is invalid`)
      }
      reservations.set(event.attemptId, event)
    } else if (event.type === 'completed') {
      const reservation = reservations.get(event.attemptId)
      if (!reservation || completions.has(event.attemptId)) throw new Error(`attempt completion at sequence ${index} is invalid`)
      exactDigest(event.recordDigest, 'completed recordDigest')
      exactDigest(event.resultLineDigest, 'completed resultLineDigest')
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(event.recordSignature ?? '')) {
        throw new Error(`attempt completion signature at sequence ${index} is invalid`)
      }
      completions.set(event.attemptId, event)
    } else if (event.type !== 'genesis') {
      throw new Error(`unknown attempt ledger event ${event.type}`)
    }
    previous = event.eventDigest
  }
  return { context, reservations, completions, head: previous }
}

async function readJournal(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`attempt ledger line ${index + 1} is invalid JSON: ${error.message}`)
    }
  })
}

async function appendJournalEvent(journal, value) {
  const prior = journal.events.at(-1)
  const core = {
    schemaVersion: 1,
    sequence: journal.events.length,
    ...journal.binding,
    previousEventDigest: prior?.eventDigest ?? EVENT_CHAIN_GENESIS,
    ...value,
  }
  const event = { ...core, eventDigest: sha256(core) }
  await appendDurable(journal.path, canonicalRecord(event))
  journal.events.push(event)
  journal.state = validateJournalEvents(journal.events, journal.binding)
  return event
}

export async function openAttemptJournal(resultsDir, binding) {
  const root = resolve(resultsDir)
  const context = exactBinding(binding)
  const path = join(root, JOURNAL_NAME)
  const events = await readJournal(path)
  const journal = { root, path, binding: context, events, state: undefined }
  if (events.length === 0) {
    await appendJournalEvent(journal, { type: 'genesis', createdAt: new Date().toISOString() })
  } else {
    journal.state = validateJournalEvents(events, context)
  }
  return journal
}

export async function reserveAttempt(journal, reservation) {
  if (journal.state.reservations.has(reservation.attemptId)) throw new Error(`attempt ${reservation.attemptId} is already reserved`)
  const unresolved = [...journal.state.reservations.keys()].filter(id => !journal.state.completions.has(id))
  if (unresolved.length > 0) throw new Error(`attempt ledger has unresolved reservation ${unresolved[0]}`)
  return appendJournalEvent(journal, {
    type: 'reserved',
    attemptId: reservation.attemptId,
    runId: reservation.runId,
    attempt: reservation.attempt,
    previousRecordDigest: exactDigest(reservation.previousRecordDigest, 'reservation previousRecordDigest'),
    reservedAt: reservation.reservedAt ?? new Date().toISOString(),
  })
}

function pendingPath(journal, attemptId) {
  return join(journal.root, PENDING_DIRECTORY, `${attemptId}.json`)
}

function validatePending(pending, journal) {
  if (pending?.schemaVersion !== 1 || pending.kind !== 'plan-lattice-rc4-pending-result') {
    throw new Error('pending result identity is invalid')
  }
  same({
    signingLedgerId: pending.signingLedgerId,
    executionEnvelopeDigest: pending.executionEnvelopeDigest,
    manifestDigest: pending.manifestDigest,
  }, journal.binding, 'pending result binding')
  const reservation = journal.state.reservations.get(pending.record?.attemptId)
  if (!reservation || reservation.eventDigest !== pending.reservationEventDigest) {
    throw new Error('pending result does not match an attempt reservation')
  }
  if (pending.record.recordSignature !== undefined) throw new Error('pending result must be persisted before signing')
  if (pending.record.recordDigest !== digestResultRecord(pending.record)) throw new Error('pending result digest changed')
  if (pending.record.recordDigest !== pending.recordDigest
    || pending.record.runId !== reservation.runId
    || pending.record.attempt !== reservation.attempt
    || pending.record.previousRecordDigest !== reservation.previousRecordDigest
    || pending.record.manifestDigest !== journal.binding.manifestDigest) {
    throw new Error('pending result differs from its reservation')
  }
  return pending
}

export async function persistPendingResult(journal, record) {
  const reservation = journal.state.reservations.get(record.attemptId)
  if (!reservation) throw new Error(`attempt ${record.attemptId} was not reserved before execution`)
  const path = pendingPath(journal, record.attemptId)
  if (await exists(path)) {
    const existing = validatePending(JSON.parse(await readFile(path, 'utf8')), journal)
    if (canonicalJson(existing.record) !== canonicalJson(record)) {
      throw new Error(`pending result ${record.attemptId} already exists with different content`)
    }
    return { path, pending: existing }
  }
  const pending = validatePending({
    schemaVersion: 1,
    kind: 'plan-lattice-rc4-pending-result',
    ...journal.binding,
    reservationEventDigest: reservation.eventDigest,
    recordDigest: record.recordDigest,
    persistedAt: new Date().toISOString(),
    record,
  }, journal)
  const bytes = canonicalJson(pending)
  await writeDurable(path, bytes, { exclusive: true })
  return { path, pending }
}

async function loadPendingResults(journal) {
  const root = join(journal.root, PENDING_DIRECTORY)
  if (!(await exists(root))) return new Map()
  const entries = await readdir(root, { withFileTypes: true })
  const pending = new Map()
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error(`pending result directory contains unsupported entry ${entry.name}`)
    const value = validatePending(JSON.parse(await readFile(join(root, entry.name), 'utf8')), journal)
    if (`${value.record.attemptId}.json` !== entry.name || pending.has(value.record.attemptId)) {
      throw new Error(`pending result filename does not match ${value.record.attemptId}`)
    }
    pending.set(value.record.attemptId, value)
  }
  return pending
}

function verifySignedRecord(record, records, publicKeySpkiBase64) {
  const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
  if (!verify(null, Buffer.from(record.recordDigest, 'hex'), key, Buffer.from(record.recordSignature, 'base64'))) {
    throw new Error(`pending result signature is invalid for ${record.attemptId}`)
  }
  const expectedPrevious = records.at(-1)?.recordDigest ?? RESULT_CHAIN_GENESIS
  if (record.previousRecordDigest !== expectedPrevious) throw new Error(`pending result chain head changed for ${record.attemptId}`)
}

async function appendCompletion(journal, record) {
  if (journal.state.completions.has(record.attemptId)) return journal.state.completions.get(record.attemptId)
  return appendJournalEvent(journal, {
    type: 'completed',
    attemptId: record.attemptId,
    recordDigest: record.recordDigest,
    recordSignature: record.recordSignature,
    resultLineDigest: sha256(canonicalRecord(record)),
    completedAt: new Date().toISOString(),
  })
}

export async function recoverPendingResults({
  journal,
  records,
  resultsPath,
  publicKeySpkiBase64,
  signRecord,
}) {
  const pendingByAttempt = await loadPendingResults(journal)
  const recordsByAttempt = new Map(records.map(record => [record.attemptId, record]))
  let recovered = 0

  for (const reservation of journal.state.reservations.values()) {
    const pending = pendingByAttempt.get(reservation.attemptId)
    const existing = recordsByAttempt.get(reservation.attemptId)
    const completion = journal.state.completions.get(reservation.attemptId)
    if (!pending && !existing) {
      throw new Error(`reserved attempt ${reservation.attemptId} has no pending result; refusing a duplicate model call`)
    }
    if (!pending) throw new Error(`attempt ${reservation.attemptId} has a result but no immutable pending record`)

    if (existing) {
      if (existing.recordDigest !== pending.recordDigest) throw new Error(`result ${reservation.attemptId} differs from its pending digest`)
      verifySignedRecord(existing, records.slice(0, records.indexOf(existing)), publicKeySpkiBase64)
      if (completion && (completion.recordDigest !== existing.recordDigest
        || completion.recordSignature !== existing.recordSignature
        || completion.resultLineDigest !== sha256(canonicalRecord(existing)))) {
        throw new Error(`completion ${reservation.attemptId} changed`)
      }
      if (!completion) await appendCompletion(journal, existing)
      continue
    }
    if (completion) throw new Error(`attempt ${reservation.attemptId} is completed without a result record`)

    const unsigned = structuredClone(pending.record)
    if (unsigned.recordDigest !== pending.recordDigest) throw new Error(`pending record digest changed for ${reservation.attemptId}`)
    const signature = await signRecord(unsigned)
    const signed = { ...unsigned, recordSignature: signature }
    verifySignedRecord(signed, records, publicKeySpkiBase64)
    await appendDurable(resultsPath, canonicalRecord(signed))
    records.push(signed)
    recordsByAttempt.set(signed.attemptId, signed)
    await appendCompletion(journal, signed)
    recovered += 1
  }

  for (const record of records) {
    if (!journal.state.reservations.has(record.attemptId) || !journal.state.completions.has(record.attemptId)) {
      throw new Error(`result ${record.attemptId} is absent from the bound attempt ledger`)
    }
  }

  return { recovered, records, journalHead: journal.state.head }
}

export const attemptPersistencePaths = Object.freeze({
  lockDirectory: LOCK_DIRECTORY,
  journalName: JOURNAL_NAME,
  pendingDirectory: PENDING_DIRECTORY,
})
