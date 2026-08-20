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
  return mkdtemp(path.join(tmpdir(), 'dwl-transitions-'))
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

async function get(store, dutyId) {
  return run(['get', '--store', store, '--duty', dutyId])
}

const OPEN = {
  commandId: 'c-open',
  type: 'open',
  dutyId: 'd1',
  actor: { id: 'alice', role: 'dispatcher' },
  at: '2026-01-01T00:00:00.000Z',
  expectedRevision: 0,
  worker: 'bob',
  start: '2026-01-01T08:00:00.000Z',
  end: '2026-01-01T16:00:00.000Z',
}

// Opens d1 and returns the store path. Fails the test if open is rejected.
async function openDuty(dir, overrides = {}) {
  const store = path.join(dir, 'store.jsonl')
  const res = await apply(dir, store, 'open.json', { ...OPEN, ...overrides })
  assert.equal(res.code, 0, res.stderr)
  return store
}

// A worker transition payload; expectedRevision is the duty revision that
// must be current for the command to be accepted.
function workerCmd(type, revision, overrides = {}) {
  return {
    commandId: 'c-' + type,
    type,
    dutyId: 'd1',
    actor: { id: 'bob', role: 'worker' },
    at: '2026-01-01T09:00:00.000Z',
    expectedRevision: revision,
    ...overrides,
  }
}

const WINDOW = { worker: 'bob', start: OPEN.start, end: OPEN.end }

test('checkin by the duty worker moves a planned duty to active', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  const res = await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), {
    commandId: 'c-checkin',
    dutyId: 'd1',
    revision: 2,
    status: 'active',
    replayed: false,
  })
  const g = await get(store, 'd1')
  assert.deepEqual(JSON.parse(g.stdout), {
    id: 'd1',
    ...WINDOW,
    status: 'active',
    revision: 2,
    note: null,
  })
})

test('pause records the reason as the duty note and moves active to paused', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  const res = await apply(dir, store, 'pause.json', workerCmd('pause', 2, { reason: 'lunch break', at: '2026-01-01T10:00:00.000Z' }))
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), {
    commandId: 'c-pause',
    dutyId: 'd1',
    revision: 3,
    status: 'paused',
    replayed: false,
  })
  const g = await get(store, 'd1')
  assert.deepEqual(JSON.parse(g.stdout), {
    id: 'd1',
    ...WINDOW,
    status: 'paused',
    revision: 3,
    note: 'lunch break',
  })
})

test('resume by a dispatcher clears the pause note and returns to active', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  await apply(dir, store, 'pause.json', workerCmd('pause', 2, { reason: 'lunch break' }))
  const res = await apply(dir, store, 'resume.json', {
    ...workerCmd('resume', 3, { at: '2026-01-01T11:00:00.000Z' }),
    actor: { id: 'alice', role: 'dispatcher' },
  })
  assert.equal(res.code, 0)
  assert.equal(JSON.parse(res.stdout).status, 'active')
  assert.equal(JSON.parse(res.stdout).revision, 4)
  const g = await get(store, 'd1')
  assert.deepEqual(JSON.parse(g.stdout), {
    id: 'd1',
    ...WINDOW,
    status: 'active',
    revision: 4,
    note: null,
  })
})

test('checkout completes the duty and records the note', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  const res = await apply(dir, store, 'checkout.json', workerCmd('checkout', 2, { note: 'finished early', at: '2026-01-01T15:00:00.000Z' }))
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), {
    commandId: 'c-checkout',
    dutyId: 'd1',
    revision: 3,
    status: 'completed',
    replayed: false,
  })
  const g = await get(store, 'd1')
  assert.deepEqual(JSON.parse(g.stdout), {
    id: 'd1',
    ...WINDOW,
    status: 'completed',
    revision: 3,
    note: 'finished early',
  })
})

test('full lifecycle open -> checkin -> pause -> resume -> checkout reaches completed', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  await apply(dir, store, 'pause.json', workerCmd('pause', 2, { reason: 'break' }))
  await apply(dir, store, 'resume.json', {
    ...workerCmd('resume', 3),
    actor: { id: 'alice', role: 'dispatcher' },
  })
  const out = await apply(dir, store, 'checkout.json', workerCmd('checkout', 4, { note: 'done' }))
  assert.equal(out.code, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout), {
    commandId: 'c-checkout',
    dutyId: 'd1',
    revision: 5,
    status: 'completed',
    replayed: false,
  })
  const g = await get(store, 'd1')
  assert.deepEqual(JSON.parse(g.stdout), {
    id: 'd1',
    ...WINDOW,
    status: 'completed',
    revision: 5,
    note: 'done',
  })
})

test('wrong actor role or worker identity is an authorization failure (exit 4)', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  // Dispatcher cannot check in.
  const dispatcherCheckin = await apply(dir, store, 'bad1.json', {
    ...workerCmd('checkin', 1),
    actor: { id: 'alice', role: 'dispatcher' },
  })
  assert.equal(dispatcherCheckin.code, 4)
  assert.equal(dispatcherCheckin.stdout, '')
  // Worker cannot resume (dispatcher-only).
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  await apply(dir, store, 'pause.json', workerCmd('pause', 2, { reason: 'break' }))
  const workerResume = await apply(dir, store, 'bad2.json', workerCmd('resume', 3))
  assert.equal(workerResume.code, 4)
  assert.equal(workerResume.stdout, '')
  // A different worker id cannot act for the duty worker.
  const wrongWorker = await apply(dir, store, 'bad3.json', {
    ...workerCmd('checkin', 1),
    commandId: 'c-bad3',
    actor: { id: 'carol', role: 'worker' },
  })
  assert.equal(wrongWorker.code, 4)
  assert.equal(wrongWorker.stdout, '')
})

test('transitions on a missing duty are state rejections (exit 3)', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'store.jsonl')
  const res = await apply(dir, store, 'checkin.json', workerCmd('checkin', 0))
  assert.equal(res.code, 3)
  assert.equal(res.stdout, '')
  await assert.rejects(stat(store), { code: 'ENOENT' })
})

test('transitions from an invalid source status are state rejections (exit 3)', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  // checkin on an active duty.
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  const reCheckin = await apply(dir, store, 'recheckin.json', workerCmd('checkin', 2, { commandId: 'c-checkin-2' }))
  assert.equal(reCheckin.code, 3)
  // pause on a planned duty (never checked in).
  const dir2 = await makeDir()
  const store2 = await openDuty(dir2)
  const pausePlanned = await apply(dir2, store2, 'pause.json', workerCmd('pause', 1, { reason: 'x' }))
  assert.equal(pausePlanned.code, 3)
  // resume on an active duty.
  const resumeActive = await apply(dir, store, 'resume.json', {
    ...workerCmd('resume', 2, { commandId: 'c-resume-2' }),
    actor: { id: 'alice', role: 'dispatcher' },
  })
  assert.equal(resumeActive.code, 3)
  // checkout on a paused duty.
  await apply(dir2, store2, 'checkin.json', workerCmd('checkin', 1))
  await apply(dir2, store2, 'pause.json', workerCmd('pause', 2, { reason: 'x' }))
  const checkoutPaused = await apply(dir2, store2, 'checkout.json', workerCmd('checkout', 3, { note: 'x' }))
  assert.equal(checkoutPaused.code, 3)
})

test('optimistic concurrency: mismatched expectedRevision is rejected (exit 3)', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  for (const revision of [0, 2, 3]) {
    const res = await apply(dir, store, 'cc-' + revision + '.json', workerCmd('checkin', revision, { commandId: 'c-cc-' + revision }))
    assert.equal(res.code, 3, 'revision ' + revision + ' should conflict')
    assert.equal(res.stdout, '')
  }
})

test('command at older than the duty latest accepted event is rejected; equal is accepted', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  const stale = await apply(dir, store, 'stale.json', workerCmd('checkin', 1, { at: '2025-12-31T23:59:59.000Z' }))
  assert.equal(stale.code, 3)
  const equal = await apply(dir, store, 'equal.json', workerCmd('checkin', 1, { at: '2026-01-01T00:00:00.000Z' }))
  assert.equal(equal.code, 0, equal.stderr)
  assert.equal(JSON.parse(equal.stdout).status, 'active')
})

test('replaying any accepted transition is idempotent and changes no bytes', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  const cmds = await Promise.all([
    writeCmd(dir, 'checkin.json', workerCmd('checkin', 1)),
    writeCmd(dir, 'pause.json', workerCmd('pause', 2, { reason: 'break' })),
    writeCmd(dir, 'resume.json', { ...workerCmd('resume', 3), actor: { id: 'alice', role: 'dispatcher' } }),
    writeCmd(dir, 'checkout.json', workerCmd('checkout', 4, { note: 'done' })),
  ])
  for (const cmd of cmds) {
    const first = await run(['apply', '--store', store, '--command', cmd])
    assert.equal(first.code, 0, first.stderr)
    const before = await readFile(store)
    const again = await run(['apply', '--store', store, '--command', cmd])
    assert.equal(again.code, 0)
    assert.equal(JSON.parse(again.stdout).replayed, true)
    assert.equal(JSON.parse(again.stdout).status, JSON.parse(first.stdout).status)
    assert.equal(JSON.parse(again.stdout).revision, JSON.parse(first.stdout).revision)
    assert.deepEqual(await readFile(store), before)
  }
})

test('commandId reuse with different content across types is a conflict (exit 3), bytes unchanged', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  const before = await readFile(store)
  // Reuse the open commandId with a checkin-shaped command.
  const hijack = await apply(dir, store, 'hijack.json', { ...workerCmd('checkin', 1), commandId: 'c-open' })
  assert.equal(hijack.code, 3)
  assert.equal(hijack.stdout, '')
  assert.deepEqual(await readFile(store), before)
})

test('rejected transitions are atomic: store bytes and directory are untouched', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  const before = await readFile(store)
  const bad = await apply(dir, store, 'bad.json', workerCmd('pause', 99, { reason: 'x' }))
  assert.equal(bad.code, 3)
  assert.deepEqual(await readFile(store), before)
  const entries = await readdir(dir)
  assert.ok(entries.every((e) => !e.startsWith('.')), 'temp files left behind: ' + entries)
})

test('durable events preserve the exact state-snapshot keys per type', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  await apply(dir, store, 'pause.json', workerCmd('pause', 2, { reason: 'lunch break' }))
  await apply(dir, store, 'resume.json', { ...workerCmd('resume', 3), actor: { id: 'alice', role: 'dispatcher' } })
  await apply(dir, store, 'checkout.json', workerCmd('checkout', 4, { note: 'finished' }))

  const content = await readFile(store, 'utf8')
  assert.ok(content.endsWith('\n'))
  const lines = content.split('\n')
  assert.equal(lines.length, 6) // five events plus the trailing empty element
  assert.equal(lines[5], '')
  const events = lines.slice(0, 5).map((l) => JSON.parse(l))

  const keysOf = (o) => Object.keys(o).sort()
  const unique = (arr) => [...new Set(arr)]
  const ENVELOPE = ['commandId', 'type', 'dutyId', 'actor', 'at', 'expectedRevision']
  const STATE = ['revision', 'status', 'worker', 'start', 'end', 'note']
  assert.deepEqual(keysOf(events[0]), unique([...ENVELOPE, 'worker', 'start', 'end', ...STATE]).sort())
  assert.deepEqual(keysOf(events[1]), unique([...ENVELOPE, ...STATE]).sort())
  assert.deepEqual(keysOf(events[2]), unique([...ENVELOPE, 'reason', ...STATE]).sort())
  assert.deepEqual(keysOf(events[3]), unique([...ENVELOPE, ...STATE]).sort())
  assert.deepEqual(keysOf(events[4]), unique([...ENVELOPE, 'note', ...STATE]).sort())

  // Each event is a full snapshot: window fields persist, revisions climb by 1.
  for (const event of events) {
    assert.equal(event.worker, 'bob')
    assert.equal(event.start, OPEN.start)
    assert.equal(event.end, OPEN.end)
  }
  assert.deepEqual(events.map((e) => e.revision), [1, 2, 3, 4, 5])
  assert.deepEqual(events.map((e) => e.status), ['planned', 'active', 'paused', 'active', 'completed'])
  assert.deepEqual(events.map((e) => e.note), [null, null, 'lunch break', null, 'finished'])
  assert.equal(events[2].reason, 'lunch break')
  assert.equal(events[2].note, 'lunch break')
  assert.equal(events[4].note, 'finished')
})

test('transition shape and value errors exit 2', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  const cases = [
    // pause without its reason key.
    workerCmd('pause', 1),
    // pause with an empty reason.
    workerCmd('pause', 1, { reason: '' }),
    // checkout without its note key.
    workerCmd('checkout', 1),
    // checkout with an empty note.
    workerCmd('checkout', 1, { note: '' }),
    // checkin with a stray type-specific key.
    { ...workerCmd('checkin', 1), worker: 'bob' },
    // resume with a stray note key.
    { ...workerCmd('resume', 3), note: 'x' },
  ]
  for (const [i, payload] of cases.entries()) {
    const res = await apply(dir, store, 'shape-' + i + '.json', payload)
    assert.equal(res.code, 2, 'case ' + i + ' should exit 2')
    assert.equal(res.stdout, '')
  }
})

test('cleanup removes temp dirs', async () => {
  const dir = await makeDir()
  const store = await openDuty(dir)
  await apply(dir, store, 'checkin.json', workerCmd('checkin', 1))
  await rm(dir, { recursive: true, force: true })
})
