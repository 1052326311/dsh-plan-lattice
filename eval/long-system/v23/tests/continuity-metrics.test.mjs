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

test('accepts bounded root workflow snapshots before and after a native replacement', () => {
  const events = [
    user(0, { kind: 'user' }, 'root task'),
    snapshot(1, 'Plan Lattice DSH-native workflow:\nTodo: none'),
    user(2, { kind: 'plugin', plugin: 'compaction' }, 'summary', { op: 'replace', start: 0, end: 1 }),
    snapshot(3, 'Plan Lattice DSH-native workflow:\nTodo: active'),
  ]
  const result = analyzeNativeContinuitySessions([session('root', events)])
  assert.equal(result.valid, true)
  assert.equal(result.totalOwnReplacements, 1)
  assert.equal(result.totalWorkflowSnapshots, 2)
})

test('accepts one read-only child capsule after the exact native child prompt', () => {
  const events = [
    user(0, { kind: 'user' }, 'parent task'),
    user(1, { kind: 'user' }, 'exact child prompt'),
    snapshot(2, '## Root-task execution capsule\nexact root authority and active Todo'),
  ]
  const result = analyzeNativeContinuitySessions([
    session('child', events, { parentSession: 'root', origin: 'subagent', seedLength: 1 }),
  ])
  assert.equal(result.valid, true)
  assert.equal(result.totalDelegatedCapsules, 1)
  assert.equal(result.sessions[0].firstOwnUserSource, 'user')
})

test('rejects a child capsule before its native prompt and duplicate capsules', () => {
  const events = [
    snapshot(0, '## Root-task execution capsule\npremature'),
    user(1, { kind: 'user' }, 'exact child prompt'),
    snapshot(2, '## Root-task execution capsule\nduplicate'),
  ]
  const result = analyzeNativeContinuitySessions([
    session('child', events, { parentSession: 'root', origin: 'subagent' }),
  ])
  assert.equal(result.valid, false)
  assert.deepEqual(result.violations.map(item => item.kind).sort(), [
    'capsule-precedes-native-child-prompt',
    'child-first-message-not-native-user',
    'duplicate-delegated-capsule',
  ])
})

test('rejects role-confused, unknown, and oversized snapshots', () => {
  const root = session('root', [
    user(0, { kind: 'user' }, 'root task'),
    snapshot(1, '## Root-task execution capsule\nwrong root role'),
    snapshot(2, 'unrecognized Plan Lattice payload'),
    snapshot(3, `Plan Lattice DSH-native workflow:\n${'x'.repeat(64)}`),
  ])
  const result = analyzeNativeContinuitySessions([root], { maxSnapshotBytes: 32 })
  assert.equal(result.valid, false)
  const kinds = result.violations.map(item => item.kind)
  assert.ok(kinds.includes('delegated-capsule-in-root'))
  assert.ok(kinds.includes('unknown-plan-lattice-snapshot'))
  assert.equal(kinds.filter(kind => kind === 'snapshot-byte-bound-exceeded').length, 3)
})
