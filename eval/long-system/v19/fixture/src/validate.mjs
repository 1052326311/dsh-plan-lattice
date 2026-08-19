import { InputError } from './errors.mjs'

// The common command envelope: every command carries exactly these keys plus
// the type-specific keys declared below.
export const ENVELOPE_KEYS = ['commandId', 'type', 'dutyId', 'actor', 'at', 'expectedRevision']

// Known command types and the extra keys each one adds to the envelope.
// `supported` is flipped on as later milestones land transitions.
export const TYPES = {
  open: { extraKeys: ['worker', 'start', 'end'], supported: true },
  checkin: { extraKeys: [], supported: false },
  checkout: { extraKeys: ['note'], supported: false },
}

export const SUPPORTED_TYPES = Object.keys(TYPES).filter((t) => TYPES[t].supported)

export const ROLES = ['dispatcher', 'worker']

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

// Canonical UTC ISO timestamp supplied by the caller: a full date-time with
// seconds (and optional fractional seconds) and a UTC designator.
export function isUtcIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

function fail(message) {
  throw new InputError(message)
}

// Validates the parsed command object exactly against the envelope plus the
// type-specific keys, then against per-field value rules. Any violation is an
// input failure (exit 2).
export function validateCommand(raw) {
  if (!isPlainObject(raw)) fail('command must be a JSON object')
  if (typeof raw.type !== 'string' || raw.type === '') fail('type must be a non-empty string')
  if (!(raw.type in TYPES)) fail(`unsupported command type: ${raw.type}`)
  if (!TYPES[raw.type].supported) fail(`unsupported command type: ${raw.type}`)

  const expectedKeys = [...ENVELOPE_KEYS, ...TYPES[raw.type].extraKeys]
  const actualKeys = Object.keys(raw)
  const expected = new Set(expectedKeys)
  if (actualKeys.length !== expectedKeys.length) fail('command has unexpected keys')
  for (const key of actualKeys) {
    if (!expected.has(key)) fail(`command has unknown key: ${key}`)
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) fail(`command missing key: ${key}`)
  }

  if (!isNonEmptyString(raw.commandId)) fail('commandId must be a non-empty string')
  if (!isNonEmptyString(raw.dutyId)) fail('dutyId must be a non-empty string')
  if (!isPlainObject(raw.actor)) fail('actor must be an object')
  const actorKeys = Object.keys(raw.actor)
  if (actorKeys.length !== 2 || !actorKeys.includes('id') || !actorKeys.includes('role')) {
    fail('actor must have exactly id and role')
  }
  if (!isNonEmptyString(raw.actor.id)) fail('actor.id must be a non-empty string')
  if (!ROLES.includes(raw.actor.role)) fail(`invalid actor role: ${raw.actor.role}`)
  if (!isUtcIsoTimestamp(raw.at)) fail('at must be a canonical UTC ISO timestamp')
  if (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 0) {
    fail('expectedRevision must be a non-negative integer')
  }

  if (raw.type === 'open') {
    if (!isNonEmptyString(raw.worker)) fail('worker must be a non-empty string')
    if (!isUtcIsoTimestamp(raw.start)) fail('start must be a canonical UTC ISO timestamp')
    if (!isUtcIsoTimestamp(raw.end)) fail('end must be a canonical UTC ISO timestamp')
    if (Date.parse(raw.end) <= Date.parse(raw.start)) fail('end must be strictly after start')
  }

  return raw
}
