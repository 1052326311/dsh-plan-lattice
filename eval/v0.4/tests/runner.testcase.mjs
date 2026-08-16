import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('dry-run requires no API key and promises zero paid calls', () => {
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.PLAN_LATTICE_EVAL_ALLOW_PAID
  delete env.PLAN_LATTICE_EVAL_DRIVER
  const result = spawnSync(process.execPath, [join(root, 'run.mjs'), '--json'], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.mode, 'dry-run')
  assert.equal(output.paidModelInvocations, 0)
  assert.equal(output.selectedRuns, 96)
})

test('paid mode remains locked while the candidate commit is unresolved', () => {
  const result = spawnSync(process.execPath, [join(root, 'run.mjs'), '--execute', '--run-id', 'missing'], {
    encoding: 'utf8',
    env: { ...process.env, PLAN_LATTICE_EVAL_ALLOW_PAID: 'I_UNDERSTAND_THIS_RUN_USES_PAID_MODELS' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate commit is not frozen/)
})
