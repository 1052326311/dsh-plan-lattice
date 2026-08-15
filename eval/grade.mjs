import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspace = resolve(process.argv[2] ?? '')
if (workspace === resolve('')) throw new Error('usage: node eval/grade.mjs <workspace>')

const digestA = 'a'.repeat(64)
const digestB = 'b'.repeat(64)

function run(input, channel = 'stable') {
  const directory = mkdtemp(join(tmpdir(), 'release-planner-grade-'))
  return directory.then(async dir => {
    const path = join(dir, 'manifest.json')
    const original = `${JSON.stringify(input, null, 2)}\n`
    await writeFile(path, original, 'utf8')
    const result = spawnSync(process.execPath, [
      'src/cli.mjs', 'plan', '--input', path, '--channel', channel, '--format', 'json',
    ], { cwd: workspace, encoding: 'utf8', timeout: 10_000 })
    const after = await readFile(path, 'utf8')
    await rm(dir, { recursive: true, force: true })
    return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), unchanged: after === original }
  })
}

function parsed(result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

const stable = await run({
  version: '2.0.0', rollbackToken: 'rollback-2',
  artifacts: [{ name: 'zeta', digest: digestB }, { name: 'alpha', digest: digestA }],
})
const canary = await run({ version: '2.1.0-rc.1', artifacts: [{ name: 'app', digest: digestA }] }, 'canary')
const noRollback = await run({ version: '2.0.0', artifacts: [{ name: 'app', digest: digestA }] })
const badDigest = await run({
  version: '2.0.0', rollbackToken: 'rollback-2', artifacts: [{ name: 'app', digest: 'ABC' }],
})
const badShape = await run({ version: '2.0.0', rollbackToken: 'x', artifacts: [], extra: true })
const badChannel = await run({
  version: '2.0.0', rollbackToken: 'x', artifacts: [{ name: 'app', digest: digestA }],
}, 'preview')

const stableValue = parsed(stable)
const canaryValue = parsed(canary)
const checks = [
  ['stable succeeds', stable.code === 0, 10],
  ['canary succeeds', canary.code === 0, 10],
  ['stable rollback policy', noRollback.code === 3 && /rollback/i.test(noRollback.stderr), 10],
  ['digest validation', badDigest.code === 2 && /digest/i.test(badDigest.stderr), 10],
  ['exact input shape', badShape.code === 2, 10],
  ['channel validation', badChannel.code === 2 && /channel/i.test(badChannel.stderr), 10],
  ['stable exact output keys', JSON.stringify(Object.keys(stableValue ?? {}).sort()) === JSON.stringify([
    'artifactNames', 'channel', 'rollbackReady', 'schemaVersion', 'version',
  ]), 10],
  ['deterministic sorted output', JSON.stringify(stableValue?.artifactNames) === JSON.stringify(['alpha', 'zeta'])
    && stableValue?.schemaVersion === 1 && stableValue?.channel === 'stable' && stableValue?.rollbackReady === true
    && canaryValue?.rollbackReady === false, 10],
  ['exit-code boundary', badDigest.code === 2 && badShape.code === 2 && badChannel.code === 2 && noRollback.code === 3, 10],
  ['input immutable and dependency free', [stable, canary, noRollback, badDigest, badShape, badChannel].every(result => result.unchanged)
    && (JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).dependencies === undefined), 10],
]
const score = checks.reduce((total, [, passed, points]) => total + (passed ? points : 0), 0)
console.log(JSON.stringify({ score, checks: checks.map(([name, passed, points]) => ({ name, passed, points })) }, null, 2))
