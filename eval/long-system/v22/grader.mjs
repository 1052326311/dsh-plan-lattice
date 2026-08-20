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

const root = await mkdtemp(join(tmpdir(), 'duty-window-v22-hidden-'))
let sequence = 0

function actor(id, role) {
  return { id, role }
}

function command(type, dutyId, at, expectedRevision, extra = {}, by = actor('dispatcher-1', 'dispatcher')) {
  sequence += 1
  return {
    commandId: `duty-v22-${String(sequence).padStart(4, '0')}`,
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

async function openDuty(store, dutyId, options = {}) {
  const at = options.at ?? '2026-06-01T08:00:00.000Z'
  const value = command('open', dutyId, at, 0, {
    worker: options.worker ?? 'worker-1',
    start: options.start ?? '2026-06-01T08:00:00.000Z',
    end: options.end ?? '2026-06-01T12:00:00.000Z',
  })
  return { value, result: await apply(store, value) }
}

function stateEvent(value, state) {
  return { ...value, ...state }
}

async function writeEventStore(path, events) {
  await writeFile(path, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
}

async function buildLegacyStore(path) {
  const openCompleted = command('open', 'DUTY-LEGACY-C', '2026-06-01T08:00:00.000Z', 0, {
    worker: 'worker-c', start: '2026-06-01T08:00:00.000Z', end: '2026-06-01T12:00:00.000Z',
  })
  const checkinCompleted = command('checkin', 'DUTY-LEGACY-C', '2026-06-01T08:10:00.000Z', 1, {}, actor('worker-c', 'worker'))
  const checkoutCompleted = command('checkout', 'DUTY-LEGACY-C', '2026-06-01T09:00:00.000Z', 2, { note: 'finished safely' }, actor('worker-c', 'worker'))
  const openResumed = command('open', 'DUTY-LEGACY-R', '2026-06-01T08:00:00.000Z', 0, {
    worker: 'worker-r', start: '2026-06-01T08:00:00.000Z', end: '2026-06-01T12:00:00.000Z',
  })
  const checkinResumed = command('checkin', 'DUTY-LEGACY-R', '2026-06-01T08:10:00.000Z', 1, {}, actor('worker-r', 'worker'))
  const pauseResumed = command('pause', 'DUTY-LEGACY-R', '2026-06-01T08:20:00.000Z', 2, { reason: 'brief pause' }, actor('worker-r', 'worker'))
  const resumeResumed = command('resume', 'DUTY-LEGACY-R', '2026-06-01T08:30:00.000Z', 3)
  const commonCompleted = { worker: 'worker-c', start: '2026-06-01T08:00:00.000Z', end: '2026-06-01T12:00:00.000Z' }
  const commonResumed = { worker: 'worker-r', start: '2026-06-01T08:00:00.000Z', end: '2026-06-01T12:00:00.000Z' }
  await writeEventStore(path, [
    stateEvent(openCompleted, { ...commonCompleted, revision: 1, status: 'planned', note: null }),
    stateEvent(checkinCompleted, { ...commonCompleted, revision: 2, status: 'active', note: null }),
    stateEvent(checkoutCompleted, { ...commonCompleted, revision: 3, status: 'completed', note: 'finished safely' }),
    stateEvent(openResumed, { ...commonResumed, revision: 1, status: 'planned', note: null }),
    stateEvent(checkinResumed, { ...commonResumed, revision: 2, status: 'active', note: null }),
    stateEvent(pauseResumed, { ...commonResumed, revision: 3, status: 'paused', note: 'brief pause' }),
    stateEvent(resumeResumed, { ...commonResumed, revision: 4, status: 'active', note: null }),
  ])
  return { checkoutCompleted, resumeResumed }
}

try {
  if (phase === 'report') {
    const store = join(root, 'report.jsonl')
    await openDuty(store, 'DUTY-Z')
    await openDuty(store, 'DUTY-A')
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
    const store = join(root, 'duties.jsonl')
    const opened = await openDuty(store, 'DUTY-CORE')
    const openedValue = json(opened.result)
    add('open exact success', 'foundation', 5, opened.result.status === 0 && opened.result.stderr === ''
      && exactKeys(openedValue, ['commandId', 'dutyId', 'revision', 'status', 'replayed'])
      && openedValue?.revision === 1 && openedValue?.status === 'planned' && openedValue?.replayed === false, true)

    const projection = json(get(store, 'DUTY-CORE'))
    add('get exact projection', 'foundation', 4, exactKeys(projection, [
      'id', 'worker', 'start', 'end', 'status', 'revision', 'note',
    ]) && projection?.id === 'DUTY-CORE' && projection?.worker === 'worker-1'
      && projection?.status === 'planned' && projection?.revision === 1 && projection?.note === null, true)

    const invalidTimestampStore = join(root, 'invalid-timestamp.jsonl')
    const invalidTimestamp = await apply(invalidTimestampStore, command(
      'open', 'DUTY-OFFSET', '2026-06-01T10:00:00+02:00', 0,
      { worker: 'worker-1', start: '2026-06-01T08:00:00.000Z', end: '2026-06-01T12:00:00.000Z' },
    ))
    add('timestamps require exact millisecond Z form', 'foundation', 3,
      invalidTimestamp.status === 2 && invalidTimestamp.stdout === '' && !existsSync(invalidTimestampStore), true)

    const storeText = (await readFile(store, 'utf8'))
    const event = JSON.parse(storeText.trimEnd())
    add('durable event has exact shape and final LF', 'storage', 5,
      storeText.endsWith('\n') && !storeText.endsWith('\n\n')
      && exactKeys(event, [
        'commandId', 'type', 'dutyId', 'actor', 'at', 'expectedRevision',
        'worker', 'start', 'end', 'revision', 'status', 'note',
      ]), true)

    const replayBefore = await bytes(store)
    const replay = await apply(store, opened.value)
    add('accepted replay is byte stable', 'storage', 4,
      replay.status === 0 && json(replay)?.replayed === true && sameBytes(replayBefore, await bytes(store)), true)

    const conflictBefore = await bytes(store)
    const conflict = await apply(store, { ...opened.value, worker: 'worker-other' })
    add('global commandId conflict is byte stable', 'storage', 3,
      conflict.status === 3 && conflict.stdout === '' && sameBytes(conflictBefore, await bytes(store)), true)

    const malformedStore = join(root, 'malformed.jsonl')
    await writeFile(malformedStore, `${JSON.stringify({ ...event, extra: true })}\n`, 'utf8')
    const malformedBefore = await bytes(malformedStore)
    const malformed = get(malformedStore, 'DUTY-CORE')
    add('malformed durable state is rejected without repair', 'storage', 3,
      malformed.status === 2 && malformed.stdout === '' && sameBytes(malformedBefore, await bytes(malformedStore)), true)

    const missingStore = join(root, 'missing.jsonl')
    const missingSummary = json(summary(missingStore, '2026-06-01T09:00:00.000Z'))
    const missingGet = get(missingStore, 'UNKNOWN')
    const invalidSummary = summary(missingStore, '2026-06-01T09:00:00Z')
    add('missing-store queries stay read only', 'storage', 3,
      exactKeys(missingSummary, ['at', 'planned', 'active', 'paused', 'completed', 'activeDutyIds', 'pausedDutyIds'])
      && missingSummary?.planned === 0 && missingSummary?.active === 0
      && missingSummary?.paused === 0 && missingSummary?.completed === 0
      && missingGet.status === 3 && invalidSummary.status === 2 && !existsSync(missingStore), true)

    const deniedBefore = await bytes(store)
    const denied = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:15:00.000Z', 1))
    add('worker role boundary is atomic', 'transitions', 4,
      denied.status === 4 && denied.stdout === '' && sameBytes(deniedBefore, await bytes(store)), true)

    const checkedIn = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:15:00.000Z', 1, {}, actor('worker-1', 'worker')))
    add('checkin transition', 'transitions', 4,
      checkedIn.status === 0 && json(checkedIn)?.status === 'active' && json(checkedIn)?.revision === 2, true)

    const paused = await apply(store, command('pause', 'DUTY-CORE', '2026-06-01T08:20:00.000Z', 2, {
      reason: 'awaiting relief',
    }, actor('worker-1', 'worker')))
    const pausedProjection = json(get(store, 'DUTY-CORE'))
    add('pause preserves reason', 'transitions', 6,
      paused.status === 0 && json(paused)?.status === 'paused' && json(paused)?.revision === 3
      && pausedProjection?.status === 'paused' && pausedProjection?.note === 'awaiting relief', true)

    const retiredStore = join(root, 'retired-new.jsonl')
    await openDuty(retiredStore, 'DUTY-RETIRED')
    await apply(retiredStore, command('checkin', 'DUTY-RETIRED', '2026-06-01T08:10:00.000Z', 1, {}, actor('worker-1', 'worker')))
    const checkoutBefore = await bytes(retiredStore)
    const checkout = await apply(retiredStore, command('checkout', 'DUTY-RETIRED', '2026-06-01T08:20:00.000Z', 2, {
      note: 'must be retired',
    }, actor('worker-1', 'worker')))
    const resume = await apply(store, command('resume', 'DUTY-CORE', '2026-06-01T08:25:00.000Z', 3))
    add('new checkout and resume are retired', 'revision', 6,
      checkout.status === 2 && resume.status === 2
      && checkout.stdout === '' && resume.stdout === ''
      && sameBytes(checkoutBefore, await bytes(retiredStore)), true)

    const legacyStore = join(root, 'legacy.jsonl')
    const legacy = await buildLegacyStore(legacyStore)
    const completed = json(get(legacyStore, 'DUTY-LEGACY-C'))
    const resumed = json(get(legacyStore, 'DUTY-LEGACY-R'))
    const legacySummary = json(summary(legacyStore, '2026-06-01T10:00:00.000Z'))
    add('retired durable events remain readable', 'revision', 6,
      completed?.status === 'completed' && completed?.revision === 3 && completed?.note === 'finished safely'
      && resumed?.status === 'active' && resumed?.revision === 4 && resumed?.note === null
      && legacySummary?.completed === 1 && legacySummary?.active === 1, true)

    const legacyBefore = await bytes(legacyStore)
    const legacyReplay = await apply(legacyStore, legacy.checkoutCompleted)
    const legacyConflict = await apply(legacyStore, { ...legacy.resumeResumed, at: '2026-06-01T08:31:00.000Z' })
    add('retired replay precedes retirement validation', 'revision', 5,
      legacyReplay.status === 0 && json(legacyReplay)?.replayed === true
      && json(legacyReplay)?.revision === 3 && json(legacyReplay)?.status === 'completed'
      && legacyConflict.status === 3 && legacyConflict.stdout === ''
      && sameBytes(legacyBefore, await bytes(legacyStore)), true)

    const adjustStore = join(root, 'adjust.jsonl')
    await openDuty(adjustStore, 'DUTY-ADJUST')
    const adjusted = await apply(adjustStore, command('adjust-start', 'DUTY-ADJUST', '2026-06-01T08:20:00.000Z', 1, {
      start: '2026-06-01T08:10:00.000Z',
    }))
    const invalidAdjustBefore = await bytes(adjustStore)
    const invalidAdjust = await apply(adjustStore, command('adjust-start', 'DUTY-ADJUST', '2026-06-01T08:30:00.000Z', 2, {
      start: '2026-06-01T12:00:00.000Z',
    }))
    const revised = json(get(adjustStore, 'DUTY-ADJUST'))
    add('adjust-start replaces start atomically', 'revision', 6,
      adjusted.status === 0 && json(adjusted)?.revision === 2 && revised?.start === '2026-06-01T08:10:00.000Z'
      && invalidAdjust.status === 2 && sameBytes(invalidAdjustBefore, await bytes(adjustStore)), true)

    const reassigned = await apply(store, command('reassign', 'DUTY-CORE', '2026-06-01T08:30:00.000Z', 3, {
      worker: 'worker-2',
    }))
    const reassignedProjection = json(get(store, 'DUTY-CORE'))
    const oldWorkerBefore = await bytes(store)
    const oldWorker = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:35:00.000Z', 4, {}, actor('worker-1', 'worker')))
    const newWorker = await apply(store, command('checkin', 'DUTY-CORE', '2026-06-01T08:36:00.000Z', 4, {}, actor('worker-2', 'worker')))
    add('reassign resets ownership and state', 'revision', 7,
      reassigned.status === 0 && json(reassigned)?.status === 'planned' && json(reassigned)?.revision === 4
      && reassignedProjection?.worker === 'worker-2' && reassignedProjection?.note === null
      && oldWorker.status === 4 && sameBytes(oldWorkerBefore, await bytes(store))
      && newWorker.status === 0 && json(newWorker)?.status === 'active', true)

    const historyStore = join(root, 'history.jsonl')
    await openDuty(historyStore, 'DUTY-HISTORY')
    await apply(historyStore, command('checkin', 'DUTY-HISTORY', '2026-06-01T08:10:00.000Z', 1, {}, actor('worker-1', 'worker')))
    await apply(historyStore, command('pause', 'DUTY-HISTORY', '2026-06-01T08:20:00.000Z', 2, { reason: 'handoff' }, actor('worker-1', 'worker')))
    await apply(historyStore, command('reassign', 'DUTY-HISTORY', '2026-06-01T08:30:00.000Z', 3, { worker: 'worker-2' }))
    const historyBefore = await bytes(historyStore)
    const beforeReassign = json(summary(historyStore, '2026-06-01T08:25:00.000Z'))
    const afterReassign = json(summary(historyStore, '2026-06-01T08:30:00.000Z'))
    add('historical summary preserves material revision', 'reporting', 9,
      beforeReassign?.paused === 1 && JSON.stringify(beforeReassign?.pausedDutyIds) === JSON.stringify(['DUTY-HISTORY'])
      && afterReassign?.planned === 1 && afterReassign?.paused === 0
      && sameBytes(historyBefore, await bytes(historyStore)), true)

    const orderingStore = join(root, 'ordering.jsonl')
    await openDuty(orderingStore, 'DUTY-LATE', { at: '2026-06-01T10:00:00.000Z' })
    await openDuty(orderingStore, 'DUTY-EARLY', { at: '2026-06-01T07:00:00.000Z' })
    await openDuty(orderingStore, 'DUTY-TIE', { at: '2026-06-01T08:00:00.000Z' })
    await apply(orderingStore, command('checkin', 'DUTY-TIE', '2026-06-01T08:00:00.000Z', 1, {}, actor('worker-1', 'worker')))
    const ordering = json(summary(orderingStore, '2026-06-01T08:00:00.000Z'))
    add('summary uses per-duty time and accepted tie order', 'reporting', 7,
      ordering?.planned === 1 && ordering?.active === 1 && ordering?.paused === 0 && ordering?.completed === 0
      && JSON.stringify(ordering?.activeDutyIds) === JSON.stringify(['DUTY-TIE']), true)

    const sortedStore = join(root, 'sorted.jsonl')
    for (const dutyId of ['DUTY-D', 'DUTY-A', 'DUTY-C', 'DUTY-B']) {
      await openDuty(sortedStore, dutyId)
      await apply(sortedStore, command('checkin', dutyId, '2026-06-01T08:10:00.000Z', 1, {}, actor('worker-1', 'worker')))
    }
    for (const dutyId of ['DUTY-D', 'DUTY-C']) {
      await apply(sortedStore, command('pause', dutyId, '2026-06-01T08:20:00.000Z', 2, { reason: 'sort check' }, actor('worker-1', 'worker')))
    }
    const sortedBefore = await bytes(sortedStore)
    const sorted = json(summary(sortedStore, '2026-06-01T09:00:00.000Z'))
    add('summary arrays are exact sorted and read only', 'reporting', 6,
      exactKeys(sorted, ['at', 'planned', 'active', 'paused', 'completed', 'activeDutyIds', 'pausedDutyIds'])
      && JSON.stringify(sorted?.activeDutyIds) === JSON.stringify(['DUTY-A', 'DUTY-B'])
      && JSON.stringify(sorted?.pausedDutyIds) === JSON.stringify(['DUTY-C', 'DUTY-D'])
      && sameBytes(sortedBefore, await bytes(sortedStore)), true)

    const testResult = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 60_000 })
    add('public test suite passes', 'quality', 4, testResult.status === 0, false)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const reporting = checks.filter(check => check.category === 'reporting')
const score = checks.reduce((total, check) => total + (check.passed ? check.points : 0), 0)
const total = checks.reduce((sum, check) => sum + check.points, 0)
if (total !== 100) throw new Error(`V22 final grader points must total 100, got ${total}`)
const hardRequirementsMissed = checks.filter(check => check.hard && !check.passed).length
const staleRequirementsRetained = checks.filter(check => check.name === 'new checkout and resume are retired' && !check.passed).length
const categories = Object.fromEntries([...new Set(checks.map(check => check.category))].map(category => {
  const entries = checks.filter(check => check.category === category)
  return [category, {
    score: entries.reduce((sum, check) => sum + (check.passed ? check.points : 0), 0),
    total: entries.reduce((sum, check) => sum + check.points, 0),
  }]
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
