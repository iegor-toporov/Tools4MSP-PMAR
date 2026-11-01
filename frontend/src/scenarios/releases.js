/**
 * Schedule of the releases of a simulation with several releases: release n starts
 * `tshift × n` days after the start date and lasts `duration` days, as in
 * PrecomputeProcess. The same limits as the backend: 2 to 12 releases, a shift of 1 to
 * 365 days.
 *
 * Dates are in UTC, so the schedule does not depend on the browser's time zone.
 *
 * Pure module: tested in releases.test.js.
 */

export const MIN_RELEASES = 2
export const MAX_RELEASES = 12

const clamp = (v, lo, hi, fallback) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? Math.max(lo, Math.min(n, hi)) : fallback
}

function addDays(date, days) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

/**
 * One element per release: `{ n, start, end }`, with `start` and `end` UTC Dates.
 * Returns [] if the start date is not valid.
 */
export function releaseSchedule(startDate, duration, releases, shift) {
  const t0 = new Date(`${startDate}T00:00:00Z`)
  if (Number.isNaN(t0.getTime())) return []
  const days  = clamp(duration, 1, 730, 1)
  const count = clamp(releases, MIN_RELEASES, MAX_RELEASES, MIN_RELEASES)
  const step  = clamp(shift, 1, 365, 30)
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(t0, step * i)
    return { n: i + 1, start, end: addDays(start, days) }
  })
}

/** Short date in the format of the language, without time-zone shifts. */
export function formatDay(date, locale) {
  return date.toLocaleDateString(locale, {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
  })
}
