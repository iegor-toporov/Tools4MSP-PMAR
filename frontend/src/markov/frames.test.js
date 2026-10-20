import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clampFrame, frameDay, markovRaster } from './frames.js'

// Griglia 3 × 2 (nx = 3, ny = 2): dominio sulle celle 0 (sud-ovest), 2 e 4 (nord, centro).
const DATA = {
  grid: { lon_min: 13.05, lat_min: 44.05, res: 0.1, nx: 3, ny: 2 },
  cells: [0, 2, 4],
  vmin: 0.01, vmax: 100,
  bounds: [[44, 13], [44.2, 13.3]],
  frames: [
    { k: 0, day: 0,  values: [100, 0, 0] },
    { k: 1, day: 10, values: [50, 30, 10] },
    { k: 2, day: 20, values: [20, 30, 20] },
  ],
}

describe('frames', () => {
  it('defaults to the last frame and clamps out-of-range indices', () => {
    assert.equal(clampFrame(DATA, null), 2)
    assert.equal(clampFrame(DATA, -3), 0)
    assert.equal(clampFrame(DATA, 9), 2)
    assert.equal(clampFrame({ frames: [] }, 1), 0)
  })

  it('gives the day of a frame', () => {
    assert.equal(frameDay(DATA, 1), 10)
    assert.equal(frameDay(DATA, null), 20)
  })
})

describe('markovRaster', () => {
  it('places domain cells on the grid, south row first', () => {
    const r = markovRaster(DATA, 1)
    assert.deepEqual(r.raster_values, [[50, 0, 30], [0, 10, 0]])
    assert.equal(r.raster_nx, 3)
    assert.equal(r.raster_lat_min, 44.05)
    assert.equal(r.scale, 'log')
    assert.equal(r.vmax, 100)
    assert.equal(r.frame, 1)
  })

  it('shows the last frame without an index', () => {
    assert.equal(markovRaster(DATA, null).raster_values[1][1], 20)
  })
})
