import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildV27Protocol, buildV27TraceProtocol } from '../protocol.mjs'

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
  const trace = buildV27TraceProtocol(protocol, 'a'.repeat(64))
  assert.equal(trace.schemaVersion, 2)
  assert.equal(trace.expectedProcessEpochs, 2)
  assert.equal(trace.expectedCompactions, 2)
  assert.equal(trace.expectedColdResumes, 1)
  assert.equal(trace.foregroundFork.stageId, 'audit-after-round-7')
  assert.match(trace.foregroundFork.stageMessageSha256, /^[0-9a-f]{64}$/u)
  assert.equal(trace.foregroundFork.requiredAuthorityMessages.length, 7)
  assert.deepEqual(trace.stages.map(stage => [stage.id, stage.epoch]), [
    ['round-1', 1], ['round-2', 1], ['round-3', 1], ['round-4', 1], ['round-5', 1],
    ['round-6', 2], ['round-7', 2], ['audit-after-round-7', 2], ['round-8', 2], ['round-9', 2],
  ])
  assert.deepEqual(trace.lifecycle, {
    compactionAfterStageIds: ['round-3', 'audit-after-round-7'],
    coldRestartAfterStageId: 'round-5',
    foregroundAuditStageId: 'audit-after-round-7',
  })
  assert.deepEqual(trace.epochs[1], {
    epochId: 'epoch-2',
    stageIds: ['round-6', 'round-7', 'audit-after-round-7', 'round-8', 'round-9'],
    coldStart: true,
    resumedAfterStageId: 'round-5',
  })
})
