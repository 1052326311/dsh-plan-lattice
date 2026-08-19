import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertDurableNativeForegroundDelegation,
  assertNativeForegroundDelegation,
} from '../driver/foreground-lifecycle.mjs'

function fixture(overrides = {}) {
  const prompt = overrides.prompt ?? 'model-authored child prompt'
  const seed = [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: {
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'root authority' }],
    } },
    { type: 'user/message', seq: 1, time: 2, surfaceOp: { op: 'replace', start: 0, end: 0 }, data: {
      role: 'user', source: { kind: 'plugin', plugin: 'compaction' }, content: [{ type: 'text', text: 'parent summary' }],
    } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const call = {
    type: 'tool/call', seq: 4, time: 20,
    data: {
      turn: 2, step: 1, callId: 'call-1', name: 'subagent_fork',
      arguments: JSON.stringify({ description: 'summary task', prompt, run_in_background: false }),
    },
  }
  const result = {
    type: 'tool/result', seq: 5, time: 40, sourceEventSeqs: [4], surfaceOp: 'append',
    data: {
      turn: 2, step: 1,
      message: {
        role: 'user', source: { kind: 'tool' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'done' }] }],
      },
    },
  }
  const parent = {
    header: { type: 'session', id: 'parent' },
    events: [...seed, {
      type: 'request/header', seq: 3, time: 10, data: { header: { tools: [{
        name: 'subagent_fork',
        description: 'Delegate focused work.',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
      }] } },
    }, call, result],
  }
  const child = {
    header: {
      type: 'session', id: 'child', parentSession: 'parent', origin: 'subagent', delegationDepth: 1, seedLength: 3,
    },
    events: [
      ...seed,
      { type: 'turn/start', seq: 3, time: 21, data: { turn: 1 } },
      { type: 'user/message', seq: 4, time: 22, surfaceOp: 'append', data: {
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }],
      } },
      { type: 'subagent/descriptor', seq: 5, time: 23, data: {
        version: 2, mode: 'one-shot', provider: 'fork', label: 'summary task',
      } },
      { type: 'assistant/message', seq: 6, time: 38, data: {
        turn: 1, step: 1,
        message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'done' }] },
      } },
      { type: 'turn/end', seq: 7, time: 39, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  return { sessions: [parent, child], parentSessionId: 'parent', parent, child, call, result }
}

test('accepts the complete model-facing foreground lifecycle', () => {
  const input = fixture()
  const evidence = assertNativeForegroundDelegation(input)
  assert.equal(evidence.childSessionId, 'child')
  assert.equal(evidence.prompt, 'model-authored child prompt')
  assert.equal(evidence.callId, 'call-1')
  assert.match(evidence.toolSchemaSha256, /^[0-9a-f]{64}$/)
  assert.equal(evidence.childTerminalSeq, 7)
})

test('rejects an evaluator-started child with no parent tool pair', () => {
  const input = fixture()
  input.parent.events = []
  assert.throws(() => assertNativeForegroundDelegation(input), /exactly one model-authored subagent_fork tool\/call/)
})

test('rejects a child whose first user message differs from the model prompt', () => {
  const input = fixture()
  input.child.events[4].data.content[0].text = 'driver-authored replacement'
  assert.throws(() => assertNativeForegroundDelegation(input), /no unique direct child/)
})

test('rejects background delegation', () => {
  const input = fixture()
  input.call.data.arguments = JSON.stringify({
    description: 'summary task', prompt: 'model-authored child prompt', run_in_background: true,
  })
  assert.throws(() => assertNativeForegroundDelegation(input), /not explicitly foreground/)
})

test('rejects an unlinked or errored parent result', () => {
  const unlinked = fixture()
  unlinked.result.sourceEventSeqs = []
  assert.throws(() => assertNativeForegroundDelegation(unlinked), /does not cite/)

  const errored = fixture()
  errored.result.data.message.content[0].isError = true
  assert.throws(() => assertNativeForegroundDelegation(errored), /tool\/result is an error/)
})

test('rejects a missing request schema or an incompletely persisted child turn', () => {
  const missingSchema = fixture()
  missingSchema.parent.events = missingSchema.parent.events.filter(event => event.type !== 'request/header')
  assert.throws(() => assertNativeForegroundDelegation(missingSchema), /no preceding native request\/header/)

  const incompleteChild = fixture()
  incompleteChild.child.events = incompleteChild.child.events.filter(event => event.type !== 'turn/end')
  assert.throws(() => assertNativeForegroundDelegation(incompleteChild), /no durably completed turn/)
})

test('reads and verifies the durable JSONL shape used by the CLI driver', async () => {
  const input = fixture()
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v21-durable-'))
  try {
    for (const session of [input.parent, input.child]) {
      const directory = join(root, session.header.id)
      await mkdir(directory)
      const rows = [session.header, ...session.events]
      await writeFile(join(directory, 'session.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    }
    const evidence = await assertDurableNativeForegroundDelegation({
      sessionsRoot: root,
      parentSessionId: 'parent',
    })
    assert.equal(evidence.childSessionId, 'child')
    assert.equal(evidence.prompt, 'model-authored child prompt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
