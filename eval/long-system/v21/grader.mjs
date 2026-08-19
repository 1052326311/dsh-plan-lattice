#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspace = resolve(process.argv[2] ?? '')
const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'final'
if (!existsSync(workspace) || !['final', 'report'].includes(phase)) {
  throw new Error('usage: node grader.mjs <workspace> [--phase final|report]')
}

const root = await mkdtemp(join(tmpdir(), 'duty-window-hidden-'))
let sequence = 0

function actor(id, role) {
  return { id, role }
}

function command(type, dutyId, at, expectedRevision, extra = {}, by = actor('dispatcher-1', 'dispatcher')) {
  sequence += 1
  return {
    commandId: `duty-eval-${String(sequence).padStart(4, '0')}`,
    type,
    dutyId,
    actor: by,
    at,
    expectedRevision,
    ...extra,
  }
}

function run(args) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...args], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

async function apply(store, value) {
  const file = join(root, `command-${String(sequence).padStart(4, '0')}.json`)
  await writeFile(file, `${JSON.stringify(value)}\n`, 'utf8')
  return run(['apply', '--store', store, '--command', file])
}

function get(store, dutyId) {
  return run(['get', '--store', store, '--duty', dutyId])
}

function summary(store, at) {
  return run(['summary', '--store', store, '--at', at])
}

function json(result) {
  try { return JSON.parse(result.stdout) } catch { return undefined }
}

function exactKeys(value, keys) {
  return value !== undefined
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
}

async function bytes(path) {
  try { return await readFile(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function sameBytes(left, right) {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right)
}

const checks = []
function add(name, category, points, passed, hard = false) {
  checks.push({ name, category, points, passed: Boolean(passed), hard })
}

async function open(store, dutyId, at = '2026-06-01T08:00:00.000Z') {
  const value = command('open', dutyId, at, 0, {
    worker: 'worker-1',
    start: '2026-06-01T08:00:00.000Z',
    end: '2026-06-01T12:00:00.000Z',
  })
  return { value, result: await apply(store, value) }
}

try {
  if (phase === 'report') {
    const store = join(root, 'report.json')
    await open(store, 'DUTY-Z')
    await open(store, 'DUTY-A')
    const checkedIn = await apply(store, command('checkin', 'DUTY-A', '2026-06-01T08:15:00.000Z', 1, {}, actor('worker-1', 'worker')))
    const paused = await apply(store, command('pause', 'DUTY-A', '2026-06-01T08:20:00.000Z', 2, {
      reason: 'handoff pending',
    }, actor('worker-1', 'worker')))
    const before = await bytes(store)
    const report = json(summary(store, '2026-06-01T09:00:00.000Z'))
    add('delegated historical summary', 'reporting', 100,
      checkedIn.status === 0 && paused.status === 0
      && exactKeys(report, ['at', 'planned', 'active', 'paused', 'completed', 'activeDutyIds', 'pausedDutyIds'])
      && report?.planned === 1 && report?.active === 0 && report?.paused === 1 && report?.completed === 0
      && JSON.stringify(report?.activeDutyIds) === JSON.stringify([])
      && JSON.stringify(report?.pausedDutyIds) === JSON.stringify(['DUTY-A'])
      && sameBytes(before, await bytes(store)), true)
  } else {
    const store = join(root, 'duties.json')
    const opened = await open(store, 'DUTY-CORE')
    const openedValue = json(opened.result)
    add('open exact success', 'foundation', 8, opened.result.status === 0 && opened.result.stderr === ''
      && exactKeys(openedValue, ['commandId', 'dutyId', 'revision', 'status', 'replayed'])
      && openedValue?.commandId === opened.value.commandId && openedValue?.dutyId === 'DUTY-CORE'
      && openedValue?.revision === 1 && openedValue?.status === 'planned' && openedValue?.replayed === false, true)

    const projection = json(get(store, 'DUTY-CORE'))
    add('get exact planned projection', 'foundation', 6, exactKeys(projection, [
      'id', 'worker', 'start', 'end', 'status', 'revision', 'note',
    ]) && projection?.id === 'DUTY-CORE' && projection?.worker === 'worker-1'
      && projection?.status === 'planned' && projection?.revision === 1 && projection?.note === null, true)

    const invalidStore = join(root, 'invalid.json')
    const invalid = await apply(invalidStore, command('open', 'DUTY-BAD', '2026-06-01T08:00:00.000Z', 0, {
      worker: 'worker-1', start: '2026-06-01T12:00:00.000Z', end: '2026-06-01T08:00:00.000Z',
    }))
    add('invalid input is atomic', 'foundation', 5, invalid.status === 2 && invalid.stdout === '' && !existsSync(invalidStore), true)

    const replayBefore = await bytes(store)
    const replay = await apply(store, opened.value)
    add('accepted command replay is byte stable', 'storage', 5, replay.status === 0 && json(replay)?.replayed === true
      && sameBytes(replayBefore, await bytes(store)), true)

    const deniedBefore = await bytes(store)
    const denied = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:15:00.000Z', 1))
    add('worker role boundary is atomic', 'transitions', 4, denied.status === 4 && denied.stdout === ''
      && sameBytes(deniedBefore, await bytes(store)), true)

    const checkedIn = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:15:00.000Z', 1, {}, actor('worker-1', 'worker')))
    add('checkin transition', 'transitions', 7, checkedIn.status === 0 && json(checkedIn)?.status === 'active'
      && json(checkedIn)?.revision === 2, true)

    const paused = await apply(store, command('pause', 'DUTY-CORE', '2026-06-01T08:20:00.000Z', 2, {
      reason: 'awaiting relief',
    }, actor('worker-1', 'worker')))
    const pausedProjection = json(get(store, 'DUTY-CORE'))
    add('pause transition preserves its reason', 'transitions', 10,
      paused.status === 0 && json(paused)?.status === 'paused' && json(paused)?.revision === 3
      && pausedProjection?.status === 'paused' && pausedProjection?.note === 'awaiting relief', true)

    const revisionStore = join(root, 'revision.json')
    await open(revisionStore, 'DUTY-REV')
    const checkoutBefore = await bytes(revisionStore)
    const obsolete = await apply(revisionStore, command('checkout', 'DUTY-REV', '2026-06-01T08:20:00.000Z', 1, {
      note: 'obsolete command',
    }, actor('worker-1', 'worker')))
    add('obsolete checkout is removed', 'revision', 8, obsolete.status === 2 && obsolete.stdout === ''
      && sameBytes(checkoutBefore, await bytes(revisionStore)), true)

    const resumeBefore = await bytes(store)
    const obsoleteResume = await apply(store, command('resume', 'DUTY-CORE', '2026-06-01T08:25:00.000Z', 3))
    add('obsolete resume is removed', 'revision', 7,
      obsoleteResume.status === 2 && obsoleteResume.stdout === ''
      && sameBytes(resumeBefore, await bytes(store)), true)

    const adjusted = await apply(revisionStore, command('adjust-start', 'DUTY-REV', '2026-06-01T08:20:00.000Z', 1, {
      start: '2026-06-01T08:10:00.000Z',
    }))
    const revised = json(get(revisionStore, 'DUTY-REV'))
    add('adjust-start replaces checkout', 'revision', 10, adjusted.status === 0 && json(adjusted)?.status === 'planned'
      && json(adjusted)?.revision === 2 && revised?.start === '2026-06-01T08:10:00.000Z', true)

    const reassigned = await apply(store, command('reassign', 'DUTY-CORE', '2026-06-01T08:30:00.000Z', 3, {
      worker: 'worker-2',
    }))
    const reassignedProjection = json(get(store, 'DUTY-CORE'))
    const oldWorkerBefore = await bytes(store)
    const oldWorker = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:35:00.000Z', 4, {}, actor('worker-1', 'worker')))
    const oldWorkerAfter = await bytes(store)
    const newWorker = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:36:00.000Z', 4, {}, actor('worker-2', 'worker')))
    add('reassign resets ownership and role boundary', 'revision', 12,
      reassigned.status === 0 && json(reassigned)?.status === 'planned' && json(reassigned)?.revision === 4
      && reassignedProjection?.worker === 'worker-2' && reassignedProjection?.note === null
      && oldWorker.status === 4 && sameBytes(oldWorkerBefore, oldWorkerAfter)
      && newWorker.status === 0 && json(newWorker)?.status === 'active' && json(newWorker)?.revision === 5, true)

    const reportStore = join(root, 'summary.json')
    await open(reportStore, 'DUTY-Z')
    await open(reportStore, 'DUTY-A')
    await apply(reportStore, command('checkin', 'DUTY-A', '2026-06-01T08:15:00.000Z', 1, {}, actor('worker-1', 'worker')))
    await apply(reportStore, command('pause', 'DUTY-A', '2026-06-01T08:20:00.000Z', 2, {
      reason: 'handoff pending',
    }, actor('worker-1', 'worker')))
    await apply(reportStore, command('reassign', 'DUTY-A', '2026-06-01T08:30:00.000Z', 3, {
      worker: 'worker-2',
    }))
    const reportBefore = await bytes(reportStore)
    const pausedReport = json(summary(reportStore, '2026-06-01T08:25:00.000Z'))
    const revisedReport = json(summary(reportStore, '2026-06-01T09:00:00.000Z'))
    const reportKeys = ['at', 'planned', 'active', 'paused', 'completed', 'activeDutyIds', 'pausedDutyIds']
    add('historical summary preserves pause and reassign', 'reporting', 15,
      exactKeys(pausedReport, reportKeys)
      && pausedReport?.planned === 1 && pausedReport?.active === 0 && pausedReport?.paused === 1
      && pausedReport?.completed === 0 && JSON.stringify(pausedReport?.pausedDutyIds) === JSON.stringify(['DUTY-A'])
      && exactKeys(revisedReport, reportKeys)
      && revisedReport?.planned === 2 && revisedReport?.active === 0 && revisedReport?.paused === 0
      && revisedReport?.completed === 0 && JSON.stringify(revisedReport?.pausedDutyIds) === JSON.stringify([])
      && sameBytes(reportBefore, await bytes(reportStore)), true)

    const testResult = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 30_000 })
    add('public test suite passes', 'quality', 3, testResult.status === 0, false)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const reporting = checks.filter(check => check.category === 'reporting')
const score = checks.reduce((total, check) => total + (check.passed ? check.points : 0), 0)
const hardRequirementsMissed = checks.filter(check => check.hard && !check.passed).length
const staleRequirementsRetained = checks.filter(check => [
  'obsolete checkout is removed',
  'obsolete resume is removed',
].includes(check.name) && !check.passed).length
const categories = Object.fromEntries([...new Set(checks.map(check => check.category))].map(category => {
  const entries = checks.filter(check => check.category === category)
  return [category, { score: entries.reduce((total, check) => total + (check.passed ? check.points : 0), 0), total: entries.reduce((total, check) => total + check.points, 0) }]
}))
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  phase,
  score,
  hardRequirementsMissed,
  staleRequirementsRetained,
  affectedArtifactCoverage: reporting.length === 0 || reporting.every(check => check.passed) ? 1 : 0,
  categories,
  checks,
}, null, 2)}\n`)
