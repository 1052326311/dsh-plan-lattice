import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sandboxBashArguments } from '../driver/candidate-wrapper/common-boundary.js'
import { assertLongSystemToolBoundary, hiddenLongSystemTools } from '../driver/candidate-wrapper/tool-boundary.js'

test('keeps model-authored Bash inside the frozen workspace sandbox', () => {
  assert.doesNotThrow(() => assertLongSystemToolBoundary({
    name: 'bash',
    arguments: { command: 'go test ./...', description: 'Run public tests' },
  }))
  for (const arguments_ of [
    { command: 'touch ../host-harness-runtime/pwned', workdir: '..' },
    { command: 'touch ../host-harness-runtime/pwned', sandbox_permissions: 'danger-full-access' },
    { command: 'touch ../host-harness-runtime/pwned', run_in_background: true },
  ]) {
    assert.throws(
      () => assertLongSystemToolBoundary({ name: 'bash', arguments: arguments_ }),
      /cannot override its workspace sandbox/,
    )
  }
  assert.deepEqual(hiddenLongSystemTools(['bash', 'read', 'grep', 'glob']), ['glob', 'grep', 'read'])
  for (const name of ['read', 'grep', 'glob']) {
    assert.throws(() => assertLongSystemToolBoundary({ name, arguments: {} }), /blocks out-of-bound tool/)
  }
})

test('wraps Bash in one explicit-read Seatbelt command', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-tool-boundary-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const temp = join(root, 'temp')
  const hidden = join(root, 'hidden.txt')
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(temp), writeFile(hidden, 'hidden')])
  await writeFile(join(workspace, 'visible.txt'), 'visible')
  await symlink(hidden, join(workspace, 'escape.txt'))

  const wrapped = sandboxBashArguments({ command: 'printf ok > output.txt' }, {
    workspace,
    env: {
      HOME: home,
      TMPDIR: temp,
      PATH: '/opt/unfrozen-toolchain:/usr/local/bin',
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  assert.match(wrapped.command, /^\/usr\/bin\/sandbox-exec -p /)
  assert.match(wrapped.command, /deny file-read/)
  assert.match(wrapped.command, /deny file-write/)
  assert.match(wrapped.command, /deny network/)
  assert.match(wrapped.command, /\(deny process-info\*\)/)
  assert.match(wrapped.command, /\(allow process-info\* \(target self\)\)/)
  assert.match(wrapped.command, /GIT_CONFIG_NOSYSTEM=1/)
  assert.match(wrapped.command, /GIT_CONFIG_GLOBAL=\/dev\/null/)
  assert.match(wrapped.command, /Library\/Developer\/CommandLineTools\/usr\/bin/)
  assert.doesNotMatch(wrapped.command, /unfrozen-toolchain|usr\/local\/bin/)
  assert.match(wrapped.command, /printf ok > output\.txt/)

  const execution = spawnSync('/bin/bash', ['-c', wrapped.command], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.equal(execution.status, 0, execution.stderr)

  const gitVersion = sandboxBashArguments({ command: 'git --version' }, {
    workspace,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const gitExecution = spawnSync('/bin/bash', ['-c', gitVersion.command], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.equal(gitExecution.status, 0, gitExecution.stderr)
  assert.match(gitExecution.stdout, /^git version /)

  const directForbiddenRead = sandboxBashArguments({ command: `cat ${hidden}` }, {
    workspace,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const directDenied = spawnSync('/bin/bash', ['-c', directForbiddenRead.command], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.notEqual(directDenied.status, 0)
  assert.doesNotMatch(directDenied.stdout, /hidden/)
  assert.match(directDenied.stderr, /operation not permitted|permission denied/iu)

  const escapedRead = sandboxBashArguments({ command: 'cat escape.txt' }, {
    workspace,
    env: {
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const denied = spawnSync('/bin/bash', ['-c', escapedRead.command], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /operation not permitted|permission denied/iu)

  for (const command of ['head -c 1 /etc/hosts', 'ls /Library/Preferences']) {
    const systemRead = sandboxBashArguments({ command }, {
      workspace,
      env: {
        HOME: home,
        TMPDIR: temp,
        DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
        DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
      },
    })
    const systemDenied = spawnSync('/bin/bash', ['-c', systemRead.command], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TMPDIR: temp },
    })
    assert.notEqual(systemDenied.status, 0)
    assert.match(systemDenied.stderr, /operation not permitted|permission denied/iu)
  }
})

test('denies a real same-UID ancestor environment canary through process-info', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v27-process-info-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const temp = join(root, 'temp')
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(temp)])

  const canaryName = 'DSH_PLAN_LATTICE_V27_ANCESTOR_ENV_CANARY'
  const canaryValue = `v27-process-info-${process.pid}-${Date.now()}`
  const boundaryUrl = new URL('../driver/candidate-wrapper/common-boundary.js', import.meta.url).href
  const helper = `
import { spawnSync } from 'node:child_process'
import { sandboxBashArguments } from ${JSON.stringify(boundaryUrl)}

const [workspace, home, temp, forbidden, canaryName] = process.argv.slice(1)
const wrapped = sandboxBashArguments({
  command: \`printf 'V27_SANDBOX_STARTED\\n'; /bin/ps eww -p \${process.pid}\`,
  description: 'Probe ancestor process metadata denial',
}, {
  workspace,
  env: {
    HOME: home,
    TMPDIR: temp,
    DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([forbidden]),
    DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
  },
})
const childEnvironment = { ...process.env, HOME: home, TMPDIR: temp }
delete childEnvironment[canaryName]
const result = spawnSync('/bin/bash', ['-c', wrapped.command], {
  cwd: workspace,
  env: childEnvironment,
  encoding: 'utf8',
})
process.stdout.write(JSON.stringify({
  status: result.status,
  signal: result.signal,
  error: result.error?.message ?? null,
  stdout: result.stdout ?? '',
  stderr: result.stderr ?? '',
}))
`
  const execution = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    helper,
    workspace,
    home,
    temp,
    root,
    canaryName,
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C',
      [canaryName]: canaryValue,
    },
  })
  assert.equal(execution.status, 0, execution.stderr)
  const probe = JSON.parse(execution.stdout)
  assert.match(probe.stdout, /^V27_SANDBOX_STARTED$/m)
  assert.notEqual(probe.status, 0, 'sandboxed ps unexpectedly inspected its ancestor')
  assert.doesNotMatch(`${probe.stdout}\n${probe.stderr}`, new RegExp(canaryValue))
  assert.match(`${probe.error ?? ''}\n${probe.stderr}`,
    /operation not permitted|permission denied|sandbox|not allowed/iu)
})
