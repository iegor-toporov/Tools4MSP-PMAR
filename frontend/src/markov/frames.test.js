import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MarkovLayer, clampFrame, effectiveLayer, firstUnvalidatedFrame, frameSummary, frameValues,
  layerAvailable, markovRaster,
} from './frames.js'

// Griglia 3 × 2 (nx = 3, ny = 2): dominio sulle celle 0 (sud-ovest), 2 e 4 (nord, centro).
const DATA = {
  grid: { lon_min: 13.05, lat_min: 44.05, res: 0.1, nx: 3, ny: 2 },
  cells: [0, 2, 4],
  vmin: 0.01, vmax: 1, diff_max: 0.2,
  bounds: [[44, 13], [44.2, 13.3]],
  frames: [
    { k: 0, day: 0,  values: [1, 0, 0],       released: 1, mass_out: 0,
      ref: { values: [1, 0, 0], mass_out: 0, emax: 0, mae: 0, ref_max: 1 } },
    { k: 1, day: 10, values: [0.5, 0.3, 0.1], released: 1, mass_out: 0.1,
      ref: { values: [0.6, 0.3, 0.05], mass_out: 0.05, emax: -0.1, mae: 0.05, ref_max: 0.6 } },
    { k: 2, day: 20, values: [0.2, 0.3, 0.2], released: 1, mass_out: 0.3, ref: null },
  ],
}

describe('frames', () => {
  it('defaults to the last frame and clamps out-of-range indices', () => {
    assert.equal(clampFrame(DATA, null), 2)
    assert.equal(clampFrame(DATA, -3), 0)
    assert.equal(clampFrame(DATA, 9), 2)
    assert.equal(clampFrame({ frames: [] }, 1), 0)
  })

  it('offers simulation and difference only while the frame is validated', () => {
    assert.equal(layerAvailable(DATA, 1, MarkovLayer.DIFFERENCE), true)
    assert.equal(layerAvailable(DATA, 2, MarkovLayer.SIMULATION), false)
    assert.equal(effectiveLayer(DATA, 2, MarkovLayer.DIFFERENCE), MarkovLayer.FORECAST)
    assert.equal(firstUnvalidatedFrame(DATA), 2)
  })

  it('computes the difference as forecast minus simulation', () => {
    const d = frameValues(DATA, 1, MarkovLayer.DIFFERENCE)
    assert.deepEqual(d.map(v => +v.toFixed(6)), [-0.1, 0, 0.05])
  })
})

describe('markovRaster', () => {
  it('places domain cells on the grid, south row first', () => {
    const r = markovRaster(DATA, 1, MarkovLayer.FORECAST)
    assert.deepEqual(r.raster_values, [[0.5, 0, 0.3], [0, 0.1, 0]])
    assert.equal(r.raster_nx, 3)
    assert.equal(r.raster_lat_min, 44.05)
    assert.equal(r.scale, 'log')
    assert.equal(r.vmax, 1)
  })

  it('uses a symmetric diverging scale for the difference', () => {
    const r = markovRaster(DATA, 1, MarkovLayer.DIFFERENCE)
    assert.equal(r.scale, 'diverging')
    assert.equal(r.vmin, -0.2)
    assert.equal(r.vmax, 0.2)
    assert.ok(Math.abs(r.raster_values[0][0] + 0.1) < 1e-12)
    assert.equal(r.raster_values[0][2], 0)          // differenza nulla: cella vuota
  })

  it('falls back to the forecast beyond the simulation', () => {
    const r = markovRaster(DATA, 2, MarkovLayer.SIMULATION)
    assert.equal(r.layer, MarkovLayer.FORECAST)
    assert.equal(r.raster_values[1][1], 0.2)
  })
})

describe('frameSummary', () => {
  it('reports shares of the release and the error only for validated frames', () => {
    const s1 = frameSummary(DATA, 1)
    assert.equal(s1.validated, true)
    assert.equal(s1.massOut, 0.1)
    assert.equal(s1.refMassOut, 0.05)
    assert.equal(s1.emax, -0.1)
    const s2 = frameSummary(DATA, 2)
    assert.equal(s2.validated, false)
    assert.equal(s2.emax, null)
    assert.equal(frameSummary(DATA, 0).validated, false)
  })
})
