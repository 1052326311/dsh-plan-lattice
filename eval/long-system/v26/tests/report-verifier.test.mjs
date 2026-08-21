import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyzeV26, V26_PROTOCOL_ID } from '../analysis.mjs'
import {
  validateV26ReportEnvelope,
  verifyV26SigningLedger,
} from '../report-verifier.mjs'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'

const RUN_ID = 'v26-report-fixture-run'
const MANIFEST_DIGEST = 'f'.repeat(64)

function grade(passedRounds) {
  const rounds = Array.from({ length: 9 }, (_, index) => {
    const round = index + 1
    const passed = round <= passedRounds
    const cases = [{ identity: `round-${round}:fixture:${round}`, originRound: round, status: passed ? 'success' : 'fail' }]
    return {
      round,
      reached: true,
      reward: passed ? 1 : 0,
      total: 1,
      successes: passed ? 1 : 0,
      failures: passed ? 0 : 1,
      caseRatio: passed ? 1 : 0,
      cases,
    }
  })
  return {
    hidden: true,
    hiddenAssetsSha256: 'a'.repeat(64),
    rounds,
    reachedRounds: 9,
    rewardScore: 100 * passedRounds / 9,
    cumulativeCaseScore: 100 * passedRounds / 9,
    historicalRequirementRegressions: 0,
    historicalRegressionKeys: [],
  }
}

function attempt(arm, ordinal, passedRounds) {
  const id = arm === 'native' ? `${RUN_ID}-native-${ordinal}` : `${RUN_ID}-candidate`
  const productGrade = grade(passedRounds)
  const native = arm === 'native'
  return {
    id,
    arm,
    status: 'completed',
    productGrade,
    metrics: {
      score: productGrade.rewardScore,
      cumulativeCaseScore: productGrade.cumulativeCaseScore,
      historicalRequirementRegressions: 0,
      hardRequirementsMissed: 9 - passedRounds,
      inputTokens: 1000,
      outputTokens: 100,
      modelTurns: 10,
      maxTokenProductTerminals: native ? 1 : 0,
      prematureTaskTerminals: native ? 1 : 0,
      attemptBudgetTerminals: 0,
    },
    trace: native ? null : { valid: true },
    budget: {
      attemptId: id,
      agentRequests: 10,
      inputTokens: 1000,
      outputTokens: 100,
      missingUsageResponses: 0,
      budgetRejections: 0,
      localBudgetRejections: 0,
      upstreamHttp429: 0,
      upstreamTransportErrors: 0,
      agentRequestSequence: 10,
      firstBudgetRejection: null,
      limits: { maxAgentRequests: 100, maxInputTokens: 10_000, maxOutputTokens: 10_000 },
    },
    evidence: {
      outcome: native
        ? { class: 'premature-terminal', terminalKind: 'max-tokens', stageId: 'round-9' }
        : { class: 'completed', terminalKind: 'completed', stageId: 'round-9' },
      terminalOutcomes: [{
        stageId: 'round-9', kind: 'product', terminalKind: native ? 'max-tokens' : 'completed',
      }],
      budgetTerminalReceipts: [],
    },
  }
}

function signedReport() {
  const keys = generateKeyPairSync('ed25519')
  const publicKeyBase64 = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const ledgerId = `${V26_PROTOCOL_ID}.${RUN_ID}`
  const unsignedAttempts = [
    ...Array.from({ length: 5 }, (_, index) => attempt('native', index + 1, 5)),
    attempt('v0.4-native-continuity', 1, 9),
  ]
  let head = '0'.repeat(64)
  const entries = []
  const attempts = unsignedAttempts.map((unsigned, index) => {
    const recordDigest = sha256(unsigned)
    const entry = {
      schemaVersion: 1,
      attemptId: unsigned.id,
      runId: RUN_ID,
      attempt: index + 1,
      signingLedgerId: ledgerId,
      executionEnvelopeDigest: MANIFEST_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      previousRecordDigest: head,
      recordDigest,
      signature: sign(null, Buffer.from(recordDigest, 'hex'), keys.privateKey).toString('base64'),
    }
    entries.push(entry)
    head = recordDigest
    return { ...unsigned, evidence: { ...unsigned.evidence, signing: entry } }
  })
  const qualification = analyzeV26({ protocolId: V26_PROTOCOL_ID, attempts: attempts.slice(0, 5) })
  const analysis = analyzeV26({ protocolId: V26_PROTOCOL_ID, attempts })
  const body = {
    schemaVersion: 1,
    runId: RUN_ID,
    protocolId: V26_PROTOCOL_ID,
    frozenManifestDigest: MANIFEST_DIGEST,
    completedAt: '2026-08-21T00:00:00.000Z',
    candidateExecuted: true,
    signing: { publicKeyBase64, ledgerId, head, records: attempts.length },
    attempts,
    qualification,
    analysis,
  }
  return {
    report: { ...body, reportDigest: sha256(body) },
    manifest: {
      protocolId: V26_PROTOCOL_ID,
      manifestDigest: MANIFEST_DIGEST,
      evidenceSigning: {
        publicKeyBase64,
        publicKeySha256: sha256(Buffer.from(publicKeyBase64, 'base64')),
      },
    },
    entries,
  }
}

test('accepts only a digest-valid exact-protocol report with reproducible analysis', () => {
  const { report, manifest } = signedReport()
  assert.equal(validateV26ReportEnvelope(report, manifest).releaseAllowed, true)

  const crossProtocol = structuredClone(report)
  crossProtocol.protocolId = 'another-protocol'
  crossProtocol.reportDigest = sha256(Object.fromEntries(
    Object.entries(crossProtocol).filter(([key]) => key !== 'reportDigest'),
  ))
  assert.throws(() => validateV26ReportEnvelope(crossProtocol, manifest), /frozen run envelope/)

  const staleDigest = structuredClone(report)
  staleDigest.attempts[0].metrics.score = 100
  assert.throws(() => validateV26ReportEnvelope(staleDigest, manifest), /does not authenticate/)
})

test('verifies every attempt digest, signature, sequence, and chain head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v26-signing-'))
  const { report, manifest, entries } = signedReport()
  try {
    await writeFile(join(root, 'signing-ledger.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    await verifyV26SigningLedger(report, manifest, root)

    const replacement = generateKeyPairSync('ed25519')
    const unanchored = structuredClone(report)
    unanchored.signing.publicKeyBase64 = replacement.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    unanchored.reportDigest = sha256(Object.fromEntries(
      Object.entries(unanchored).filter(([key]) => key !== 'reportDigest'),
    ))
    assert.throws(() => validateV26ReportEnvelope(unanchored, manifest), /frozen run envelope/)

    const forged = structuredClone(report)
    forged.attempts[0].metrics.inputTokens += 1
    await assert.rejects(verifyV26SigningLedger(forged, manifest, root), /signing-ledger proof/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
