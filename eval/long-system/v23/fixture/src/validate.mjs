import { InputError } from './errors.mjs'

// The common command envelope: every command carries exactly these keys plus
// the type-specific keys declared below.
export const ENVELOPE_KEYS = ['commandId', 'type', 'dutyId', 'actor', 'at', 'expectedRevision']

// The durable state portion of every event snapshot, in canonical order.
export const STATE_KEYS = ['revision', 'status', 'worker', 'start', 'end', 'note']

// Known command types, the extra keys each one adds to the envelope, and
// whether the type is currently open for new acceptance. Foundation knows the
// durable shape of every initial type but opens only `open`; later milestones
// change acceptance without changing how existing events are decoded.
// The registry has a null prototype so hostile type names that collide with
// Object.prototype members (e.g. "__proto__", "constructor") are treated as
// unknown types instead of leaking inherited members into validation.
export const TYPES = Object.assign(Object.create(null), {
  open: { extraKeys: ['worker', 'start', 'end'], supported: true },
  checkin: { extraKeys: [], supported: true },
  pause: { extraKeys: ['reason'], supported: true },
  resume: { extraKeys: [], supported: true },
  checkout: { extraKeys: ['note'], supported: true },
})

export const ROLES = ['dispatcher', 'worker']

export const STATUSES = ['planned', 'active', 'paused', 'completed']

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

// Byte-canonical UTC timestamp: exactly YYYY-MM-DDTHH:mm:ss.sssZ. It must
// denote a real instant: impossible dates (e.g. 2026-02-30, hour 24) that
// engines would normalize are rejected because the instant must round-trip
// to the identical byte string.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isUtcIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return false
  return new Date(ms).toISOString() === value
}

function exactKeysMatch(obj, keys) {
  const own = Object.keys(obj)
  if (own.length !== keys.length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false
  }
  return true
}

function uniqueKeys(...groups) {
  const out = []
  const seen = new Set()
  for (const group of groups) {
    for (const key of group) {
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
      }
    }
  }
  return out
}

// Validates the envelope fields that are common to every command and event:
// presence, exact actor shape and per-field value rules. Type-specific and
// state keys are not considered here.
function envelopeError(obj) {
  for (const key of ENVELOPE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return `command missing key: ${key}`
  }
  if (!isNonEmptyString(obj.commandId)) return 'commandId must be a non-empty string'
  if (!isNonEmptyString(obj.dutyId)) return 'dutyId must be a non-empty string'
  if (!isPlainObject(obj.actor)) return 'actor must be an object'
  if (!exactKeysMatch(obj.actor, ['id', 'role'])) return 'actor must have exactly id and role'
  if (!isNonEmptyString(obj.actor.id)) return 'actor.id must be a non-empty string'
  if (!ROLES.includes(obj.actor.role)) return `invalid actor role: ${obj.actor.role}`
  if (!isUtcIsoTimestamp(obj.at)) return 'at must be a byte-canonical UTC timestamp'
  if (!Number.isInteger(obj.expectedRevision) || obj.expectedRevision < 0) {
    return 'expectedRevision must be a non-negative integer'
  }
  return null
}

// Validates the type-specific key values of a command or event.
function typeValueError(obj) {
  const spec = TYPES[obj.type]
  if (spec.extraKeys.includes('worker') && !isNonEmptyString(obj.worker)) {
    return 'worker must be a non-empty string'
  }
  if (spec.extraKeys.includes('start') && !isUtcIsoTimestamp(obj.start)) {
    return 'start must be a byte-canonical UTC timestamp'
  }
  if (spec.extraKeys.includes('end') && !isUtcIsoTimestamp(obj.end)) {
    return 'end must be a byte-canonical UTC timestamp'
  }
  if (
    spec.extraKeys.includes('start') &&
    spec.extraKeys.includes('end') &&
    Date.parse(obj.end) <= Date.parse(obj.start)
  ) {
    return 'end must be strictly after start'
  }
  if (spec.extraKeys.includes('reason') && !isNonEmptyString(obj.reason)) {
    return 'reason must be a non-empty string'
  }
  if (spec.extraKeys.includes('note') && !isNonEmptyString(obj.note)) {
    return 'note must be a non-empty string'
  }
  return null
}

// Validates a parsed command object exactly against the envelope plus the
// type-specific keys. Returns an error string or null. Unknown types pass the
// envelope checks and are rejected later by the type-support gate, so the
// replay/conflict decision can take precedence over type acceptance.
export function commandError(raw) {
  if (!isPlainObject(raw)) return 'command must be a JSON object'
  if (typeof raw.type !== 'string' || raw.type === '') return 'type must be a non-empty string'
  const envErr = envelopeError(raw)
  if (envErr) return envErr
  const spec = TYPES[raw.type]
  if (!spec) return null
  if (!exactKeysMatch(raw, uniqueKeys(ENVELOPE_KEYS, spec.extraKeys))) {
    return 'command has unexpected or missing keys'
  }
  return typeValueError(raw)
}

// Validates one durable event record. Every event is a full state snapshot:
// the command envelope, the type-specific keys, and the state keys, with
// overlapping keys occurring once. Returns an error string or null.
export function eventError(event) {
  if (!isPlainObject(event)) return 'event must be a JSON object'
  if (typeof event.type !== 'string' || event.type === '') return 'type must be a non-empty string'
  const envErr = envelopeError(event)
  if (envErr) return envErr
  const spec = TYPES[event.type]
  if (!spec) return `unsupported event type: ${event.type}`
  if (!exactKeysMatch(event, uniqueKeys(ENVELOPE_KEYS, spec.extraKeys, STATE_KEYS))) {
    return 'event has unexpected or missing keys'
  }
  const typeErr = typeValueError(event)
  if (typeErr) return typeErr
  if (!Number.isInteger(event.revision) || event.revision < 1) {
    return 'revision must be a positive integer'
  }
  if (!STATUSES.includes(event.status)) return `invalid status: ${event.status}`
  if (!isNonEmptyString(event.worker)) return 'worker must be a non-empty string'
  if (!isUtcIsoTimestamp(event.start)) return 'start must be a byte-canonical UTC timestamp'
  if (!isUtcIsoTimestamp(event.end)) return 'end must be a byte-canonical UTC timestamp'
  if (Date.parse(event.end) <= Date.parse(event.start)) return 'end must be strictly after start'
  if (event.note !== null && !isNonEmptyString(event.note)) return 'note must be null or a non-empty string'
  return null
}

// Throws InputError on the first validation violation of a command.
export function validateCommand(raw) {
  const err = commandError(raw)
  if (err) throw new InputError(err)
  return raw
}
