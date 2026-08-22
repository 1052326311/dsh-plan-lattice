import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { strictSeatbeltConfine } from '../driver/candidate-wrapper/strict-seatbelt-profile.js'
import { assertLongSystemToolBoundary, hiddenLongSystemTools } from '../driver/candidate-wrapper/tool-boundary.js'

function strictBashCommand(arguments_, { workspace, env }) {
  const command = assertLongSystemToolBoundary({ name: 'bash', arguments: arguments_ })
  return strictSeatbeltConfine(
    ['bash', '-c', command],
    { mode: 'workspace-write', workspaceRoot: workspace },
    env,
  )
}

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
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-tool-boundary-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const temp = join(root, 'temp')
  const hidden = join(root, 'hidden.txt')
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(temp), writeFile(hidden, 'hidden')])
  await writeFile(join(workspace, 'visible.txt'), 'visible')
  await writeFile(join(workspace, 'verification.test.mjs'), [
    "import assert from 'node:assert/strict'",
    "import { readFile } from 'node:fs/promises'",
    "import test from 'node:test'",
    '',
    "test('reads only the authorized workspace', async () => {",
    "  assert.equal(await readFile('visible.txt', 'utf8'), 'visible')",
    '})',
    '',
  ].join('\n'))
  await symlink(hidden, join(workspace, 'escape.txt'))

  const wrapped = strictBashCommand({ command: 'printf ok > output.txt' }, {
    workspace,
    env: {
      HOME: home,
      TMPDIR: temp,
      PATH: '/opt/unfrozen-toolchain:/usr/local/bin',
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const wrappedText = wrapped.argv.join('\n')
  assert.equal(wrapped.argv[0], '/usr/bin/sandbox-exec')
  assert.match(wrappedText, /deny file-read/)
  assert.match(wrappedText, /deny file-write/)
  assert.match(wrappedText, /deny network/)
  assert.match(wrappedText, /\(deny process-info\*\)/)
  assert.match(wrappedText, /\(allow process-info\* \(target self\)\)/)
  assert.match(wrappedText, /GIT_CONFIG_NOSYSTEM=1/)
  assert.match(wrappedText, /GIT_CONFIG_GLOBAL=\/dev\/null/)
  assert.match(wrappedText, /Library\/Developer\/CommandLineTools\/usr\/bin/)
  assert.doesNotMatch(wrappedText, /unfrozen-toolchain|usr\/local\/bin/)
  assert.deepEqual(wrapped.argv.slice(-3), ['bash', '-c', 'printf ok > output.txt'])

  const execution = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.equal(execution.status, 0, execution.stderr)

  const gitVersion = strictBashCommand({ command: 'git --version' }, {
    workspace,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const gitExecution = spawnSync(gitVersion.argv[0], gitVersion.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.equal(gitExecution.status, 0, gitExecution.stderr)
  assert.match(gitExecution.stdout, /^git version /)

  const nodeVerification = strictBashCommand({ command: 'node --test verification.test.mjs' }, {
    workspace,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([dirname(dirname(process.execPath))]),
    },
  })
  const nodeVerificationExecution = spawnSync(nodeVerification.argv[0], nodeVerification.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.equal(nodeVerificationExecution.status, 0, nodeVerificationExecution.stderr)

  const directForbiddenRead = strictBashCommand({ command: `cat ${hidden}` }, {
    workspace,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const directDenied = spawnSync(directForbiddenRead.argv[0], directForbiddenRead.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.notEqual(directDenied.status, 0)
  assert.doesNotMatch(directDenied.stdout, /hidden/)
  assert.match(directDenied.stderr, /operation not permitted|permission denied/iu)

  const siblingMetadata = strictBashCommand({ command: `stat ${hidden}` }, {
    workspace,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const metadataDenied = spawnSync(siblingMetadata.argv[0], siblingMetadata.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.notEqual(metadataDenied.status, 0)
  assert.doesNotMatch(metadataDenied.stdout, /hidden\.txt/u)
  assert.match(metadataDenied.stderr, /operation not permitted|permission denied/iu)

  const escapedRead = strictBashCommand({ command: 'cat escape.txt' }, {
    workspace,
    env: {
      HOME: home,
      TMPDIR: temp,
      DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
      DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
    },
  })
  const denied = spawnSync(escapedRead.argv[0], escapedRead.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: temp },
  })
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /operation not permitted|permission denied/iu)

  for (const command of ['head -c 1 /etc/hosts', 'ls /Library/Preferences']) {
    const systemRead = strictBashCommand({ command }, {
      workspace,
      env: {
        HOME: home,
        TMPDIR: temp,
        DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([root]),
        DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
      },
    })
    const systemDenied = spawnSync(systemRead.argv[0], systemRead.argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TMPDIR: temp },
    })
    assert.notEqual(systemDenied.status, 0)
    assert.match(systemDenied.stderr, /operation not permitted|permission denied/iu)
  }
})

test('denies a real same-UID ancestor environment canary through process-info', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v28-process-info-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const temp = join(root, 'temp')
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(temp)])

  const canaryName = 'DSH_PLAN_LATTICE_V28_ANCESTOR_ENV_CANARY'
  const canaryValue = `v28-process-info-${process.pid}-${Date.now()}`
  const boundaryUrl = new URL('../driver/candidate-wrapper/strict-seatbelt-profile.js', import.meta.url).href
  const helper = `
import { spawnSync } from 'node:child_process'
import { strictSeatbeltConfine } from ${JSON.stringify(boundaryUrl)}

const [workspace, home, temp, forbidden, canaryName] = process.argv.slice(1)
const wrapped = strictSeatbeltConfine(
  ['bash', '-c', \`printf 'V28_SANDBOX_STARTED\\n'; /bin/ps eww -p \${process.pid}\`],
  { mode: 'workspace-write', workspaceRoot: workspace },
  {
    HOME: home,
    TMPDIR: temp,
    DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON: JSON.stringify([forbidden]),
    DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON: JSON.stringify([]),
  },
)
const childEnvironment = { ...process.env, HOME: home, TMPDIR: temp }
delete childEnvironment[canaryName]
const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
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
  assert.match(probe.stdout, /^V28_SANDBOX_STARTED$/m)
  assert.notEqual(probe.status, 0, 'sandboxed ps unexpectedly inspected its ancestor')
  assert.doesNotMatch(`${probe.stdout}\n${probe.stderr}`, new RegExp(canaryValue))
  assert.match(`${probe.error ?? ''}\n${probe.stderr}`,
    /operation not permitted|permission denied|sandbox|not allowed/iu)
})
