import { readFile } from 'node:fs/promises'
import { validateResultRecord } from './validation.mjs'
import { verifyResultChain } from './attempt-integrity.mjs'

export async function readJsonLines(path, { validate = true } = {}) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const value = JSON.parse(line)
      if (validate) validateResultRecord(value)
      return value
    } catch (error) {
      throw new Error(`invalid JSONL record on line ${index + 1}: ${error.message}`)
    }
  })
}

export function resolveEvaluationSlots(records, manifest, retryPolicy) {
  const errors = [...verifyResultChain(records)]
  const attemptsByRun = new Map()
  const knownRuns = new Map(
    [...manifest.infrastructureRuns, ...manifest.statisticalRuns].map((run) => [run.runId, run]),
  )
  const attemptIds = new Set()
  for (const record of records) {
    if (attemptIds.has(record.attemptId)) errors.push(`duplicate attemptId ${record.attemptId}`)
    attemptIds.add(record.attemptId)
    const expected = knownRuns.get(record.runId)
    if (!expected) errors.push(`unknown runId ${record.runId}`)
    if (expected && record.phase !== expected.phase) errors.push(`phase mismatch for ${record.attemptId}`)
    if (expected && record.suite !== expected.suite) errors.push(`suite mismatch for ${record.attemptId}`)
    if (expected && record.armId !== expected.arm.id) errors.push(`arm mismatch for ${record.attemptId}`)
    if (record.manifestDigest !== manifest.manifestDigest) errors.push(`manifest digest mismatch for ${record.attemptId}`)
    const group = attemptsByRun.get(record.runId) ?? []
    group.push(record)
    attemptsByRun.set(record.runId, group)
  }

  const resolvedByPhase = { infrastructure: new Map(), statistical: new Map() }
  for (const run of [...manifest.infrastructureRuns, ...manifest.statisticalRuns]) {
    const attempts = [...(attemptsByRun.get(run.runId) ?? [])].sort((left, right) => left.attempt - right.attempt)
    if (attempts.length === 0) continue
    for (let index = 0; index < attempts.length; index += 1) {
      const current = attempts[index]
      if (current.attempt !== index + 1) errors.push(`${run.runId} attempt sequence is not contiguous`)
      if (index === 0) {
        if (current.rerunOfAttemptId) errors.push(`first attempt ${current.attemptId} cannot be a rerun`)
        continue
      }
      const previous = attempts[index - 1]
      const allowed = previous.status === 'failed'
        && previous.failure?.classification === 'infrastructure'
        && retryPolicy.allowedInfrastructureCodes.includes(previous.failure.code)
        && current.rerunOfAttemptId === previous.attemptId
      if (!allowed) errors.push(`unauthorized rerun ${current.attemptId} for ${run.runId}`)
    }
    const final = attempts.at(-1)
    if (final.status === 'failed' && final.failure?.classification === 'infrastructure') continue
    if (run.phase === 'infrastructure' && final.status !== 'completed') continue
    resolvedByPhase[run.phase].set(run.runId, final)
  }

  return {
    errors,
    infrastructure: {
      resolved: resolvedByPhase.infrastructure,
      missingRunIds: manifest.infrastructureRuns.filter((run) => !resolvedByPhase.infrastructure.has(run.runId)).map((run) => run.runId),
    },
    statistical: {
      resolved: resolvedByPhase.statistical,
      missingRunIds: manifest.statisticalRuns.filter((run) => !resolvedByPhase.statistical.has(run.runId)).map((run) => run.runId),
    },
    retainedAttemptCount: records.length,
  }
}

export function resolveStatisticalSlots(records, manifest, retryPolicy) {
  const state = resolveEvaluationSlots(records, manifest, retryPolicy)
  return {
    errors: state.errors,
    resolved: state.statistical.resolved,
    missingRunIds: state.statistical.missingRunIds,
    retainedAttemptCount: state.retainedAttemptCount,
  }
}
