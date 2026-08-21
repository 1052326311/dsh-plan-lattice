import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { hiddenLongSystemTools, assertLongSystemToolBoundary } from './tool-boundary.js'
import { longSystemCommonPrompt } from './common-prompt.js'

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function sbplString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function configuredForbiddenRoots(env) {
  let roots
  try {
    roots = JSON.parse(env.DSH_PLAN_LATTICE_BASH_FORBIDDEN_ROOTS_JSON ?? '[]')
  } catch {
    throw new Error('long-system Bash forbidden-root policy is not valid JSON')
  }
  if (!Array.isArray(roots) || roots.some(path => typeof path !== 'string' || !isAbsolute(path))) {
    throw new Error('long-system Bash forbidden-root policy must contain absolute paths')
  }
  return [...new Set(roots.map(path => realpathSync(resolve(path))))]
}

function configuredAllowedReadRoots(env) {
  let roots
  try {
    roots = JSON.parse(env.DSH_PLAN_LATTICE_BASH_ALLOWED_READ_ROOTS_JSON ?? '[]')
  } catch {
    throw new Error('long-system Bash allowed-read-root policy is not valid JSON')
  }
  if (!Array.isArray(roots) || roots.some(path => typeof path !== 'string' || !isAbsolute(path))) {
    throw new Error('long-system Bash allowed-read-root policy must contain absolute paths')
  }
  return [...new Set(roots.map(path => realpathSync(resolve(path))))]
}

export function sandboxBashArguments(arguments_, {
  workspace = process.cwd(),
  env = process.env,
} = {}) {
  const command = assertLongSystemToolBoundary({ name: 'bash', arguments: arguments_ })
  const workspaceRoot = realpathSync(resolve(workspace))
  const writableRoots = [workspaceRoot]
  for (const value of [env.HOME, env.TMPDIR]) {
    if (typeof value === 'string' && value.length > 0) writableRoots.push(realpathSync(resolve(value)))
  }
  const allowed = [...new Set(writableRoots)]
  const forbidden = configuredForbiddenRoots(env)
  const configuredReadable = configuredAllowedReadRoots(env)
  const readable = [...new Set([...allowed, ...configuredReadable])]
  const toolPath = [
    '/Library/Developer/CommandLineTools/usr/bin',
    '/usr/bin',
    '/bin',
    ...configuredReadable.flatMap(path => [join(path, 'bin'), path]),
  ]
    .filter(Boolean)
    .join(':')
  const privateHostRoots = [
    '/Users',
    '/Volumes',
    '/private/tmp',
    '/etc',
    '/private/etc',
    '/Library/Preferences',
    '/Library/Application Support',
  ]
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny process-info*)',
    '(allow process-info* (target self))',
    '(deny network*)',
    '(deny file-read* (vnode-type SYMLINK))',
    ...forbidden.map(path => `(deny file-read* (subpath ${sbplString(path)}))`),
    ...privateHostRoots.map(path => `(deny file-read* (subpath ${sbplString(path)}))`),
    ...readable.map(path => `(allow file-read* (subpath ${sbplString(path)}))`),
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
    `(allow file-write* ${allowed.map(path => `(subpath ${sbplString(path)})`).join(' ')})`,
  ].join('\n')
  return {
    ...arguments_,
    command: `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /usr/bin/env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null PATH=${shellQuote(toolPath)} /bin/bash --noprofile --norc -c ${shellQuote(command)}`,
  }
}

export function installLongSystemBoundary(ctx) {
  const restrictions = new Map()

  function replaceRestriction(agent) {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
    const deny = hiddenLongSystemTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (deny.length > 0) restrictions.set(key, agent.ctx.tools.restrict({ deny }))
    const remaining = hiddenLongSystemTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (remaining.length > 0) {
      throw new Error(`long-system matched boundary failed to hide tools: ${remaining.join(', ')}`)
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'bash') exec.arguments = sandboxBashArguments(exec.arguments)
    else assertLongSystemToolBoundary(exec)
    return next()
  })
  ctx.on('agent/created', ({ agent }) => replaceRestriction(agent))
  ctx.on('agent/session-start', ({ agent }) => replaceRestriction(agent))
  ctx.on('agent/inbox/inserted', ({ agent }) => replaceRestriction(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
  })
  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'long-system:matched-boundary',
    order: 55,
    text: () => longSystemCommonPrompt(realpathSync(process.cwd())),
  }))
}
