import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm, readdir, stat, mkdir } from 'node:fs/promises'
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
  return mkdtemp(path.join(tmpdir(), 'dwl-foundation-'))
}

// Command files live in a cmds/ subdirectory so the temp dir's root only ever
// holds the store file (keeps "no stray files" assertions simple).
async function writeCmd(dir, name, payload) {
  const cmds = path.join(dir, 'cmds')
  await mkdir(cmds, { recursive: true })
  const cmd = path.join(cmds, name)
  await writeFile(cmd, JSON.stringify(payload))
  return cmd
}

const OPEN = {
  commandId: 'c1',
  type: 'open',
  dutyId: 'd1',
  actor: { id: 'alice', role: 'dispatcher' },
  at: '2026-01-01T00:00:00.000Z',
  expectedRevision: 0,
  worker: 'bob',
  start: '2026-01-01T08:00:00.000Z',
  end: '2026-01-01T16:00:00.000Z',
}

async function applyOpen(dir, overrides = {}) {
  const store = path.join(dir, 'store.jsonl')
  const cmd = await writeCmd(dir, 'open.json', { ...OPEN, ...overrides })
  const res = await run(['apply', '--store', store, '--command', cmd])
  return { store, cmd, res }
}

test('open accepts a dispatcher command and creates a planned duty', async () => {
  const dir = await makeDir()
  const { store, res } = await applyOpen(dir)
  assert.equal(res.code, 0)
  assert.equal(res.stderr, '')
  assert.deepEqual(JSON.parse(res.stdout), {
    commandId: 'c1',
    dutyId: 'd1',
    revision: 1,
    status: 'planned',
    replayed: false,
  })
  // Store was created as a JSON-lines log with exactly one event.
  const content = await readFile(store, 'utf8')
  const lines = content.trimEnd().split('\n')
  assert.equal(lines.length, 1)
  const event = JSON.parse(lines[0])
  assert.equal(event.commandId, 'c1')
  assert.equal(event.dutyId, 'd1')
  assert.equal(event.revision, 1)
  assert.equal(event.status, 'planned')
  assert.equal(event.worker, 'bob')
  assert.equal(event.note, null)
})

test('get returns exactly the duty projection with null note', async () => {
  const dir = await makeDir()
  const { store } = await applyOpen(dir)
  const res = await run(['get', '--store', store, '--duty', 'd1'])
  assert.equal(res.code, 0)
  assert.equal(res.stderr, '')
  assert.deepEqual(JSON.parse(res.stdout), {
    id: 'd1',
    worker: 'bob',
    start: '2026-01-01T08:00:00.000Z',
    end: '2026-01-01T16:00:00.000Z',
    status: 'planned',
    revision: 1,
    note: null,
  })
})

test('get for an unknown duty exits 3 with no stdout', async () => {
  const dir = await makeDir()
  const { store } = await applyOpen(dir)
  const res = await run(['get', '--store', store, '--duty', 'nope'])
  assert.equal(res.code, 3)
  assert.equal(res.stdout, '')
  assert.ok(res.stderr.length > 0)
})

test('get on a missing store exits 3 and never creates the store', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 'missing.jsonl')
  const res = await run(['get', '--store', store, '--duty', 'd1'])
  assert.equal(res.code, 3)
  assert.equal(res.stdout, '')
  await assert.rejects(stat(store), { code: 'ENOENT' })
})

test('repeating an identical accepted command replays with replayed true and changes no bytes', async () => {
  const dir = await makeDir()
  const { store, cmd } = await applyOpen(dir)
  const before = await readFile(store)
  const res = await run(['apply', '--store', store, '--command', cmd])
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), {
    commandId: 'c1',
    dutyId: 'd1',
    revision: 1,
    status: 'planned',
    replayed: true,
  })
  assert.deepEqual(await readFile(store), before)
})

test('reusing a commandId with different content exits 3 and changes no bytes', async () => {
  const dir = await makeDir()
  const { store } = await applyOpen(dir)
  const before = await readFile(store)
  const other = await writeCmd(dir, 'other.json', { ...OPEN, worker: 'carol' })
  const res = await run(['apply', '--store', store, '--command', other])
  assert.equal(res.code, 3)
  assert.equal(res.stdout, '')
  assert.deepEqual(await readFile(store), before)
})

test('open on an existing duty is a state conflict (exit 3)', async () => {
  const dir = await makeDir()
  const { store } = await applyOpen(dir)
  const cmd = await writeCmd(dir, 'second.json', { ...OPEN, commandId: 'c2', at: '2026-01-02T00:00:00.000Z' })
  const res = await run(['apply', '--store', store, '--command', cmd])
  assert.equal(res.code, 3)
  assert.equal(res.stdout, '')
})

test('open with a non-zero expectedRevision is an optimistic conflict (exit 3)', async () => {
  const dir = await makeDir()
  const { store, res } = await applyOpen(dir, { expectedRevision: 1 })
  assert.equal(res.code, 3)
  assert.equal(res.stdout, '')
  await assert.rejects(stat(store), { code: 'ENOENT' })
})

test('open by a worker role is an authorization failure (exit 4) and never creates the store', async () => {
  const dir = await makeDir()
  const { store, res } = await applyOpen(dir, { actor: { id: 'bob', role: 'worker' } })
  assert.equal(res.code, 4)
  assert.equal(res.stdout, '')
  await assert.rejects(stat(store), { code: 'ENOENT' })
})

test('rejected commands leave no temporary files behind', async () => {
  const dir = await makeDir()
  const { store } = await applyOpen(dir)
  const before = await readdir(dir)
  const cmd = await writeCmd(dir, 'bad.json', { ...OPEN, worker: 'carol' })
  await run(['apply', '--store', store, '--command', cmd])
  assert.deepEqual(await readdir(dir), before)
})

test('strict CLI parsing: unknown command, flag, duplicates, missing values, positionals', async () => {
  const dir = await makeDir()
  assert.equal((await run(['frobnicate'])).code, 2)
  assert.equal((await run([])).code, 2)
  assert.equal((await run(['apply', '--store', dir])).code, 2) // missing --command
  assert.equal((await run(['apply', '--bogus', 'x', '--command', 'y', '--store', 'z'])).code, 2)
  assert.equal((await run(['get', '--store', 'a', '--store', 'b', '--duty', 'd'])).code, 2)
  assert.equal((await run(['get', '--store'])).code, 2)
  assert.equal((await run(['get', '--store', 'a', '--duty', 'd', 'extra'])).code, 2)
  assert.equal((await run(['apply', '--store', 's', '--command', 'c', '--command', 'c2'])).code, 2)
})

test('strict CLI parsing: empty flag values are missing values (exit 2)', async () => {
  assert.equal((await run(['get', '--store', '', '--duty', 'd'])).code, 2)
})

test('unreadable or malformed command files exit 2', async () => {
  const dir = await makeDir()
  const missing = path.join(dir, 'cmds', 'missing.json')
  const bad = await writeCmd(dir, 'bad.json', null)
  await writeFile(bad, '{not json')
  assert.equal((await run(['apply', '--store', path.join(dir, 's'), '--command', missing])).code, 2)
  assert.equal((await run(['apply', '--store', path.join(dir, 's'), '--command', bad])).code, 2)
})

test('non-object and non-exact command shapes exit 2', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 's.jsonl')
  const cases = [
    { ...OPEN, extra: 1 }, // unknown key
    (({ worker, ...rest }) => rest)(OPEN), // missing worker
    [...Object.entries(OPEN)], // array root
    { ...OPEN, actor: { id: 'alice' } }, // actor missing role
    { ...OPEN, actor: { id: 'alice', role: 'dispatcher', extra: 1 } }, // actor extra key
  ]
  for (const [i, payload] of cases.entries()) {
    const cmd = await writeCmd(dir, `case-${i}.json`, payload)
    const res = await run(['apply', '--store', store, '--command', cmd])
    assert.equal(res.code, 2, `case ${i} should exit 2`)
    assert.equal(res.stdout, '')
  }
})

test('invalid field values exit 2', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 's.jsonl')
  const cases = [
    { ...OPEN, commandId: '' },
    { ...OPEN, dutyId: '' },
    { ...OPEN, at: 'not-a-timestamp' },
    { ...OPEN, at: '2026-01-01' }, // missing time part
    { ...OPEN, expectedRevision: -1 },
    { ...OPEN, expectedRevision: 1.5 },
    { ...OPEN, expectedRevision: '0' },
    { ...OPEN, worker: '' },
    { ...OPEN, actor: { id: '', role: 'dispatcher' } },
    { ...OPEN, actor: { id: 'alice', role: 'admin' } },
    { ...OPEN, start: '2026-01-01T16:00:00.000Z', end: '2026-01-01T08:00:00.000Z' }, // end before start
    { ...OPEN, start: '2026-01-01T08:00:00.000Z', end: '2026-01-01T08:00:00.000Z' }, // end == start
    { ...OPEN, type: 'frobnicate' }, // unknown type
  ]
  for (const [i, payload] of cases.entries()) {
    const cmd = await writeCmd(dir, `val-${i}.json`, payload)
    const res = await run(['apply', '--store', store, '--command', cmd])
    assert.equal(res.code, 2, `case ${i} should exit 2`)
    assert.equal(res.stdout, '')
  }
})

test('malformed durable store state is an input failure (exit 2)', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 's.jsonl')
  await writeFile(store, 'not json\n')
  const cmd = await writeCmd(dir, 'c.json', OPEN)
  const res = await run(['apply', '--store', store, '--command', cmd])
  assert.equal(res.code, 2)
  assert.equal(res.stdout, '')
  const get = await run(['get', '--store', store, '--duty', 'd1'])
  assert.equal(get.code, 2)
})

test('summary on a missing store reports all-zero counts and never creates the store', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 's.jsonl')
  const res = await run(['summary', '--store', store, '--at', '2026-01-01T00:00:00.000Z'])
  assert.equal(res.code, 0)
  assert.equal(res.stderr, '')
  assert.deepEqual(JSON.parse(res.stdout), {
    at: '2026-01-01T00:00:00.000Z',
    planned: 0,
    active: 0,
    paused: 0,
    completed: 0,
    activeDutyIds: [],
    pausedDutyIds: [],
  })
  await assert.rejects(stat(store), { code: 'ENOENT' })
})

test('successful apply leaves exactly the store file and no temp files', async () => {
  const dir = await makeDir()
  const { store } = await applyOpen(dir)
  const entries = await readdir(dir)
  assert.ok(entries.includes(path.basename(store)))
  // No leftover same-directory temporary files (dot-prefixed) from atomic writes.
  assert.ok(entries.every((e) => !e.startsWith('.')), `unexpected temp files: ${entries}`)
})

test('hostile type names colliding with Object.prototype exit 2 with a clean diagnostic', async () => {
  const dir = await makeDir()
  const store = path.join(dir, 's.jsonl')
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const cmd = await writeCmd(dir, 'type-' + type + '.json', { ...OPEN, type })
    const res = await run(['apply', '--store', store, '--command', cmd])
    assert.equal(res.code, 2, 'type ' + type + ' should exit 2')
    assert.equal(res.stdout, '')
    assert.match(res.stderr, /unsupported command type/)
    await assert.rejects(stat(store), { code: 'ENOENT' })
  }
})

test('cleanup removes temp dirs', async () => {
  const dir = await makeDir()
  await applyOpen(dir)
  await rm(dir, { recursive: true, force: true })
})
