import { UsageError } from './errors.mjs'

// Public CLI surface. Each subcommand declares the flags it accepts and which
// of them are required.
const COMMANDS = {
  apply: { flags: ['store', 'command'], required: ['store', 'command'] },
  get: { flags: ['store', 'duty'], required: ['store', 'duty'] },
  summary: { flags: ['store', 'at'], required: ['store', 'at'] },
}

// Strict parser for the token list after the subcommand name. Unknown flags,
// duplicate flags, missing values, empty values and stray positional tokens are
// all usage errors (exit 2).
export function parseArgv(argv) {
  if (argv.length === 0) throw new UsageError('missing command')
  const [command, ...rest] = argv
  const spec = COMMANDS[command]
  if (!spec) throw new UsageError(`unknown command: ${command}`)
  const values = parseFlags(rest, spec.flags)
  for (const flag of spec.required) {
    if (!Object.prototype.hasOwnProperty.call(values, flag)) {
      throw new UsageError(`missing required flag: --${flag}`)
    }
  }
  return { command, values }
}

function parseFlags(tokens, allowed) {
  const values = {}
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new UsageError(`unexpected positional argument: ${token}`)
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    if (name === '' || !allowed.includes(name)) {
      throw new UsageError(`unknown flag: --${name}`)
    }
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      throw new UsageError(`duplicate flag: --${name}`)
    }
    let value
    if (eq !== -1) {
      value = token.slice(eq + 1)
    } else {
      if (i + 1 >= tokens.length) {
        throw new UsageError(`missing value for flag: --${name}`)
      }
      const next = tokens[i + 1]
      if (typeof next !== 'string' || next.startsWith('--')) {
        throw new UsageError(`missing value for flag: --${name}`)
      }
      value = next
      i += 1
    }
    if (value === '') throw new UsageError(`missing value for flag: --${name}`)
    values[name] = value
    i += 1
  }
  return values
}
