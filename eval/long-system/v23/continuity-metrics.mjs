const DSH_RUNTIME_CONTEXT_PLUGIN = '@deepseek-ai/dsh-system-prompt'
const PLAN_LATTICE_CONTEXT = 'plan-lattice:execution-state'

const ROOT_WORKFLOW_MARKER = 'Plan Lattice DSH-native workflow:'
const DELEGATED_CAPSULE_MARKER = '## Root-task execution capsule'
const BOUNDARY_RECOVERY_MARKER = 'Plan Lattice native continuity projection:'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isReplacement(event) {
  return event?.surfaceOp !== null
    && typeof event?.surfaceOp === 'object'
    && event.surfaceOp.op === 'replace'
}

function snapshotKind(text) {
  if (text.includes(DELEGATED_CAPSULE_MARKER)) return 'delegated-capsule'
  if (text.includes(ROOT_WORKFLOW_MARKER)) return 'root-workflow'
  if (text.includes(BOUNDARY_RECOVERY_MARKER)) return 'boundary-recovery'
  return 'unknown'
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
  return {
    seq: event.seq,
    bytes: Buffer.byteLength(section.text),
    kind: snapshotKind(section.text),
  }
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

/** Audit RC.9 continuity from persisted DSH Session events only. */
export function analyzeNativeContinuitySessions(sessions, options = {}) {
  invariant(Array.isArray(sessions) && sessions.length > 0, 'continuity metrics require at least one Session')
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024
  invariant(Number.isSafeInteger(maxSnapshotBytes) && maxSnapshotBytes > 0, 'maxSnapshotBytes must be positive')

  const ids = new Set()
  const violations = []
  const reports = []
  for (const session of sessions) {
    validateSession(session)
    invariant(!ids.has(session.header.id), `duplicate Session ${session.header.id}`)
    ids.add(session.header.id)
    const events = ownEvents(session)
    const replacements = events.filter(isReplacement)
    const snapshots = events.map(planLatticeSnapshot).filter(Boolean)
    const delegated = typeof session.header.parentSession === 'string'
    const firstOwnUser = events.find(event => event.type === 'user/message')

    if (delegated && firstOwnUser?.data?.source?.kind !== 'user') {
      violations.push({
        kind: 'child-first-message-not-native-user',
        sessionId: session.header.id,
        firstUserSeq: firstOwnUser?.seq ?? null,
      })
    }

    for (const snapshot of snapshots) {
      if (snapshot.bytes > maxSnapshotBytes) {
        violations.push({
          kind: 'snapshot-byte-bound-exceeded',
          sessionId: session.header.id,
          snapshotSeq: snapshot.seq,
          bytes: snapshot.bytes,
          limit: maxSnapshotBytes,
        })
      }
      if (snapshot.kind === 'unknown') {
        violations.push({ kind: 'unknown-plan-lattice-snapshot', sessionId: session.header.id, snapshotSeq: snapshot.seq })
      }
      if (!delegated && snapshot.kind === 'delegated-capsule') {
        violations.push({ kind: 'delegated-capsule-in-root', sessionId: session.header.id, snapshotSeq: snapshot.seq })
      }
      if (delegated && snapshot.kind === 'root-workflow') {
        violations.push({ kind: 'root-workflow-in-child', sessionId: session.header.id, snapshotSeq: snapshot.seq })
      }
      if (delegated && snapshot.kind === 'delegated-capsule'
        && (firstOwnUser === undefined || snapshot.seq <= firstOwnUser.seq)) {
        violations.push({ kind: 'capsule-precedes-native-child-prompt', sessionId: session.header.id, snapshotSeq: snapshot.seq })
      }
    }

    const workflowSnapshots = snapshots.filter(snapshot => snapshot.kind === 'root-workflow')
    const delegatedCapsules = snapshots.filter(snapshot => snapshot.kind === 'delegated-capsule')
    const boundaryRecoveries = snapshots.filter(snapshot => snapshot.kind === 'boundary-recovery')
    if (delegated && delegatedCapsules.length > 1) {
      violations.push({
        kind: 'duplicate-delegated-capsule',
        sessionId: session.header.id,
        snapshotSeqs: delegatedCapsules.map(snapshot => snapshot.seq),
      })
    }

    reports.push({
      sessionId: session.header.id,
      parentSession: session.header.parentSession ?? null,
      seedLength: session.header.seedLength ?? 0,
      ownReplacements: replacements.map(event => event.seq),
      workflowSnapshots: workflowSnapshots.map(snapshot => ({ seq: snapshot.seq, bytes: snapshot.bytes })),
      delegatedCapsules: delegatedCapsules.map(snapshot => ({ seq: snapshot.seq, bytes: snapshot.bytes })),
      boundaryRecoveries: boundaryRecoveries.map(snapshot => ({ seq: snapshot.seq, bytes: snapshot.bytes })),
      firstOwnUserSource: firstOwnUser?.data?.source?.kind ?? null,
    })
  }

  const allSnapshots = reports.flatMap(report => [
    ...report.workflowSnapshots,
    ...report.delegatedCapsules,
    ...report.boundaryRecoveries,
  ])
  return {
    valid: violations.length === 0,
    maxSnapshotBytes,
    totalOwnReplacements: reports.reduce((sum, report) => sum + report.ownReplacements.length, 0),
    totalSnapshots: allSnapshots.length,
    totalWorkflowSnapshots: reports.reduce((sum, report) => sum + report.workflowSnapshots.length, 0),
    totalDelegatedCapsules: reports.reduce((sum, report) => sum + report.delegatedCapsules.length, 0),
    totalBoundaryRecoveries: reports.reduce((sum, report) => sum + report.boundaryRecoveries.length, 0),
    totalSnapshotBytes: allSnapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0),
    maximumObservedSnapshotBytes: Math.max(0, ...allSnapshots.map(snapshot => snapshot.bytes)),
    sessions: reports,
    violations,
  }
}
