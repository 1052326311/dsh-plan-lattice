import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const mutants = [
  {
    id: 'open-wrong-initial-status',
    targetCheck: 'open exact success',
    file: 'src/domain.mjs',
    from: "revision: 1,\n        status: 'planned',\n        worker: command.worker,",
    to: "revision: 1,\n        status: 'active',\n        worker: command.worker,",
  },
  {
    id: 'get-wrong-duty-id',
    targetCheck: 'get exact projection',
    file: 'src/report.mjs',
    from: 'id: latest.dutyId,',
    to: "id: `${latest.dutyId}-mutated`,",
  },
  {
    id: 'timestamp-accepts-noncanonical-instants',
    targetCheck: 'timestamps require exact millisecond Z form',
    file: 'src/validate.mjs',
    from: `export function isUtcIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return false
  return new Date(ms).toISOString() === value
}`,
    to: `export function isUtcIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}`,
  },
  {
    id: 'durable-event-extra-key',
    targetCheck: 'durable event has exact shape and final LF',
    file: 'src/domain.mjs',
    from: 'return { ...command, ...next }',
    to: 'return { ...command, ...next, extra: true }',
  },
  {
    id: 'accepted-replay-appends-duplicate',
    targetCheck: 'accepted replay is byte stable',
    file: 'src/cli.mjs',
    from: `if (spec && commandContentEquals(prior, raw)) {
      return {`,
    to: `if (spec && commandContentEquals(prior, raw)) {
      await appendEvents(values.store, events, [prior])
      return {`,
  },
  {
    id: 'command-id-conflict-mutates-store',
    targetCheck: 'global commandId conflict is byte stable',
    file: 'src/cli.mjs',
    from: "throw new StateError('commandId already used with different content')",
    to: "await appendEvents(values.store, events, [prior])\n    throw new StateError('commandId already used with different content')",
  },
  {
    id: 'malformed-event-extra-key-accepted',
    targetCheck: 'malformed durable state is rejected without repair',
    file: 'src/validate.mjs',
    from: `if (!exactKeysMatch(event, uniqueKeys(ENVELOPE_KEYS, spec.extraKeys, STATE_KEYS))) {
    return 'event has unexpected or missing keys'
  }`,
    to: `if (!exactKeysMatch(event, uniqueKeys(ENVELOPE_KEYS, spec.extraKeys, STATE_KEYS))) {
    // Mutant: silently accepts non-exact durable events.
  }`,
  },
  {
    id: 'missing-store-query-creates-file',
    targetCheck: 'missing-store queries stay read only',
    file: 'src/store.mjs',
    from: "if (err && err.code === 'ENOENT') return []",
    to: `if (err && err.code === 'ENOENT') {
      await appendEvents(storePath, [], [])
      return []
    }`,
  },
  {
    id: 'dispatcher-can-checkin',
    targetCheck: 'worker role boundary is atomic',
    file: 'src/domain.mjs',
    from: "roles: ['worker'],\n    allowedFrom: ['planned'],",
    to: "roles: ['worker', 'dispatcher'],\n    allowedFrom: ['planned'],",
  },
  {
    id: 'checkin-enters-paused',
    targetCheck: 'checkin transition',
    file: 'src/domain.mjs',
    from: `checkin: {
    roles: ['worker'],
    allowedFrom: ['planned'],
    apply(command, current) {
      return {
        ...carryWindow(current),
        revision: current.revision + 1,
        status: 'active',`,
    to: `checkin: {
    roles: ['worker'],
    allowedFrom: ['planned'],
    apply(command, current) {
      return {
        ...carryWindow(current),
        revision: current.revision + 1,
        status: 'paused',`,
  },
  {
    id: 'pause-drops-reason',
    targetCheck: 'pause preserves reason',
    file: 'src/domain.mjs',
    from: 'status: \'paused\',\n        note: command.reason,',
    to: "status: 'paused',\n        note: null,",
  },
  {
    id: 'resume-remains-open-for-new-commands',
    targetCheck: 'new checkout and resume are retired',
    file: 'src/validate.mjs',
    from: 'resume: { extraKeys: [], supported: false },',
    to: 'resume: { extraKeys: [], supported: true },',
  },
  {
    id: 'retired-events-rejected-on-read',
    targetCheck: 'retired durable events remain readable',
    file: 'src/validate.mjs',
    from: `const spec = TYPES[event.type]
  if (!spec) return \`unsupported event type: ${'${event.type}'}\`
  if (!exactKeysMatch(event, uniqueKeys(ENVELOPE_KEYS, spec.extraKeys, STATE_KEYS))) {`,
    to: `const spec = TYPES[event.type]
  if (!spec) return \`unsupported event type: ${'${event.type}'}\`
  if (!spec.supported) return \`retired event type: ${'${event.type}'}\`
  if (!exactKeysMatch(event, uniqueKeys(ENVELOPE_KEYS, spec.extraKeys, STATE_KEYS))) {`,
  },
  {
    id: 'retirement-gate-precedes-idempotency',
    targetCheck: 'retired replay precedes retirement validation',
    file: 'src/cli.mjs',
    from: `const spec = TYPES[raw.type]
  const prior = events.find((e) => e.commandId === raw.commandId)`,
    to: `const spec = TYPES[raw.type]
  if (!spec || !spec.supported) throw new InputError(\`unsupported command type: ${'${raw.type}'}\`)
  const prior = events.find((e) => e.commandId === raw.commandId)`,
  },
  {
    id: 'adjust-start-invalid-window-is-state-error',
    targetCheck: 'adjust-start replaces start and classifies start >= end as atomic input failure',
    file: 'src/domain.mjs',
    from: "throw new InputError('start must be strictly before end')",
    to: "throw new StateError('start must be strictly before end')",
  },
  {
    id: 'reassign-leaves-old-worker-authorized',
    targetCheck: 'reassign rejects old worker byte-stably before accepting new worker mutation',
    file: 'src/domain.mjs',
    from: `if (!transition.creates && current && command.actor.role === 'worker' && command.actor.id !== current.worker) {
    throw new AuthError('worker actor id must equal the duty worker')
  }`,
    to: `if (false) {
    throw new AuthError('worker actor id must equal the duty worker')
  }`,
  },
  {
    id: 'summary-ignores-reassign-events',
    targetCheck: 'historical summary preserves material revision',
    file: 'src/summary.mjs',
    from: `for (const event of events) {
    if (Date.parse(event.at) > instant) continue`,
    to: `for (const event of events) {
    if (event.type === 'reassign') continue
    if (Date.parse(event.at) > instant) continue`,
  },
  {
    id: 'summary-excludes-equal-timestamps',
    targetCheck: 'summary uses per-duty time and accepted tie order',
    file: 'src/summary.mjs',
    from: 'if (Date.parse(event.at) > instant) continue',
    to: 'if (Date.parse(event.at) >= instant) continue',
  },
  {
    id: 'paused-summary-ids-unsorted',
    targetCheck: 'summary arrays are exact sorted and read only',
    file: 'src/summary.mjs',
    from: 'pausedIds.sort()',
    to: '// Mutant: paused ids retain acceptance order.',
  },
]

export async function applyMutant(workspace, mutant) {
  const file = join(workspace, mutant.file)
  const source = await readFile(file, 'utf8')
  const first = source.indexOf(mutant.from)
  const last = source.lastIndexOf(mutant.from)
  if (first === -1) throw new Error(`${mutant.id}: mutation source not found in ${mutant.file}`)
  if (first !== last) throw new Error(`${mutant.id}: mutation source is not unique in ${mutant.file}`)
  await writeFile(file, source.replace(mutant.from, mutant.to), 'utf8')
}
