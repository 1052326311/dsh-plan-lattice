import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertV27CheckoutIntegrity,
  inspectV27CheckoutSpecialStates,
  materializeV27FrozenCommitRecords,
  readV27DriverClosureWorktreeRecords,
} from '../checkout-integrity.mjs'

function git(root, args) {
  const result = spawnSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'V27 Fixture',
      GIT_AUTHOR_EMAIL: 'v27@example.invalid',
      GIT_COMMITTER_NAME: 'V27 Fixture',
      GIT_COMMITTER_EMAIL: 'v27@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-checkout-integrity-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'driver', 'nested'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'driver', 'main.mjs'), 'export const value = 1\n'),
    writeFile(join(root, 'driver', 'nested', 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
  ])
  git(root, ['init', '--quiet'])
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'frozen driver'])
  return { root, commit: git(root, ['rev-parse', 'HEAD']), sourcePaths: ['driver'] }
}

test('compares every driver closure path, byte, and Git mode with the frozen commit', async (context) => {
  const input = await fixture(context)
  const worktree = readV27DriverClosureWorktreeRecords(input)
  const frozen = materializeV27FrozenCommitRecords(input)
  assert.deepEqual(
    worktree.map(({ path, mode, bytes }) => ({ path, mode, bytes: bytes.toString() })),
    frozen.map(({ path, mode, bytes }) => ({ path, mode, bytes: bytes.toString() })),
  )
  const inspected = assertV27CheckoutIntegrity(input)
  assert.equal(inspected.fileCount, 2)
  assert.match(inspected.recordsSha256, /^[0-9a-f]{64}$/u)

  await chmod(join(input.root, 'driver', 'nested', 'run.sh'), 0o644)
  assert.throws(() => assertV27CheckoutIntegrity(input), /mode differs from the frozen commit/)

  await chmod(join(input.root, 'driver', 'nested', 'run.sh'), 0o755)
  await writeFile(join(input.root, 'driver', 'main.mjs'), 'export const value = 2\n')
  assert.throws(() => assertV27CheckoutIntegrity(input), /bytes differ from the frozen commit/)
})

test('rejects an assume-unchanged mutation hidden from porcelain status', async (context) => {
  const input = await fixture(context)
  git(input.root, ['update-index', '--assume-unchanged', 'driver/main.mjs'])
  await writeFile(join(input.root, 'driver', 'main.mjs'), 'export const value = 2\n')
  assert.equal(git(input.root, ['status', '--porcelain', '--', 'driver/main.mjs']), '')
  assert.deepEqual(inspectV27CheckoutSpecialStates({ root: input.root }).assumeUnchanged, ['driver/main.mjs'])
  assert.throws(() => assertV27CheckoutIntegrity(input), /assume-unchanged index entries/)
})

test('rejects a skip-worktree mutation hidden from porcelain status', async (context) => {
  const input = await fixture(context)
  git(input.root, ['update-index', '--skip-worktree', 'driver/main.mjs'])
  await writeFile(join(input.root, 'driver', 'main.mjs'), 'export const value = 2\n')
  assert.equal(git(input.root, ['status', '--porcelain', '--', 'driver/main.mjs']), '')
  assert.deepEqual(inspectV27CheckoutSpecialStates({ root: input.root }).skipWorktree, ['driver/main.mjs'])
  assert.throws(() => assertV27CheckoutIntegrity(input), /skip-worktree index entries/)
})

test('rejects fsmonitor and sparse checkout state', async (context) => {
  const fsmonitor = await fixture(context)
  git(fsmonitor.root, ['update-index', '--fsmonitor'])
  const fsmonitorState = inspectV27CheckoutSpecialStates({ root: fsmonitor.root })
  assert.equal(fsmonitorState.fsmonitor.indexExtension, true)
  assert.throws(() => assertV27CheckoutIntegrity(fsmonitor), /fsmonitor state enabled/)

  const sparse = await fixture(context)
  git(sparse.root, ['config', 'core.sparseCheckout', 'true'])
  const sparseState = inspectV27CheckoutSpecialStates({ root: sparse.root })
  assert.deepEqual(sparseState.sparse.configValues, [{ key: 'core.sparsecheckout', value: 'true' }])
  assert.throws(() => assertV27CheckoutIntegrity(sparse), /sparse checkout or sparse-index state enabled/)
})
