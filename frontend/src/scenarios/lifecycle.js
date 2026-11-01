/**
 * Life cycle of the simulations as `scenario_status` reports it
 * (see processes/scenario_state.py): `queued` → `running` → `ready` | `failed`.
 *
 * The state lives on the server, not in the page: after a reload, or on another tab
 * or device, the list is the same. Here the module derives what to show and which
 * notifications to give between one poll and the next.
 *
 * Pure module (no React, no DOM): tested in lifecycle.test.js.
 */

export const Status = {
  QUEUED:  'queued',
  RUNNING: 'running',
  READY:   'ready',
  FAILED:  'failed',
}

/** How often to read the list again while something is queued or running. */
export const POLL_INTERVAL_MS = 5000

export const isActive = st => st === Status.QUEUED || st === Status.RUNNING

/** State of a scenario; a backend without `state` gives only `computed`. */
export function statusOf(info) {
  return info.state ?? (info.computed ? Status.READY : Status.FAILED)
}

export function anyActive(statuses) {
  return Object.values(statuses).some(sc => isActive(sc.status))
}

/**
 * State changes between two readings of the list, for the notifications.
 * Only scenarios that were active count: at the first reading (`prev` null) nothing is
 * notified, but a simulation that finishes after a reload is.
 * An active scenario that disappears was cancelled (Stop).
 *
 * @returns {{id: string, to: string}[]} `to` is `ready`, `failed` or `removed`
 */
export function transitions(prev, next) {
  if (!prev) return []
  const out = []
  for (const [id, before] of Object.entries(prev)) {
    if (!isActive(before.status)) continue
    const after = next[id]
    if (!after) out.push({ id, to: 'removed' })
    else if (after.status === Status.READY || after.status === Status.FAILED) out.push({ id, to: after.status })
  }
  return out
}

/** Whole minutes elapsed since an ISO timestamp, or null. */
export function minutesSince(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : null
}

/**
 * Short text of the state, for the list and the box of running simulations.
 * @param {object} s  texts: statusReady, statusFailed, statusQueued ({n}),
 *                    statusRunning, statusRunningSeeding ({n}, {total})
 */
export function statusText(sc, s) {
  switch (sc.status) {
    case Status.QUEUED:
      return sc.queue_position ? s.statusQueued.replace('{n}', sc.queue_position) : s.statusQueuedPlain
    case Status.RUNNING: {
      const total = sc.progress?.total ?? sc.seedings ?? 1
      if (total > 1) {
        const n = Math.min((sc.progress?.done ?? 0) + 1, total)
        return s.statusRunningSeeding.replace('{n}', n).replace('{total}', total)
      }
      return s.statusRunning
    }
    case Status.FAILED:
      return s.statusFailed
    default:
      return s.statusReady
  }
}

// Messages written by the backend itself (scenario_state.py): they are translated. The
// others (OpenDrift, CMEMS…) stay as they are, because they are the technical cause.
const KNOWN_ERRORS = {
  'interrupted (worker restart)':              'interrupted',
  'incomplete (created before job tracking)':  'incomplete',
  'job lost (no record in the queue)':         'lost',
}

/** Error message to show; `e` = texts { interrupted, incomplete, lost, unknown }. */
export function errorText(error, e) {
  if (!error) return e.unknown
  const key = KNOWN_ERRORS[error]
  return key ? e[key] : error
}
