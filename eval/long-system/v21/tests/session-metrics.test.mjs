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
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v21-session-metrics-'))
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unseeded root metrics continue to inspect the first ordinary user message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v21-root-metrics-'))
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
