import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { forcingLabel } from './forcing.js'

const L = {
  unknown: 'CMEMS', hourly: 'hourly', daily: 'daily', hours: 'every {h} h',
  reanalysis: 'reanalysis', forecast: 'analysis', basins: { med: 'Mediterranean', glo: 'Global' },
}

describe('forcingLabel', () => {
  it('describes the currents dataset', () => {
    const sc = { forcing_datasets: { cur: [{ basin: 'med', res: '4.2 km', step_h: 1, kind: 'my' }] } }
    assert.equal(forcingLabel(sc, L), 'CMEMS Mediterranean 4.2 km · hourly · reanalysis')
  })

  it('joins a regional and a global dataset', () => {
    const sc = { forcing_datasets: { cur: [
      { basin: 'med', res: '4.2 km', step_h: 24, kind: 'anfc' },
      { basin: 'glo', res: '1/12°', step_h: 1, kind: 'anfc' },
    ] } }
    assert.equal(forcingLabel(sc, L),
      'CMEMS Mediterranean 4.2 km · daily · analysis + Global 1/12° · hourly · analysis')
  })

  it('falls back for older scenarios', () => {
    assert.equal(forcingLabel({}, L), 'CMEMS')
    assert.equal(forcingLabel(null, L), 'CMEMS')
  })
})
