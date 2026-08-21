import { spawnSync } from 'node:child_process'

const FIXED_GIT_ENVIRONMENT = Object.freeze({
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

export function isolatedGitEnvironment() {
  return { ...FIXED_GIT_ENVIRONMENT }
}

export function isolatedGit(root, args, {
  encoding = 'utf8',
  input,
  maxBuffer = 32 * 1024 * 1024,
  timeout = 60_000,
} = {}) {
  const result = spawnSync('/usr/bin/git', ['-C', root, ...args], {
    encoding,
    env: isolatedGitEnvironment(),
    input,
    maxBuffer,
    timeout,
    killSignal: 'SIGKILL',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = encoding === null ? Buffer.from(result.stderr ?? '').toString() : result.stderr
    const stdout = encoding === null ? Buffer.from(result.stdout ?? '').toString() : result.stdout
    throw new Error((stderr || stdout || `git ${args[0]} failed`).trim())
  }
  return encoding === null ? Buffer.from(result.stdout) : result.stdout.trim()
}
