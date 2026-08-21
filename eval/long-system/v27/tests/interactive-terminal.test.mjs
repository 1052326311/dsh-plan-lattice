import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  handleV27AttemptAbort,
  handleV27StageComplete,
  runInteractiveEpoch,
  terminateV27ProcessGroup,
  writeReceiptExclusive,
} from '../driver/evocode-runner.mjs'

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

test('clears the complete detached Harness process group after a normal leader exit', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-process-group-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const dshBin = join(root, 'background-harness.mjs')
  const pidPath = join(root, 'background.pid')
  await mkdir(workspace)
  await writeFile(dshBin, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })`,
    'child.unref()',
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
    '',
  ].join('\n'))
  const result = await runInteractiveEpoch({
    epoch: { schemaVersion: 1, epoch: 1, rootSessionId: 'v27-process-group-session', stages: [] },
    dshBin,
    env: {},
    workspace,
    timeoutMs: 5_000,
    onMarker: async () => undefined,
    logPrefix: join(root, 'harness'),
    secretValues: [],
  })
  const backgroundPid = Number(await readFile(pidPath, 'utf8'))
  assert.equal(result.status, 0)
  assert.equal(result.processGroupCleaned, true)
  assert.equal(processExists(backgroundPid), false)
})

test('process-group cleanup is idempotent after every member has exited', async () => {
  const child = spawn('/usr/bin/true', [], { detached: true, stdio: 'ignore' })
  await new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', resolveClose)
  })
  assert.deepEqual(await terminateV27ProcessGroup(child.pid), { pid: child.pid, cleaned: true })
})

const REVISION = 'revision-integration-123'
const ATTEMPT_ID = 'v27-integration-native-1'
const SESSION_ID = 'plan-lattice-v27-integration-session'
const WORKSPACE_DIGEST = 'd'.repeat(64)
const HIDDEN_DIGEST = 'a'.repeat(64)
const TERMINAL_ID = 'b'.repeat(64)
const supportPluginSource = join(dirname(fileURLToPath(import.meta.url)), '..', 'driver', 'support-plugin', 'index.js')

const fakeHarness = `
import { apply } from './support-plugin.mjs'
const protocol = JSON.parse(process.env.DSH_PLAN_LATTICE_V27_EPOCH_JSON)
const reason = JSON.parse(process.env.FAKE_TURN_REASON_JSON)
const session = { id: protocol.rootSessionId, seq: 0, events: [] }
const agent = {
  session,
  ctx: {
    get(name) {
      if (name === 'compaction' && process.env.FAKE_COMPACTION_FAILURE === '1') {
        return { async compactNow() { throw Object.assign(new Error('local budget rejection'), { status: 429 }) } }
      }
      return undefined
    },
  },
  async whenIdle() {},
  followup() {
    session.seq += 1
    session.events.push({ seq: session.seq, type: 'turn/end', data: { reason } })
  },
}
const ctx = {
  on() {},
  agentDefaultModel: { currentSelection() { return { provider: 'fixture', model: 'fixture' } } },
  agents: {
    async resume() { throw new Error('session not found') },
    async create() { return { agent } },
  },
  get(name) {
    if (name === 'loader') return { async await() {} }
    if (name === 'appExit') return code => setImmediate(() => process.exit(code))
    return undefined
  },
  sessions: { async flush() {} },
  userQuestions: { registerProvider() {} },
}
apply(ctx)
`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-interactive-'))
  const workspace = join(root, 'workspace')
  const dshBin = join(root, 'fake-harness.mjs')
  await mkdir(workspace)
  await Promise.all([
    writeFile(dshBin, fakeHarness, 'utf8'),
    copyFile(supportPluginSource, join(root, 'support-plugin.mjs')),
  ])
  return { root, workspace, dshBin }
}

function stage(overrides = {}) {
  return {
    index: 0, id: 'round-3', kind: 'product', productRound: 3,
    revision: REVISION, message: 'fixture', ...overrides,
  }
}

function epoch(stageValue = stage()) {
  return { schemaVersion: 1, epoch: 1, rootSessionId: SESSION_ID, stages: [stageValue] }
}

function localBudgetSnapshot(sessionId = SESSION_ID) {
  return {
    attemptId: ATTEMPT_ID,
    agentRequests: 10,
    inputTokens: 100,
    outputTokens: 20,
    missingUsageResponses: 0,
    budgetRejections: 1,
    localBudgetRejections: 1,
    upstreamHttp429: 0,
    upstreamTransportErrors: 0,
    agentRequestSequence: 11,
    limits: { maxAgentRequests: 10, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
    firstBudgetRejection: {
      attemptId: ATTEMPT_ID,
      sessionId,
      terminalId: TERMINAL_ID,
      requestSequence: 11,
      acceptedSnapshot: { agentRequests: 10, inputTokens: 100, outputTokens: 20, missingUsageResponses: 0 },
      exhausted: [{ metric: 'agentRequests', actual: 10, limit: 10 }],
    },
  }
}

function preTerminalBudgetSnapshot(agentRequests = 10) {
  return {
    ...localBudgetSnapshot(),
    agentRequests,
    budgetRejections: 0,
    localBudgetRejections: 0,
    agentRequestSequence: agentRequests,
    firstBudgetRejection: null,
  }
}

function trackedOpen(timeline) {
  return async (...args) => {
    const handle = await open(...args)
    return {
      async writeFile(...writeArgs) {
        await handle.writeFile(...writeArgs)
        timeline.push('receipt-write')
      },
      async sync() {
        await handle.sync()
        timeline.push('receipt-fsync-resolved')
      },
      async close() {
        await handle.close()
        timeline.push('receipt-close-resolved')
      },
    }
  }
}

function trackedDirectoryOpen(timeline) {
  return async (...args) => {
    const handle = await open(...args)
    return {
      async sync() {
        await handle.sync()
        timeline.push('receipt-directory-fsync-resolved')
      },
      async close() { await handle.close() },
    }
  }
}

function assertOrdered(timeline, expected) {
  let prior = -1
  for (const item of expected) {
    const current = timeline.indexOf(item)
    assert.ok(current > prior, `${item} is out of order in ${timeline.join(', ')}`)
    prior = current
  }
}

function runOptions(root, workspace, dshBin, onMarker, options = {}) {
  return {
    epoch: options.epoch ?? epoch(),
    dshBin,
    env: {
      DSH_PLAN_LATTICE_EVAL_SESSION_ID: SESSION_ID,
      FAKE_TURN_REASON_JSON: JSON.stringify(options.reason
        ?? { kind: 'error', error: { status: 429, code: 'RATE_LIMIT' } }),
      ...(options.env ?? {}),
    },
    workspace,
    forbiddenReadRoots: [],
    timeoutMs: 10_000,
    logPrefix: join(root, 'harness'),
    secretValues: [],
    onMarker,
  }
}

test('real support plugin waits for a durable host receipt before echoing a local-budget terminal', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { root, workspace, dshBin } = await fixture()
  const receiptPath = join(root, 'round-3.json')
  const timeline = []
  const markers = []
  let graderCalls = 0
  try {
    const result = await runInteractiveEpoch(runOptions(root, workspace, dshBin, async value => {
      markers.push(value)
      timeline.push(value.type)
      if (value.type === 'stage-start') {
        await new Promise(resolve => setTimeout(resolve, 30))
        timeline.push('stage-start-host-ready')
        return undefined
      }
      if (value.type !== 'stage-complete') return undefined
      const handled = await handleV27StageComplete({
        value,
        stage: stage(),
        expectedEpoch: 1,
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        budgetSnapshot: () => localBudgetSnapshot('plan-lattice-v27-foreground-child'),
        budgetBeforeSnapshot: preTerminalBudgetSnapshot(),
        workspace,
        taskRoot: '/hidden/task',
        dockerImage: 'fixture@sha256:' + 'c'.repeat(64),
        verifierTempRoot: join(root, 'verifier'),
        receiptPath,
        hiddenAssetsSha256: HIDDEN_DIGEST,
        async digestWorkspace() { return WORKSPACE_DIGEST },
        async gradeRound() {
          graderCalls += 1
          timeline.push('grader-complete')
          return { round: 3, reward: 1, total: 1, successes: 1, failures: 0, cases: [] }
        },
        async writeReceipt(path, body) {
          return writeReceiptExclusive(
            path,
            body,
            trackedOpen(timeline),
            trackedDirectoryOpen(timeline),
          )
        },
      })
      return handled.acknowledgement
    }))

    assert.equal(result.status, 0)
    assert.equal(result.signal, null)
    assert.equal(graderCalls, 1)
    assertOrdered(timeline, ['stage-start', 'stage-start-host-ready', 'stage-complete'])
    assertOrdered(timeline, [
      'stage-complete', 'grader-complete', 'receipt-write', 'receipt-fsync-resolved',
      'receipt-close-resolved', 'receipt-directory-fsync-resolved', 'attempt-terminal', 'epoch-complete',
    ])
    const terminal = markers.find(value => value.type === 'attempt-terminal')
    assert.equal(terminal.terminalReason.kind, 'attempt-budget-exhausted')
    assert.equal(terminal.budgetTerminalId, TERMINAL_ID)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(terminal.receiptDigest, receipt.receiptDigest)
    assert.equal(receipt.observedTurnReasonKind, 'error')
    assert.equal(receipt.terminalBudgetEvidence.terminalId, TERMINAL_ID)
    assert.equal(receipt.terminalBudgetEvidence.sessionId, 'plan-lattice-v27-foreground-child')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('real support plugin converts a compaction budget rejection into an attempt-wide terminal', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { root, workspace, dshBin } = await fixture()
  const compactingStage = stage({ compactAfter: true })
  const productReceiptPath = join(root, 'round-3.json')
  const terminalReceiptPath = join(root, 'round-3.terminal.json')
  const childSessionId = 'plan-lattice-v27-compaction-session'
  let priorAcknowledgement
  const markers = []
  try {
    const result = await runInteractiveEpoch(runOptions(root, workspace, dshBin, async value => {
      markers.push(value)
      if (value.type === 'stage-complete') {
        const handled = await handleV27StageComplete({
          value,
          stage: compactingStage,
          expectedEpoch: 1,
          attemptId: ATTEMPT_ID,
          sessionId: SESSION_ID,
          budgetSnapshot: {
            ...preTerminalBudgetSnapshot(9),
          },
          budgetBeforeSnapshot: preTerminalBudgetSnapshot(8),
          workspace,
          taskRoot: '/hidden/task',
          dockerImage: 'fixture@sha256:' + 'c'.repeat(64),
          verifierTempRoot: join(root, 'verifier'),
          receiptPath: productReceiptPath,
          hiddenAssetsSha256: HIDDEN_DIGEST,
          async digestWorkspace() { return WORKSPACE_DIGEST },
          async gradeRound() { return { round: 3, reward: 1, total: 1, successes: 1, failures: 0, cases: [] } },
        })
        priorAcknowledgement = handled.acknowledgement
        return priorAcknowledgement
      }
      if (value.type === 'stage-abort') {
        return (await handleV27AttemptAbort({
          value,
          stage: compactingStage,
          expectedEpoch: 1,
          attemptId: ATTEMPT_ID,
          sessionId: SESSION_ID,
          budgetSnapshot: localBudgetSnapshot(childSessionId),
          budgetBeforeSnapshot: preTerminalBudgetSnapshot(9),
          priorAcknowledgement,
          workspace,
          taskRoot: '/hidden/task',
          dockerImage: 'fixture@sha256:' + 'c'.repeat(64),
          verifierTempRoot: join(root, 'verifier'),
          productReceiptPath,
          terminalReceiptPath,
          hiddenAssetsSha256: HIDDEN_DIGEST,
        })).acknowledgement
      }
      return undefined
    }, {
      epoch: epoch(compactingStage),
      reason: { kind: 'completed' },
      env: { FAKE_COMPACTION_FAILURE: '1' },
    }))

    assert.equal(result.status, 0)
    assert.equal(result.signal, null)
    assert.equal(markers.filter(value => value.type === 'stage-abort').length, 1)
    const terminal = markers.find(value => value.type === 'attempt-terminal')
    const receipt = JSON.parse(await readFile(terminalReceiptPath, 'utf8'))
    assert.equal(terminal.terminalReason.kind, 'attempt-budget-exhausted')
    assert.equal(terminal.receiptDigest, receipt.receiptDigest)
    assert.equal(receipt.productReceiptDigest, priorAcknowledgement.receiptDigest)
    assert.equal(receipt.terminalBudgetEvidence.sessionId, childSessionId)
    assert.equal(receipt.abortedPhase, 'post-stage-compaction')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const scenario of [
  {
    name: 'generic 429 without local proof',
    snapshot: { ...localBudgetSnapshot(), budgetRejections: 0, localBudgetRejections: 0, firstBudgetRejection: null },
  },
  {
    name: 'upstream 429',
    snapshot: {
      ...localBudgetSnapshot(), budgetRejections: 0, localBudgetRejections: 0,
      upstreamHttp429: 1, firstBudgetRejection: null,
    },
  },
]) {
  test(`real support plugin rejects ${scenario.name} without grader or receipt`, {
    skip: process.platform !== 'darwin',
  }, async () => {
    const { root, workspace, dshBin } = await fixture()
    const receiptPath = join(root, 'round-3.json')
    let graderCalls = 0
    let caught
    try {
      await runInteractiveEpoch(runOptions(root, workspace, dshBin, async value => {
        if (value.type !== 'stage-complete') return undefined
        return (await handleV27StageComplete({
          value,
          stage: stage(),
          expectedEpoch: 1,
          attemptId: ATTEMPT_ID,
          sessionId: SESSION_ID,
          budgetSnapshot: scenario.snapshot,
          budgetBeforeSnapshot: preTerminalBudgetSnapshot(),
          workspace,
          taskRoot: '/hidden/task',
          dockerImage: 'fixture@sha256:' + 'c'.repeat(64),
          verifierTempRoot: join(root, 'verifier'),
          receiptPath,
          hiddenAssetsSha256: HIDDEN_DIGEST,
          async digestWorkspace() { return WORKSPACE_DIGEST },
          async gradeRound() { graderCalls += 1 },
        })).acknowledgement
      }))
    } catch (error) {
      caught = error
    }

    try {
      assert.ok(caught instanceof Error)
      assert.match(caught.message, /host-authenticated scoreable terminal/)
      assert.equal(caught.processResult.status, 1)
      assert.equal(caught.processResult.signal, null)
      assert.equal(caught.evaluatorRejectionTimedOut, false)
      assert.equal(graderCalls, 0)
      assert.equal(caught.processResult.observedMarkers.some(value => value.type === 'attempt-terminal'), false)
      const epochError = caught.processResult.observedMarkers.find(value => value.type === 'epoch-error')
      assert.match(epochError?.message ?? '', /evaluator rejected the terminal evidence/)
      await assert.rejects(readFile(receiptPath), error => error?.code === 'ENOENT')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
