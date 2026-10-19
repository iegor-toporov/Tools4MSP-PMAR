import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PENDING_MAX_AGE_MS, STATE_VERSION, fromStored, mergeAnalyses, toStored } from './persistedState.js'

const NOW = Date.parse('2026-10-19T10:00:00Z')
const an = (id, kind = 'pmar', extra = {}) => ({ id, kind, title: id, data: { x: 1 }, view: { visible: false }, ...extra })

describe('toStored / fromStored', () => {
  it('round-trips analyses, the active one and pending jobs', () => {
    const state = { analyses: [an('a'), an('b', 'connectivity')], activeAnalysisId: 'b',
                    pendingJobs: [{ jobId: 'j1', kind: 'pmar', title: 't', submittedAt: NOW }] }
    const back = fromStored(toStored(state, { max: 10, now: NOW }), { max: 10, now: NOW })
    assert.deepEqual(back.analyses.map(a => a.id), ['a', 'b'])
    assert.equal(back.activeAnalysisId, 'b')
    assert.deepEqual(back.pendingJobs.map(j => j.jobId), ['j1'])
  })

  it('caps the number of analyses', () => {
    const state = { analyses: [an('a'), an('b'), an('c')], activeAnalysisId: 'a', pendingJobs: [] }
    assert.equal(toStored(state, { max: 2 }).analyses.length, 2)
    assert.equal(fromStored({ version: STATE_VERSION, analyses: state.analyses }, { max: 1 }).analyses.length, 1)
  })

  it('fills views saved by an older version with the defaults', () => {
    const back = fromStored({ version: STATE_VERSION, analyses: [an('a')] },
                            { max: 10, defaultView: { visible: true, metric: 'in_strength' } })
    assert.deepEqual(back.analyses[0].view, { visible: false, metric: 'in_strength' })
  })
})

describe('fromStored distrusts what it reads', () => {
  it('starts empty on nothing, garbage or another version', () => {
    for (const raw of [null, undefined, 'x', { version: 999, analyses: [an('a')] }, { analyses: [an('a')] }])
      assert.deepEqual(fromStored(raw, { max: 10 }), { analyses: [], activeAnalysisId: null, pendingJobs: [] })
  })

  it('drops malformed analyses and jobs', () => {
    const back = fromStored({
      version: STATE_VERSION,
      analyses: [an('ok'), { id: 'nodata', kind: 'pmar' }, an('badkind', 'opendrift'), null, { kind: 'pmar', data: {} }],
      pendingJobs: [{ jobId: 'j', kind: 'connectivity' }, { jobId: 3, kind: 'pmar' }, { kind: 'pmar' }],
    }, { max: 10, now: NOW })
    assert.deepEqual(back.analyses.map(a => a.id), ['ok'])
    assert.deepEqual(back.pendingJobs.map(j => j.jobId), ['j'])
  })

  it('falls back to the first analysis when the active one is gone', () => {
    const back = fromStored({ version: STATE_VERSION, analyses: [an('a'), an('b')], activeAnalysisId: 'zz' }, { max: 10 })
    assert.equal(back.activeAnalysisId, 'a')
  })

  it('forgets jobs older than the backend keeps them', () => {
    const back = fromStored({ version: STATE_VERSION, pendingJobs: [
      { jobId: 'old', kind: 'pmar', submittedAt: NOW - PENDING_MAX_AGE_MS - 1 },
      { jobId: 'new', kind: 'pmar', submittedAt: NOW - 1000 },
    ] }, { max: 10, now: NOW })
    assert.deepEqual(back.pendingJobs.map(j => j.jobId), ['new'])
  })
})

describe('mergeAnalyses', () => {
  it('keeps analyses added before the stored state was read, without duplicates', () => {
    const merged = mergeAnalyses([an('new')], [an('a'), an('new'), an('b')], 3)
    assert.deepEqual(merged.map(a => a.id), ['new', 'a', 'b'])
    assert.equal(mergeAnalyses([an('x')], [an('a'), an('b')], 2).length, 2)
  })
})
