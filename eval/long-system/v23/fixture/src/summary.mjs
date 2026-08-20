// `summary` projection: the state of every duty at a fixed instant, derived by
// replaying the accepted log in its stored order.
//
// Only events whose `at` is <= the instant qualify (an event exactly at the
// instant is included; strictly after is excluded). For each duty the LAST
// qualifying event wins, so when several events share the same `at` the
// later-accepted one (later position in the log) defines the status.
export function formatSummary(events, at) {
  const instant = Date.parse(at)
  const latestByDuty = new Map()
  for (const event of events) {
    if (Date.parse(event.at) > instant) continue
    latestByDuty.set(event.dutyId, event)
  }

  let planned = 0
  let active = 0
  let paused = 0
  let completed = 0
  const activeIds = []
  const pausedIds = []
  for (const event of latestByDuty.values()) {
    if (event.status === 'planned') {
      planned += 1
    } else if (event.status === 'active') {
      active += 1
      activeIds.push(event.dutyId)
    } else if (event.status === 'paused') {
      paused += 1
      pausedIds.push(event.dutyId)
    } else if (event.status === 'completed') {
      completed += 1
    }
  }
  activeIds.sort()
  pausedIds.sort()

  return {
    at,
    planned,
    active,
    paused,
    completed,
    activeDutyIds: activeIds,
    pausedDutyIds: pausedIds,
  }
}
