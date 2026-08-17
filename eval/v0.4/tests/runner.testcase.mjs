import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('retired protocol refuses a dry run before any paid call', () => {
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.PLAN_LATTICE_EVAL_ALLOW_PAID
  delete env.PLAN_LATTICE_EVAL_DRIVER
  const result = spawnSync(process.execPath, [join(root, 'run.mjs'), '--json'], { encoding: 'utf8', env })
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /protocol checksum mismatch; execution and analysis are locked/)
})

test('retired protocol refuses paid mode before reaching the credential gate', () => {
  const result = spawnSync(process.execPath, [
    join(root, 'run.mjs'),
    '--execute',
    '--run-id',
    'infra-simple-simple-js-clamp-native-r0',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PLAN_LATTICE_EVAL_ALLOW_PAID: 'I_UNDERSTAND_THIS_RUN_USES_PAID_MODELS' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /protocol checksum mismatch; execution and analysis are locked/)
  assert.doesNotMatch(result.stderr, /paid execution must start through eval\/v0\.4\/secure-run\.sh/)
})
