#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WORKER = join(ROOT, 'demo/crash-continuity-worker.mjs')
const RESULT_JSON = join(ROOT, 'demo/results/crash-continuity-benchmark.json')
const RESULT_MARKDOWN = join(ROOT, 'demo/results/crash-continuity-benchmark.md')
const writeResults = process.argv.includes('--write')
const cases = [
  { id: 'successful-side-effect-no-checkpoint', kind: 'hazard', description: 'Process dies after a side effect but before the successful tool result and mechanical receipt.' },
  { id: 'partial-failure-no-checkpoint', kind: 'hazard', description: 'Process dies after a side effect but before the failing tool result and mechanical receipt.' },
  { id: 'clean-restart-current-basis', kind: 'control', description: 'Process dies with a clean, current execution basis and no unproved side effect.' },
  { id: 'checkpoint-after-restart', kind: 'control', description: 'After restart, the prior side effect is checkpointed before later work.' },
]

async function sourceDigest() {
  const hash = createHash('sha256')
  const paths = [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'cordis.patch.yml',
    'demo/crash-continuity-benchmark.mjs',
    'demo/crash-continuity-worker.mjs',
    ...(await readdir(join(ROOT, 'src'))).filter(path => path.endsWith('.ts')).map(path => `src/${path}`).sort(),
  ]
  for (const path of paths) {
    hash.update(path).update('\0').update(await readFile(join(ROOT, path))).update('\0')
  }
  return hash.digest('hex')
}

function jsonLines(buffer) {
  return buffer.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function prepareAndKill(arm, caseId, root) {
  const child = spawn(process.execPath, [WORKER, 'prepare', arm, caseId, root], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const deadline = Date.now() + 20_000
  while (!jsonLines(stdout).some(item => item.event === 'ready')) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`prepare worker exited before READY: ${stderr || stdout}`)
    }
    if (Date.now() >= deadline) {
      child.kill('SIGKILL')
      throw new Error(`prepare worker timed out before READY: ${stderr || stdout}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const ready = jsonLines(stdout).find(item => item.event === 'ready')
  child.kill('SIGKILL')
  const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  if (exit.signal !== 'SIGKILL') throw new Error(`prepare worker was not terminated by SIGKILL: ${JSON.stringify(exit)}`)
  return {
    ready: {
      event: ready.event,
      processIdObserved: Number.isSafeInteger(ready.pid),
      toolBodyEntries: ready.toolBodyEntries,
    },
    exit,
  }
}

async function resume(arm, caseId, root) {
  const child = spawn(process.execPath, [WORKER, 'resume', arm, caseId, root], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  if (exit.code !== 0) throw new Error(`resume worker failed: ${stderr || stdout}`)
  const result = jsonLines(stdout).find(item => item.event === 'result')
  if (result === undefined) throw new Error(`resume worker produced no result: ${stderr || stdout}`)
  return { ...result, exit }
}

async function runSlot(testCase, arm) {
  const root = await mkdtemp(join(tmpdir(), `dsh-crash-continuity-${arm}-`))
  try {
    const killed = await prepareAndKill(arm, testCase.id, root)
    // The persistent owner is reclaimable only after a definitely dead PID has
    // remained dead for the fixed takeover grace period.
    await new Promise(resolve => setTimeout(resolve, 1_100))
    const resumed = await resume(arm, testCase.id, root)
    const expectedExecution = testCase.kind === 'control' || arm === 'native'
    return {
      prepare: killed,
      resume: resumed,
      expectedExecution,
      protocolExpectationMet: resumed.secondMutationExecuted === expectedExecution
        && resumed.toolBodyEntries === (expectedExecution ? 1 : 0)
        && resumed.isError === !expectedExecution,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const reportCases = []
for (const testCase of cases) {
  const arms = {}
  for (const arm of ['native', 'plan-lattice']) arms[arm] = await runSlot(testCase, arm)
  reportCases.push({ ...testCase, arms })
}

const hazards = reportCases.filter(item => item.kind === 'hazard')
const controls = reportCases.filter(item => item.kind === 'control')
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  candidate: {
    packageVersion: JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version,
    sourceDigest: await sourceDigest(),
    runtime: process.version,
    termination: 'SIGKILL',
    takeoverGraceMs: 1100,
  },
  caveat: 'Deterministic, hand-designed crash-continuity mechanism experiment. It does not estimate general coding quality, model intelligence, production reliability, or real-world task-success uplift.',
  cases: reportCases,
  summary: {
    hazardCount: hazards.length,
    nativeUnsafeContinuations: hazards.filter(item => item.arms.native.resume.secondMutationExecuted).length,
    planLatticeUnsafeContinuations: hazards.filter(item => item.arms['plan-lattice'].resume.secondMutationExecuted).length,
    controlCount: controls.length,
    nativeLegitimateContinuations: controls.filter(item => item.arms.native.resume.secondMutationExecuted).length,
    planLatticeLegitimateContinuations: controls.filter(item => item.arms['plan-lattice'].resume.secondMutationExecuted).length,
    allProtocolExpectationsMet: reportCases.every(item => Object.values(item.arms).every(arm => arm.protocolExpectationMet)),
  },
}

function markdown(value) {
  const lines = [
    '# Crash-Continuity Mechanism Experiment',
    '',
    `> ${value.caveat}`,
    '',
    `Candidate: \`${value.candidate.packageVersion}\`, source digest \`${value.candidate.sourceDigest.slice(0, 12)}\``,
    '',
    '| Case | Kind | Native later mutation | Plan Lattice later mutation |',
    '| --- | --- | ---: | ---: |',
  ]
  for (const item of value.cases) {
    lines.push(`| \`${item.id}\` | ${item.kind} | ${item.arms.native.resume.secondMutationExecuted ? 'executed' : 'blocked'} | ${item.arms['plan-lattice'].resume.secondMutationExecuted ? 'executed' : 'blocked'} |`)
  }
  lines.push(
    '',
    `Unsafe post-crash continuations: native **${value.summary.nativeUnsafeContinuations}/${value.summary.hazardCount}**; Plan Lattice **${value.summary.planLatticeUnsafeContinuations}/${value.summary.hazardCount}**.`,
    '',
    `Matched legitimate continuations: native **${value.summary.nativeLegitimateContinuations}/${value.summary.controlCount}**; Plan Lattice **${value.summary.planLatticeLegitimateContinuations}/${value.summary.controlCount}**.`,
    '',
    'Each prepare worker was stopped with real `SIGKILL`. Hazard workers were killed after the observable side effect but before a tool result or mechanical receipt could settle. The resume arm ran in a new Node.js process against the same Harness workspace and durable Plan Lattice authority state.',
    '',
  )
  return lines.join('\n')
}

if (!report.summary.allProtocolExpectationsMet) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} else if (writeResults) {
  await mkdir(dirname(RESULT_JSON), { recursive: true })
  await writeFile(RESULT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(RESULT_MARKDOWN, markdown(report), 'utf8')
} else {
  const expected = JSON.parse(await readFile(RESULT_JSON, 'utf8'))
  const comparable = structuredClone(report)
  comparable.generatedAt = expected.generatedAt
  if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
    throw new Error('crash-continuity results differ from the committed artifact; run demo:crash-continuity intentionally')
  }
  if (await readFile(RESULT_MARKDOWN, 'utf8') !== markdown(expected)) {
    throw new Error('crash-continuity Markdown differs from the committed JSON result')
  }
}

process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`)
