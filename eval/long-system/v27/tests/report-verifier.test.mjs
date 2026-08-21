import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { analyzeV27, V27_EXECUTION_PLAN, V27_PROTOCOL_ID } from '../analysis.mjs'
import {
  validateV27ReportEnvelope,
  rebuildV27TraceFromDisk,
  verifyV27AttemptDirectoryClosure,
  verifyV27AnalyzerCheckout,
  verifyV27BudgetAudit,
  verifyV27ModelAudit,
  verifyV27ModelBudgetReconciliation,
  verifyV27SigningLedger,
  verifyV27TrialTerminal,
  verifyV27WrapperEvidence,
} from '../report-verifier.mjs'
import { canonicalJson, sha256 } from '../../../v0.4/lib/canonical.mjs'
import { materializeLongSystemWrapper } from '../driver/runtime.mjs'
import { buildCandidateActivationReceiptBody } from '../driver/evocode-runner.mjs'

const RUN_ID = 'v27-report-fixture-run'
const MANIFEST_DIGEST = 'f'.repeat(64)
const MANIFEST_COMMIT = 'd'.repeat(40)
const EXECUTION_ENVELOPE_DIGEST = 'e'.repeat(64)

test('reconstructs Native and Candidate wrapper payloads from the retained driver snapshot', async (context) => {
  const runRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-wrapper-evidence-'))
  context.after(() => rm(runRoot, { recursive: true, force: true }))
  const driverRoot = join(
    runRoot,
    'input-snapshot',
    'driver-repository',
    'eval',
    'long-system',
    'v27',
    'driver',
  )
  await mkdir(join(runRoot, 'attempts'), { recursive: true })
  await cp(fileURLToPath(new URL('../driver', import.meta.url)), driverRoot, { recursive: true })
  const candidatePackage = join(runRoot, 'input-snapshot', 'candidate-package.tgz')
  await writeFile(candidatePackage, 'fixture candidate path')

  for (const candidate of [false, true]) {
    const label = candidate ? 'pair-1-candidate' : 'pair-1-native'
    const packageName = candidate
      ? 'dsh-plan-lattice-long-system-wrapper'
      : 'dsh-plan-lattice-long-system-native-wrapper'
    const attemptRoot = join(runRoot, 'attempts', label)
    await mkdir(attemptRoot)
    const wrapper = await materializeLongSystemWrapper(
      attemptRoot,
      candidate ? candidatePackage : undefined,
      driverRoot,
    )
    const unpack = join(attemptRoot, 'installed-wrapper')
    const modules = join(attemptRoot, 'dsh-home', 'profiles', 'headless', 'node_modules')
    await Promise.all([mkdir(unpack), mkdir(modules, { recursive: true })])
    const extracted = spawnSync('/usr/bin/tar', ['-xzf', wrapper.path, '-C', unpack], { encoding: 'utf8' })
    assert.equal(extracted.status, 0, extracted.stderr)
    await rename(join(unpack, 'package'), join(modules, packageName))
    const attempt = {
      id: `fixture-${label}`,
      arm: candidate ? 'v0.4-native-continuity' : 'native',
    }
    const raw = {
      wrapperPackageSha256: wrapper.digest,
      pluginIdentity: candidate ? { wrapperPackageSha256: wrapper.digest } : null,
    }
    await verifyV27WrapperEvidence({ attempt, attemptRoot, raw })
    await writeFile(join(modules, packageName, 'common-prompt.js'), 'tampered installed wrapper')
    await assert.rejects(
      verifyV27WrapperEvidence({ attempt, attemptRoot, raw }),
      /differs from frozen driver input/,
    )
  }
})

function grade(passedRounds, reachedRounds) {
  const rounds = Array.from({ length: 9 }, (_, index) => {
    const round = index + 1
    if (round > reachedRounds) {
      return {
        round, reached: false, reward: 0, total: 0, successes: 0,
        failures: 0, caseRatio: 0, summaryPresent: false, cases: [],
      }
    }
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
    reachedRounds,
    rewardScore: 100 * passedRounds / 9,
    cumulativeCaseScore: 100 * passedRounds / 9,
    historicalRequirementRegressions: 0,
    historicalRegressionKeys: [],
  }
}

function candidateActivations(attemptId) {
  return [1, 2].map(epoch => {
    const body = buildCandidateActivationReceiptBody({
      attemptId,
      epoch,
      epochSha256: String(epoch).repeat(64),
      processPid: 12344 + epoch,
      processNonce: String(epoch).repeat(64),
      pluginIdentity: {
        candidateCommit: 'c'.repeat(40),
        candidateVersion: '0.4.0-rc.9',
        candidatePackageSha256: 'a'.repeat(64),
        candidatePayloadSha256: 'b'.repeat(64),
        wrapperPackageSha256: 'd'.repeat(64),
      },
      pluginConfig: {
        activationMode: 'auto',
        clarificationPolicy: 'critical',
        controlCeiling: 'lattice',
      },
      bashAdapterSha256: 'e'.repeat(64),
    })
    return { ...body, activationReceiptDigest: sha256(body) }
  })
}

function attempt(slot, passedRounds) {
  const arm = slot.arm
  const id = `${RUN_ID}-${slot.label}`
  const native = arm === 'native'
  const reachedRounds = native ? 1 : 9
  const productGrade = grade(passedRounds, reachedRounds)
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
        ? { class: 'premature-terminal', terminalKind: 'max-tokens', stageId: 'round-1' }
        : { class: 'completed', terminalKind: 'completed', stageId: 'round-9' },
      terminalOutcomes: Array.from({ length: reachedRounds }, (_, index) => ({
        stageId: `round-${index + 1}`,
        kind: 'product',
        terminalKind: native ? 'max-tokens' : 'completed',
      })),
      budgetTerminalReceipts: [],
      processEpochs: native ? 1 : 2,
      candidateActivations: native ? [] : candidateActivations(id),
    },
  }
}

function signedReport() {
  const keys = generateKeyPairSync('ed25519')
  const publicKeyBase64 = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const ledgerId = `${V27_PROTOCOL_ID}.${RUN_ID}`
  const unsignedAttempts = [
    ...V27_EXECUTION_PLAN.map(slot => attempt(slot, slot.arm === 'native' ? 0 : 9)),
  ]
  let head = '0'.repeat(64)
  const entries = []
  const attempts = unsignedAttempts.map((unsigned, index) => {
    const recordDigest = sha256(unsigned)
    const body = {
      schemaVersion: 3,
      attemptId: unsigned.id,
      runId: RUN_ID,
      ordinal: index + 1,
      signingLedgerId: ledgerId,
      executionEnvelopeDigest: EXECUTION_ENVELOPE_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      manifestCommit: MANIFEST_COMMIT,
      previousRecordDigest: head,
      recordDigest,
    }
    const signaturePayloadDigest = sha256(canonicalJson(body))
    const entry = {
      schemaVersion: 3,
      body,
      signaturePayloadDigest,
      signature: sign(null, Buffer.from(signaturePayloadDigest, 'hex'), keys.privateKey).toString('base64'),
    }
    entries.push(entry)
    head = signaturePayloadDigest
    return { ...unsigned, evidence: { ...unsigned.evidence, signing: entry } }
  })
  const analysis = analyzeV27({ protocolId: V27_PROTOCOL_ID, attempts })
  const body = {
    schemaVersion: 3,
    runId: RUN_ID,
    protocolId: V27_PROTOCOL_ID,
    frozenManifestDigest: MANIFEST_DIGEST,
    manifestCommit: MANIFEST_COMMIT,
    executionEnvelopeDigest: EXECUTION_ENVELOPE_DIGEST,
    completedAt: '2026-08-21T00:00:00.000Z',
    candidateExecuted: true,
    signing: { publicKeyBase64, ledgerId, head, records: attempts.length },
    attempts,
    qualification: analysis.qualification,
    analysis,
  }
  return {
    report: { ...body, reportDigest: sha256(body) },
    manifest: {
      protocolId: V27_PROTOCOL_ID,
      manifestDigest: MANIFEST_DIGEST,
      evidenceSigning: {
        publicKeyBase64,
        publicKeySha256: sha256(Buffer.from(publicKeyBase64, 'base64')),
      },
    },
    entries,
    keys,
  }
}

test('accepts only a digest-valid exact-protocol report with reproducible analysis', () => {
  const { report, manifest } = signedReport()
  assert.equal(validateV27ReportEnvelope(report, manifest).releaseAllowed, true)

  const crossProtocol = structuredClone(report)
  crossProtocol.protocolId = 'another-protocol'
  crossProtocol.reportDigest = sha256(Object.fromEntries(
    Object.entries(crossProtocol).filter(([key]) => key !== 'reportDigest'),
  ))
  assert.throws(() => validateV27ReportEnvelope(crossProtocol, manifest), /frozen run envelope/)

  const staleDigest = structuredClone(report)
  staleDigest.attempts[0].metrics.score = 100
  assert.throws(() => validateV27ReportEnvelope(staleDigest, manifest), /does not authenticate/)
})

test('verifies every attempt digest, signature, sequence, and chain head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-signing-'))
  const { report, manifest, entries } = signedReport()
  try {
    await writeFile(join(root, 'signing-ledger.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    await verifyV27SigningLedger(report, manifest, root)

    const replacement = generateKeyPairSync('ed25519')
    const unanchored = structuredClone(report)
    unanchored.signing.publicKeyBase64 = replacement.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    unanchored.reportDigest = sha256(Object.fromEntries(
      Object.entries(unanchored).filter(([key]) => key !== 'reportDigest'),
    ))
    assert.throws(() => validateV27ReportEnvelope(unanchored, manifest), /frozen run envelope/)

    const forged = structuredClone(report)
    forged.attempts[0].metrics.inputTokens += 1
    await assert.rejects(verifyV27SigningLedger(forged, manifest, root), /signing-ledger proof/)

    for (const mutate of [
      entry => { entry.body.manifestDigest = 'a'.repeat(64) },
      entry => { entry.body.ordinal += 1 },
      entry => { entry.body.previousRecordDigest = 'b'.repeat(64) },
    ]) {
      const alteredEntries = structuredClone(entries)
      mutate(alteredEntries[0])
      await writeFile(join(root, 'signing-ledger.jsonl'), `${alteredEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
      await assert.rejects(verifyV27SigningLedger(report, manifest, root), /signing-ledger proof/)
    }

    await writeFile(join(root, 'signing-ledger.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    const alteredBudget = structuredClone(report)
    alteredBudget.attempts[0].budget.limits.maxInputTokens += 1
    await assert.rejects(verifyV27SigningLedger(alteredBudget, manifest, root), /signing-ledger proof/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects extra attempts and closes every model and budget audit record', async (context) => {
  const runRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-audit-closure-'))
  context.after(() => rm(runRoot, { recursive: true, force: true }))
  const attemptsRoot = join(runRoot, 'attempts')
  await mkdir(attemptsRoot)
  const attempts = V27_EXECUTION_PLAN.slice(0, 2).map((slot, index) => ({
    id: `audit-attempt-${index + 1}`,
    status: 'completed',
    arm: slot.arm,
  }))
  await Promise.all(V27_EXECUTION_PLAN.slice(0, 2).map(slot => mkdir(join(attemptsRoot, slot.label))))
  assert.equal((await verifyV27AttemptDirectoryClosure({ runRoot, attempts })).length, 2)
  await mkdir(join(attemptsRoot, 'replacement-attempt'))
  await assert.rejects(
    verifyV27AttemptDirectoryClosure({ runRoot, attempts }),
    /directory set differs/,
  )

  const manifest = {
    model: {
      id: 'deepseek-v4-flash',
      temperature: 0,
      agentMaxOutputTokens: 32768,
      compactionMaxOutputTokens: 8192,
    },
    budgetPerAttempt: { maxAgentRequests: 10, maxInputTokens: 1000, maxOutputTokens: 1000 },
  }
  const modelRecords = attempts.flatMap((attempt, index) => {
    const sequence = index + 1
    return [
      {
        event: 'request', sequence, attemptId: attempt.id, role: 'agent', method: 'POST',
        path: '/chat/completions', compact: false, contractValid: true,
        model: manifest.model.id, temperature: 0, maxTokens: 32768,
      },
      { event: 'response', sequence, attemptId: attempt.id, role: 'agent', status: 200, usage: {} },
    ]
  })
  const modelAudit = verifyV27ModelAudit(modelRecords, attempts, manifest)
  assert.equal(modelAudit.requests, 2)
  assert.throws(
    () => verifyV27ModelAudit([...modelRecords, {
      event: 'request', sequence: 3, attemptId: 'replacement-attempt', role: 'agent', contractValid: true,
    }], attempts, manifest),
    /unknown attempt/,
  )
  assert.throws(
    () => verifyV27ModelAudit(modelRecords.slice(0, -1), attempts, manifest),
    /does not close/,
  )
  assert.throws(
    () => verifyV27ModelAudit(modelRecords.map(record => record.event === 'request'
      ? { ...record, path: 'https://escape.invalid/chat/completions' }
      : record), attempts, manifest),
    /frozen model envelope/,
  )

  const budgetRecords = attempts.flatMap(attempt => {
    const snapshot = {
      attemptId: attempt.id,
      agentRequests: 1,
      inputTokens: 10,
      outputTokens: 5,
      missingUsageResponses: 0,
      budgetRejections: 0,
      localBudgetRejections: 0,
      upstreamHttp429: 0,
      upstreamTransportErrors: 0,
      agentRequestSequence: 1,
      limits: manifest.budgetPerAttempt,
    }
    return [
      { event: 'budget-activated', attemptId: attempt.id, limits: manifest.budgetPerAttempt },
      { event: 'agent-response', attemptId: attempt.id, status: 200, usage: {}, snapshot },
    ]
  })
  const budgetAudit = verifyV27BudgetAudit(budgetRecords, attempts, manifest)
  assert.equal(budgetAudit.snapshots.size, 2)
  assert.doesNotThrow(() => verifyV27ModelBudgetReconciliation(modelAudit, budgetAudit, attempts))
  const unaccountedModel = verifyV27ModelAudit([...modelRecords, {
    ...modelRecords[0], sequence: 3,
  }, {
    ...modelRecords[1], sequence: 3,
  }], attempts, manifest)
  assert.throws(
    () => verifyV27ModelBudgetReconciliation(unaccountedModel, budgetAudit, attempts),
    /do not match budget-accounted requests/,
  )
  assert.throws(
    () => verifyV27BudgetAudit([...budgetRecords, {
      event: 'budget-activated', attemptId: 'replacement-attempt', limits: manifest.budgetPerAttempt,
    }], attempts, manifest),
    /unknown attempt/,
  )
  assert.throws(
    () => verifyV27BudgetAudit([...budgetRecords, budgetRecords[0]], attempts, manifest),
    /duplicate or out of order/,
  )
})

test('binds final release analysis to the exact frozen driver checkout', () => {
  const commit = '1'.repeat(40)
  const manifestCommit = '4'.repeat(40)
  const tree = '2'.repeat(40)
  const checkoutRecordsSha256 = '5'.repeat(64)
  const sourceObjects = {
    'eval/long-system/v27': tree,
    'eval/v0.4/lib/canonical.mjs': '3'.repeat(40),
  }
  const manifest = {
    driver: {
      commit,
      tree,
      sourceObjects,
      sourceDigest: sha256(sourceObjects),
    },
  }
  const cleanGit = args => {
    if (args[0] === 'diff') return 'eval/long-system/v27/frozen-manifest.json'
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') {
      const specification = args[1]
      if (specification === `${commit}:eval/long-system/v27`) return tree
      const path = specification.slice(commit.length + 1)
      return sourceObjects[path]
    }
    return ''
  }
  const inspectCheckout = (input) => {
    assert.equal(input.commit, manifestCommit)
    assert.deepEqual(input.sourcePaths, Object.keys(sourceObjects).sort())
    return { fileCount: 7, recordsSha256: checkoutRecordsSha256 }
  }
  assert.deepEqual(verifyV27AnalyzerCheckout(manifest, {
    git: cleanGit,
    manifestCommit,
    inspectCheckout,
  }), {
    commit,
    tree,
    sourceDigest: manifest.driver.sourceDigest,
    checkoutFileCount: 7,
    checkoutRecordsSha256,
  })

  assert.throws(() => verifyV27AnalyzerCheckout(manifest, {
    manifestCommit,
    inspectCheckout,
    git(args) {
      if (args[0] === 'diff') return 'eval/long-system/v27/analysis.mjs'
      return cleanGit(args)
    },
  }), /changed after freeze/)
})

test('rebuilds candidate continuity only with a separately trusted frozen decoder', async (context) => {
  const attemptRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-trace-rebuild-'))
  context.after(() => rm(attemptRoot, { recursive: true, force: true }))
  const sessionsRoot = join(attemptRoot, 'sessions')
  const attemptDecoder = join(
    attemptRoot,
    'host-harness-runtime',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-session',
    'lib',
    'index.js',
  )
  const trustedRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-trusted-decoder-'))
  context.after(() => rm(trustedRoot, { recursive: true, force: true }))
  const decoder = join(trustedRoot, 'index.js')
  await mkdir(sessionsRoot, { recursive: true })
  await mkdir(join(attemptDecoder, '..'), { recursive: true })
  await writeFile(attemptDecoder, 'throw new Error("attempt decoder must never execute")\n')
  await writeFile(decoder, 'export const decodeStorageRecord = value => [value]\n')
  const raw = {
    attemptId: 'candidate-fixture',
    rootSessionId: 'root-session',
    traceProtocol: { expectedCompactions: 2 },
    processLedger: [{ epochId: 'epoch-1' }],
    productGrade: grade(9, 9),
  }
  let observed
  const rebuilt = await rebuildV27TraceFromDisk({
    raw,
    sessionsRoot,
    trustedDecoderModulePath: decoder,
    async traceGrader(value) {
      observed = value
      return { valid: true, metrics: { rebuilt: true } }
    },
  })
  assert.equal(observed.sessionsRoot, sessionsRoot)
  assert.equal(observed.rootSessionId, raw.rootSessionId)
  assert.equal(observed.decoderModulePath, decoder)
  assert.deepEqual(rebuilt, { valid: true, metrics: { rebuilt: true } })
})

test('requires one report-bound Ed25519 trial terminal before release authority exists', async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-terminal-'))
  context.after(() => rm(outputRoot, { recursive: true, force: true }))
  const runRoot = join(outputRoot, RUN_ID)
  await mkdir(runRoot)
  const { report, manifest, keys } = signedReport()
  const analysis = validateV27ReportEnvelope(report, manifest)
  await assert.rejects(
    verifyV27TrialTerminal({ report, manifest, analysis, runRoot }),
    /requires one durable trial terminal/,
  )

  const body = {
    schemaVersion: 3,
    status: 'release-allowed',
    runId: report.runId,
    protocolId: manifest.protocolId,
    manifestDigest: manifest.manifestDigest,
    manifestCommit: report.manifestCommit,
    executionEnvelopeDigest: report.executionEnvelopeDigest,
    reportDigest: report.reportDigest,
    signingLedgerHead: report.signing.head,
    signingRecords: report.signing.records,
    releaseAllowed: true,
    completedAt: '2026-08-22T00:00:00.000Z',
    replacementAllowed: false,
    rerunAllowed: false,
  }
  const terminalPayloadDigest = sha256(body)
  const terminal = {
    ...body,
    terminalPayloadDigest,
    signature: sign(null, Buffer.from(terminalPayloadDigest, 'hex'), keys.privateKey).toString('base64'),
  }
  const terminalPath = join(outputRoot, `v27-trial-terminal-${manifest.manifestDigest}.json`)
  await writeFile(terminalPath, JSON.stringify(terminal))
  assert.equal((await verifyV27TrialTerminal({ report, manifest, analysis, runRoot })).releaseAllowed, true)

  terminal.reportDigest = '0'.repeat(64)
  await writeFile(terminalPath, JSON.stringify(terminal))
  await assert.rejects(
    verifyV27TrialTerminal({ report, manifest, analysis, runRoot }),
    /missing, forged, or not bound/,
  )

  await writeFile(join(outputRoot, `v27-trial-fatal-${manifest.manifestDigest}.json`), '{}')
  await assert.rejects(
    verifyV27TrialTerminal({ report, manifest, analysis, runRoot }),
    /fatal terminal record exists/,
  )
})
