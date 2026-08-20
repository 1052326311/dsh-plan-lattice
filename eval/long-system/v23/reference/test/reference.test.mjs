import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('..', import.meta.url))

function run(args) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...args], {
    cwd: workspace,
    encoding: 'utf8',
  })
}

test('reference implements the material revision and atomic input rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duty-window-v23-reference-'))
  const store = join(root, 'duties.jsonl')
  let sequence = 0
  const apply = async (command) => {
    const file = join(root, `command-${sequence++}.json`)
    await writeFile(file, `${JSON.stringify(command)}\n`, 'utf8')
    return run(['apply', '--store', store, '--command', file])
  }
  const base = {
    dutyId: 'DUTY-REFERENCE',
    actor: { id: 'dispatcher-1', role: 'dispatcher' },
  }

  try {
    assert.equal((await apply({
      ...base,
      commandId: 'open-1',
      type: 'open',
      at: '2026-06-01T08:00:00.000Z',
      expectedRevision: 0,
      worker: 'worker-1',
      start: '2026-06-01T08:00:00.000Z',
      end: '2026-06-01T12:00:00.000Z',
    })).status, 0)

    const before = await readFile(store)
    const invalid = await apply({
      ...base,
      commandId: 'adjust-invalid',
      type: 'adjust-start',
      at: '2026-06-01T08:10:00.000Z',
      expectedRevision: 1,
      start: '2026-06-01T12:00:00.000Z',
    })
    assert.equal(invalid.status, 2)
    assert.deepEqual(await readFile(store), before)

    const retired = await apply({
      ...base,
      commandId: 'resume-new',
      type: 'resume',
      at: '2026-06-01T08:20:00.000Z',
      expectedRevision: 1,
    })
    assert.equal(retired.status, 2)
    assert.deepEqual(await readFile(store), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
