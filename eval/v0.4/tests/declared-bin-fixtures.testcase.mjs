import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const fixturesRoot = join(repositoryRoot, 'eval/fixtures/plugins')
const goodFixture = join(fixturesRoot, 'declared-bin-good')
const badFixture = join(fixturesRoot, 'declared-bin-bad')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
  return result
}

async function packFixture(fixture, temporaryRoot) {
  const destination = join(temporaryRoot, basename(fixture))
  const unpacked = join(destination, 'unpacked')
  await mkdir(unpacked, { recursive: true })
  const packed = run('npm', ['pack', '--json', '--pack-destination', destination], { cwd: fixture })
  const records = JSON.parse(packed.stdout)
  assert.equal(records.length, 1)
  const tarball = join(destination, records[0].filename)
  run('tar', ['-xzf', tarball, '-C', unpacked])
  return join(unpacked, 'package')
}

test('packed declared-bin fixtures differ only by shebang and reproduce ENOEXEC', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-declared-bin-'))
  try {
    const relativeFiles = ['package.json', 'lib/index.js', 'cordis.patch.yml']
    for (const relative of relativeFiles) {
      assert.equal(await readFile(join(goodFixture, relative), 'utf8'), await readFile(join(badFixture, relative), 'utf8'))
    }

    const goodSourceCli = join(goodFixture, 'lib/cli.js')
    const badSourceCli = join(badFixture, 'lib/cli.js')
    const goodSource = await readFile(goodSourceCli, 'utf8')
    const badSource = await readFile(badSourceCli, 'utf8')
    assert.equal(goodSource, `#!/usr/bin/env node\n${badSource}`)
    const sourceMode = (await stat(goodSourceCli)).mode & 0o777
    assert.equal(sourceMode, (await stat(badSourceCli)).mode & 0o777)
    assert.ok((sourceMode & 0o111) !== 0, 'source CLI must be directly executable')

    const packedGood = await packFixture(goodFixture, temporaryRoot)
    const packedBad = await packFixture(badFixture, temporaryRoot)
    const goodCli = join(packedGood, 'lib/cli.js')
    const badCli = join(packedBad, 'lib/cli.js')
    const packedMode = (await stat(goodCli)).mode & 0o777
    assert.equal(packedMode, (await stat(badCli)).mode & 0o777)
    assert.ok((packedMode & 0o111) !== 0, 'packed CLI must remain directly executable')

    const goodRun = run(goodCli, ['--help'])
    assert.match(goodRun.stdout, /^Usage: dsh-declared-bin-fixture --help/m)

    const badRun = spawnSync(badCli, ['--help'], { encoding: 'utf8' })
    assert.equal(badRun.status, null)
    assert.equal(badRun.error?.code, 'ENOEXEC')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
