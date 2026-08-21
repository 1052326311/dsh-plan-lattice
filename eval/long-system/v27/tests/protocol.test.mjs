import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildV27Protocol } from '../protocol.mjs'

test('builds two exact process epochs around the round-5 cold restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-protocol-'))
  for (let round = 1; round <= 9; round += 1) {
    const directory = join(root, 'steps', `round-${round}`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'instruction.md'), `official round ${round}\n`, 'utf8')
  }
  const protocol = await buildV27Protocol(root, 'root-session-v27')
  assert.deepEqual(protocol.epochs[0].stages.map(stage => stage.id), [
    'round-1', 'round-2', 'round-3', 'round-4', 'round-5',
  ])
  assert.deepEqual(protocol.epochs[1].stages.map(stage => stage.id), [
    'round-6', 'round-7', 'audit-after-round-7', 'round-8', 'round-9',
  ])
  assert.equal(protocol.epochs[0].stages[2].compactAfter, true)
  assert.equal(protocol.epochs[1].stages[2].compactAfter, true)
  assert.match(protocol.epochs[1].stages[2].message, /evocode-jobforge-r7-[0-9a-f]{16}/)
  assert.equal(protocol.stages.filter(stage => stage.kind === 'product').length, 9)
  assert.deepEqual(
    protocol.stages.filter(stage => stage.kind === 'product' && stage.productRound <= 7).map(stage => stage.message),
    Array.from({ length: 7 }, (_, index) => `official round ${index + 1}\n`),
  )
})
