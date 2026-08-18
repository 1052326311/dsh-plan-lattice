import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const EXCLUDED_ROOTS = new Set(['.dsh', '.git', 'node_modules'])

function validateArguments(arguments_) {
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
    throw new Error('Bash arguments must be an object')
  }
  const unsupported = Object.keys(arguments_).filter(key => key !== 'command' && key !== 'description')
  if (unsupported.length > 0) {
    throw new Error(`Bash does not allow execution metadata ${JSON.stringify(unsupported.sort())}`)
  }
  if (typeof arguments_.command !== 'string' || arguments_.command.trim() === '') {
    throw new Error('Bash command must be non-empty text')
  }
  return arguments_.command
}

function digestWorkspace(workspace) {
  const root = realpathSync(resolve(workspace))
  const hash = createHash('sha256')
  function visit(path) {
    const name = relative(root, path)
    const top = name.split('/')[0]
    if (top && EXCLUDED_ROOTS.has(top)) return
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      hash.update(`directory\0${name}\0`)
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry))
      return
    }
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${name}\0${readlinkSync(path)}\0`)
      return
    }
    if (!stat.isFile()) throw new Error(`unsupported workspace entry ${name}`)
    hash.update(`file\0${name}\0`).update(readFileSync(path)).update('\0')
  }
  visit(root)
  return { root, digest: hash.digest('hex') }
}

function validated(input) {
  validateArguments(input.arguments)
  const current = digestWorkspace(input.workspace)
  if (input.resource !== `workspace:${current.root}`) {
    throw new Error('resource must identify the exact evaluation workspace')
  }
  return current
}

export const workspaceShellAdapter = {
  normalizeArguments(arguments_) {
    return { command: validateArguments(arguments_) }
  },
  async snapshot(input) {
    const current = validated(input)
    return {
      stateDigest: current.digest,
      description: 'Exact Bash command bound to the current non-control workspace tree.',
    }
  },
  verify(input) {
    try {
      return validated(input).digest === input.expectedStateDigest
        ? undefined
        : 'the evaluation workspace changed after the action basis was prepared'
    } catch (error) {
      return error instanceof Error ? error.message : 'the evaluation workspace cannot be verified'
    }
  },
}
