#!/usr/bin/env node
import process from 'node:process'
import { readFile } from 'node:fs/promises'
import { parseArgv } from './args.mjs'
import { validateCommand, ENVELOPE_KEYS, TYPES } from './validate.mjs'
import { readEvents, appendEvents } from './store.mjs'
import { evaluateCommand } from './domain.mjs'
import { formatGet } from './report.mjs'
import { AuthError, CliError, InputError, StateError } from './errors.mjs'

// Deep canonical serialization so semantically identical JSON compares equal
// regardless of object key order.
function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Compares the command portion of a stored event with an incoming command.
function commandContentEquals(event, command) {
  const keys = [...ENVELOPE_KEYS, ...TYPES[command.type].extraKeys]
  const stored = {}
  const incoming = {}
  for (const key of keys) {
    stored[key] = event[key]
    incoming[key] = command[key]
  }
  return canonicalStringify(stored) === canonicalStringify(incoming)
}

async function runApply(values) {
  let raw
  try {
    const text = await readFile(values.command, 'utf8')
    raw = JSON.parse(text)
  } catch (err) {
    throw new InputError(`cannot read command file: ${err.message}`)
  }
  const command = validateCommand(raw)
  const events = await readEvents(values.store)

  // Global idempotency: an identical accepted command replays its original
  // result and changes no bytes; reuse with different content is a conflict.
  const prior = events.find((e) => e.commandId === command.commandId)
  if (prior) {
    if (commandContentEquals(prior, command)) {
      return {
        commandId: prior.commandId,
        dutyId: prior.dutyId,
        revision: prior.revision,
        status: prior.status,
        replayed: true,
      }
    }
    throw new StateError('commandId already used with different content')
  }

  const event = evaluateCommand(events, command)
  await appendEvents(values.store, events, [event])
  return {
    commandId: event.commandId,
    dutyId: event.dutyId,
    revision: event.revision,
    status: event.status,
    replayed: false,
  }
}

async function main(argv) {
  const { command, values } = parseArgv(argv)

  if (command === 'apply') {
    return runApply(values)
  }
  if (command === 'get') {
    const events = await readEvents(values.store)
    return formatGet(events, values.duty)
  }
  if (command === 'summary') {
    // Delegated to a later milestone; recognized here but not yet implemented.
    throw new InputError('summary is not implemented')
  }
  throw new InputError(`unknown command: ${command}`)
}

try {
  const result = await main(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (err) {
  const message = err instanceof Error && err.message ? err.message : String(err)
  const code = err instanceof AuthError ? 4 : err instanceof StateError ? 3 : 2
  process.stderr.write(`${message}\n`)
  process.exitCode = code
}
