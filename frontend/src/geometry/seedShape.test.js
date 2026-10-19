import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { geometryPolygonCount, seedShapePolygonCount, seedShapeToGeoJSON } from './seedShape.js'

const ring = [[13, 44], [13.2, 44], [13.2, 44.2]]

describe('seedShapePolygonCount', () => {
  it('counts one polygon for circles and rectangles, one per ring otherwise', () => {
    assert.equal(seedShapePolygonCount(null), 0)
    assert.equal(seedShapePolygonCount({ type: 'circle', lon: 13, lat: 44, radius: 1000 }), 1)
    assert.equal(seedShapePolygonCount({ type: 'rectangle', lon_min: 13, lat_min: 44, lon_max: 14, lat_max: 45 }), 1)
    assert.equal(seedShapePolygonCount({ type: 'polygon', rings: [ring, ring, [[1, 1], [2, 2]]] }), 2)
  })

  it('matches the features sent to the backend', () => {
    const shape = { type: 'polygon', rings: [ring, ring, ring] }
    assert.equal(seedShapePolygonCount(shape), seedShapeToGeoJSON(shape).features.length)
  })
})

describe('geometryPolygonCount', () => {
  it('counts the parts of multipolygons, like explode() on the backend', () => {
    const poly = { type: 'Polygon', coordinates: [[...ring, ring[0]]] }
    const multi = { type: 'MultiPolygon', coordinates: [poly.coordinates, poly.coordinates, poly.coordinates] }
    assert.equal(geometryPolygonCount(poly), 1)
    assert.equal(geometryPolygonCount(multi), 3)
    assert.equal(geometryPolygonCount({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: multi }, { type: 'Feature', geometry: poly }] }), 4)
    assert.equal(geometryPolygonCount({ type: 'GeometryCollection', geometries: [poly, multi] }), 4)
    assert.equal(geometryPolygonCount(null), 0)
    assert.equal(geometryPolygonCount({ type: 'Point', coordinates: [1, 2] }), 0)
  })
})
