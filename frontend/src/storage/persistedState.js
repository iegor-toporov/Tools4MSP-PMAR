/**
 * What of the analysis panel is kept from one reload to the next, and how it is read
 * back without trusting it: the content comes from the browser, and may belong to an
 * earlier version of the app or to jobs that have expired.
 *
 * - `analyses`: the completed analyses, with their data and their view;
 * - `activeAnalysisId`;
 * - `pendingJobs`: analyses submitted and not yet finished, to resume at start.
 *
 * Pure module (no IndexedDB, no React): tested in persistedState.test.js.
 * The actual reading and writing are in analysesStore.js.
 */

export const STATE_VERSION = 1

/** Jobs stay in Redis for 7 days (worker/tasks.py `_TTL`): after that, there is nothing to resume. */
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
 * Reloaded state, cleaned up. With nothing valid: everything empty.
 * @param {object} defaultView  default view: completes saved views that have fewer
 *                              fields
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

/** Analyses already present (added before the saved state was read) plus the saved ones. */
export function mergeAnalyses(current, stored, max) {
  const ids = new Set(current.map(a => a.id))
  return [...current, ...stored.filter(a => !ids.has(a.id))].slice(0, max)
}
