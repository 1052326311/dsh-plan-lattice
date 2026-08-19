const DSH_RUNTIME_CONTEXT_PLUGIN = '@deepseek-ai/dsh-system-prompt'
const PLAN_LATTICE_CONTEXT = 'plan-lattice:execution-state'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isReplacement(event) {
  return event?.surfaceOp !== null
    && typeof event?.surfaceOp === 'object'
    && event.surfaceOp.op === 'replace'
}

function planLatticeSnapshot(event) {
  if (event?.type !== 'user/message') return undefined
  const source = event.data?.source
  if (source?.kind !== 'plugin'
    || source.plugin !== DSH_RUNTIME_CONTEXT_PLUGIN
    || source.form !== 'snapshot'
    || !Array.isArray(source.sections)) return undefined
  const matches = source.sections.filter(section => section?.name === PLAN_LATTICE_CONTEXT)
  invariant(matches.length <= 1, `Session event ${event.seq} repeats the Plan Lattice runtime-context section`)
  const section = matches[0]
  if (section === undefined || section.text === '') return undefined
  invariant(typeof section.text === 'string', `Session event ${event.seq} has a malformed Plan Lattice context`)
  return { seq: event.seq, bytes: Buffer.byteLength(section.text), text: section.text }
}

function ownEvents(session) {
  const seedLength = session.header.seedLength ?? 0
  invariant(Number.isSafeInteger(seedLength) && seedLength >= 0 && seedLength <= session.events.length,
    `Session ${session.header.id} has an invalid seedLength`)
  return session.events.slice(seedLength)
}

function validateSession(session) {
  invariant(session && typeof session === 'object', 'continuity metrics require Session objects')
  invariant(typeof session.header?.id === 'string' && session.header.id.length > 0, 'Session has no stable id')
  invariant(Array.isArray(session.events), `Session ${session.header.id} has no event log`)
  for (const [index, event] of session.events.entries()) {
    invariant(event && typeof event === 'object'
      && Number.isSafeInteger(event.seq)
      && event.seq === index,
    `Session ${session.header.id} has a malformed or non-contiguous event at index ${index}`)
  }
}

/**
 * Audit only DSH-native continuity behavior. The evaluator does not infer task
 * meaning and does not treat a private graph or contract as lifecycle proof.
 */
export function analyzeNativeContinuitySessions(sessions, options = {}) {
  invariant(Array.isArray(sessions) && sessions.length > 0, 'continuity metrics require at least one Session')
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024
  invariant(Number.isSafeInteger(maxSnapshotBytes) && maxSnapshotBytes > 0, 'maxSnapshotBytes must be positive')
  const ids = new Set()
  const violations = []
  const reports = []
  let totalSnapshots = 0
  let totalSnapshotBytes = 0
  let totalOwnReplacements = 0

  for (const session of sessions) {
    validateSession(session)
    invariant(!ids.has(session.header.id), `duplicate Session ${session.header.id}`)
    ids.add(session.header.id)
    const events = ownEvents(session)
    const replacements = events.filter(isReplacement)
    const snapshots = events.map(planLatticeSnapshot).filter(Boolean)
    const snapshotsByReplacement = new Map()

    for (const snapshot of snapshots) {
      const replacement = replacements.filter(event => event.seq < snapshot.seq).at(-1)
      if (replacement === undefined) {
        violations.push({
          kind: 'snapshot-without-own-replacement',
          sessionId: session.header.id,
          snapshotSeq: snapshot.seq,
        })
      } else {
        const count = (snapshotsByReplacement.get(replacement.seq) ?? 0) + 1
        snapshotsByReplacement.set(replacement.seq, count)
        if (count > 1) {
          violations.push({
            kind: 'duplicate-snapshot-for-replacement',
            sessionId: session.header.id,
            replacementSeq: replacement.seq,
            snapshotSeq: snapshot.seq,
          })
        }
      }
      if (snapshot.bytes > maxSnapshotBytes) {
        violations.push({
          kind: 'snapshot-byte-bound-exceeded',
          sessionId: session.header.id,
          snapshotSeq: snapshot.seq,
          bytes: snapshot.bytes,
          limit: maxSnapshotBytes,
        })
      }
    }

    const delegated = typeof session.header.parentSession === 'string'
    const firstOwnUser = events.find(event => event.type === 'user/message')
    const firstOwnReplacement = replacements[0]
    const freshChildSnapshots = delegated
      ? snapshots.filter(snapshot => firstOwnReplacement === undefined || snapshot.seq < firstOwnReplacement.seq)
      : []
    if (delegated && firstOwnUser?.data?.source?.kind !== 'user') {
      violations.push({
        kind: 'child-first-message-not-native-user',
        sessionId: session.header.id,
        firstUserSeq: firstOwnUser?.seq ?? null,
      })
    }
    for (const snapshot of freshChildSnapshots) {
      violations.push({
        kind: 'fresh-child-injection',
        sessionId: session.header.id,
        snapshotSeq: snapshot.seq,
      })
    }

    totalSnapshots += snapshots.length
    totalSnapshotBytes += snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0)
    totalOwnReplacements += replacements.length
    reports.push({
      sessionId: session.header.id,
      parentSession: session.header.parentSession ?? null,
      seedLength: session.header.seedLength ?? 0,
      ownReplacements: replacements.map(event => event.seq),
      continuitySnapshots: snapshots.map(snapshot => ({ seq: snapshot.seq, bytes: snapshot.bytes })),
      firstOwnUserSource: firstOwnUser?.data?.source?.kind ?? null,
    })
  }

  return {
    valid: violations.length === 0,
    maxSnapshotBytes,
    totalOwnReplacements,
    totalSnapshots,
    totalSnapshotBytes,
    maximumObservedSnapshotBytes: Math.max(0, ...reports.flatMap(report =>
      report.continuitySnapshots.map(snapshot => snapshot.bytes))),
    sessions: reports,
    violations,
  }
}

