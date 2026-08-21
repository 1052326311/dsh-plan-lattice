import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  EVOCODE_ROUND_COUNT,
  inspectEvoCodeTask,
  parseEvoCodeTaskToml,
  parseOfficialVerifierOutput,
  runOfficialRoundInDocker,
  summarizeOfficialRounds,
} from '../benchmark.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v26-task-'))
  await mkdir(join(root, 'environment'), { recursive: true })
  await writeFile(join(root, 'environment', 'Dockerfile'), 'FROM scratch\n')
  const stepBlocks = []
  for (let round = 1; round <= EVOCODE_ROUND_COUNT; round += 1) {
    const step = `round-${round}`
    stepBlocks.push(`[[steps]]\nname = "${step}"`)
    await mkdir(join(root, 'steps', step, 'tests'), { recursive: true })
    await mkdir(join(root, 'steps', step, 'solution'), { recursive: true })
    await writeFile(join(root, 'steps', step, 'instruction.md'), `requirement ${round}\n`)
    await writeFile(join(root, 'steps', step, 'tests', 'test.sh'), `#!/bin/bash\necho round ${round}\n`)
    await writeFile(join(root, 'steps', step, 'solution', 'solve.sh'), `#!/bin/bash\necho solve ${round}\n`)
  }
  await writeFile(join(root, 'task.toml'), [
    'schema_version = "1.2"',
    '[metadata.requirement_chain]',
    `num_steps = ${EVOCODE_ROUND_COUNT}`,
    ...stepBlocks,
    '',
  ].join('\n'))
  return root
}

function output(cases) {
  const lines = cases.map((entry) => [
    'CASE_RESULT',
    `case_id=${entry.caseId}`,
    `origin_step=${entry.originStep === 'base' ? 'base' : `round-${entry.originStep}`}`,
    `requirement_ref=${entry.requirementRef ?? 'requirement'}`,
    `case_type=${entry.caseType ?? 'core'}`,
    `status=${entry.status}`,
    `intent="" scenario="${entry.scenario ?? entry.caseId}" input="" expected="" actual="" failure_reason=""`,
  ].join(' '))
  const successes = cases.filter((entry) => entry.status === 'success').length
  lines.push(`CASE_SUMMARY total_cases=${cases.length} success_count=${successes} fail_count=${cases.length - successes}`)
  return `${lines.join('\n')}\n`
}

test('asset identity keeps public, hidden, and oracle bytes in separate digests', async () => {
  const root = await fixture()
  try {
    const initial = await inspectEvoCodeTask(root)
    assert.deepEqual(initial.steps, Array.from({ length: 9 }, (_, index) => `round-${index + 1}`))
    assert.equal(initial.digests.public.files.length, 11)
    assert.equal(initial.digests.hidden.files.length, 9)
    assert.equal(initial.digests.oracle.files.length, 9)

    await writeFile(join(root, 'steps', 'round-1', 'instruction.md'), 'changed public requirement\n')
    const publicChange = await inspectEvoCodeTask(root)
    assert.notEqual(publicChange.digests.public.sha256, initial.digests.public.sha256)
    assert.equal(publicChange.digests.hidden.sha256, initial.digests.hidden.sha256)
    assert.equal(publicChange.digests.oracle.sha256, initial.digests.oracle.sha256)

    await writeFile(join(root, 'steps', 'round-1', 'tests', 'test.sh'), '#!/bin/bash\necho changed hidden test\n')
    const hiddenChange = await inspectEvoCodeTask(root)
    assert.equal(hiddenChange.digests.public.sha256, publicChange.digests.public.sha256)
    assert.notEqual(hiddenChange.digests.hidden.sha256, publicChange.digests.hidden.sha256)
    assert.equal(hiddenChange.digests.oracle.sha256, publicChange.digests.oracle.sha256)

    await writeFile(join(root, 'steps', 'round-1', 'solution', 'solve.sh'), '#!/bin/bash\necho changed oracle\n')
    const oracleChange = await inspectEvoCodeTask(root)
    assert.equal(oracleChange.digests.public.sha256, hiddenChange.digests.public.sha256)
    assert.equal(oracleChange.digests.hidden.sha256, hiddenChange.digests.hidden.sha256)
    assert.notEqual(oracleChange.digests.oracle.sha256, hiddenChange.digests.oracle.sha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('task.toml parser requires the fixed ordered nine-round protocol', () => {
  const valid = `[metadata.requirement_chain]\nnum_steps = 9\n${Array.from({ length: 9 }, (_, index) => `[[steps]]\nname = "round-${index + 1}"`).join('\n')}`
  assert.equal(parseEvoCodeTaskToml(valid).length, 9)
  assert.throws(() => parseEvoCodeTaskToml(valid.replace('num_steps = 9', 'num_steps = 8')), /exactly 9/)
  assert.throws(() => parseEvoCodeTaskToml(valid.replace('name = "round-9"', 'name = "round-8"')), /must be ordered/)
})

test('official output parser reads case identities, summary, and binary reward', () => {
  const parsed = parseOfficialVerifierOutput(output([
    { caseId: 'build', originStep: 'base', status: 'success' },
    { caseId: 'same', originStep: 1, status: 'success' },
    { caseId: 'edge', originStep: 2, status: 'fail', caseType: 'boundary' },
  ]), { round: 2, reward: '0.0\n' })
  assert.deepEqual(parsed.cases.map((entry) => entry.identity), [
    'base:requirement:build', 'round-1:requirement:same', 'round-2:requirement:edge',
  ])
  assert.deepEqual({ total: parsed.total, successes: parsed.successes, failures: parsed.failures }, {
    total: 3, successes: 2, failures: 1,
  })
  assert.equal(parsed.reward, 0)
  assert.equal(parsed.caseRatio, 2 / 3)
})

test('official output parser rejects incomplete, contradictory, or unstable receipts', () => {
  const passing = output([{ caseId: 'one', originStep: 1, status: 'success', scenario: 'stable' }])
  assert.throws(() => parseOfficialVerifierOutput(passing, { round: 1, reward: 0 }), /reward conflicts/)
  assert.throws(() => parseOfficialVerifierOutput(
    passing.replace('origin_step=round-1', 'origin_step=round-9'),
    { round: 1, reward: 1 },
  ), /future origin/)
  assert.throws(() => parseOfficialVerifierOutput(
    passing.replace(/\nCASE_SUMMARY.*\n$/, '\n'),
    { round: 1, reward: 1 },
  ), /no CASE_SUMMARY/)
  const duplicate = output([
    { caseId: 'one', originStep: 1, status: 'success', scenario: 'stable' },
    { caseId: 'renumbered', originStep: 1, status: 'success', scenario: 'stable' },
  ])
  assert.throws(() => parseOfficialVerifierOutput(duplicate, { round: 1, reward: 1 }), /duplicate stable case identity/)
})

test('summary pads unreached rounds with zero and keys regressions by stable scenario identity', () => {
  const round1 = parseOfficialVerifierOutput(output([
    { caseId: 'same', originStep: 1, status: 'success' },
  ]), { round: 1, reward: 1 })
  const round2 = parseOfficialVerifierOutput(output([
    { caseId: 'same', originStep: 1, status: 'fail' },
    { caseId: 'same', originStep: 2, status: 'success' },
  ]), { round: 2, reward: 0 })
  const summary = summarizeOfficialRounds([round1, round2])
  assert.equal(summary.rounds.length, 9)
  assert.equal(summary.reachedRounds, 2)
  assert.equal(summary.rounds[8].reached, false)
  assert.equal(summary.rounds[8].reward, 0)
  assert.ok(Math.abs(summary.rewardScore - (100 / 9)) < 1e-12)
  assert.deepEqual(summary.historicalRegressionKeys, ['round-1:requirement:same'])
  assert.equal(summary.historicalRequirementRegressions, 1)
})

test('Docker grader exposes only workspace, one test script, and evaluator logs', async () => {
  const taskRoot = await fixture()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v26-workspace-'))
  const toolsRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v26-tools-'))
  const verifierTempRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v26-verifiers-'))
  const fakeDocker = join(toolsRoot, 'docker')
  const argumentLog = join(toolsRoot, 'arguments.json')
  try {
    await writeFile(fakeDocker, `#!/usr/bin/env node
const args = process.argv.slice(2)
const mounts = args.filter((value, index) => args[index - 1] === '--mount')
if (mounts.some((value) => value.includes('solution'))) process.exit(91)
if (mounts.some((value) => value.includes('dst=/app/tests'))) process.exit(92)
require('node:fs').writeFileSync(${JSON.stringify(argumentLog)}, JSON.stringify(args))
const logs = mounts.find((value) => value.includes('dst=/logs/verifier'))
const source = logs.match(/(?:^|,)src=([^,]+)/)[1]
require('node:fs').writeFileSync(require('node:path').join(source, 'reward.txt'), '1.0\\n')
const app = mounts.find((value) => value.includes('dst=/app'))
const appSource = app.match(/(?:^|,)src=([^,]+)/)[1]
require('node:fs').writeFileSync(require('node:path').join(appSource, 'marker'), 'grader mutation\\n')
process.stdout.write('CASE_RESULT case_id=ok origin_step=round-1 requirement_ref=base case_type=core status=success intent="" scenario="ok" input="" expected="" actual="" failure_reason=""\\nCASE_SUMMARY total_cases=1 success_count=1 fail_count=0\\n')
`)
    await chmod(fakeDocker, 0o755)
    const result = await runOfficialRoundInDocker({
      taskRoot,
      workspaceRoot,
      round: 1,
      image: 'frozen-image@sha256:abc',
      dockerExecutable: fakeDocker,
      verifierTempRoot,
    })
    assert.equal(result.reward, 1)
    assert.equal(result.total, 1)
    assert.equal(result.process.status, 0)
    const arguments_ = JSON.parse(await readFile(argumentLog, 'utf8'))
    const mounts = arguments_.filter((value, index) => arguments_[index - 1] === '--mount')
    const canonicalTaskRoot = await realpath(taskRoot)
    const canonicalWorkspaceRoot = await realpath(workspaceRoot)
    const canonicalVerifierTempRoot = await realpath(verifierTempRoot)
    assert.equal(mounts.length, 3)
    const appMount = mounts.find(value => value.endsWith(',dst=/app'))
    assert.ok(appMount)
    assert.ok(!appMount.includes(`src=${canonicalWorkspaceRoot},`))
    assert.ok(appMount.includes(`src=${canonicalVerifierTempRoot}/`))
    assert.ok(mounts.includes(`type=bind,src=${join(canonicalTaskRoot, 'steps', 'round-1', 'tests', 'test.sh')},dst=/opt/evocode-grader/test.sh,readonly`))
    assert.ok(mounts.some((value) => value.endsWith(',dst=/logs/verifier')))
    assert.ok(!arguments_.includes(canonicalTaskRoot))
    assert.ok(!arguments_.some((value) => value.includes('/solution/')))
    await assert.rejects(
      runOfficialRoundInDocker({ taskRoot, workspaceRoot: join(taskRoot, 'environment'), round: 1, image: 'x', dockerExecutable: fakeDocker }),
      /disjoint/,
    )
    await assert.rejects(
      runOfficialRoundInDocker({
        taskRoot,
        workspaceRoot,
        round: 1,
        image: 'x',
        dockerExecutable: fakeDocker,
        verifierTempRoot: join(workspaceRoot, 'verifier'),
      }),
      /verifier temporary root must be disjoint/,
    )
    assert.equal((await readFile(join(workspaceRoot, 'marker'), 'utf8').catch(() => undefined)), undefined)
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(toolsRoot, { recursive: true, force: true })
    await rm(verifierTempRoot, { recursive: true, force: true })
  }
})
