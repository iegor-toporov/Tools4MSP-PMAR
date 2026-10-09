import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  ErrorCode, JobOutcome, OgcError, Process,
  dismissJob, executeAsync, executeSync, fetchFeatureLayer, waitForJob,
} from './ogcProcesses.js'

/** Installs a fetch stub and records the calls made through it. */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return calls
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

const rawResponse = (body, { ok = false, status = 500 } = {}) => ({
  ok, status,
  json: async () => JSON.parse(body),
  text: async () => body,
})

afterEach(() => { delete globalThis.fetch })

describe('executeSync', () => {
  it('unwraps the pygeoapi "result" envelope', async () => {
    stubFetch(() => jsonResponse({ result: { scenarios: {} } }))
    assert.deepEqual(await executeSync(Process.SCENARIO_STATUS, {}), { scenarios: {} })
  })

  it('returns the payload unchanged when there is no envelope', async () => {
    stubFetch(() => jsonResponse({ scenarios: {} }))
    assert.deepEqual(await executeSync(Process.SCENARIO_STATUS, {}), { scenarios: {} })
  })

  it('posts the inputs to the process execution endpoint', async () => {
    const calls = stubFetch(() => jsonResponse({}))
    await executeSync(Process.MSP_ZONES, { lon_min: 12 })
    assert.equal(calls[0].url, '/processes/msp_zones/execution')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), { inputs: { lon_min: 12 } })
  })
})

describe('error reporting', () => {
  it('surfaces the backend description as detail', async () => {
    stubFetch(() => rawResponse(JSON.stringify({ description: 'area on land' })))
    const err = await executeSync(Process.PMAR, {}).catch(e => e)
    assert.ok(err instanceof OgcError)
    assert.equal(err.code, ErrorCode.HTTP)
    assert.equal(err.detail, 'area on land')
    assert.equal(err.httpStatus, 500)
  })

  it('falls back to the raw body when the error is not JSON', async () => {
    stubFetch(() => rawResponse('<html>502 Bad Gateway</html>', { status: 502 }))
    const err = await executeSync(Process.PMAR, {}).catch(e => e)
    assert.equal(err.detail, '<html>502 Bad Gateway</html>')
  })

  it('leaves detail null when the backend explained nothing, so the UI can word it', async () => {
    stubFetch(() => rawResponse(JSON.stringify({ code: 'NoApplicableCode' })))
    const err = await executeSync(Process.PMAR, {}).catch(e => e)
    assert.equal(err.detail, null)
    assert.equal(err.httpStatus, 500)
  })
})

describe('executeAsync', () => {
  it('requests asynchronous execution and returns the job id', async () => {
    const calls = stubFetch(() => jsonResponse({ jobID: 'job-42' }))
    assert.equal(await executeAsync(Process.OPENDRIFT, { model: 'oil' }), 'job-42')
    assert.equal(calls[0].init.headers.Prefer, 'respond-async')
  })

  it('throws instead of yielding an undefined job id when submission fails', async () => {
    stubFetch(() => rawResponse(JSON.stringify({ description: 'worker busy' }), { status: 423 }))
    await assert.rejects(() => executeAsync(Process.PRECOMPUTE, {}), OgcError)
  })
})

describe('waitForJob', () => {
  const statuses = (...sequence) => stubFetch((_url, _init, n) => jsonResponse(sequence[n - 1]))

  it('polls until the job succeeds', async () => {
    statuses({ status: 'running' }, { status: 'accepted' }, { status: 'successful' })
    const { outcome } = await waitForJob('job-1', { intervalMs: 1 })
    assert.equal(outcome, JobOutcome.SUCCESS)
  })

  it('reports a stopped job as an outcome, not an error', async () => {
    statuses({ status: 'running' }, { status: 'dismissed' })
    const { outcome } = await waitForJob('job-1', { intervalMs: 1 })
    assert.equal(outcome, JobOutcome.DISMISSED)
  })

  it('throws with the backend message when the job fails', async () => {
    statuses({ status: 'failed', message: 'no particles seeded' })
    const err = await waitForJob('job-1', { intervalMs: 1 }).catch(e => e)
    assert.equal(err.code, ErrorCode.JOB_FAILED)
    assert.equal(err.detail, 'no particles seeded')
  })

  it('stops polling when the caller aborts', async () => {
    statuses({ status: 'running' }, { status: 'running' }, { status: 'successful' })
    const controller = new AbortController()
    controller.abort(new Error('user left the page'))
    await assert.rejects(() => waitForJob('job-1', { intervalMs: 1, signal: controller.signal }))
  })
})

describe('fetchFeatureLayer', () => {
  it('returns the collection when the bbox contains features', async () => {
    stubFetch(() => jsonResponse({ result: { features: [{ id: 1 }] } }))
    const layer = await fetchFeatureLayer(Process.WINDFARMS, {})
    assert.equal(layer.features.length, 1)
  })

  it('reports an empty bbox as null rather than as an error', async () => {
    stubFetch(() => jsonResponse({ result: { features: [] } }))
    assert.equal(await fetchFeatureLayer(Process.WINDFARMS, {}), null)
  })
})

describe('dismissJob', () => {
  it('never throws, because the authoritative signal is the polled job status', async () => {
    stubFetch(() => { throw new TypeError('network down') })
    assert.equal(await dismissJob('job-1'), false)
  })

  it('reports acceptance by the backend', async () => {
    const calls = stubFetch(() => ({ ok: true, status: 204 }))
    assert.equal(await dismissJob('job-1'), true)
    assert.equal(calls[0].init.method, 'DELETE')
  })
})
