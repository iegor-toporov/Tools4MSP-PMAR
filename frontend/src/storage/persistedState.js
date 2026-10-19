/**
 * Cosa del pannello delle analisi si conserva fra una ricarica e l'altra, e come lo
 * si rilegge senza fidarsi: il contenuto viene dal browser, può essere di una
 * versione precedente dell'app o di job ormai scaduti.
 *
 * - `analyses`: le analisi completate, coi loro dati e la loro vista;
 * - `activeAnalysisId`;
 * - `pendingJobs`: analisi inviate e non ancora finite, da riprendere all'avvio.
 *
 * Modulo puro (niente IndexedDB, niente React): testato in persistedState.test.js.
 * La lettura e la scrittura vere sono in analysesStore.js.
 */

export const STATE_VERSION = 1

/** I job restano in Redis 7 giorni (worker/tasks.py `_TTL`): oltre, non c'è più niente da riprendere. */
export const PENDING_MAX_AGE_MS = 7 * 24 * 3600 * 1000

const KINDS = new Set(['pmar', 'connectivity', 'markov'])

export function toStored({ analyses, activeAnalysisId, pendingJobs }, { max, now = Date.now() }) {
  return {
    version: STATE_VERSION,
    savedAt: now,
    analyses: analyses.slice(0, max),
    activeAnalysisId,
    pendingJobs,
  }
}

const isAnalysis = a => a && typeof a.id === 'string' && KINDS.has(a.kind) &&
                        a.data && typeof a.data === 'object'
const isPendingJob = j => j && typeof j.jobId === 'string' && KINDS.has(j.kind)

/**
 * Stato ricaricato, ripulito. Senza niente di valido: tutto vuoto.
 * @param {object} defaultView  vista di default: completa le viste salvate da versioni
 *                              che avevano meno campi
 */
export function fromStored(raw, { max, defaultView = {}, now = Date.now() }) {
  const empty = { analyses: [], activeAnalysisId: null, pendingJobs: [] }
  if (!raw || raw.version !== STATE_VERSION) return empty

  const analyses = (Array.isArray(raw.analyses) ? raw.analyses : [])
    .filter(isAnalysis)
    .slice(0, max)
    .map(a => ({ ...a, title: a.title ?? '', view: { ...defaultView, ...(a.view ?? {}) } }))
  const ids = new Set(analyses.map(a => a.id))
  const activeAnalysisId = ids.has(raw.activeAnalysisId) ? raw.activeAnalysisId : (analyses[0]?.id ?? null)

  const pendingJobs = (Array.isArray(raw.pendingJobs) ? raw.pendingJobs : [])
    .filter(isPendingJob)
    .filter(j => !(j.submittedAt && now - j.submittedAt > PENDING_MAX_AGE_MS))
  return { analyses, activeAnalysisId, pendingJobs }
}

/** Analisi già presenti (aggiunte prima che lo stato salvato fosse letto) più quelle salvate. */
export function mergeAnalyses(current, stored, max) {
  const ids = new Set(current.map(a => a.id))
  return [...current, ...stored.filter(a => !ids.has(a.id))].slice(0, max)
}
