#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspace = resolve(process.argv[2] ?? '')
const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'final'
if (!existsSync(workspace) || !['final', 'report'].includes(phase)) {
  throw new Error('usage: node grader.mjs <workspace> [--phase final|report]')
}

const root = await mkdtemp(join(tmpdir(), 'deployment-window-hidden-'))
let sequence = 0

function actor(id, role) {
  return { id, role }
}

function command(type, windowId, at, expectedRevision, extra = {}, by = actor('planner-1', 'planner')) {
  sequence += 1
  return {
    commandId: `cmd-eval-${String(sequence).padStart(4, '0')}`,
    type,
    windowId,
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

function get(store, windowId) {
  return run(['get', '--store', store, '--window', windowId])
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

async function sourceTree() {
  const files = ['src/cli.mjs', 'src/domain.mjs', 'src/store.mjs', 'src/report.mjs', 'README.md']
  const source = {}
  for (const path of files) {
    try { source[path] = await readFile(join(workspace, path), 'utf8') } catch { source[path] = '' }
  }
  let tests = ''
  try {
    for (const entry of (await readdir(join(workspace, 'test'))).sort()) {
      if (/\.[cm]?js$/u.test(entry)) tests += await readFile(join(workspace, 'test', entry), 'utf8')
    }
  } catch {}
  return { ...source, tests }
}

const checks = []
function add(name, category, points, passed, hard = false) {
  checks.push({ name, category, points, passed: Boolean(passed), hard })
}

try {
  const store = join(root, 'windows.json')
  const create = command('create', 'WIN-CORE', '2026-04-01T08:00:00.000Z', 0, {
    service: 'payments', startsAt: '2026-04-01T09:00:00.000Z', endsAt: '2026-04-01T10:00:00.000Z', risk: 'high',
  })
  const created = await apply(store, create)
  const createdValue = json(created)
  add('create exact success', 'foundation', 10, created.status === 0 && created.stderr === ''
    && exactKeys(createdValue, ['commandId', 'windowId', 'revision', 'status', 'replayed'])
    && createdValue?.commandId === create.commandId && createdValue?.windowId === 'WIN-CORE'
    && createdValue?.revision === 1 && createdValue?.status === 'draft' && createdValue?.replayed === false, true)

  const projection = json(get(store, 'WIN-CORE'))
  add('get exact draft projection', 'foundation', 8, exactKeys(projection, [
    'id', 'service', 'startsAt', 'endsAt', 'risk', 'status', 'revision', 'outcome', 'cancelledReason',
  ]) && projection?.id === 'WIN-CORE' && projection?.service === 'payments'
    && projection?.status === 'draft' && projection?.revision === 1
    && projection?.outcome === null && projection?.cancelledReason === null, true)

  const invalidStore = join(root, 'invalid.json')
  const invalid = await apply(invalidStore, command('create', 'WIN-BAD', '2026-04-01T08:00:00.000Z', 0, {
    service: 'bad', startsAt: '2026-04-01T10:00:00.000Z', endsAt: '2026-04-01T09:00:00.000Z', risk: 'high',
  }))
  add('invalid input does not create store', 'foundation', 6, invalid.status === 2 && invalid.stdout === '' && !existsSync(invalidStore), true)

  if (phase === 'report') {
    const reportStore = join(root, 'report-phase.json')
    await apply(reportStore, command('create', 'WIN-Z', '2026-04-02T08:00:00.000Z', 0, {
      service: 'zeta', startsAt: '2026-04-02T09:00:00.000Z', endsAt: '2026-04-02T10:00:00.000Z', risk: 'low',
    }))
    await apply(reportStore, command('create', 'WIN-A', '2026-04-02T08:00:00.000Z', 0, {
      service: 'alpha', startsAt: '2026-04-02T09:00:00.000Z', endsAt: '2026-04-02T10:00:00.000Z', risk: 'high',
    }))
    const reportValue = json(summary(reportStore, '2026-04-02T09:00:00.000Z'))
    add('delegated historical summary', 'reporting', 70, exactKeys(reportValue, [
      'at', 'draft', 'approved', 'active', 'finished', 'cancelled', 'atRiskWindowIds',
    ]) && reportValue?.draft === 2 && reportValue?.approved === 0 && reportValue?.active === 0
      && JSON.stringify(reportValue?.atRiskWindowIds) === JSON.stringify(['WIN-A', 'WIN-Z']), true)
    const sources = await sourceTree()
    add('delegated report ownership', 'reporting', 30, sources['src/report.mjs'].length > 0
      && /summary|atRisk|at risk/i.test(sources['src/report.mjs'])
      && /summary/i.test(sources['README.md']), false)
  } else {
    const beforeUnauthorized = await bytes(store)
    const denied = await apply(store, command('approve', 'WIN-CORE', '2026-04-01T08:01:00.000Z', 1, {}, actor('planner-1', 'planner')))
    add('role boundary is atomic', 'transitions', 6, denied.status === 4 && denied.stdout === ''
      && sameBytes(beforeUnauthorized, await bytes(store)), true)

    const approve = await apply(store, command('approve', 'WIN-CORE', '2026-04-01T08:01:00.000Z', 1, {}, actor('approver-1', 'approver')))
    const started = await apply(store, command('start', 'WIN-CORE', '2026-04-01T09:00:00.000Z', 2, {}, actor('operator-1', 'operator')))
    const finishCommand = command('finish', 'WIN-CORE', '2026-04-01T09:30:00.000Z', 3, { outcome: 'healthy' }, actor('operator-1', 'operator'))
    const finish = await apply(store, finishCommand)
    add('approve start finish transitions', 'transitions', 16, json(approve)?.status === 'approved' && json(approve)?.revision === 2
      && json(started)?.status === 'active' && json(started)?.revision === 3
      && json(finish)?.status === 'finished' && json(finish)?.revision === 4, true)

    const replayBefore = await bytes(store)
    const replayed = await apply(store, finishCommand)
    add('accepted command replay is byte stable', 'storage', 8, replayed.status === 0 && json(replayed)?.replayed === true
      && sameBytes(replayBefore, await bytes(store)), true)

    const conflictBefore = await bytes(store)
    const conflict = await apply(store, command('reschedule', 'WIN-CORE', '2026-04-01T09:31:00.000Z', 3, {
      startsAt: '2026-04-01T11:00:00.000Z', endsAt: '2026-04-01T12:00:00.000Z',
    }))
    add('state conflict is atomic', 'storage', 6, conflict.status === 3 && conflict.stdout === ''
      && sameBytes(conflictBefore, await bytes(store)), true)

    const revisionStore = join(root, 'revision.json')
    await apply(revisionStore, command('create', 'WIN-REVISION', '2026-05-01T08:00:00.000Z', 0, {
      service: 'catalog', startsAt: '2026-05-01T09:00:00.000Z', endsAt: '2026-05-01T10:00:00.000Z', risk: 'low',
    }))
    const cancelledBefore = await bytes(revisionStore)
    const cancelled = await apply(revisionStore, command('cancel', 'WIN-REVISION', '2026-05-01T08:01:00.000Z', 1, { reason: 'obsolete' }))
    add('obsolete cancel is removed', 'revision', 10, cancelled.status === 2 && cancelled.stdout === ''
      && sameBytes(cancelledBefore, await bytes(revisionStore)), true)
    const rescheduled = await apply(revisionStore, command('reschedule', 'WIN-REVISION', '2026-05-01T08:01:00.000Z', 1, {
      startsAt: '2026-05-01T11:00:00.000Z', endsAt: '2026-05-01T12:00:00.000Z',
    }))
    const revised = json(get(revisionStore, 'WIN-REVISION'))
    add('reschedule replaces cancelled behavior', 'revision', 10, rescheduled.status === 0 && json(rescheduled)?.status === 'draft'
      && json(rescheduled)?.revision === 2 && revised?.startsAt === '2026-05-01T11:00:00.000Z'
      && revised?.endsAt === '2026-05-01T12:00:00.000Z', true)

    const reportStore = join(root, 'report.json')
    await apply(reportStore, command('create', 'WIN-Z', '2026-06-01T08:00:00.000Z', 0, {
      service: 'zeta', startsAt: '2026-06-01T09:00:00.000Z', endsAt: '2026-06-01T10:00:00.000Z', risk: 'low',
    }))
    await apply(reportStore, command('create', 'WIN-A', '2026-06-01T08:00:00.000Z', 0, {
      service: 'alpha', startsAt: '2026-06-01T09:00:00.000Z', endsAt: '2026-06-01T10:00:00.000Z', risk: 'high',
    }))
    const reportBefore = await bytes(reportStore)
    const reportValue = json(summary(reportStore, '2026-06-01T09:00:00.000Z'))
    add('historical summary and sorted at-risk list', 'reporting', 10, exactKeys(reportValue, [
      'at', 'draft', 'approved', 'active', 'finished', 'cancelled', 'atRiskWindowIds',
    ]) && reportValue?.draft === 2 && reportValue?.approved === 0
      && JSON.stringify(reportValue?.atRiskWindowIds) === JSON.stringify(['WIN-A', 'WIN-Z'])
      && sameBytes(reportBefore, await bytes(reportStore)), true)

    const sources = await sourceTree()
    const testResult = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 30_000 })
    add('required architecture tests and documentation', 'quality', 10,
      ['src/cli.mjs', 'src/domain.mjs', 'src/store.mjs', 'src/report.mjs'].every(path => sources[path].length > 0)
      && /apply|summary|reschedule/i.test(sources['README.md']) && sources.tests.length > 80
      && testResult.status === 0, false)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const reportingScore = checks
  .filter(check => check.category === 'reporting')
  .reduce((total, check) => total + (check.passed ? check.points : 0), 0)
const score = phase === 'report'
  ? reportingScore
  : checks.reduce((total, check) => total + (check.passed ? check.points : 0), 0)
const hardRequirementsMissed = checks.filter(check => check.hard && !check.passed).length
const staleRequirementsRetained = checks.filter(check => check.name === 'obsolete cancel is removed' && !check.passed).length
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
  affectedArtifactCoverage: checks.filter(check => check.category === 'revision').every(check => check.passed) ? 1 : 0,
  categories,
  checks,
}, null, 2)}\n`)
