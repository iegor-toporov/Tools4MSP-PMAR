import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { anyActive, errorText, minutesSince, statusOf, statusText, transitions } from './lifecycle.js'

const S = {
  statusReady: 'ready', statusFailed: 'failed', statusQueued: 'queued #{n}', statusQueuedPlain: 'queued',
  statusRunning: 'running', statusRunningSeeding: 'running {n}/{total}',
}
const E = { interrupted: 'INT', incomplete: 'INC', lost: 'LOST', unknown: '?' }

describe('statusOf', () => {
  it('uses the server state, falling back to computed for an old backend', () => {
    assert.equal(statusOf({ state: 'queued', computed: false }), 'queued')
    assert.equal(statusOf({ computed: true }), 'ready')
    assert.equal(statusOf({ computed: false }), 'failed')
  })
})

describe('transitions', () => {
  const active = { a: { status: 'running' }, b: { status: 'queued' }, c: { status: 'ready' } }

  it('reports nothing on the first read', () => {
    assert.deepEqual(transitions(null, active), [])
  })

  it('reports finished, failed and cancelled simulations, only if they were active', () => {
    const next = { a: { status: 'ready' }, c: { status: 'ready' }, d: { status: 'failed' } }
    assert.deepEqual(transitions(active, next), [{ id: 'a', to: 'ready' }, { id: 'b', to: 'removed' }])
    assert.deepEqual(transitions(active, { a: { status: 'failed' }, b: { status: 'running' }, c: { status: 'ready' } }),
                     [{ id: 'a', to: 'failed' }])
  })

  it('anyActive drives the polling', () => {
    assert.equal(anyActive(active), true)
    assert.equal(anyActive({ c: { status: 'ready' }, d: { status: 'failed' } }), false)
  })
})

describe('statusText', () => {
  it('shows the queue position and the seeding being computed', () => {
    assert.equal(statusText({ status: 'queued', queue_position: 2 }, S), 'queued #2')
    assert.equal(statusText({ status: 'queued' }, S), 'queued')
    assert.equal(statusText({ status: 'running', progress: { done: 1, total: 4 } }, S), 'running 2/4')
    assert.equal(statusText({ status: 'running', progress: { done: 4, total: 4 } }, S), 'running 4/4')
    assert.equal(statusText({ status: 'running', progress: { done: 0, total: 1 } }, S), 'running')
    assert.equal(statusText({ status: 'failed' }, S), 'failed')
  })
})

describe('errorText and minutesSince', () => {
  it('translates the backend messages and keeps the technical ones', () => {
    assert.equal(errorText('interrupted (worker restart)', E), 'INT')
    assert.equal(errorText('Simulation stopped within first timestep', E), 'Simulation stopped within first timestep')
    assert.equal(errorText(null, E), '?')
  })

  it('counts whole minutes and ignores missing dates', () => {
    const now = Date.parse('2026-10-19T10:00:00Z')
    assert.equal(minutesSince('2026-10-19T09:47:30+00:00', now), 12)
    assert.equal(minutesSince(null, now), null)
  })
})
