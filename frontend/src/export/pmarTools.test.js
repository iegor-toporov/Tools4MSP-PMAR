import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cellAreaKm2, cellId, cellsCsv, comparisonCsv, computeStats, exceedanceCurve, histogramBins,
  histogramCsv, metaHeader, profileCsv, quantile, statsCsv, thresholdCsv, toCsv,
} from './pmarTools.js'

// Raster 3×4 a 0.1°, celle centrate su lat 44.0/44.1/44.2, lon 13.0…13.3
const RD = {
  raster_values: [
    [0,   5,  50, 0],
    [1,  10, 100, 2],
    [0, 500,   0, 0],
  ],
  raster_lat_min: 44.0, raster_lon_min: 13.0, raster_res: 0.1, raster_nx: 4, raster_ny: 3,
  vmin: 1, vmax: 500,
}
const SNAP = { rowMin: 0, rowMax: 2, colMin: 0, colMax: 3,
               snapLatMin: 43.95, snapLatMax: 44.25, snapLonMin: 12.95, snapLonMax: 13.35 }
const META = { title: 'Test, "A"', scenario: { label: 'S', start_time: '2024-09-28T00:00:00', duration_days: 30,
               pnum: 10000, seedings: 1 }, sourceLayer: 'Uniform', valueLabel: 'PPI (passages per cell)',
               res: 0.1, exportedAt: '2026-10-18T00:00:00Z' }

const parse = csv => {
  const lines = csv.trim().split('\n')
  const header = lines.filter(l => l.startsWith('#'))
  const [cols, ...rows] = lines.filter(l => !l.startsWith('#'))
  return { header, cols: cols.split(','), rows: rows.map(r => r.split(',')) }
}

describe('geometry', () => {
  it('cellAreaKm2 shrinks with latitude', () => {
    assert.ok(Math.abs(cellAreaKm2(0, 0.1) - 123.92) < 0.01)
    assert.ok(Math.abs(cellAreaKm2(60, 0.1) - 123.92 / 2) < 0.01)
  })

  it('cellId matches the map tooltip format', () => {
    assert.equal(cellId(13.2, 44.1, 0.1), '13.20E_44.10N')
    assert.equal(cellId(13.25, 44.05, 0.05), '13.250E_44.050N')
  })
})

describe('quantile', () => {
  it('interpolates like numpy / pandas', () => {
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
    assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2)
    assert.equal(quantile([10], 0.9), 10)
  })
})

describe('metaHeader and toCsv', () => {
  it('writes only # lines in the header, then escaped rows', () => {
    const header = metaHeader('x', META, [['empty', ''], ['k', 'v']])
    assert.ok(header.every(l => l.startsWith('# ')))
    assert.ok(!header.some(l => l.startsWith('# empty')))
    const csv = toCsv(header, ['a', 'b'], [[1, 'x,y'], [Infinity, 'q"z']])
    assert.ok(csv.includes('\na,b\n1,"x,y"\ninf,"q""z"\n'))
  })
})

describe('statistics', () => {
  const s = computeStats(RD.raster_values, 0, 3, 0, 2)
  it('uses only cells > 0 and numpy quantiles', () => {
    assert.equal(s.n, 7)
    assert.equal(s.median, 10)
    assert.equal(s.min, 1)
    assert.equal(s.max, 500)
  })
  it('exports one row per statistic', () => {
    const { cols, rows } = parse(statsCsv({ ...SNAP, stats: s }, META))
    assert.deepEqual(cols, ['stat', 'value'])
    assert.equal(rows.length, 11)
  })
})

describe('histogram', () => {
  const h = { bins: [2, 3, 2], nBins: 3, total: 7, noData: 5, logMin: 0, logMax: 3, step: 1,
              valMin: 1, valMax: 500, mean: 95.4, ...SNAP }
  it('opens the first and last bins', () => {
    const b = histogramBins(h)
    assert.equal(b[0].lower, 0)
    assert.equal(b[1].lower, 10)
    assert.equal(b[2].upper, Infinity)
    assert.equal(b.reduce((s, x) => s + x.count, 0), h.total)
  })
  it('exports bins with fractions', () => {
    const { cols, rows } = parse(histogramCsv(h, META))
    assert.deepEqual(cols, ['bin', 'lower', 'upper', 'count', 'fraction'])
    assert.equal(rows[2][2], 'inf')
  })
})

describe('threshold', () => {
  const cells = [{ v: 1, lat: 44 }, { v: 10, lat: 44 }, { v: 100, lat: 60 }, { v: 500, lat: 60 }]
  const curve = exceedanceCurve(cells, 1, 500, 0.1, 10)
  it('is monotone and starts from every cell', () => {
    assert.equal(curve[0].cellsAbove, 4)
    assert.equal(curve[0].pctCells, 100)
    for (let i = 1; i < curve.length; i++) assert.ok(curve[i].cellsAbove <= curve[i - 1].cellsAbove)
    assert.equal(curve.at(-1).cellsAbove, 1)
  })
  it('sums real (latitude-corrected) cell areas', () => {
    assert.ok(Math.abs(curve.at(-1).areaKm2 - cellAreaKm2(60, 0.1)) < 1e-9)
  })
  it('exports the curve', () => {
    const { cols, rows } = parse(thresholdCsv({ ...SNAP, cells, vmin: 1, vmax: 500, rasterRes: 0.1 }, META, 10))
    assert.deepEqual(cols, ['threshold', 'cells_above', 'area_km2', 'pct_cells'])
    assert.equal(rows.length, 10)
  })
})

describe('cells', () => {
  it('exports every cell of the rectangle, zeros included', () => {
    const { cols, rows } = parse(cellsCsv(RD, SNAP, META))
    assert.deepEqual(cols, ['row', 'col', 'cell_id', 'lat', 'lon', 'cell_area_km2', 'value'])
    assert.equal(rows.length, 3 * 4)
    assert.equal(rows.filter(r => r[6] === '0').length, 5)
    assert.equal(rows[6][2], '13.20E_44.10N')        // riga 1, colonna 2
  })
})

describe('profile', () => {
  it('exports distance, position, cell and value per sample', () => {
    const profile = { latA: 44, lonA: 13, latB: 44.1, lonB: 13.2, totalDist: 18.4,
                      pts: [{ dist: 0, lat: 44, lon: 13, cellId: '13.00E_44.00N', value: 0 },
                            { dist: 9.2, lat: 44.05, lon: 13.1, cellId: '13.10E_44.10N', value: 10 }] }
    const { cols, rows } = parse(profileCsv(profile, META))
    assert.deepEqual(cols, ['sample', 'distance_km', 'lat', 'lon', 'cell_id', 'value'])
    assert.equal(rows.length, 2)
  })
})

describe('comparison', () => {
  it('writes a long table with one header line per area', () => {
    const h = { bins: [1, 2], nBins: 2, total: 3, logMin: 0, logMax: 2, step: 1, ...SNAP }
    const csv = comparisonCsv([h, { ...h, bins: [0, 4], total: 4 }], ['A', 'B, east'], META)
    const { header, cols, rows } = parse(csv)
    assert.deepEqual(cols, ['area', 'bin', 'lower', 'upper', 'count', 'fraction'])
    assert.equal(rows.length, 4)
    assert.equal(header.filter(l => l.startsWith('# area ')).length, 2)
    assert.ok(csv.includes('"B, east",1,10,inf,4,1'))
  })
})
