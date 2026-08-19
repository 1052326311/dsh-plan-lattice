import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeNativeContinuitySessions } from '../continuity-metrics.mjs'

function user(seq, source, text, surfaceOp = 'append') {
  return {
    type: 'user/message',
    seq,
    time: seq,
    surfaceOp,
    data: { id: `m-${seq}`, source, content: [{ type: 'text', text }] },
  }
}

function snapshot(seq, text) {
  return user(seq, {
    kind: 'plugin',
    plugin: '@deepseek-ai/dsh-system-prompt',
    form: 'snapshot',
    sections: [{ name: 'plan-lattice:execution-state', text }],
  }, text)
}

function session(id, events, header = {}) {
  return { header: { type: 'session', id, ...header }, events }
}

test('accepts one bounded recovery snapshot after one own replacement', () => {
  const events = [
    user(0, { kind: 'user' }, 'root task'),
    user(1, { kind: 'plugin', plugin: 'compaction' }, 'summary', { op: 'replace', start: 0, end: 0 }),
    snapshot(2, 'Plan Lattice native continuity projection:\nexact authority'),
  ]
  const result = analyzeNativeContinuitySessions([session('root', events)])
  assert.equal(result.valid, true)
  assert.equal(result.totalOwnReplacements, 1)
  assert.equal(result.totalSnapshots, 1)
})

test('rejects a fresh child snapshot caused only by a replacement in its fork seed', () => {
  const events = [
    user(0, { kind: 'user' }, 'parent task'),
    user(1, { kind: 'plugin', plugin: 'compaction' }, 'parent summary', { op: 'replace', start: 0, end: 0 }),
    user(2, { kind: 'user' }, 'exact child prompt'),
    snapshot(3, 'Plan Lattice native continuity projection:\nwrong fresh-child injection'),
  ]
  const result = analyzeNativeContinuitySessions([
    session('child', events, { parentSession: 'root', origin: 'subagent', seedLength: 2 }),
  ])
  assert.equal(result.valid, false)
  assert.deepEqual(result.violations.map(item => item.kind).sort(), [
    'fresh-child-injection',
    'snapshot-without-own-replacement',
  ])
})

test('accepts exact child prompt first and recovery only after a child-owned replacement', () => {
  const events = [
    user(0, { kind: 'user' }, 'parent task'),
    user(1, { kind: 'plugin', plugin: 'compaction' }, 'parent summary', { op: 'replace', start: 0, end: 0 }),
    user(2, { kind: 'user' }, 'exact child prompt'),
    user(3, { kind: 'plugin', plugin: 'compaction' }, 'child summary', { op: 'replace', start: 2, end: 2 }),
    snapshot(4, 'Plan Lattice native continuity projection:\nexact child prompt'),
  ]
  const result = analyzeNativeContinuitySessions([
    session('child', events, { parentSession: 'root', origin: 'subagent', seedLength: 2 }),
  ])
  assert.equal(result.valid, true)
  assert.equal(result.sessions[0].firstOwnUserSource, 'user')
  assert.deepEqual(result.sessions[0].ownReplacements, [3])
})

test('rejects duplicate and oversized recovery snapshots', () => {
  const events = [
    user(0, { kind: 'user' }, 'root task'),
    user(1, { kind: 'plugin', plugin: 'compaction' }, 'summary', { op: 'replace', start: 0, end: 0 }),
    snapshot(2, 'first'),
    snapshot(3, 'x'.repeat(32)),
  ]
  const result = analyzeNativeContinuitySessions([session('root', events)], { maxSnapshotBytes: 16 })
  assert.equal(result.valid, false)
  assert.deepEqual(result.violations.map(item => item.kind).sort(), [
    'duplicate-snapshot-for-replacement',
    'snapshot-byte-bound-exceeded',
  ])
})

