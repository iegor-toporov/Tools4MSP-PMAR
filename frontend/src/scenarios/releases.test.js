import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseSchedule, formatDay } from './releases.js'

const iso = d => d.toISOString().slice(0, 10)

test('six releases of 90 days, one every 30', () => {
  const r = releaseSchedule('2024-07-01', 90, 6, 30)
  assert.equal(r.length, 6)
  assert.deepEqual(r.map(x => x.n), [1, 2, 3, 4, 5, 6])
  assert.equal(iso(r[0].start), '2024-07-01')
  assert.equal(iso(r[0].end), '2024-09-29')
  assert.equal(iso(r[5].start), '2024-11-28')
  assert.equal(iso(r[5].end), '2025-02-26')
})

test('values outside the backend limits are brought inside them', () => {
  assert.equal(releaseSchedule('2024-01-01', 10, 40, 30).length, 12)
  assert.equal(releaseSchedule('2024-01-01', 10, 1, 30).length, 2)
  const r = releaseSchedule('2024-01-01', 10, 2, 0)
  assert.equal(iso(r[1].start), '2024-01-02')
})

test('empty or invalid fields do not break the schedule', () => {
  assert.deepEqual(releaseSchedule('', 30, 3, 30), [])
  assert.equal(releaseSchedule('2024-01-01', '', '', '').length, 2)
})

test('dates do not depend on the time zone of the browser', () => {
  const [first] = releaseSchedule('2024-03-31', 1, 2, 1)
  assert.equal(formatDay(first.start, 'it-IT'), '31/03/2024')
})
