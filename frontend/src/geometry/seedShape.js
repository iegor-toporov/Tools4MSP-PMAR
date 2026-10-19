/**
 * Conversioni per l'area di seeding disegnata sulla mappa.
 *
 * Il modulo non dipende da React, da Leaflet né da i18n: prende una forma e
 * restituisce dati. Le tre funzioni erano duplicate in App.jsx, Panel.jsx e
 * PmarPanel.jsx, e un terzo tipo di forma le avrebbe fatte divergere.
 *
 * Una forma è uno di:
 *   { type: 'circle',    lon, lat, radius }                  raggio in metri
 *   { type: 'rectangle', lon_min, lat_min, lon_max, lat_max }
 *   { type: 'polygon',   rings: [ [[lon, lat], …], … ] }     anelli non chiusi, ≥3 vertici
 */

/** Vertici con cui si approssima un cerchio quando diventa un poligono GeoJSON. */
const CIRCLE_VERTICES = 64

/** Metri per grado di latitudine; per la longitudine si corregge col coseno. */
const M_PER_DEG = 111320

const feature = (ring) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring] },
  properties: {},
})

/** Chiude un anello ripetendo il primo vertice, come vuole GeoJSON. */
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
 * Traduce la forma nel GeoJSON che il backend salva come shapefile di seeding.
 *
 * Un'area a più poligoni diventa una FeatureCollection con una Feature per
 * anello: `_save_custom_shapefile()` le legge tutte, e OpenDrift semina poi in
 * ciascuna geometria.
 *
 * @param {?object} shape
 * @returns {?object} FeatureCollection, o null se non c'è una forma
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
 * Riquadro che contiene la forma, nel formato atteso dai processi di overlay
 * (EMODnet, Natura 2000) e dal seeding rettangolare di OpenDrift.
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

/** Riassunto "N poligoni · M vertici", con il singolare quando serve. */
export function formatPolygonCounts(shape, labels = {}) {
  const { n, v } = polygonCounts(shape)
  const tpl = (n === 1 ? labels.polygonsOne : labels.polygons) ?? '{n} · {v}'
  return tpl.replace('{n}', n).replace('{v}', v)
}

/** Numero di anelli e di vertici complessivi di un'area poligonale. */
export function polygonCounts(shape) {
  const rings = shape?.type === 'polygon' ? (shape.rings ?? []) : []
  return { n: rings.length, v: rings.reduce((sum, r) => sum + r.length, 0) }
}

/**
 * Riassunto leggibile della forma, per il pannello.
 *
 * @param {?object} shape
 * @param {{polygons: string, polygonsOne: string}} [labels] testi già tradotti,
 *        con i segnaposto `{n}` (poligoni) e `{v}` (vertici); servono solo alle
 *        aree poligonali, e il singolare perché "1 poligoni" si legge male
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
 * Poligoni in cui semina OpenDrift per una forma disegnata: uno per cerchio e
 * rettangolo, uno per anello di un'area poligonale. Serve alla semina per
 * connettività, dove il totale è particelle per poligono × poligoni.
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
 * Poligoni di una geometria GeoJSON contati come li conta il backend
 * (`geometry.explode()`): una MultiPolygon vale quanto le sue parti.
 * Accetta geometrie, Feature e FeatureCollection.
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
