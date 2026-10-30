/**
 * Calendario dei rilasci di una simulazione multi seeding: il rilascio n parte
 * `tshift × n` giorni dopo la data di inizio e dura `duration` giorni, come in
 * PrecomputeProcess. Gli stessi limiti del backend: da 2 a 12 rilasci, uno
 * sfasamento da 1 a 365 giorni.
 *
 * Le date sono in UTC, così il calendario non dipende dal fuso del browser.
 *
 * Modulo puro: testato in releases.test.js.
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
 * Un elemento per rilascio: `{ n, start, end }`, con `start` e `end` Date UTC.
 * Restituisce [] se la data di inizio non è valida.
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

/** Data breve nel formato della lingua, senza spostamenti di fuso. */
export function formatDay(date, locale) {
  return date.toLocaleDateString(locale, {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
  })
}
