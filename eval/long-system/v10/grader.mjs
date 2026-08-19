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

const root = await mkdtemp(join(tmpdir(), 'incident-timeline-hidden-'))
let sequence = 0

function actor(id, role) {
  return { id, role }
}

function command(type, incidentId, at, expectedRevision, extra = {}, by = actor('commander-1', 'commander')) {
  sequence += 1
  return {
    commandId: `cmd-eval-${String(sequence).padStart(4, '0')}`,
    type,
    incidentId,
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

function get(store, incidentId) {
  return run(['get', '--store', store, '--incident', incidentId])
}

function timeline(store, at) {
  return run(['timeline', '--store', store, '--at', at])
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
  const store = join(root, 'incidents.json')
  const open = command('open', 'INC-CORE', '2026-04-01T08:00:00.000Z', 0, {
    service: 'payments', detectedAt: '2026-04-01T07:55:00.000Z', severity: 'sev1',
  })
  const opend = await apply(store, open)
  const opendValue = json(opend)
  add('open exact success', 'foundation', 10, opend.status === 0 && opend.stderr === ''
    && exactKeys(opendValue, ['commandId', 'incidentId', 'revision', 'status', 'replayed'])
    && opendValue?.commandId === open.commandId && opendValue?.incidentId === 'INC-CORE'
    && opendValue?.revision === 1 && opendValue?.status === 'open' && opendValue?.replayed === false, true)

  const projection = json(get(store, 'INC-CORE'))
  add('get exact open projection', 'foundation', 8, exactKeys(projection, [
    'id', 'service', 'detectedAt', 'severity', 'status', 'revision', 'outcome', 'closedReason',
  ]) && projection?.id === 'INC-CORE' && projection?.service === 'payments'
    && projection?.status === 'open' && projection?.revision === 1
    && projection?.outcome === null && projection?.closedReason === null, true)

  const invalidStore = join(root, 'invalid.json')
  const invalid = await apply(invalidStore, command('open', 'INC-BAD', '2026-04-01T08:00:00.000Z', 0, {
    service: 'bad', detectedAt: '2026-04-01T08:01:00.000Z', severity: 'sev1',
  }))
  add('invalid input does not open store', 'foundation', 6, invalid.status === 2 && invalid.stdout === '' && !existsSync(invalidStore), true)

  if (phase === 'report') {
    const reportStore = join(root, 'report-phase.json')
    await apply(reportStore, command('open', 'INC-Z', '2026-04-02T08:00:00.000Z', 0, {
      service: 'zeta', detectedAt: '2026-04-02T07:55:00.000Z', severity: 'sev2',
    }))
    await apply(reportStore, command('open', 'INC-A', '2026-04-02T08:00:00.000Z', 0, {
      service: 'alpha', detectedAt: '2026-04-02T07:55:00.000Z', severity: 'sev1',
    }))
    const reportValue = json(timeline(reportStore, '2026-04-02T09:00:00.000Z'))
    add('delegated historical timeline', 'reporting', 70, exactKeys(reportValue, [
      'at', 'open', 'acknowledged', 'mitigating', 'resolved', 'closed', 'activeIncidentIds',
    ]) && reportValue?.open === 2 && reportValue?.acknowledged === 0 && reportValue?.mitigating === 0
      && JSON.stringify(reportValue?.activeIncidentIds) === JSON.stringify(['INC-A', 'INC-Z']), true)
    const sources = await sourceTree()
    add('delegated report ownership', 'reporting', 30, sources['src/report.mjs'].length > 0
      && /timeline|active/i.test(sources['src/report.mjs'])
      && /timeline/i.test(sources['README.md']), false)
  } else {
    const beforeUnauthorized = await bytes(store)
    const denied = await apply(store, command('acknowledge', 'INC-CORE', '2026-04-01T08:01:00.000Z', 1, {}, actor('commander-1', 'commander')))
    add('role boundary is atomic', 'transitions', 6, denied.status === 4 && denied.stdout === ''
      && sameBytes(beforeUnauthorized, await bytes(store)), true)

    const acknowledge = await apply(store, command('acknowledge', 'INC-CORE', '2026-04-01T08:01:00.000Z', 1, {}, actor('responder-1', 'responder')))
    const mitigateed = await apply(store, command('mitigate', 'INC-CORE', '2026-04-01T09:00:00.000Z', 2, {}, actor('responder-1', 'responder')))
    const resolveCommand = command('resolve', 'INC-CORE', '2026-04-01T09:30:00.000Z', 3, { outcome: 'healthy' }, actor('commander-1', 'commander'))
    const resolve = await apply(store, resolveCommand)
    add('acknowledge mitigate resolve transitions', 'transitions', 16, json(acknowledge)?.status === 'acknowledged' && json(acknowledge)?.revision === 2
      && json(mitigateed)?.status === 'mitigating' && json(mitigateed)?.revision === 3
      && json(resolve)?.status === 'resolved' && json(resolve)?.revision === 4, true)

    const replayBefore = await bytes(store)
    const replayed = await apply(store, resolveCommand)
    add('accepted command replay is byte stable', 'storage', 8, replayed.status === 0 && json(replayed)?.replayed === true
      && sameBytes(replayBefore, await bytes(store)), true)

    const conflictBefore = await bytes(store)
    const conflict = await apply(store, command('retime', 'INC-CORE', '2026-04-01T09:31:00.000Z', 3, {
      detectedAt: '2026-04-01T08:30:00.000Z',
    }))
    add('state conflict is atomic', 'storage', 6, conflict.status === 3 && conflict.stdout === ''
      && sameBytes(conflictBefore, await bytes(store)), true)

    const revisionStore = join(root, 'revision.json')
    await apply(revisionStore, command('open', 'INC-REVISION', '2026-05-01T08:00:00.000Z', 0, {
      service: 'catalog', detectedAt: '2026-05-01T07:55:00.000Z', severity: 'sev2',
    }))
    const closedBefore = await bytes(revisionStore)
    const closed = await apply(revisionStore, command('close', 'INC-REVISION', '2026-05-01T08:01:00.000Z', 1, { reason: 'obsolete' }))
    add('obsolete close is removed', 'revision', 10, closed.status === 2 && closed.stdout === ''
      && sameBytes(closedBefore, await bytes(revisionStore)), true)
    const retimed = await apply(revisionStore, command('retime', 'INC-REVISION', '2026-05-01T08:01:00.000Z', 1, {
      detectedAt: '2026-05-01T07:50:00.000Z',
    }))
    const revised = json(get(revisionStore, 'INC-REVISION'))
    add('retime replaces closed behavior', 'revision', 10, retimed.status === 0 && json(retimed)?.status === 'open'
      && json(retimed)?.revision === 2 && revised?.detectedAt === '2026-05-01T07:50:00.000Z', true)

    const reportStore = join(root, 'report.json')
    await apply(reportStore, command('open', 'INC-Z', '2026-06-01T08:00:00.000Z', 0, {
      service: 'zeta', detectedAt: '2026-06-01T07:55:00.000Z', severity: 'sev2',
    }))
    await apply(reportStore, command('open', 'INC-A', '2026-06-01T08:00:00.000Z', 0, {
      service: 'alpha', detectedAt: '2026-06-01T07:55:00.000Z', severity: 'sev1',
    }))
    const reportBefore = await bytes(reportStore)
    const reportValue = json(timeline(reportStore, '2026-06-01T09:00:00.000Z'))
    add('historical timeline and sorted active-incident list', 'reporting', 10, exactKeys(reportValue, [
      'at', 'open', 'acknowledged', 'mitigating', 'resolved', 'closed', 'activeIncidentIds',
    ]) && reportValue?.open === 2 && reportValue?.acknowledged === 0
      && JSON.stringify(reportValue?.activeIncidentIds) === JSON.stringify(['INC-A', 'INC-Z'])
      && sameBytes(reportBefore, await bytes(reportStore)), true)

    const sources = await sourceTree()
    const testResult = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 30_000 })
    add('required architecture tests and documentation', 'quality', 10,
      ['src/cli.mjs', 'src/domain.mjs', 'src/store.mjs', 'src/report.mjs'].every(path => sources[path].length > 0)
      && /apply|timeline|retime/i.test(sources['README.md']) && sources.tests.length > 80
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
const staleRequirementsRetained = checks.filter(check => check.name === 'obsolete close is removed' && !check.passed).length
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
