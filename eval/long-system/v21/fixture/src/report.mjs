import { StateError } from './errors.mjs'
import { latestEventForDuty } from './domain.mjs'

// `get` projection: exactly id, worker, start, end, status, revision, note
// (JSON null when the duty has no note). Unknown duty is a state rejection.
export function formatGet(events, dutyId) {
  const latest = latestEventForDuty(events, dutyId)
  if (!latest) throw new StateError(`duty not found: ${dutyId}`)
  return {
    id: latest.dutyId,
    worker: latest.worker,
    start: latest.start,
    end: latest.end,
    status: latest.status,
    revision: latest.revision,
    note: latest.note ?? null,
  }
}
