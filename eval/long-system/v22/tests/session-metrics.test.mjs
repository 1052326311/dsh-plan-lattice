import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseSessionMetrics } from '../driver/session-metrics.mjs'

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

function user(seq, text, source = { kind: 'user' }) {
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    data: {
      id: `message-${seq}`,
      source,
      content: [{ type: 'text', text }],
    },
    surfaceOp: 'append',
  }
}

function assistant(seq, inputTokens, outputTokens) {
  return {
    type: 'assistant/message',
    seq,
    time: seq + 1,
    data: {
      usage: { inputTokens, outputTokens },
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    },
    surfaceOp: 'append',
  }
}

function compaction(seq, inputTokens, outputTokens) {
  return {
    type: 'compaction/summary',
    seq,
    time: seq + 1,
    data: { usage: { inputTokens, outputTokens } },
  }
}

function replacement(seq, text = 'summary') {
  return {
    ...user(seq, text, { kind: 'plugin', plugin: 'compaction' }),
    surfaceOp: { op: 'replace', start: 0, end: Math.max(0, seq - 1) },
  }
}

function latticeCall(seq, name = 'lattice_open') {
  return {
    type: 'tool/call',
    seq,
    time: seq + 1,
    data: { name, callId: `call-${seq}`, arguments: '{}' },
  }
}

async function writeSession(root, name, header, events) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'session.jsonl'),
    `${[header, ...events].map(row => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  )
}

test('fork lineage metrics read the first child-owned user message after seedLength', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v22-session-metrics-'))
  try {
    await writeSession(root, 'child', {
      type: 'session',
      id: 'child',
      parentSession: 'parent',
      origin: 'subagent',
      delegationDepth: 1,
      seedLength: 2,
    }, [
      user(0, 'inherited parent request'),
      user(1, 'inherited parent summary', { kind: 'plugin', plugin: 'compaction' }),
      user(2, 'exact model-authored child prompt'),
    ])

    const result = await parseSessionMetrics(root)
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0].initialUserTextSha256, digest('exact model-authored child prompt'))
    assert.equal(result.sessions[0].initialUserSourceKind, 'user')
    assert.equal(result.sessions[0].seedLength, 2)
    assert.equal(result.sessions[0].ownEventCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork metrics never count inherited parent usage or lifecycle events twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v22-seed-accounting-'))
  try {
    const continuationSource = { kind: 'plugin', plugin: 'plan-lattice' }
    const continuation = '[plan-lattice/max-token-continuation] Continue the same accepted task from the durable session state. Preserve human authority and boundaries; execute the next incomplete acceptance item.'
    await writeSession(root, 'parent', { type: 'session', id: 'parent', seedLength: 0 }, [
      user(0, 'parent request'),
      assistant(1, 100, 10),
      compaction(2, 40, 4),
      replacement(3),
      latticeCall(4),
      user(5, continuation, continuationSource),
    ])
    await writeSession(root, 'child', {
      type: 'session',
      id: 'child',
      parentSession: 'parent',
      origin: 'subagent',
      delegationDepth: 1,
      seedLength: 6,
    }, [
      user(0, 'parent request'),
      assistant(1, 100, 10),
      compaction(2, 40, 4),
      replacement(3),
      latticeCall(4),
      user(5, continuation, continuationSource),
      user(6, 'model-authored child prompt'),
      assistant(7, 25, 5),
      { type: 'subagent/descriptor', seq: 8, time: 9, data: { mode: 'one-shot' } },
      compaction(9, 15, 3),
      replacement(10, 'child summary'),
      { type: 'turn/end', seq: 11, time: 12, data: { reason: { kind: 'completed' } } },
    ])

    const result = await parseSessionMetrics(root, {
      expectedSessionIds: ['parent', 'child'],
      terminalSessionId: 'child',
    })
    assert.equal(result.modelTurns, 4)
    assert.equal(result.inputTokens, 180)
    assert.equal(result.outputTokens, 22)
    assert.equal(result.compactionSummaries, 2)
    assert.equal(result.surfaceReplacements, 2)
    assert.equal(result.nativeMaxTokenContinuations, 1)
    assert.deepEqual(result.controlToolCalls, [{ sessionId: 'parent', seq: 4, name: 'lattice_open' }])
    assert.equal(result.forbiddenAutomaticControlCalls.length, 1)
    assert.deepEqual(result.terminalReason, { kind: 'completed' })
    assert.equal(result.transcriptDurationMs, 11)
    assert.equal(result.sessions.find(session => session.id === 'child').subagentDescriptor, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork terminal and descriptor evidence must be child-owned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v22-seed-terminal-'))
  try {
    await writeSession(root, 'child', {
      type: 'session', id: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 3,
    }, [
      user(0, 'parent request'),
      { type: 'subagent/descriptor', seq: 1, time: 2, data: { mode: 'ancestor' } },
      { type: 'turn/end', seq: 2, time: 3, data: { reason: { kind: 'completed' } } },
      user(3, 'child prompt'),
    ])

    const result = await parseSessionMetrics(root, { terminalSessionId: 'child' })
    assert.equal(result.sessions[0].subagentDescriptor, false)
    assert.equal(result.terminalReason, undefined)
    assert.equal(result.transcriptDurationMs, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects an invalid fork seed boundary before aggregating metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v22-invalid-seed-'))
  try {
    await writeSession(root, 'child', {
      type: 'session', id: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 2,
    }, [user(0, 'only one event')])
    await assert.rejects(parseSessionMetrics(root), /invalid seedLength/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unseeded root metrics continue to inspect the first ordinary user message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v22-root-metrics-'))
  try {
    await writeSession(root, 'root', { type: 'session', id: 'root', seedLength: 0 }, [
      user(0, 'root request'),
    ])

    const result = await parseSessionMetrics(root)
    assert.equal(result.sessions[0].initialUserTextSha256, digest('root request'))
    assert.equal(result.sessions[0].initialUserSourceKind, 'user')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
