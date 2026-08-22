import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const PRIVATE_HOST_ROOTS = [
  '/Users',
  '/Volumes',
  '/private/tmp',
  '/etc',
  '/private/etc',
  '/Library/Preferences',
  '/Library/Application Support',
]

function sbplString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function configuredRoots(environment, name, description) {
  let roots
  try {
    roots = JSON.parse(environment[name] ?? '[]')
  } catch {
    throw new Error(`long-system Bash ${description} policy is not valid JSON`)
  }
  if (!Array.isArray(roots) || roots.some(path => typeof path !== 'string' || !isAbsolute(path))) {
    throw new Error(`long-system Bash ${description} policy must contain absolute paths`)
  }
  return [...new Set(roots.map(path => realpathSync(resolve(path))))]
}

function canonicalRoots(values) {
  return [...new Set(values
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => realpathSync(resolve(value))))]
}

function traversalAncestors(paths) {
  const ancestors = new Set()
  for (const path of paths) {
    let current = dirname(path)
    while (current !== dirname(current)) {
      ancestors.add(current)
      current = dirname(current)
    }
  }
  return [...ancestors]
}

export function strictSeatbeltConfine(argv, policy, environment = process.env) {
  if (process.platform !== 'darwin') throw new Error('V28 strict Seatbelt provider requires Darwin')
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string')) {
    throw new Error('V28 strict Seatbelt provider requires a non-empty string argv')
  }
  if (policy?.mode !== 'workspace-write' && policy?.mode !== 'read-only') {
    throw new Error(`V28 strict Seatbelt provider cannot confine mode ${JSON.stringify(policy?.mode)}`)
  }
  if (typeof policy.workspaceRoot !== 'string' || !isAbsolute(policy.workspaceRoot)) {
    throw new Error('V28 strict Seatbelt provider requires an absolute workspace root')
  }

  const workspaceRoot = realpathSync(resolve(policy.workspaceRoot))
  const writable = policy.mode === 'workspace-write'
    ? canonicalRoots([workspaceRoot, environment.HOME, environment.TMPDIR])
    : []
  const forbidden = configuredRoots(
    environment,
    'DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON',
    'forbidden-root',
  )
  const configuredReadable = configuredRoots(
    environment,
    'DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON',
    'allowed-read-root',
  )
  const readable = canonicalRoots([workspaceRoot, ...writable, ...configuredReadable])
  // Runtimes such as Node realpath their entry point before opening it. Grant
  // only metadata on the directory chain leading to an authorized root; this
  // does not permit listing a parent or reading any sibling file.
  const readableAncestors = traversalAncestors(readable)
  const toolPath = [
    '/Library/Developer/CommandLineTools/usr/bin',
    '/usr/bin',
    '/bin',
    ...configuredReadable.flatMap(path => [join(path, 'bin'), path]),
  ].join(':')
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny process-info*)',
    '(allow process-info* (target self))',
    '(deny network*)',
    '(deny file-read* (vnode-type SYMLINK))',
    ...forbidden.map(path => `(deny file-read* (subpath ${sbplString(path)}))`),
    ...PRIVATE_HOST_ROOTS.map(path => `(deny file-read* (subpath ${sbplString(path)}))`),
    ...readable.map(path => `(allow file-read* (subpath ${sbplString(path)}))`),
    ...(readableAncestors.length === 0
      ? []
      : [`(allow file-read-metadata ${readableAncestors.map(path => `(literal ${sbplString(path)})`).join(' ')})`]),
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
    ...(writable.length === 0
      ? []
      : [`(allow file-write* ${writable.map(path => `(subpath ${sbplString(path)})`).join(' ')})`]),
  ].join('\n')
  return {
    argv: [
      '/usr/bin/sandbox-exec',
      '-p',
      profile,
      '--',
      '/usr/bin/env',
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null',
      `PATH=${toolPath}`,
      ...argv,
    ],
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
  }
}
