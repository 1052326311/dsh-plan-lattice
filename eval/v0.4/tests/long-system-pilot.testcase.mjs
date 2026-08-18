import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseSessionMetrics } from '../../pilots/driver/lib/session-metrics.mjs'
import { buildLongSystemManifest } from '../../long-system/freeze.mjs'
import { workspaceShellAdapter } from '../../pilots/driver/long-system-candidate-wrapper/workspace-shell-adapter.js'
import { hiddenLongSystemTools } from '../../pilots/driver/long-system-candidate-wrapper/tool-boundary.js'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

test('workspace shell adapter binds command and current non-control tree', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'plan-lattice-long-shell-'))
  try {
    await writeFile(join(workspace, 'source.txt'), 'one\n')
    await mkdir(join(workspace, '.dsh'), { recursive: true })
    const args = { command: 'npm test', description: 'Run tests' }
    const resource = `workspace:${realpathSync(workspace)}`
    const snapshot = await workspaceShellAdapter.snapshot({ workspace, resource, arguments: args })
    const scope = await workspaceShellAdapter.snapshotScope({ workspace })
    assert.equal(scope.resource, resource)
    assert.equal(workspaceShellAdapter.verify({
      workspace, resource, arguments: args, expectedStateDigest: snapshot.stateDigest,
    }), undefined)
    await writeFile(join(workspace, '.dsh', 'control.json'), '{}\n')
    assert.equal(workspaceShellAdapter.verify({
      workspace, resource, arguments: args, expectedStateDigest: snapshot.stateDigest,
    }), undefined)
    assert.equal(workspaceShellAdapter.verifyScope({
      workspace, resource, expectedStateDigest: scope.stateDigest,
    }), undefined)
    await writeFile(join(workspace, 'source.txt'), 'two\n')
    assert.match(workspaceShellAdapter.verify({
      workspace, resource, arguments: args, expectedStateDigest: snapshot.stateDigest,
    }), /workspace changed/)
    assert.match(workspaceShellAdapter.verifyScope({
      workspace, resource, expectedStateDigest: scope.stateDigest,
    }), /workspace changed/)
    assert.throws(() => workspaceShellAdapter.normalizeArguments({ command: 'npm test', timeoutMs: 10 }), /metadata/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('long-system paired boundary hides alternate execution and information channels', () => {
  assert.deepEqual(hiddenLongSystemTools([
    'read', 'bash', 'write', 'edit', 'ask_user_question', 'web_search', 'subagent',
    'subagent_fork', 'job_output', 'schedule_create', 'workflow', 'lattice_open',
  ]), [
    'ask_user_question', 'edit', 'job_output', 'schedule_create', 'subagent',
    'subagent_fork', 'web_search', 'workflow', 'write',
  ])
})

test('session metrics aggregate root and durable delegated child without losing terminal evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-session-metrics-'))
  try {
    const rootDir = join(root, 'root')
    const childDir = join(root, 'child')
    await Promise.all([mkdir(rootDir), mkdir(childDir)])
    const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
    await writeFile(join(rootDir, 'session.jsonl'), [
      { type: 'session', version: 0, id: 'root', createdAt: 1, delegationDepth: 0 },
      { type: 'assistant/message', seq: 0, time: 2, data: { usage } },
      { type: 'compaction/summary', seq: 1, time: 3, data: { usage } },
      { type: 'turn/end', seq: 2, time: 4, data: { reason: { kind: 'completed' } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    await writeFile(join(childDir, 'session.jsonl'), [
      { type: 'session', version: 0, id: 'child', createdAt: 5, parentSession: 'root', origin: 'subagent', delegationDepth: 1 },
      { type: 'assistant/message', seq: 0, time: 6, data: { usage } },
      { type: 'turn/end', seq: 1, time: 7, data: { reason: { kind: 'completed' } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const metrics = await parseSessionMetrics(root, {
      expectedSessionIds: ['root', 'child'], terminalSessionId: 'child',
    })
    assert.equal(metrics.modelTurns, 3)
    assert.equal(metrics.inputTokens, 30)
    assert.equal(metrics.outputTokens, 6)
    assert.equal(metrics.compactionSummaries, 1)
    assert.deepEqual(metrics.terminalReason, { kind: 'completed' })
    assert.deepEqual(metrics.sessions.find(session => session.id === 'child'), {
      id: 'child', parentSession: 'root', origin: 'subagent', delegationDepth: 1,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('long-system task freezes two real compactions, one delegated stage, and one human revision', async () => {
  const task = JSON.parse(await readFile(join(repositoryRoot, 'eval/long-system/task.json'), 'utf8'))
  assert.equal(task.stages.length, 5)
  assert.equal(task.stages.filter(stage => stage.compactBefore).length, 2)
  assert.equal(task.stages.filter(stage => stage.actor === 'child').length, 1)
  assert.deepEqual(task.stages.filter(stage => stage.source === 'user').map(stage => stage.id), [
    'foundation', 'material-revision',
  ])
  assert.match(task.initialPrompt, /append-only JSON event store/)
  assert.match(task.initialPrompt, /reopen: supervisor only/)
  assert.match(task.stages.find(stage => stage.id === 'material-revision').message, /Add requeue instead/)
  assert.doesNotMatch(task.stages.find(stage => stage.id === 'final-integration').message, /sev1|15 minutes|expectedRevision/)
})

test('long-system manifest construction deterministically binds every experiment authority', async () => {
  const candidate = 'a'.repeat(40)
  const first = await buildLongSystemManifest(candidate)
  const second = await buildLongSystemManifest(candidate)
  assert.deepEqual(first, second)
  assert.equal(first.candidateCommit, candidate)
  assert.equal(first.protocolId, 'plan-lattice-rc7-long-system-exploratory-v6')
  assert.equal(first.predecessor.status, 'valid-negative-result')
  assert.equal(first.predecessor.manifestDigest, '411e8d5e0333c7f07a9e181260683a95ba37c31124b368fbf1fbdc968b7c4405')
  assert.equal(first.task.stages.length, 5)
  assert.deepEqual(first.order, ['v0.4-lattice', 'native'])
  assert.match(first.sources.driverSourceDigest, /^[0-9a-f]{64}$/)
  assert.match(first.manifestDigest, /^[0-9a-f]{64}$/)
  assert.equal(first.thresholds.minimumAbsoluteScoreGain, 15)
  assert.equal(first.claimBoundary.includes('cannot establish'), true)
})

test('hidden grader is executable against the untouched fixture and keeps a 100-point final denominator', () => {
  const fixture = join(repositoryRoot, 'eval/long-system/fixture')
  const grader = join(repositoryRoot, 'eval/long-system/grader.mjs')
  const result = spawnSync(process.execPath, [grader, fixture], { encoding: 'utf8', timeout: 180_000 })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schemaVersion, 1)
  assert.equal(payload.phase, 'final')
  assert.equal(payload.possiblePoints, 100)
  assert.ok(payload.score < 10)
  assert.ok(payload.hardRequirementsMissed > 0)
})

test('real pilot source binds staged Harness execution and refuses broad claims', async () => {
  const pilot = await readFile(join(repositoryRoot, 'eval/pilots/rc7-long-system-pilot.mjs'), 'utf8')
  const runtime = await readFile(join(repositoryRoot, 'eval/pilots/driver/lib/runtime.mjs'), 'utf8')
  const support = await readFile(join(repositoryRoot, 'eval/pilots/driver/support-plugin/index.js'), 'utf8')
  assert.match(pilot, /shellAdapter: 'workspace-tree'/)
  assert.match(pilot, /plan-lattice-long-system-/)
  assert.doesNotMatch(pilot, /rootSessionId = `long-system-/)
  assert.match(pilot, /stageProtocol/)
  assert.match(pilot, /positiveExploratorySignal/)
  assert.match(pilot, /globalBestEstablished: false/)
  assert.match(pilot, /merge-base', '--is-ancestor', candidateCommit, driverCommit/)
  assert.match(pilot, /assert\.notEqual\(driverCommit, candidateCommit/)
  assert.doesNotMatch(pilot, /assert\.equal\(gitHead, candidateCommit/)
  assert.match(pilot, /driverCommit,/)
  assert.match(runtime, /DSH_PLAN_LATTICE_EVAL_STAGE_INDEX/)
  assert.match(runtime, /stage-snapshots/)
  assert.match(support, /compaction\.compactNow/)
  assert.match(support, /parentSession: root\.session\.id/)
  assert.match(support, /ctx\.agents\.withInitiator\(root, open\)/)
})
