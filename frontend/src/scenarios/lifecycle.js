/**
 * Ciclo di vita delle simulazioni come lo riporta `scenario_status`
 * (vedi processes/scenario_state.py): `queued` → `running` → `ready` | `failed`.
 *
 * Lo stato vive sul server, non nella pagina: ricaricando, cambiando scheda o
 * dispositivo si ritrova lo stesso elenco. Qui si ricava cosa mostrare e quali
 * notifiche dare fra un polling e il successivo.
 *
 * Modulo puro (niente React, niente DOM): testato in lifecycle.test.js.
 */

export const Status = {
  QUEUED:  'queued',
  RUNNING: 'running',
  READY:   'ready',
  FAILED:  'failed',
}

/** Ogni quanto rileggere l'elenco mentre qualcosa è in coda o in calcolo. */
export const POLL_INTERVAL_MS = 5000

export const isActive = st => st === Status.QUEUED || st === Status.RUNNING

/** Stato di uno scenario; un backend vecchio, senza `state`, dà solo `computed`. */
export function statusOf(info) {
  return info.state ?? (info.computed ? Status.READY : Status.FAILED)
}

export function anyActive(statuses) {
  return Object.values(statuses).some(sc => isActive(sc.status))
}

/**
 * Cambi di stato fra due letture dell'elenco, per le notifiche.
 * Contano solo gli scenari che erano attivi: alla prima lettura (`prev` null) non si
 * notifica niente, ma una simulazione che finisce dopo una ricarica sì.
 * Uno scenario attivo che sparisce è stato annullato (Stop).
 *
 * @returns {{id: string, to: string}[]} `to` è `ready`, `failed` o `removed`
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

/** Minuti interi trascorsi da un timestamp ISO, o null. */
export function minutesSince(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : null
}

/**
 * Testo breve dello stato, per l'elenco e il riquadro delle simulazioni in corso.
 * @param {object} s  testi: statusReady, statusFailed, statusQueued ({n}),
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

// Messaggi che scrive il backend stesso (scenario_state.py): si traducono. Gli altri
// (OpenDrift, CMEMS…) restano come sono, perché sono la spiegazione tecnica.
const KNOWN_ERRORS = {
  'interrupted (worker restart)':              'interrupted',
  'incomplete (created before job tracking)':  'incomplete',
  'job lost (no record in the queue)':         'lost',
}

/** Messaggio d'errore da mostrare; `e` = testi { interrupted, incomplete, lost, unknown }. */
export function errorText(error, e) {
  if (!error) return e.unknown
  const key = KNOWN_ERRORS[error]
  return key ? e[key] : error
}
