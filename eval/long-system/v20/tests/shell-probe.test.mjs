import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildShellProbeCommand,
  shellQuote,
  verifyShellProbe,
} from '../driver/shell-probe.mjs'

test('shellQuote preserves paths containing apostrophes', () => {
  const value = "a path/with ' one"
  const result = spawnSync('/bin/bash', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, value)
})

test('probe runs a real Node test and records success when the forbidden path is unreadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v20-shell-probe-'))
  try {
    const result = spawnSync('/bin/bash', ['-c', buildShellProbeCommand(join(root, 'missing-forbidden-root'))], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /V20_NODE_TEST_PASSED/)
    await verifyShellProbe(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('probe fails closed when the supposedly forbidden path is readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v20-shell-probe-denial-'))
  try {
    const readable = join(root, 'readable.txt')
    await writeFile(readable, 'visible\n', 'utf8')
    const result = spawnSync('/bin/bash', ['-c', buildShellProbeCommand(readable)], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 91)
    assert.match(result.stderr, /outer sandbox read boundary failed/)
    await assert.rejects(verifyShellProbe(root), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
