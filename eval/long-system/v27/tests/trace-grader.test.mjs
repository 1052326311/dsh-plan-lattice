import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packChunkRuns } from '@deepseek-ai/dsh-session'
import { sha256 } from '../../../v0.4/lib/canonical.mjs'
import { gradeV27Trace, validateV27ProcessLedger } from '../trace-grader.mjs'

const REVISION_ID = 'jobforge-r4-dot-v2'
const REVISION_RULE = 'DOT edges use spaces, never commas'
const HIDDEN_ASSETS_SHA256 = 'a'.repeat(64)

function eventBuilder(timeOffset = 100) {
  const events = []
  const push = (type, data, extra = {}) => {
    const event = { type, seq: events.length, time: timeOffset + events.length, data, ...extra }
    events.push(event)
    return event
  }
  return { events, push }
}

function user(push, text, source = { kind: 'user' }, extra = {}) {
  return push('user/message', {
    id: `message-${Math.random()}`,
    source,
    content: [{ type: 'text', text }],
  }, { surfaceOp: 'append', ...extra })
}

function messageTextForTest(event) {
  return event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function todo(push, prefix, statuses) {
  return push('todo/write', {
    todos: statuses.map((status, index) => ({ content: `${prefix}-${index + 1}`, status })),
  })
}

function toolCall(push, name, args, turn) {
  const callId = `${name}-${turn}-${Math.random()}`
  return push('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) })
}

function toolResult(push, call, text = 'Process exited with code 0\nok package/example') {
  return push('tool/result', {
    turn: call.data.turn,
    step: call.data.step,
    message: {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: call.data.callId,
        isError: false,
        content: [{ type: 'text', text }],
      }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

function completeTwoItemRound(push, turn, prefix, prompt) {
  push('turn/start', { turn })
  const message = user(push, prompt)
  todo(push, prefix, ['in_progress', 'pending'])
  const firstMutation = toolCall(push, 'edit', { path: 'main.go', replacement: prefix }, turn)
  toolResult(push, firstMutation, 'updated main.go')
  const firstVerification = toolCall(push, 'bash', { command: 'go test ./...' }, turn)
  toolResult(push, firstVerification)
  todo(push, prefix, ['completed', 'in_progress'])
  const secondMutation = toolCall(push, 'edit', { path: 'main.go', replacement: `${prefix}-2` }, turn)
  toolResult(push, secondMutation, 'updated main.go')
  const secondVerification = toolCall(push, 'bash', { command: 'go test ./...' }, turn)
  toolResult(push, secondVerification)
  todo(push, prefix, ['completed', 'completed'])
  const end = push('turn/end', { turn, reason: { kind: 'completed' } })
  return { message, end }
}

function compaction(push, id, shadowedSeq) {
  const start = push('compaction/start', { compactionId: id, turn: null })
  const summaryContent = [{ type: 'text', text: `summary-${id}` }]
  const summary = push('compaction/summary', {
    compactionId: id,
    summary: summaryContent,
    shadowedRange: { start: shadowedSeq, end: shadowedSeq },
    shadowedSeqs: [shadowedSeq],
    shadowedTokenCount: 10,
    provider: 'fixture',
    model: 'fixture',
  })
  user(push, `summary-${id}`, { kind: 'plugin', plugin: 'compact', compactionId: id }, {
    surfaceOp: { op: 'replace', start: shadowedSeq, end: shadowedSeq },
    sourceEventSeqs: [start.seq, summary.seq, shadowedSeq],
  })
  return push('compaction/end', { compactionId: id, turn: null })
}

function buildFixture() {
  const rootBuilder = eventBuilder()
  const { events, push } = rootBuilder
  const initialUserSeq = 1

  push('turn/start', { turn: 1 })
  const roundThreeMessage = user(push, 'Implement jobforge rounds 1 through 3.')
  for (const text of ['one', 'two', 'three']) {
    push('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } })
  }
  todo(push, 'R1', ['in_progress', 'pending'])
  const r1a = toolCall(push, 'edit', { path: 'main.go', replacement: 'R1-A' }, 1)
  toolResult(push, r1a, 'updated main.go')
  const r1v1 = toolCall(push, 'bash', { command: 'go test ./...' }, 1)
  toolResult(push, r1v1)
  todo(push, 'R1', ['completed', 'in_progress'])
  const r1b = toolCall(push, 'edit', { path: 'main.go', replacement: 'R1-B' }, 1)
  toolResult(push, r1b, 'updated main.go')
  const r1v2 = toolCall(push, 'bash', { command: 'go test ./...' }, 1)
  toolResult(push, r1v2)
  todo(push, 'R1', ['completed', 'completed'])
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const firstCompactionEnd = compaction(push, 'compact-after-r3', initialUserSeq)
  const epochAEnd = firstCompactionEnd.seq
  const epochBStart = push('session/end-seed', {}).seq
  push('turn/start', { turn: 6 })
  const roundSixMessage = user(push, 'Apply official round 6 without restating previous requirements.')
  push('step/start', { turn: 6, step: 1 })
  push('request/header', {
    header: { config: { provider: 'fixture', model: 'fixture' } },
    reason: 'resume',
  })
  todo(push, 'R6', ['in_progress', 'pending'])
  const r6a = toolCall(push, 'edit', { path: 'main.go', replacement: 'R6-A' }, 6)
  toolResult(push, r6a, 'updated main.go')
  const r6v1 = toolCall(push, 'bash', { command: 'go test ./...' }, 6)
  toolResult(push, r6v1)
  todo(push, 'R6', ['completed', 'in_progress'])
  const r6b = toolCall(push, 'edit', { path: 'main.go', replacement: 'R6-B' }, 6)
  toolResult(push, r6b, 'updated main.go')
  const r6v2 = toolCall(push, 'bash', { command: 'go test ./...' }, 6)
  toolResult(push, r6v2)
  todo(push, 'R6', ['completed', 'completed'])
  push('step/end', { turn: 6, step: 1 })
  push('turn/end', { turn: 6, reason: { kind: 'completed' } })

  const auditStart = push('turn/start', { turn: 7 })
  const auditMessage = user(push, `Current revision ${REVISION_ID}: ${REVISION_RULE}. Audit it before continuing.`, {
    kind: 'plugin', plugin: 'plan-lattice-v27-eval-support',
  })
  todo(push, 'R7', ['in_progress', 'pending'])
  const childPrompt = `Audit current revision ${REVISION_ID}. Required contract: ${REVISION_RULE}. Report evidence only.`
  const fork = toolCall(push, 'subagent_fork', {
    description: 'Audit current Jobforge revision',
    prompt: childPrompt,
    run_in_background: false,
  }, 7)
  const forkResult = toolResult(push, fork, 'Revision audit passed')
  const r7v1 = toolCall(push, 'bash', { command: 'go test ./...' }, 7)
  toolResult(push, r7v1)
  todo(push, 'R7', ['completed', 'in_progress'])
  const r7b = toolCall(push, 'edit', { path: 'main.go', replacement: 'R7-B' }, 7)
  toolResult(push, r7b, 'updated main.go')
  const r7v2 = toolCall(push, 'bash', { command: 'go test ./...' }, 7)
  toolResult(push, r7v2)
  todo(push, 'R7', ['completed', 'completed'])
  const auditEnd = push('turn/end', { turn: 7, reason: { kind: 'completed' } })

  compaction(push, 'compact-after-r7', initialUserSeq)
  const roundNine = completeTwoItemRound(
    push, 9, 'R9', 'Complete official round 9 and preserve all historical requirements.',
  )

  const child = eventBuilder(0)
  user(child.push, 'Inherited parent history')
  const childUser = user(child.push, childPrompt)
  childUser.time = fork.time + 0.25
  child.push('subagent/descriptor', {
    mode: 'one-shot', provider: 'fork', label: 'Audit current Jobforge revision',
  })
  child.push('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return {
    sessions: [
      { name: 'root', header: { type: 'session', id: 'root', seedLength: 0 }, events },
      {
        name: 'child',
        header: {
          type: 'session', id: 'child', parentSession: 'root', origin: 'subagent',
          delegationDepth: 1, seedLength: 1,
        },
        events: child.events,
      },
    ],
    stageProtocol: {
      schemaVersion: 2,
      protocolId: 'fixture-v27-lifecycle',
      expectedProcessEpochs: 2,
      expectedCompactions: 2,
      expectedColdResumes: 1,
      guardedTools: ['edit'],
      hiddenAssetsSha256: HIDDEN_ASSETS_SHA256,
      stages: [
        { id: 'round-3', index: 0, kind: 'product', epoch: 1,
          messageSha256: sha256(messageTextForTest(roundThreeMessage)), source: { kind: 'user' } },
        { id: 'round-6', index: 1, kind: 'product', epoch: 2,
          messageSha256: sha256(messageTextForTest(roundSixMessage)), source: { kind: 'user' } },
        { id: 'audit-after-round-7', index: 2, kind: 'audit', epoch: 2,
          messageSha256: sha256(messageTextForTest(auditMessage)),
          source: { kind: 'plugin', plugin: 'plan-lattice-v27-eval-support' } },
        { id: 'round-9', index: 3, kind: 'product', epoch: 2,
          messageSha256: sha256(messageTextForTest(roundNine.message)), source: { kind: 'user' } },
      ],
      epochs: [
        { epochId: 'epoch-1', stageIds: ['round-3'], coldStart: false },
        { epochId: 'epoch-2', stageIds: ['round-6', 'audit-after-round-7', 'round-9'],
          coldStart: true, resumedAfterStageId: 'round-3' },
      ],
      lifecycle: {
        compactionAfterStageIds: ['round-3', 'audit-after-round-7'],
        coldRestartAfterStageId: 'round-3',
        foregroundAuditStageId: 'audit-after-round-7',
      },
      foregroundFork: {
        stageId: 'audit-after-round-7',
        firstSeq: auditStart.seq,
        lastSeq: auditEnd.seq,
        revisionId: REVISION_ID,
        requiredFragments: [REVISION_RULE],
      },
    },
    processLedger: {
      epochs: [
        {
          epochId: 'epoch-1', pid: 1001, startedAt: '2026-08-22T00:00:01.000Z',
          processId: '1001@2026-08-22T00:00:01.000Z', sessionId: 'root', rootSessionId: 'root',
          firstSeq: 0, lastSeq: epochAEnd, ended: true, exit: { status: 0, signal: null },
          processGroupCleaned: true, coldStart: false, endSeedSeq: null,
        },
        {
          epochId: 'epoch-2', pid: 1002, startedAt: '2026-08-22T00:00:02.000Z',
          processId: '1002@2026-08-22T00:00:02.000Z', sessionId: 'root', rootSessionId: 'root',
          firstSeq: epochBStart, lastSeq: events.at(-1).seq,
          ended: true, exit: { status: 0, signal: null }, processGroupCleaned: true,
          coldStart: true, resumedFromEpochId: 'epoch-1', endSeedSeq: epochBStart,
        },
      ],
    },
    productGrade: {
      hiddenAssetsSha256: HIDDEN_ASSETS_SHA256,
      staleBehavior: { hidden: true, failures: 0, passed: true },
    },
    markers: { forkCallId: fork.data.callId, forkResultSeq: forkResult.seq },
  }
}

async function writeFixture(root, fixture) {
  for (const session of fixture.sessions) {
    const directory = join(root, session.name)
    await mkdir(directory, { recursive: true })
    const rows = packChunkRuns(session.events)
    await writeFile(join(directory, 'session.jsonl'),
      `${[session.header, ...rows].map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  }
}

async function runFixture(context, mutate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-trace-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const fixture = buildFixture()
  mutate(fixture)
  await writeFixture(root, fixture)
  return gradeV27Trace({
    sessionsRoot: root,
    rootSessionId: 'root',
    stageProtocol: fixture.stageProtocol,
    processLedger: fixture.processLedger,
    productGrade: fixture.productGrade,
  })
}

function codes(result) {
  return new Set(result.violations.map(violation => violation.code))
}

function moveCompactionAfterFinalStage(events, compactionId) {
  const moved = events.filter(event => event.data?.compactionId === compactionId
    || event.data?.source?.compactionId === compactionId)
  const retained = events.filter(event => !moved.includes(event))
  const originalSeq = new Map(events.map(event => [event, event.seq]))
  const reordered = [...retained, ...moved]
  const remap = new Map(reordered.map((event, index) => [originalSeq.get(event), index]))
  events.splice(0, events.length, ...reordered)
  for (const [index, event] of events.entries()) {
    event.seq = index
    if (Array.isArray(event.sourceEventSeqs)) {
      event.sourceEventSeqs = event.sourceEventSeqs.map(seq => remap.get(seq))
    }
    if (Array.isArray(event.data?.shadowedSeqs)) {
      event.data.shadowedSeqs = event.data.shadowedSeqs.map(seq => remap.get(seq))
    }
    if (event.data?.shadowedRange) {
      event.data.shadowedRange.start = remap.get(event.data.shadowedRange.start)
      event.data.shadowedRange.end = remap.get(event.data.shadowedRange.end)
    }
    if (event.surfaceOp?.op === 'replace') {
      event.surfaceOp.start = remap.get(event.surfaceOp.start)
      event.surfaceOp.end = remap.get(event.surfaceOp.end)
    }
  }
}

test('accepts a complete V27 trace and expands rc.7 packed JSONL', async (context) => {
  const result = await runFixture(context)
  assert.equal(result.valid, true, JSON.stringify(result.violations, null, 2))
  assert.equal(result.metrics.storage.packedStorageRows, 1)
  assert.equal(result.metrics.successfulCompactions.successful.length, 2)
  assert.equal(result.metrics.sameSessionResumes.proven.length, 1)
  assert.equal(result.metrics.childRevisionCoverage.childSessionId, 'child')
  assert.equal(result.metrics.staleBehaviorFailures.source, 'hidden')
  assert.equal(result.metrics.prematureTerminals.count, 0)
})

test('derives the foreground audit boundary from the frozen durable stage message', async (context) => {
  const result = await runFixture(context, fixture => {
    const message = fixture.sessions[0].events.find(event => event.type === 'user/message'
      && messageTextForTest(event).includes(REVISION_ID))
    message.data.source = { kind: 'plugin', plugin: 'plan-lattice-v27-eval-support' }
    delete fixture.stageProtocol.foregroundFork.firstSeq
    delete fixture.stageProtocol.foregroundFork.lastSeq
    fixture.stageProtocol.foregroundFork.stageMessageSha256 = sha256(messageTextForTest(message))
    fixture.stageProtocol.foregroundFork.stageSource = message.data.source
  })
  assert.equal(result.valid, true, JSON.stringify(result.violations, null, 2))
})

test('requires two unique cleanly exited Harness processes for a completed frozen trace', () => {
  const stageProtocol = { expectedProcessEpochs: 2 }
  const processLedger = [1, 2].map(epoch => ({
    epochId: `epoch-${epoch}`,
    pid: 1000 + epoch,
    startedAt: `2026-08-22T00:00:0${epoch}.000Z`,
    processId: `${1000 + epoch}@2026-08-22T00:00:0${epoch}.000Z`,
    sessionId: 'root-session',
    rootSessionId: 'root-session',
    firstSeq: (epoch - 1) * 10,
    lastSeq: epoch * 10 - 1,
    ended: true,
    exit: { status: 0, signal: null },
    processGroupCleaned: true,
    coldStart: epoch > 1,
    ...(epoch > 1 ? { resumedFromEpochId: `epoch-${epoch - 1}` } : {}),
  }))
  assert.equal(validateV27ProcessLedger({
    processLedger, stageProtocol, rootSessionId: 'root-session',
  }).length, 2)
  for (const mutate of [
    value => value.pop(),
    value => { value[1].exit.status = 137 },
    value => { value[1].exit.signal = 'SIGKILL' },
    value => { value[1].processGroupCleaned = false },
    value => { value[1].processId = value[0].processId },
  ]) {
    const changed = structuredClone(processLedger)
    mutate(changed)
    assert.throws(() => validateV27ProcessLedger({
      processLedger: changed, stageProtocol, rootSessionId: 'root-session',
    }))
  }
})

test('supports an injected rc.7-compatible storage decoder', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-decoder-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const fixture = buildFixture()
  await writeFixture(root, fixture)
  const decoder = join(root, 'decoder.mjs')
  await writeFile(decoder,
    `export { decodeStorageRecord } from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-session'))}\n`, 'utf8')
  const result = await gradeV27Trace({
    sessionsRoot: root,
    rootSessionId: 'root',
    stageProtocol: fixture.stageProtocol,
    processLedger: fixture.processLedger,
    productGrade: fixture.productGrade,
    decoderModulePath: decoder,
  })
  assert.equal(result.valid, true, JSON.stringify(result.violations, null, 2))
  assert.equal(result.metrics.storage.packedStorageRows, 1)
})

test('rejects Todo batch advancement and mutation without later verification', async (context) => {
  const batch = await runFixture(context, fixture => {
    const root = fixture.sessions[0]
    const snapshot = root.events.find(event => event.type === 'todo/write'
      && event.data.todos[0].content === 'R1-1'
      && event.data.todos[0].status === 'completed')
    snapshot.data.todos[1].status = 'completed'
  })
  assert.equal(batch.valid, false)
  assert.equal(codes(batch).has('TODO_BATCH_ADVANCE'), true)

  const unverified = await runFixture(context, fixture => {
    const root = fixture.sessions[0]
    const verification = root.events.find(event => event.type === 'tool/call'
      && event.data.name === 'bash' && event.data.turn === 1)
    verification.data.arguments = JSON.stringify({ command: 'pwd' })
  })
  assert.equal(unverified.valid, false)
  assert.equal(codes(unverified).has('TODO_ADVANCED_WITHOUT_VERIFICATION'), true)
})

test('rejects an internally inconsistent compaction bracket', async (context) => {
  const result = await runFixture(context, fixture => {
    const root = fixture.sessions[0]
    const replacement = root.events.find(event => event.type === 'user/message'
      && event.data.source?.compactionId === 'compact-after-r3')
    replacement.data.source.compactionId = 'tampered-compaction'
  })
  assert.equal(result.valid, false)
  assert.equal(codes(result).has('COMPACTION_INVALID_REPLACEMENT'), true)
  assert.equal(codes(result).has('COMPACTION_UNSUCCESSFUL'), true)
})

test('rejects valid compactions moved away from their frozen stage anchors', async (context) => {
  const result = await runFixture(context, fixture => {
    const root = fixture.sessions[0]
    moveCompactionAfterFinalStage(root.events, 'compact-after-r7')
    fixture.processLedger.epochs[1].lastSeq = root.events.at(-1).seq
  })
  assert.equal(result.valid, false)
  assert.equal(codes(result).has('COMPACTION_POSITION_MISMATCH'), true)
})

test('rejects gaps and truncation in the frozen process partition', async (context) => {
  const gap = await runFixture(context, fixture => {
    fixture.processLedger.epochs[1].firstSeq += 1
    fixture.processLedger.epochs[1].endSeedSeq += 1
  })
  assert.equal(gap.valid, false)
  assert.equal(codes(gap).has('EPOCH_PARTITION_MISMATCH'), true)

  const truncated = await runFixture(context, fixture => {
    fixture.processLedger.epochs[1].lastSeq -= 1
  })
  assert.equal(truncated.valid, false)
  assert.equal(codes(truncated).has('EPOCH_PARTITION_MISMATCH'), true)
})

test('requires external proof of a distinct-process same-Session cold resume', async (context) => {
  await assert.rejects(runFixture(context, fixture => {
    fixture.processLedger.epochs[1].processId = fixture.processLedger.epochs[0].processId
  }), /authentic process identity|reuses a process identity/)
})

test('rejects an R7 child that did not receive the current revision', async (context) => {
  const result = await runFixture(context, fixture => {
    const child = fixture.sessions[1]
    child.events[1].data.content[0].text = 'Audit an obsolete revision.'
  })
  assert.equal(result.valid, false)
  assert.equal(codes(result).has('FOREGROUND_CHILD_NOT_PROVEN'), true)
})

test('rejects a revision marker without the complete prior human authority', async (context) => {
  const result = await runFixture(context, fixture => {
    fixture.stageProtocol.foregroundFork.requiredFragments = []
    fixture.stageProtocol.foregroundFork.requiredAuthorityMessages = [
      'round-1 exact requirement',
      'round-7 exact requirement',
    ]
  })
  assert.equal(result.valid, false)
  assert.equal(codes(result).has('CHILD_CURRENT_REVISION_MISSING'), true)
})

test('rejects a foreground audit child that invokes a mutation tool', async (context) => {
  const result = await runFixture(context, fixture => {
    const child = fixture.sessions[1]
    const terminalIndex = child.events.findIndex(event => event.type === 'turn/end')
    child.events.splice(terminalIndex, 0, {
      type: 'tool/call', seq: terminalIndex, time: 10,
      data: { turn: 1, step: 1, callId: 'child-bash', name: 'bash', arguments: '{"command":"touch changed"}' },
    })
    child.events.forEach((event, index) => { event.seq = index })
  })
  assert.equal(result.valid, false)
  assert.equal(codes(result).has('FOREGROUND_CHILD_NOT_READ_ONLY'), true)
})

test('delegates stale-behavior authority exclusively to the hidden product grader', async (context) => {
  const failure = await runFixture(context, fixture => {
    fixture.productGrade.staleBehavior.failures = 1
    fixture.productGrade.staleBehavior.passed = false
  })
  assert.equal(failure.valid, false)
  assert.equal(codes(failure).has('STALE_BEHAVIOR_FAILURE'), true)

  const untrusted = await runFixture(context, fixture => {
    fixture.productGrade.staleBehavior.hidden = false
  })
  assert.equal(untrusted.valid, false)
  assert.equal(codes(untrusted).has('STALE_BEHAVIOR_NOT_HIDDEN_GRADED'), true)

  const wrongAssets = await runFixture(context, fixture => {
    fixture.productGrade.hiddenAssetsSha256 = 'b'.repeat(64)
  })
  assert.equal(wrongAssets.valid, false)
  assert.equal(codes(wrongAssets).has('HIDDEN_ASSET_IDENTITY_MISMATCH'), true)
})

test('rejects completed terminals while durable Todo work remains', async (context) => {
  const result = await runFixture(context, fixture => {
    const root = fixture.sessions[0]
    const finalTodo = root.events.filter(event => event.type === 'todo/write').at(-1)
    finalTodo.data.todos[1].status = 'in_progress'
  })
  assert.equal(result.valid, false)
  assert.equal(codes(result).has('PREMATURE_TERMINAL'), true)
  assert.equal(result.metrics.prematureTerminals.count, 1)
})
