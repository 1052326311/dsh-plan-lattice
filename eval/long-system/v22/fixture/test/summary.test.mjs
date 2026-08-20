import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm, mkdir, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

async function run(args) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], { encoding: 'utf8' })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

async function makeDir() {
  return mkdtemp(path.join(tmpdir(), 'dwl-summary-'))
}

async function writeCmd(dir, name, payload) {
  const cmds = path.join(dir, 'cmds')
  await mkdir(cmds, { recursive: true })
  const cmd = path.join(cmds, name)
  await writeFile(cmd, JSON.stringify(payload))
  return cmd
}

async function apply(dir, store, name, payload) {
  const cmd = await writeCmd(dir, name, payload)
  return run(['apply', '--store', store, '--command', cmd])
}

async function summary(store, at) {
  return run(['summary', '--store', store, '--at', at])
}

const ZERO = { planned: 0, active: 0, paused: 0, completed: 0, activeDutyIds: [], pausedDutyIds: [] }

function open(dutyId, commandId, at) {
  return {
    commandId,
    type: 'open',
    dutyId,
    actor: { id: 'alice', role: 'dispatcher' },
    at,
    expectedRevision: 0,
    worker: 'bob',
    start: '2026-01-01T08:00:00.000Z',
    end: '2026-01-01T16:00:00.000Z',
  }
}

function workerCmd(type, dutyId, commandId, at, revision, extra = {}) {
  return {
    commandId,
    type,
    dutyId,
    actor: { id: 'bob', role: 'worker' },
    at,
    expectedRevision: revision,
    ...extra,
  }
}

test('summary on a missing store is exit 0 with all-zero counts and never creates the store', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  const res = await summary(store, '2026-01-01T00:00:00.000Z')
  assert.equal(res.code, 0)
  assert.equal(res.stderr, '')
  const out = JSON.parse(res.stdout)
  // Exact output shape, key order as listed in the contract.
  assert.deepEqual(Object.keys(out), ['at', 'planned', 'active', 'paused', 'completed', 'activeDutyIds', 'pausedDutyIds'])
  assert.deepEqual(out, { at: '2026-01-01T00:00:00.000Z', ...ZERO })
  await assert.rejects(stat(store), { code: 'ENOENT' })
  assert.deepEqual(await readdir(dir), [])
})

test('summary after a full lifecycle counts one completed duty', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  const steps = [
    open('d1', 'c1', '2026-01-01T00:00:00.000Z'),
    workerCmd('checkin', 'd1', 'c2', '2026-01-01T09:00:00.000Z', 1),
    { ...workerCmd('pause', 'd1', 'c3', '2026-01-01T10:00:00.000Z', 2), reason: 'break' },
    { ...workerCmd('resume', 'd1', 'c4', '2026-01-01T11:00:00.000Z', 3), actor: { id: 'alice', role: 'dispatcher' } },
    { ...workerCmd('checkout', 'd1', 'c5', '2026-01-01T15:00:00.000Z', 4), note: 'done' },
  ]
  for (const [i, payload] of steps.entries()) {
    const res = await apply(dir, store, 'step-' + i + '.json', payload)
    assert.equal(res.code, 0, res.stderr)
  }
  const res = await summary(store, '2026-01-01T16:00:00.000Z')
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), {
    at: '2026-01-01T16:00:00.000Z',
    planned: 0,
    active: 0,
    paused: 0,
    completed: 1,
    activeDutyIds: [],
    pausedDutyIds: [],
  })
})

test('intermediate instants reflect the duty state at each point', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await apply(dir, store, 'open.json', open('d1', 'c1', '2026-01-01T00:00:00.000Z'))
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 'd1', 'c2', '2026-01-01T09:00:00.000Z', 1))
  await apply(dir, store, 'pause.json', { ...workerCmd('pause', 'd1', 'c3', '2026-01-01T10:00:00.000Z', 2), reason: 'break' })

  const planned = await summary(store, '2026-01-01T08:00:00.000Z')
  assert.equal(planned.code, 0)
  assert.deepEqual(JSON.parse(planned.stdout), {
    at: '2026-01-01T08:00:00.000Z', planned: 1, active: 0, paused: 0, completed: 0,
    activeDutyIds: [], pausedDutyIds: [],
  })

  const active = await summary(store, '2026-01-01T09:00:00.000Z')
  assert.equal(active.code, 0)
  assert.deepEqual(JSON.parse(active.stdout), {
    at: '2026-01-01T09:00:00.000Z', planned: 0, active: 1, paused: 0, completed: 0,
    activeDutyIds: ['d1'], pausedDutyIds: [],
  })

  const paused = await summary(store, '2026-01-01T10:00:00.000Z')
  assert.equal(paused.code, 0)
  assert.deepEqual(JSON.parse(paused.stdout), {
    at: '2026-01-01T10:00:00.000Z', planned: 0, active: 0, paused: 1, completed: 0,
    activeDutyIds: [], pausedDutyIds: ['d1'],
  })
})

test('boundary: events exactly at the instant are included, strictly after excluded', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await apply(dir, store, 'open.json', open('d1', 'c1', '2026-01-01T00:00:00.000Z'))
  // Exactly at the instant -> included.
  const atBoundary = await summary(store, '2026-01-01T00:00:00.000Z')
  assert.equal(atBoundary.code, 0)
  assert.deepEqual(JSON.parse(atBoundary.stdout), {
    at: '2026-01-01T00:00:00.000Z', planned: 1, active: 0, paused: 0, completed: 0,
    activeDutyIds: [], pausedDutyIds: [],
  })
  // Before the only event -> nothing qualifies.
  const before = await summary(store, '2025-12-31T23:59:59.999Z')
  assert.equal(before.code, 0)
  assert.deepEqual(JSON.parse(before.stdout), { at: '2025-12-31T23:59:59.999Z', ...ZERO })
  // Once a later event exists, an earlier instant still sees the earlier state.
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 'd1', 'c2', '2026-01-01T09:00:00.000Z', 1))
  const stillPlanned = await summary(store, '2026-01-01T00:00:00.000Z')
  assert.equal(stillPlanned.code, 0)
  assert.deepEqual(JSON.parse(stillPlanned.stdout), {
    at: '2026-01-01T00:00:00.000Z', planned: 1, active: 0, paused: 0, completed: 0,
    activeDutyIds: [], pausedDutyIds: [],
  })
})

test('tie ordering: equal at timestamps resolve to the later-accepted event', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await apply(dir, store, 'open.json', open('d1', 'c1', '2026-01-01T00:00:00.000Z'))
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 'd1', 'c2', '2026-01-01T00:00:00.000Z', 1))
  const res = await summary(store, '2026-01-01T00:00:00.000Z')
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), {
    at: '2026-01-01T00:00:00.000Z',
    planned: 0,
    active: 1,
    paused: 0,
    completed: 0,
    activeDutyIds: ['d1'],
    pausedDutyIds: [],
  })
})

test('multiple duties: sorted unique id arrays, lexicographic order, non-sorted acceptance', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  // Acceptance order deliberately interleaves duties: d10, d1, d2, d20.
  const steps = [
    open('d10', 'c1', '2026-01-01T00:00:00.000Z'),
    workerCmd('checkin', 'd10', 'c2', '2026-01-01T00:00:00.000Z', 1), // d10 active
    open('d1', 'c3', '2026-01-01T00:00:00.000Z'),
    workerCmd('checkin', 'd1', 'c4', '2026-01-01T00:00:00.000Z', 1),
    { ...workerCmd('pause', 'd1', 'c5', '2026-01-01T00:00:00.000Z', 2), reason: 'x' }, // d1 paused
    open('d2', 'c6', '2026-01-01T00:00:00.000Z'),
    workerCmd('checkin', 'd2', 'c7', '2026-01-01T00:00:00.000Z', 1), // d2 active
    open('d20', 'c8', '2026-01-01T00:00:00.000Z'),
    workerCmd('checkin', 'd20', 'c9', '2026-01-01T00:00:00.000Z', 1),
    { ...workerCmd('pause', 'd20', 'c10', '2026-01-01T00:00:00.000Z', 2), reason: 'x' }, // d20 paused
  ]
  for (const [i, payload] of steps.entries()) {
    const res = await apply(dir, store, 'step-' + i + '.json', payload)
    assert.equal(res.code, 0, res.stderr)
  }
  const res = await summary(store, '2026-01-01T00:00:00.000Z')
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), {
    at: '2026-01-01T00:00:00.000Z',
    planned: 0,
    active: 2,
    paused: 2,
    completed: 0,
    activeDutyIds: ['d10', 'd2'], // lexicographic: 'd10' sorts before 'd2'
    pausedDutyIds: ['d1', 'd20'],
  })
})

test('historical view: a duty paused and later resumed counts paused only before the resume', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await apply(dir, store, 'open.json', open('d1', 'c1', '2026-01-01T00:00:00.000Z'))
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 'd1', 'c2', '2026-01-01T09:00:00.000Z', 1))
  await apply(dir, store, 'pause.json', { ...workerCmd('pause', 'd1', 'c3', '2026-01-01T10:00:00.000Z', 2), reason: 'break' })
  await apply(dir, store, 'resume.json', { ...workerCmd('resume', 'd1', 'c4', '2026-01-01T11:00:00.000Z', 3), actor: { id: 'alice', role: 'dispatcher' } })

  const duringPause = await summary(store, '2026-01-01T10:00:00.000Z')
  assert.equal(duringPause.code, 0)
  assert.deepEqual(JSON.parse(duringPause.stdout), {
    at: '2026-01-01T10:00:00.000Z',
    planned: 0, active: 0, paused: 1, completed: 0,
    activeDutyIds: [], pausedDutyIds: ['d1'],
  })

  const afterResume = await summary(store, '2026-01-01T11:00:00.000Z')
  assert.equal(afterResume.code, 0)
  assert.deepEqual(JSON.parse(afterResume.stdout), {
    at: '2026-01-01T11:00:00.000Z',
    planned: 0, active: 1, paused: 0, completed: 0,
    activeDutyIds: ['d1'], pausedDutyIds: [],
  })
})

test('malformed --at values exit 2 with no stdout', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await apply(dir, store, 'open.json', open('d1', 'c1', '2026-01-01T00:00:00.000Z'))
  const bad = [
    '2026-01-01', // no time part
    '2026-01-01T00:00:00Z', // no milliseconds
    '2026-01-01T00:00:00.000', // no Z
    '2026-02-30T00:00:00.000Z', // impossible date
    'not-a-time',
  ]
  for (const at of bad) {
    const res = await summary(store, at)
    assert.equal(res.code, 2, 'at ' + at + ' should exit 2')
    assert.equal(res.stdout, '')
    assert.ok(res.stderr.length > 0)
  }
})

test('summary is byte read-only: store bytes and directory unchanged', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await apply(dir, store, 'open.json', open('d1', 'c1', '2026-01-01T00:00:00.000Z'))
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 'd1', 'c2', '2026-01-01T09:00:00.000Z', 1))
  const before = await readFile(store)
  const res = await summary(store, '2026-01-01T09:00:00.000Z')
  assert.equal(res.code, 0)
  assert.deepEqual(await readFile(store), before)
  const entries = await readdir(dir)
  assert.ok(entries.every((e) => !e.startsWith('.')), 'temp files left behind: ' + entries)
})

test('malformed store is an input failure (exit 2) for summary', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await writeFile(store, 'not json\n')
  const res = await summary(store, '2026-01-01T00:00:00.000Z')
  assert.equal(res.code, 2)
  assert.equal(res.stdout, '')
})

test('cleanup removes temp dirs', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  await apply(dir, store, 'open.json', open('d1', 'c1', '2026-01-01T00:00:00.000Z'))
  await rm(dir, { recursive: true, force: true })
})
