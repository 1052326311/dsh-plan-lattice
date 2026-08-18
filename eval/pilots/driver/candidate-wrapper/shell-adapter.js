import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function tokenize(command) {
  const tokens = []
  let value = ''
  let quote
  let quoted = false
  let unquoted = false
  const push = () => {
    if (value === '' && !quoted) return
    tokens.push({ value, quoted, unquoted })
    value = ''
    quoted = false
    unquoted = false
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") quote = undefined
      else value += char
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined
        continue
      }
      if (char === '$' || char === '`') throw new Error('host interpolation is not allowed in a quoted Docker command')
      if (char === '\\') {
        index += 1
        if (index >= command.length) throw new Error('unterminated shell escape')
        value += command[index]
      } else value += char
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoted = true
      continue
    }
    if (char === '\\') {
      index += 1
      if (index >= command.length) throw new Error('unterminated shell escape')
      value += command[index]
      unquoted = true
      continue
    }
    if (';&|<>`$()'.includes(char)) throw new Error('host shell operators are not allowed around docker exec')
    value += char
    unquoted = true
  }
  if (quote !== undefined) throw new Error('unterminated shell quote')
  push()
  return tokens
}

export function parseIcaeDockerExec(command, expectedContainerId) {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('bash command must be non-empty text')
  const tokens = tokenize(command)
  if (tokens[0]?.value !== 'docker' || tokens[1]?.value !== 'exec') {
    throw new Error('only a single docker exec command is allowed')
  }
  let index = 2
  let workdir
  while (tokens[index]?.value?.startsWith('-')) {
    const option = tokens[index].value
    if (option === '-i' || option === '--interactive') {
      index += 1
      continue
    }
    if (option === '-w' || option === '--workdir') {
      workdir = tokens[index + 1]?.value
      index += 2
      continue
    }
    if (option.startsWith('--workdir=')) {
      workdir = option.slice('--workdir='.length)
      index += 1
      continue
    }
    throw new Error(`unsupported docker exec option ${JSON.stringify(option)}`)
  }
  if (workdir !== '/workspace') throw new Error('docker exec must use /workspace as its working directory')
  if (tokens[index]?.value !== expectedContainerId) throw new Error('docker exec must target the frozen ICAE container')
  index += 1
  if (tokens[index]?.value !== 'bash' || tokens[index + 1]?.value !== '-lc') {
    throw new Error('docker exec must invoke bash -lc')
  }
  const script = tokens[index + 2]
  if (script === undefined || index + 3 !== tokens.length || !script.quoted || script.unquoted) {
    throw new Error('the in-container script must be one single-quoted shell argument')
  }
  return { containerId: expectedContainerId, script: script.value }
}

export function assertIcaeBashArguments(arguments_, expectedContainerId) {
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
    throw new Error('ICAE Bash arguments must be an object')
  }
  const unsupported = Object.keys(arguments_).filter(key => key !== 'command' && key !== 'description')
  if (unsupported.length > 0) {
    throw new Error(`ICAE Bash does not allow execution metadata ${JSON.stringify(unsupported.sort())}`)
  }
  return parseIcaeDockerExec(arguments_.command, expectedContainerId)
}

export function validateIcaeWorkspaceMount(record, workspace) {
  const expectedWorkspace = realpathSync(resolve(workspace))
  const mounts = (record.Mounts ?? []).filter(candidate => candidate.Destination === '/workspace')
  if (mounts.length !== 1) throw new Error('the frozen ICAE container must expose exactly one /workspace mount')
  const mount = mounts[0]
  if (mount.Type !== 'bind' || mount.RW !== true) {
    throw new Error('the frozen ICAE /workspace mount must be a writable bind mount')
  }
  if (realpathSync(resolve(mount.Source)) !== expectedWorkspace) {
    throw new Error('the frozen ICAE container no longer exposes the exact agent workspace')
  }
  return { expectedWorkspace, mount }
}

function inspectContainer(containerId, workspace) {
  const result = spawnSync('docker', ['inspect', containerId], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('the frozen ICAE container cannot be inspected')
  const record = JSON.parse(result.stdout)[0]
  if (record?.Id !== containerId || record?.State?.Running !== true) {
    throw new Error('the frozen ICAE container is not running with the expected identity')
  }
  const { expectedWorkspace, mount } = validateIcaeWorkspaceMount(record, workspace)
  const state = JSON.stringify({
    id: record.Id,
    image: record.Image,
    startedAt: record.State.StartedAt,
    workspace: expectedWorkspace,
    mountType: mount.Type,
    readWrite: mount.RW,
  })
  return createHash('sha256').update(state).digest('hex')
}

function validated(input) {
  const containerId = process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID
  if (!/^[0-9a-f]{64}$/.test(containerId ?? '')) throw new Error('frozen ICAE container identity is unavailable')
  if (input.resource !== `container:${containerId}`) throw new Error('resource must identify the frozen ICAE container')
  assertIcaeBashArguments(input.arguments, containerId)
  return { containerId, stateDigest: inspectContainer(containerId, input.workspace) }
}

export const icaeShellAdapter = {
  normalizeArguments(arguments_) {
    const command = arguments_?.command
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('bash command must be non-empty text')
    }
    return { command }
  },
  async snapshot(input) {
    const { containerId, stateDigest } = validated(input)
    return {
      stateDigest,
      description: `Exact docker exec arguments bound to running disposable ICAE container ${containerId.slice(0, 12)} and its /workspace mount.`,
    }
  },
  verify(input) {
    try {
      const current = validated(input)
      return current.stateDigest === input.expectedStateDigest
        ? undefined
        : 'the disposable ICAE container identity or workspace mount changed'
    } catch (error) {
      return error instanceof Error ? error.message : 'the disposable ICAE container precondition cannot be verified'
    }
  },
}
