#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspace = resolve(process.argv[2] ?? '')
const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'final'
if (!existsSync(workspace) || !['final', 'report'].includes(phase)) {
  throw new Error('usage: node grader.mjs <workspace> [--phase final|report]')
}

const root = await mkdtemp(join(tmpdir(), 'incident-ledger-hidden-'))
const digestA = 'a'.repeat(12)
let commandSequence = 0
let commandFileSequence = 0

function actor(id, role) {
  return { id, role }
}

function command(type, incidentId, at, expectedRevision, extra = {}, by = actor('dispatch-1', 'dispatcher')) {
  commandSequence += 1
  return {
    commandId: `cmd-${digestA}-${commandSequence}`,
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
  commandFileSequence += 1
  const path = join(root, `command-${String(commandFileSequence).padStart(4, '0')}.json`)
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
  return run(['apply', '--store', store, '--command', path])
}

function query(store, incidentId) {
  return run(['get', '--store', store, '--incident', incidentId])
}

function report(store, at) {
  return run(['report', '--store', store, '--at', at])
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
  const paths = ['src/cli.mjs', 'src/domain.mjs', 'src/store.mjs', 'src/report.mjs', 'README.md']
  const values = {}
  for (const path of paths) {
    try { values[path] = await readFile(join(workspace, path), 'utf8') } catch { values[path] = '' }
  }
  let tests = ''
  try {
    for (const entry of (await readdir(join(workspace, 'test'))).sort()) {
      if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.cjs')) {
        tests += await readFile(join(workspace, 'test', entry), 'utf8')
      }
    }
  } catch {}
  return { ...values, tests }
}

const checks = []
function add(name, category, points, passed, hard = false) {
  checks.push({ name, category, points, passed: Boolean(passed), hard })
}

try {
  const coreStore = join(root, 'core.json')
  const openedCommand = command('open', 'INC-CORE', '2026-01-01T00:00:00.000Z', 0, {
    title: 'Database unavailable', severity: 'sev1',
  })
  const opened = await apply(coreStore, openedCommand)
  const openValue = json(opened)
  add('open exact success', 'state-machine', 5, opened.status === 0
    && opened.stderr === ''
    && exactKeys(openValue, ['commandId', 'incidentId', 'revision', 'status', 'replayed'])
    && openValue.commandId === openedCommand.commandId
    && openValue.incidentId === 'INC-CORE'
    && openValue.revision === 1 && openValue.status === 'open' && openValue.replayed === false, true)

  const assignedCommand = command('assign', 'INC-CORE', '2026-01-01T00:01:00.000Z', 1, { assigneeId: 'responder-1' })
  const assigned = await apply(coreStore, assignedCommand)
  const assignedValue = json(assigned)
  add('assign transition', 'state-machine', 5, assigned.status === 0
    && assignedValue?.revision === 2 && assignedValue?.status === 'open', true)

  const beforeUnauthorized = await bytes(coreStore)
  const unauthorized = await apply(coreStore, command(
    'acknowledge', 'INC-CORE', '2026-01-01T00:02:00.000Z', 2, {}, actor('other', 'responder'),
  ))
  add('authorization exit and immutability', 'boundaries', 5, unauthorized.status === 4
    && unauthorized.stdout === '' && /authori|assignee|responder/i.test(unauthorized.stderr)
    && sameBytes(beforeUnauthorized, await bytes(coreStore)), true)

  const acknowledgedCommand = command(
    'acknowledge', 'INC-CORE', '2026-01-01T00:02:00.000Z', 2, {}, actor('responder-1', 'responder'),
  )
  const acknowledged = await apply(coreStore, acknowledgedCommand)
  add('acknowledge transition', 'state-machine', 5, acknowledged.status === 0
    && json(acknowledged)?.revision === 3 && json(acknowledged)?.status === 'acknowledged', true)

  const resolvedCommand = command(
    'resolve', 'INC-CORE', '2026-01-01T00:03:00.000Z', 3,
    { resolution: 'Restored primary database' }, actor('responder-1', 'responder'),
  )
  const resolved = await apply(coreStore, resolvedCommand)
  add('resolve transition', 'state-machine', 5, resolved.status === 0
    && json(resolved)?.revision === 4 && json(resolved)?.status === 'resolved', true)

  const got = query(coreStore, 'INC-CORE')
  const gotValue = json(got)
  add('get exact projection', 'projection', 5, got.status === 0
    && exactKeys(gotValue, [
      'id', 'title', 'severity', 'status', 'assigneeId', 'revision', 'cycle',
      'openedAt', 'acknowledgedAt', 'resolvedAt', 'resolution',
    ])
    && gotValue.id === 'INC-CORE' && gotValue.status === 'resolved'
    && gotValue.assigneeId === 'responder-1' && gotValue.revision === 4
    && gotValue.cycle === 1 && gotValue.resolution === 'Restored primary database', true)

  const beforeConflict = await bytes(coreStore)
  const conflict = await apply(coreStore, command('assign', 'INC-CORE', '2026-01-01T00:04:00.000Z', 2, { assigneeId: 'x' }))
  add('optimistic concurrency exit and immutability', 'boundaries', 5, conflict.status === 3
    && conflict.stdout === '' && /revision|state|conflict/i.test(conflict.stderr)
    && sameBytes(beforeConflict, await bytes(coreStore)), true)

  const replayBefore = await bytes(coreStore)
  const replay = await apply(coreStore, resolvedCommand)
  const replayValue = json(replay)
  add('accepted command replay is byte-stable', 'idempotency', 5, replay.status === 0
    && replayValue?.commandId === resolvedCommand.commandId
    && replayValue?.revision === 4 && replayValue?.status === 'resolved' && replayValue?.replayed === true
    && sameBytes(replayBefore, await bytes(coreStore)), true)

  const reused = { ...resolvedCommand, resolution: 'Different payload' }
  const reusedBefore = await bytes(coreStore)
  const reuseConflict = await apply(coreStore, reused)
  add('conflicting command id is rejected atomically', 'idempotency', 5, reuseConflict.status === 3
    && reuseConflict.stdout === '' && /command|idempot|conflict/i.test(reuseConflict.stderr)
    && sameBytes(reusedBefore, await bytes(coreStore)), true)

  const staleTimestampBefore = await bytes(coreStore)
  const staleTimestamp = await apply(coreStore, command('requeue', 'INC-CORE', '2025-12-31T23:59:00.000Z', 4, { reason: 'retry' }))
  add('monotonic timestamp boundary', 'boundaries', 3, staleTimestamp.status === 3
    && sameBytes(staleTimestampBefore, await bytes(coreStore)), true)

  const extraKeyBefore = await bytes(coreStore)
  const extraKey = await apply(coreStore, {
    ...command('requeue', 'INC-CORE', '2026-01-01T00:30:00.000Z', 4, { reason: 'retry' }),
    extra: true,
  })
  add('exact command shape boundary', 'boundaries', 3, extraKey.status === 2
    && extraKey.stdout === '' && sameBytes(extraKeyBefore, await bytes(coreStore)), true)

  const invalidStore = join(root, 'invalid-open.json')
  const invalidSeverity = await apply(invalidStore, command('open', 'INC-BAD', '2026-01-01T00:00:00.000Z', 0, {
    title: 'Bad', severity: 'critical',
  }))
  add('invalid input does not create store', 'boundaries', 3, invalidSeverity.status === 2
    && invalidSeverity.stdout === '' && !existsSync(invalidStore), true)

  const reopenBefore = await bytes(coreStore)
  const reopen = await apply(coreStore, command(
    'reopen', 'INC-CORE', '2026-01-01T00:10:00.000Z', 4, { reason: 'old rule' }, actor('supervisor-1', 'supervisor'),
  ))
  const staleRequirementsRetained = reopen.status === 0
  add('obsolete reopen command is removed', 'revision', 6, reopen.status === 2
    && reopen.stdout === '' && sameBytes(reopenBefore, await bytes(coreStore)), true)

  const requeueCommand = command('requeue', 'INC-CORE', '2026-01-01T00:30:00.000Z', 4, { reason: 'new signal' })
  const requeue = await apply(coreStore, requeueCommand)
  const requeueValue = json(requeue)
  add('requeue replacement succeeds after fifteen minutes', 'revision', 7, requeue.status === 0
    && exactKeys(requeueValue, ['commandId', 'incidentId', 'revision', 'status', 'replayed'])
    && requeueValue.revision === 5 && requeueValue.status === 'open' && requeueValue.replayed === false, true)

  const requeuedProjection = json(query(coreStore, 'INC-CORE'))
  add('requeue clears state and advances cycle', 'revision', 5, requeuedProjection?.status === 'open'
    && requeuedProjection?.revision === 5 && requeuedProjection?.cycle === 2
    && requeuedProjection?.assigneeId === null && requeuedProjection?.acknowledgedAt === null
    && requeuedProjection?.resolvedAt === null && requeuedProjection?.resolution === null, true)

  const reportStore = join(root, 'report.json')
  await apply(reportStore, command('open', 'INC-Z', '2026-02-01T00:00:00.000Z', 0, { title: 'Z', severity: 'sev1' }))
  await apply(reportStore, command('open', 'INC-A', '2026-02-01T00:00:00.000Z', 0, { title: 'A', severity: 'sev1' }))
  const earlyReport = report(reportStore, '2026-02-01T00:04:00.000Z')
  const earlyValue = json(earlyReport)
  add('historical report exact shape and counts', 'reporting', 6, earlyReport.status === 0
    && exactKeys(earlyValue, ['at', 'open', 'acknowledged', 'resolved', 'overdueIncidentIds'])
    && earlyValue.at === '2026-02-01T00:04:00.000Z'
    && earlyValue.open === 2 && earlyValue.acknowledged === 0 && earlyValue.resolved === 0
    && JSON.stringify(earlyValue.overdueIncidentIds) === '[]', true)

  const overdueReport = report(reportStore, '2026-02-01T00:06:00.000Z')
  const overdueValue = json(overdueReport)
  add('severity deadline and sorted overdue ids', 'reporting', 6, overdueReport.status === 0
    && overdueValue?.open === 2
    && JSON.stringify(overdueValue?.overdueIncidentIds) === JSON.stringify(['INC-A', 'INC-Z']), true)

  const reportBefore = await bytes(reportStore)
  report(reportStore, '2026-02-01T00:06:00.000Z')
  const repeatedReport = report(reportStore, '2026-02-01T00:06:00.000Z')
  add('report is read-only', 'reporting', 2, repeatedReport.status === 0
    && sameBytes(reportBefore, await bytes(reportStore)), true)

  const beforeRequeue = report(coreStore, '2026-01-01T00:29:00.000Z')
  const afterRequeueEarly = report(coreStore, '2026-01-01T00:34:00.000Z')
  const afterRequeueLate = report(coreStore, '2026-01-01T00:36:00.001Z')
  add('report replays revision and restarted deadline', 'reporting', 5,
    json(beforeRequeue)?.resolved === 1
    && json(afterRequeueEarly)?.open === 1
    && JSON.stringify(json(afterRequeueEarly)?.overdueIncidentIds) === '[]'
    && JSON.stringify(json(afterRequeueLate)?.overdueIncidentIds) === JSON.stringify(['INC-CORE']), true)

  const sources = await sourceTree()
  const requiredFiles = ['src/cli.mjs', 'src/domain.mjs', 'src/store.mjs', 'src/report.mjs', 'README.md']
  add('required architecture exists', 'quality', 2, requiredFiles.every(path => sources[path].trim() !== ''), false)

  const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
  const production = requiredFiles.filter(path => path.startsWith('src/')).map(path => sources[path]).join('\n')
  add('dependency-free and network-free production', 'quality', 3,
    Object.keys(manifest.dependencies ?? {}).length === 0
    && !/\bfetch\s*\(|node:(?:http|https|net|tls|dns)|from\s+['"](?:http|https|net|tls|dns)['"]/.test(production), true)

  const tests = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 120_000 })
  add('project tests pass', 'quality', 2, tests.status === 0, false)

  const readme = sources['README.md']
  add('documentation reflects current revision', 'quality', 2,
    /\brequeue\b/i.test(readme)
    && (/reopen[^\n]*(unsupported|removed|no longer)/i.test(readme) || !/\breopen\b/i.test(readme))
    && /exit\s*(?:code)?\s*2/i.test(readme)
    && /exit\s*(?:code)?\s*3/i.test(readme)
    && /exit\s*(?:code)?\s*4/i.test(readme), false)

  const affectedArtifacts = {
    cli: /\brequeue\b/.test(sources['src/cli.mjs']),
    domain: /\brequeue\b/.test(sources['src/domain.mjs']),
    tests: /\brequeue\b/.test(sources.tests),
    documentation: /\brequeue\b/i.test(readme),
  }
  const selected = phase === 'report'
    ? checks.filter(check => check.category === 'reporting')
    : checks
  const score = selected.reduce((sum, check) => sum + (check.passed ? check.points : 0), 0)
  const possible = selected.reduce((sum, check) => sum + check.points, 0)
  const hard = selected.filter(check => check.hard)
  const output = {
    schemaVersion: 1,
    taskId: 'incident-ledger-v1',
    phase,
    score: possible === 0 ? 0 : (score / possible) * 100,
    earnedPoints: score,
    possiblePoints: possible,
    hardRequirementsTotal: hard.length,
    hardRequirementsMissed: hard.filter(check => !check.passed).length,
    staleRequirementsRetained,
    affectedArtifacts,
    affectedArtifactCoverage: Object.values(affectedArtifacts).filter(Boolean).length / Object.keys(affectedArtifacts).length,
    categories: Object.fromEntries([...new Set(selected.map(check => check.category))].map(category => {
      const rows = selected.filter(check => check.category === category)
      const earned = rows.reduce((sum, check) => sum + (check.passed ? check.points : 0), 0)
      const total = rows.reduce((sum, check) => sum + check.points, 0)
      return [category, { earned, total, score: total === 0 ? 0 : (earned / total) * 100 }]
    })),
    checks: selected,
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
