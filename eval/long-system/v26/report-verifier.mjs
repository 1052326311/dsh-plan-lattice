import { createPublicKey, verify } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { analyzeV26, V26_PROTOCOL_ID, V26_THRESHOLDS } from './analysis.mjs'
import { summarizeOfficialRounds } from './benchmark.mjs'
import { FROZEN_MANIFEST_PATH, readV26FrozenManifest } from './manifest.mjs'

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function validateDigestRecord(record, field) {
  if (!record || typeof record !== 'object') throw new Error(`${field} must be an object`)
  const { [field]: digest, ...body } = record
  if (!/^[0-9a-f]{64}$/.test(digest ?? '') || sha256(body) !== digest) {
    throw new Error(`${field} does not authenticate its body`)
  }
  return body
}

export function validateV26ReportEnvelope(report, manifest) {
  validateDigestRecord(report, 'reportDigest')
  if (report.schemaVersion !== 1
    || report.protocolId !== V26_PROTOCOL_ID
    || report.protocolId !== manifest?.protocolId
    || report.frozenManifestDigest !== manifest?.manifestDigest
    || typeof report.runId !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{7,47}$/.test(report.runId)
    || !Array.isArray(report.attempts)
    || report.signing?.publicKeyBase64 !== manifest?.evidenceSigning?.publicKeyBase64
    || report.signing?.ledgerId !== `${V26_PROTOCOL_ID}.${report.runId}`
    || !/^[0-9a-f]{64}$/.test(report.signing?.head ?? '')
    || report.signing?.records !== report.attempts.length) {
    throw new Error('V26 report is not bound to the frozen run envelope')
  }
  const expectedIds = report.attempts.map((attempt, index) => index < V26_THRESHOLDS.requiredNativeAttempts
    ? `${report.runId}-native-${index + 1}`
    : `${report.runId}-candidate`)
  if (!same(report.attempts.map(attempt => attempt?.id), expectedIds)
    || report.attempts.length > V26_THRESHOLDS.requiredNativeAttempts + 1
    || report.candidateExecuted !== (report.attempts.length === V26_THRESHOLDS.requiredNativeAttempts + 1)) {
    throw new Error('V26 report attempt identities or candidate execution flag are inconsistent')
  }

  const nativeAttempts = report.attempts.filter(attempt => attempt?.arm === 'native')
  const qualification = analyzeV26({ protocolId: report.protocolId, attempts: nativeAttempts })
  const analysis = analyzeV26({ protocolId: report.protocolId, attempts: report.attempts })
  if (!same(report.qualification, qualification) || !same(report.analysis, analysis)) {
    throw new Error('V26 report embeds an analysis that cannot be reproduced from its attempts')
  }
  return analysis
}

export async function verifyV26SigningLedger(report, manifest, runRoot) {
  const entries = String(await readFile(join(runRoot, 'signing-ledger.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  if (entries.length !== report.attempts.length) {
    throw new Error('V26 signing ledger does not contain exactly one record per attempt')
  }
  let publicKey
  try {
    publicKey = createPublicKey({
      key: Buffer.from(manifest.evidenceSigning.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    throw new Error('V26 signing ledger public key is invalid')
  }
  let head = '0'.repeat(64)
  for (const [index, attempt] of report.attempts.entries()) {
    const { signing, ...evidence } = attempt.evidence ?? {}
    const unsigned = { ...attempt, evidence }
    const expected = {
      schemaVersion: 1,
      attemptId: attempt.id,
      runId: report.runId,
      attempt: index + 1,
      signingLedgerId: report.signing.ledgerId,
      executionEnvelopeDigest: manifest.manifestDigest,
      manifestDigest: manifest.manifestDigest,
      previousRecordDigest: head,
      recordDigest: sha256(unsigned),
      signature: signing?.signature,
    }
    if (!same(signing, expected) || !same(entries[index], expected)
      || !verify(null, Buffer.from(expected.recordDigest, 'hex'), publicKey, Buffer.from(expected.signature ?? '', 'base64'))) {
      throw new Error(`V26 attempt ${attempt.id} failed its signing-ledger proof`)
    }
    head = expected.recordDigest
  }
  if (head !== report.signing.head) throw new Error('V26 report signing head differs from the verified ledger')
}

function attemptLabel(index) {
  return index < V26_THRESHOLDS.requiredNativeAttempts ? `native-${index + 1}` : 'candidate'
}

function within(path, parent) {
  const absolute = resolve(path)
  const root = `${resolve(parent)}${sep}`
  return absolute.startsWith(root)
}

function selectedRawMetrics(raw) {
  return {
    score: raw.productGrade.rewardScore,
    cumulativeCaseScore: raw.productGrade.cumulativeCaseScore,
    historicalRequirementRegressions: raw.productGrade.historicalRequirementRegressions,
    hardRequirementsMissed: raw.productGrade.rounds.filter(round => round.reward !== 1).length,
    inputTokens: raw.metrics.inputTokens,
    outputTokens: raw.metrics.outputTokens,
    modelTurns: raw.metrics.modelTurns,
    maxTokenProductTerminals: raw.metrics.maxTokenProductTerminals,
    prematureTaskTerminals: raw.metrics.prematureTaskTerminals,
    attemptBudgetTerminals: raw.metrics.attemptBudgetTerminals,
  }
}

async function verifyReceipts(attemptRoot, raw, hiddenAssetsSha256) {
  const receiptRoot = join(attemptRoot, 'round-receipts')
  const names = (await readdir(receiptRoot)).sort()
  const receipts = []
  for (const name of names) {
    if (!/^round-[1-9](?:\.terminal)?\.json$/.test(name)) {
      throw new Error(`unexpected V26 receipt file ${name}`)
    }
    const receipt = await readJson(join(receiptRoot, name))
    const { receiptDigest, ...body } = receipt
    if (!/^[0-9a-f]{64}$/.test(receiptDigest ?? '') || sha256(body) !== receiptDigest) {
      throw new Error(`V26 receipt ${name} failed its digest`)
    }
    if (receipt.hiddenAssetsSha256 !== hiddenAssetsSha256) {
      throw new Error(`V26 receipt ${name} is not bound to the hidden task assets`)
    }
    receipts.push({ name, receipt })
  }
  const productReceipts = receipts
    .filter(entry => /^round-[1-9]\.json$/.test(entry.name))
    .map(entry => entry.receipt)
  const rebuilt = summarizeOfficialRounds(productReceipts)
  rebuilt.hidden = true
  rebuilt.hiddenAssetsSha256 = hiddenAssetsSha256
  rebuilt.staleBehavior = {
    hidden: true,
    failures: rebuilt.historicalRequirementRegressions,
    passed: rebuilt.historicalRequirementRegressions === 0,
  }
  if (!same(rebuilt, raw.productGrade)) {
    throw new Error('V26 product grade does not reproduce from immutable round receipts')
  }
  const receiptDigests = new Set(receipts.map(entry => entry.receipt.receiptDigest))
  for (const terminal of raw.budgetTerminalReceipts ?? []) {
    if (!receiptDigests.has(terminal?.receiptDigest)) {
      throw new Error('V26 budget terminal is not bound to a persisted receipt')
    }
  }
}

async function verifyCompletedAttempt({ attempt, attemptRoot, manifest }) {
  const raw = await readJson(join(attemptRoot, 'attempt-result.json'))
  if (sha256(raw) !== attempt?.evidence?.rawAttemptSha256
    || raw.attemptId !== attempt.id
    || raw.arm !== attempt.arm
    || raw.protocolId !== manifest.protocolId
    || raw.dockerImage !== manifest.image.reference
    || !same(attempt.productGrade, raw.productGrade)
    || !same(attempt.metrics, selectedRawMetrics(raw))
    || !same(attempt.trace, raw.trace)
    || !same(attempt.evidence?.outcome, raw.outcome)
    || attempt.evidence?.rootSessionId !== raw.rootSessionId
    || !same(attempt.evidence?.terminalOutcomes, raw.terminalOutcomes)
    || !same(attempt.evidence?.budgetTerminalReceipts, raw.budgetTerminalReceipts)
    || !same(attempt.evidence?.taskDigests, manifest.task.digests)
    || !same(attempt.evidence?.taskDigests, Object.fromEntries(
      Object.entries(raw.taskIdentity.digests).map(([name, identity]) => [name, identity.sha256]),
    ))) {
    throw new Error(`V26 attempt ${attempt.id} does not reproduce from its raw result`)
  }
  if (!within(raw.sessionsRoot, attemptRoot)) {
    throw new Error(`V26 attempt ${attempt.id} references Session state outside its attempt root`)
  }
  await verifyReceipts(attemptRoot, raw, manifest.task.digests.hidden)
}

async function readBudgetSnapshots(path) {
  const records = String(await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const snapshots = new Map()
  for (const record of records) {
    if (typeof record?.attemptId === 'string' && record.snapshot !== undefined) {
      snapshots.set(record.attemptId, record.snapshot)
    }
  }
  return snapshots
}

export async function verifyV26ReportFile({
  reportPath,
  manifestPath = FROZEN_MANIFEST_PATH,
}) {
  const absoluteReport = resolve(reportPath)
  const runRoot = dirname(absoluteReport)
  const [report, manifest, budgetSnapshots] = await Promise.all([
    readJson(absoluteReport),
    readV26FrozenManifest(manifestPath),
    readBudgetSnapshots(join(runRoot, 'budget-audit.jsonl')),
  ])
  const analysis = validateV26ReportEnvelope(report, manifest)
  await verifyV26SigningLedger(report, manifest, runRoot)
  for (const [index, attempt] of report.attempts.entries()) {
    const root = join(runRoot, 'attempts', attemptLabel(index))
    if (attempt.status === 'completed') {
      await verifyCompletedAttempt({ attempt, attemptRoot: root, manifest })
      if (!same(attempt.budget, budgetSnapshots.get(attempt.id))) {
        throw new Error(`V26 attempt ${attempt.id} budget does not match the host audit log`)
      }
    } else {
      const failure = await readJson(join(root, 'attempt-failure.json'))
      if (!same(failure, attempt)) throw new Error(`V26 failure ${attempt.id} differs from its exclusive record`)
    }
  }
  return {
    ...analysis,
    evidenceVerified: true,
    frozenManifestDigest: manifest.manifestDigest,
    reportDigest: report.reportDigest,
  }
}
