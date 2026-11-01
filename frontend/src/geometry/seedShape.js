/**
 * Conversions for the release area drawn on the map.
 *
 * The module does not depend on React, Leaflet or i18n: it takes a shape and returns
 * data. App.jsx, Panel.jsx and PmarPanel.jsx all use it, so a new kind of shape needs
 * to be handled in one place only.
 *
 * A shape is one of:
 *   { type: 'circle',    lon, lat, radius }                  radius in metres
 *   { type: 'rectangle', lon_min, lat_min, lon_max, lat_max }
 *   { type: 'polygon',   rings: [ [[lon, lat], …], … ] }     open rings, ≥3 vertices
 */

/** Vertices used to approximate a circle when it becomes a GeoJSON polygon. */
const CIRCLE_VERTICES = 64

/** Metres per degree of latitude; for longitude, corrected with the cosine. */
const M_PER_DEG = 111320

const feature = (ring) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring] },
  properties: {},
})

/** Close a ring by repeating the first vertex, as GeoJSON requires. */
const closeRing = (ring) => [...ring, ring[0]]

function circleRing({ lon, lat, radius }) {
  const ring = []
  for (let i = 0; i < CIRCLE_VERTICES; i++) {
    const angle = (i / CIRCLE_VERTICES) * 2 * Math.PI
    const dLat  = (radius / M_PER_DEG) * Math.cos(angle)
    const dLon  = (radius / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle)
    ring.push([lon + dLon, lat + dLat])
  }
  return closeRing(ring)
}

/**
 * Turn the shape into the GeoJSON that the backend saves as the release shapefile.
 *
 * An area of several polygons becomes a FeatureCollection with one Feature per ring:
 * `_save_custom_shapefile()` reads them all, and OpenDrift then seeds in each
 * geometry.
 *
 * @param {?object} shape
 * @returns {?object} FeatureCollection, or null if there is no shape
 */
export function seedShapeToGeoJSON(shape) {
  if (!shape) return null

  if (shape.type === 'circle') {
    return { type: 'FeatureCollection', features: [feature(circleRing(shape))] }
  }

  if (shape.type === 'polygon') {
    const rings = (shape.rings ?? []).filter(r => r.length >= 3)
    if (!rings.length) return null
    return { type: 'FeatureCollection', features: rings.map(r => feature(closeRing(r))) }
  }

  const { lon_min, lat_min, lon_max, lat_max } = shape
  return {
    type: 'FeatureCollection',
    features: [feature([
      [lon_min, lat_min], [lon_max, lat_min],
      [lon_max, lat_max], [lon_min, lat_max],
      [lon_min, lat_min],
    ])],
  }
}

/**
 * Box that contains the shape, in the format expected by the overlay processes
 * (EMODnet, Natura 2000) and by OpenDrift's rectangular seeding.
 *
 * @param {?object} shape
 * @returns {?{lon_min: number, lat_min: number, lon_max: number, lat_max: number}}
 */
export function seedShapeBounds(shape) {
  if (!shape) return null

  if (shape.type === 'circle') {
    const { lon, lat, radius } = shape
    const dLat = radius / M_PER_DEG
    const dLon = radius / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))
    return { lon_min: lon - dLon, lat_min: lat - dLat, lon_max: lon + dLon, lat_max: lat + dLat }
  }

  if (shape.type === 'polygon') {
    const pts = (shape.rings ?? []).flat()
    if (!pts.length) return null
    const lons = pts.map(p => p[0])
    const lats = pts.map(p => p[1])
    return {
      lon_min: Math.min(...lons), lat_min: Math.min(...lats),
      lon_max: Math.max(...lons), lat_max: Math.max(...lats),
    }
  }

  const { lon_min, lat_min, lon_max, lat_max } = shape
  return { lon_min, lat_min, lon_max, lat_max }
}

/** Summary "N polygons · M vertices", with the singular when needed. */
export function formatPolygonCounts(shape, labels = {}) {
  const { n, v } = polygonCounts(shape)
  const tpl = (n === 1 ? labels.polygonsOne : labels.polygons) ?? '{n} · {v}'
  return tpl.replace('{n}', n).replace('{v}', v)
}

/** Number of rings and total vertices of a polygonal area. */
export function polygonCounts(shape) {
  const rings = shape?.type === 'polygon' ? (shape.rings ?? []) : []
  return { n: rings.length, v: rings.reduce((sum, r) => sum + r.length, 0) }
}

/**
 * Readable summary of the shape, for the panel.
 *
 * @param {?object} shape
 * @param {{polygons: string, polygonsOne: string}} [labels] texts already translated,
 *        with the placeholders `{n}` (polygons) and `{v}` (vertices); needed only for
 *        polygonal areas, and the singular because "1 polygons" reads badly
 * @returns {?string}
 */
export function formatSeedShape(shape, labels = {}) {
  if (!shape) return null

  if (shape.type === 'circle') {
    const km = (shape.radius / 1000).toFixed(1)
    return `${shape.lon.toFixed(3)}°E  ${shape.lat.toFixed(3)}°N · r = ${km} km`
  }

  if (shape.type === 'polygon') {
    return formatPolygonCounts(shape, labels)
  }

  return `${shape.lon_min.toFixed(2)}°–${shape.lon_max.toFixed(2)}°E · ` +
         `${shape.lat_min.toFixed(2)}°–${shape.lat_max.toFixed(2)}°N`
}

/**
 * Polygons in which OpenDrift seeds for a drawn shape: one for a circle or rectangle,
 * one per ring of a polygonal area. Needed by seeding for connectivity, where the
 * total is particles per polygon × polygons.
 *
 * @param {?object} shape
 * @returns {number}
 */
export function seedShapePolygonCount(shape) {
  if (!shape) return 0
  if (shape.type === 'polygon') return (shape.rings ?? []).filter(r => r.length >= 3).length
  return 1
}

/**
 * Polygons of a GeoJSON geometry, counted as the backend counts them
 * (`geometry.explode()`): a MultiPolygon counts as its parts.
 * Accepts geometries, Features and FeatureCollections.
 *
 * @param {?object} geo
 * @returns {number}
 */
export function geometryPolygonCount(geo) {
  if (!geo) return 0
  switch (geo.type) {
    case 'Polygon':            return 1
    case 'MultiPolygon':       return geo.coordinates?.length ?? 0
    case 'GeometryCollection': return (geo.geometries ?? []).reduce((n, g) => n + geometryPolygonCount(g), 0)
    case 'Feature':            return geometryPolygonCount(geo.geometry)
    case 'FeatureCollection':  return (geo.features ?? []).reduce((n, f) => n + geometryPolygonCount(f), 0)
    default:                   return 0
  }
}
