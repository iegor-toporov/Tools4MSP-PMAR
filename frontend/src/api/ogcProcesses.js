/**
 * Client for the OGC API - Processes endpoints exposed by the pygeoapi backend.
 *
 * This module deliberately depends on nothing but the Fetch API: no React, no UI
 * library, no i18n. It returns structured data and throws structured errors, so
 * that every presentation decision (which message to show, in which language,
 * where to put the result) stays with the caller.
 */

/** Process identifiers served by the backend, as declared in pygeoapi-config.yml. */
export const Process = {
  OPENDRIFT:              'opendrift',
  PMAR:                   'pmar',
  PRECOMPUTE:             'precompute',
  SCENARIO_STATUS:        'scenario_status',
  WINDFARMS:              'windfarms',
  OFFSHORE_INSTALLATIONS: 'offshore_installations',
  MSP_ZONES:              'msp_zones',
  NATURA2000:             'natura2000',
}

/** Stable error identifiers. The UI maps these to localized text, never the reverse. */
export const ErrorCode = {
  HTTP:       'HTTP_ERROR',  // backend answered with a non-2xx status
  JOB_FAILED: 'JOB_FAILED',  // async job reached status "failed"
}

/**
 * Terminal states of an async job.
 *
 * `DISMISSED` is the state a job reaches after the user presses STOP; it is a
 * legitimate outcome of waiting, not a failure, and is therefore returned rather
 * than thrown.
 */
export const JobOutcome = {
  SUCCESS:   'successful',
  DISMISSED: 'dismissed',
}

export class OgcError extends Error {
  /**
   * @param {string}  code              one of {@link ErrorCode}
   * @param {?string} options.detail    text supplied by the backend, or null when it
   *                                    offered nothing beyond the status code — in that
   *                                    case the caller should use its own wording
   * @param {?number} options.httpStatus HTTP status, when the failure was an HTTP one
   */
  constructor(code, { detail = null, httpStatus = null } = {}) {
    super(detail ?? code)
    this.name       = 'OgcError'
    this.code       = code
    this.detail     = detail
    this.httpStatus = httpStatus
  }
}

const JSON_HEADERS  = { 'Content-Type': 'application/json' }
const ACCEPT_JSON   = { Accept: 'application/json' }
const ASYNC_HEADERS = { ...JSON_HEADERS, Prefer: 'respond-async' }

const DEFAULT_POLL_INTERVAL_MS = 3000

/**
 * pygeoapi returns synchronous output either bare or wrapped in a `result` key,
 * depending on how the process declares its outputs. Callers should not have to care.
 */
const unwrapResult = (payload) => payload?.result ?? payload

/** Builds an OgcError from a failed response, preserving whatever the backend explained. */
async function toHttpError(response) {
  const body = await response.text()
  let detail
  try {
    detail = JSON.parse(body).description ?? null
  } catch {
    detail = body.slice(0, 300) || null
  }
  return new OgcError(ErrorCode.HTTP, { detail, httpStatus: response.status })
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init)
  if (!response.ok) throw await toHttpError(response)
  return response.json()
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Runs a process synchronously and returns its unwrapped output.
 * Use for the fast, read-only processes (previews, scenario listing).
 */
export function executeSync(processId, inputs = {}, { signal } = {}) {
  return requestJson(`/processes/${processId}/execution`, {
    method:  'POST',
    headers: JSON_HEADERS,
    body:    JSON.stringify({ inputs }),
    signal,
  }).then(unwrapResult)
}

/**
 * Submits a process for asynchronous execution on the Celery worker.
 * @returns {Promise<string>} the job id to poll
 */
export function executeAsync(processId, inputs = {}, { signal } = {}) {
  return requestJson(`/processes/${processId}/execution`, {
    method:  'POST',
    headers: ASYNC_HEADERS,
    body:    JSON.stringify({ inputs }),
    signal,
  }).then(job => job.jobID)
}

/** Reads a job document once. Use when the caller drives its own polling cadence. */
export function fetchJobStatus(jobId, { signal } = {}) {
  return requestJson(`/jobs/${jobId}`, { headers: ACCEPT_JSON, signal })
}

/**
 * Polls a job until it reaches a terminal state.
 *
 * @returns {Promise<{outcome: string, job: object}>} resolves on success or dismissal
 * @throws  {OgcError} with code JOB_FAILED when the job itself failed
 */
export async function waitForJob(jobId, { intervalMs = DEFAULT_POLL_INTERVAL_MS, signal } = {}) {
  for (;;) {
    await delay(intervalMs, signal)
    const job = await fetchJobStatus(jobId, { signal })

    if (job.status === JobOutcome.SUCCESS)   return { outcome: JobOutcome.SUCCESS,   job }
    if (job.status === JobOutcome.DISMISSED) return { outcome: JobOutcome.DISMISSED, job }
    if (job.status === 'failed') {
      throw new OgcError(ErrorCode.JOB_FAILED, { detail: job.message ?? null })
    }
  }
}

/**
 * Fetches the results of a finished job, as returned by the backend.
 *
 * Intentionally not unwrapped: each process has its own result shape (OpenDrift
 * returns steps/times, PMAR a raster payload, precompute a scenario id), and that
 * knowledge belongs to the caller, not to the transport layer.
 */
export function fetchJobResults(jobId, { signal } = {}) {
  return requestJson(`/jobs/${jobId}/results`, { headers: ACCEPT_JSON, signal })
}

/**
 * Asks the backend to revoke a running job (STOP button).
 *
 * Never throws: the authoritative signal that a job stopped is its status turning
 * to `dismissed` during polling, not the response to this call, so a failed DELETE
 * must not break the caller's flow.
 *
 * @returns {Promise<boolean>} whether the backend accepted the request
 */
export async function dismissJob(jobId) {
  try {
    const response = await fetch(`/jobs/${jobId}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Runs one of the map overlay processes (EMODnet layers, Natura 2000) for a bbox.
 *
 * @param {{lon_min: number, lat_min: number, lon_max: number, lat_max: number}} bounds
 * @returns {Promise<?object>} the FeatureCollection, or null when the backend found
 *                             no features there — an empty area is a normal answer,
 *                             so it is reported as a value rather than as an error
 */
export async function fetchFeatureLayer(processId, bounds, { signal } = {}) {
  const data = await executeSync(processId, bounds, { signal })
  return data?.features?.length > 0 ? data : null
}
