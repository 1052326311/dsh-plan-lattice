import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { materializeDriverSourceSnapshot } from '../execution-snapshot.mjs'
import { isolatedGit, isolatedGitEnvironment } from '../git-safety.mjs'
import { V27_DRIVER_OBJECT_PATHS } from '../manifest.mjs'

function git(root, args) {
  const result = spawnSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'V27 Fixture',
      GIT_AUTHOR_EMAIL: 'v27@example.invalid',
      GIT_COMMITTER_NAME: 'V27 Fixture',
      GIT_COMMITTER_EMAIL: 'v27@example.invalid',
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-git-source-'))
  git(root, ['init', '--quiet'])
  for (const path of V27_DRIVER_OBJECT_PATHS) {
    const file = path.endsWith('.mjs') ? path : join(path, 'fixture.txt')
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), `frozen:${file}\n`)
  }
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'frozen driver'])
  return { root, commit: git(root, ['rev-parse', 'HEAD']) }
}

test('uses a fixed whitelist under a hostile inherited Git environment', async (context) => {
  const fixture = await sourceFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const hostile = {
    PATH: '/hostile/bin',
    HOME: '/hostile/home',
    TMPDIR: '/hostile/tmp',
    TMP: '/hostile/tmp',
    TEMP: '/hostile/tmp',
    LANG: 'hostile_LOCALE',
    LC_ALL: 'hostile_LOCALE',
    GIT_EXEC_PATH: '/hostile/git-core',
    GIT_SSL_CAINFO: '/hostile/ca.pem',
    SSL_CERT_FILE: '/hostile/ca.pem',
    CURL_CA_BUNDLE: '/hostile/ca.pem',
    HTTPS_PROXY: 'http://hostile.invalid:8080',
    ALL_PROXY: 'socks5://hostile.invalid:1080',
    GIT_SSH: '/hostile/ssh',
    GIT_SSH_COMMAND: '/hostile/ssh --rewrite',
    SSH_AUTH_SOCK: '/hostile/agent.sock',
    SSH_ASKPASS: '/hostile/askpass',
    GIT_ASKPASS: '/hostile/askpass',
    GCM_INTERACTIVE: 'always',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/hostile/objects',
    GIT_OBJECT_DIRECTORY: '/hostile/objects',
    GIT_COMMON_DIR: '/hostile/common',
    GIT_DIR: '/hostile/repository',
    GIT_WORK_TREE: '/hostile/worktree',
    GIT_INDEX_FILE: '/hostile/index',
    GIT_SHALLOW_FILE: '/hostile/shallow',
    GIT_REPLACE_REF_BASE: 'refs/hostile/',
    GIT_CONFIG_SYSTEM: '/hostile/system.gitconfig',
    GIT_CONFIG_GLOBAL: '/hostile/global.gitconfig',
    GIT_CONFIG_NOSYSTEM: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '/hostile/helper',
    GIT_CONFIG_PARAMETERS: "'credential.helper'='/hostile/helper'",
  }
  assert.deepEqual(isolatedGitEnvironment(hostile), {
    PATH: '/usr/bin:/bin',
    HOME: '/var/empty',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  })

  const previous = Object.fromEntries(Object.keys(hostile).map(name => [name, process.env[name]]))
  try {
    Object.assign(process.env, hostile)
    assert.equal(isolatedGit(fixture.root, ['rev-parse', 'HEAD']), fixture.commit)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('fails closed instead of waiting forever for a stuck Git transport or helper', async (context) => {
  const fixture = await sourceFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  assert.throws(
    () => isolatedGit(fixture.root, ['-c', 'alias.v27-stall=!sleep 2', 'v27-stall'], { timeout: 20 }),
    error => error?.code === 'ETIMEDOUT',
  )
})

test('ignores Git replacement refs and materializes only frozen commit bytes', async (context) => {
  const fixture = await sourceFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const target = 'eval/long-system/v27/fixture.txt'

  await writeFile(join(fixture.root, target), 'replacement bytes\n')
  git(fixture.root, ['add', target])
  git(fixture.root, ['commit', '--quiet', '-m', 'replacement driver'])
  const replacement = git(fixture.root, ['rev-parse', 'HEAD'])
  git(fixture.root, ['replace', fixture.commit, replacement])
  assert.equal(git(fixture.root, ['show', `${fixture.commit}:${target}`]), 'replacement bytes')
  assert.equal(isolatedGit(fixture.root, ['show', `${fixture.commit}:${target}`]), `frozen:${target}`)

  await writeFile(join(fixture.root, target), 'dirty post-preflight bytes\n')
  const output = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-driver-snapshot-'))
  context.after(() => rm(output, { recursive: true, force: true }))
  const repository = join(output, 'repository')
  await materializeDriverSourceSnapshot({
    destination: repository,
    commit: fixture.commit,
    sourceRoot: fixture.root,
  })
  assert.equal(await readFile(join(repository, target), 'utf8'), `frozen:${target}\n`)
})
