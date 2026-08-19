import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditPersistentNativeContinuity } from '../session-audit.mjs'

function user(seq, source, text, surfaceOp = 'append') {
  return {
    type: 'user/message',
    seq,
    time: seq,
    surfaceOp,
    data: { id: `m-${seq}`, source, content: [{ type: 'text', text }] },
  }
}

async function writeSession(root, header, events, complete = true) {
  const directory = join(root, header.id)
  await mkdir(directory, { recursive: true })
  const text = [header, ...events].map(row => JSON.stringify(row)).join('\n') + (complete ? '\n' : '')
  await writeFile(join(directory, 'session.jsonl'), text, 'utf8')
}

test('audits complete durable root and child Session artifacts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v21-audit-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeSession(root, { type: 'session', id: 'root' }, [
    user(0, { kind: 'user' }, 'root task'),
    user(1, { kind: 'plugin', plugin: 'compaction' }, 'summary', { op: 'replace', start: 0, end: 0 }),
    user(2, {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [{ name: 'plan-lattice:execution-state', text: 'bounded recovery' }],
    }, 'bounded recovery'),
  ])
  await writeSession(root, {
    type: 'session', id: 'child', parentSession: 'root', origin: 'subagent', seedLength: 2,
  }, [
    user(0, { kind: 'user' }, 'seed authority'),
    user(1, { kind: 'plugin', plugin: 'compaction' }, 'seed summary', { op: 'replace', start: 0, end: 0 }),
    user(2, { kind: 'user' }, 'exact child prompt'),
  ])
  const result = await auditPersistentNativeContinuity(root, {
    expectedSessionIds: ['root', 'child'],
  })
  assert.equal(result.valid, true)
  assert.equal(result.files.length, 2)
  assert.equal(result.totalSnapshots, 1)
})

test('rejects truncated JSONL before interpreting continuity', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v21-truncated-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeSession(root, { type: 'session', id: 'root' }, [
    user(0, { kind: 'user' }, 'root task'),
  ], false)
  await assert.rejects(auditPersistentNativeContinuity(root), /not a complete durable JSONL artifact/)
})

