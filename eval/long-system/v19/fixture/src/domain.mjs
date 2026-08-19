import { AuthError, InputError, StateError } from './errors.mjs'

// Returns the latest accepted event for a duty (events are appended in
// acceptance order, so the last occurrence is the newest state snapshot).
export function latestEventForDuty(events, dutyId) {
  let latest = null
  for (const event of events) {
    if (event.dutyId === dutyId) latest = event
  }
  return latest
}

// Transition registry. Each type declares the roles allowed to issue it,
// whether it creates a new duty, the source statuses it may leave, and how it
// derives the next event's state. checkin/checkout land in later milestones.
const TRANSITIONS = {
  open: {
    roles: ['dispatcher'],
    creates: true,
    apply(command) {
      return {
        revision: 1,
        status: 'planned',
        worker: command.worker,
        start: command.start,
        end: command.end,
        note: null,
      }
    },
  },
}

// Evaluates a validated command against the current log.
//   - Authorization failures (wrong role, wrong worker identity) -> exit 4
//   - State / optimistic-concurrency rejections                  -> exit 3
// Returns the full event record to persist on acceptance.
export function evaluateCommand(events, command) {
  const transition = TRANSITIONS[command.type]
  if (!transition) throw new InputError(`unsupported command type: ${command.type}`)

  const current = latestEventForDuty(events, command.dutyId)

  // Authorization.
  if (!transition.roles.includes(command.actor.role)) {
    throw new AuthError(`${command.type} requires role: ${transition.roles.join(' or ')}`)
  }
  if (!transition.creates && current && command.actor.id !== current.worker) {
    throw new AuthError('worker actor id must equal the duty worker')
  }

  // State and optimistic concurrency.
  if (transition.creates) {
    if (current) throw new StateError(`duty already exists: ${command.dutyId}`)
    if (command.expectedRevision !== 0) throw new StateError('open requires expectedRevision 0')
  } else {
    if (!current) throw new StateError(`duty does not exist: ${command.dutyId}`)
    if (current.revision !== command.expectedRevision) {
      throw new StateError('expectedRevision does not match current revision')
    }
    if (transition.allowedFrom && !transition.allowedFrom.includes(current.status)) {
      throw new StateError(`cannot transition duty from status: ${current.status}`)
    }
    if (Date.parse(command.at) < Date.parse(current.at)) {
      throw new StateError('command timestamp is older than the duty latest accepted event')
    }
  }

  const next = transition.apply(command, current)
  return { ...command, ...next }
}
