import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { connectivityRaster, encodeGeoTiff, fileStem } from './geotiff.js'

/** Legge l'IFD: tag → { type, count, values }. */
function readTags(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(dv.getUint16(0, true), 0x4949)
  assert.equal(dv.getUint16(2, true), 42)
  const ifd = dv.getUint32(4, true)
  const n = dv.getUint16(ifd, true)
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 }
  const tags = {}
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12
    const tag = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), count = dv.getUint32(p + 4, true)
    const bytesLen = count * size[type]
    const at = bytesLen <= 4 ? p + 8 : dv.getUint32(p + 8, true)
    const values = []
    for (let k = 0; k < count; k++) {
      const o = at + k * size[type]
      values.push(type === 3 ? dv.getUint16(o, true) : type === 4 ? dv.getUint32(o, true)
                : type === 12 ? dv.getFloat64(o, true) : dv.getUint8(o))
    }
    tags[tag] = { type, count, values }
  }
  return { dv, tags }
}

// 3 colonne × 2 righe; riga 0 = sud.
const RASTER = { values: [[1, 2, 3], [4, 5, 6]], lon_min: 13.05, lat_min: 44.05, res: 0.1, nx: 3, ny: 2 }

describe('encodeGeoTiff', () => {
  it('writes size, float samples and the georeference of the north-west corner', () => {
    const { tags } = readTags(encodeGeoTiff(RASTER))
    assert.deepEqual(tags[256].values, [3])
    assert.deepEqual(tags[257].values, [2])
    assert.deepEqual(tags[258].values, [32])
    assert.deepEqual(tags[339].values, [3])
    assert.deepEqual(tags[33550].values.map(v => +v.toFixed(9)), [0.1, 0.1, 0])
    const tie = tags[33922].values
    assert.ok(Math.abs(tie[3] - 13.0) < 1e-9 && Math.abs(tie[4] - 44.2) < 1e-9)
    assert.ok(tags[34735].values.includes(4326))
  })

  it('stores pixels north row first', () => {
    const bytes = encodeGeoTiff(RASTER)
    const { dv, tags } = readTags(bytes)
    const off = tags[273].values[0]
    const px = Array.from({ length: 6 }, (_, i) => dv.getFloat32(off + i * 4, true))
    assert.deepEqual(px, [4, 5, 6, 1, 2, 3])
    assert.equal(tags[279].values[0], 24)
    assert.equal(bytes.length, off + 24)
  })

  it('writes the nodata tag and maps non-finite values to it', () => {
    const { dv, tags } = readTags(encodeGeoTiff({ ...RASTER, values: [[NaN, 2, 3], [4, 5, 6]] }))
    assert.equal(String.fromCharCode(...tags[42113].values), '0\0')
    assert.equal(dv.getFloat32(tags[273].values[0] + 3 * 4, true), 0)
    const none = readTags(encodeGeoTiff(RASTER, { nodata: null }))
    assert.equal(none.tags[42113], undefined)
  })
})

describe('connectivityRaster', () => {
  const cell = (x, y, v, reliable = true) => ({
    type: 'Feature',
    properties: { in_strength: v, reliable },
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.5, y], [x + 0.5, y + 0.5], [x, y + 0.5], [x, y]]] },
  })
  const data = {
    node_source: 'grid', grid_res: 0.5, grid_bbox: [12, 44, 13, 45],
    polygons_geojson: { features: [cell(12, 44, 1), cell(12.5, 44.5, 2), cell(12.5, 44, 9, false)] },
  }

  it('places each grid cell by its centre and leaves unreliable cells empty', () => {
    const r = connectivityRaster(data, 'in_strength')
    assert.deepEqual(r.values, [[1, 0], [0, 2]])
    assert.equal(r.lon_min, 12.25)
    assert.equal(r.nx, 2)
  })

  it('returns null for polygon nodes', () => {
    assert.equal(connectivityRaster({ ...data, node_source: 'polygons' }, 'in_strength'), null)
  })
})

describe('fileStem', () => {
  it('keeps a readable, safe name', () => {
    assert.equal(fileStem('PPI · Uniform · Azores – RAMPA'), 'PPI_Uniform_Azores_RAMPA')
    assert.equal(fileStem('   '), 'layer')
  })
})
