/**
 * Minimal GeoTIFF (Float32, one band, uncompressed, EPSG:4326) written in the browser:
 * it downloads the layers that the backend does not already send as GeoTIFF (Markov
 * frames, connectivity measures on a grid). No dependency: a TIFF header and the
 * essential GeoTIFF tags, which GDAL/QGIS read as a lon/lat raster.
 *
 * Input in the app's raster format (the same as PmarLayer):
 *   values   rows from south to north (values[0] = southernmost row)
 *   lon_min, lat_min  centre of the south-west cell
 *   res, nx, ny
 *
 * Pure module: tested in geotiff.test.js.
 */

const TYPE = { SHORT: 3, LONG: 4, DOUBLE: 12, ASCII: 2 }
const TYPE_SIZE = { [TYPE.SHORT]: 2, [TYPE.LONG]: 4, [TYPE.DOUBLE]: 8, [TYPE.ASCII]: 1 }

/**
 * @param {object}   raster   { values, lon_min, lat_min, res, nx, ny }
 * @param {object}   [opts]
 * @param {number|null} [opts.nodata=0]  no-data value; `null` = no tag
 * @returns {Uint8Array} the file
 */
export function encodeGeoTiff({ values, lon_min, lat_min, res, nx, ny }, { nodata = 0 } = {}) {
  if (!(nx > 0 && ny > 0 && res > 0)) throw new Error('invalid raster')

  // Pixels: TIFF starts from the top row (north).
  const pixels = new Float32Array(nx * ny)
  for (let r = 0; r < ny; r++) {
    const row = values[ny - 1 - r] ?? []
    for (let c = 0; c < nx; c++) {
      const v = Number(row[c])
      pixels[r * nx + c] = Number.isFinite(v) ? v : (nodata ?? NaN)
    }
  }

  const west  = lon_min - res / 2
  const north = lat_min + (ny - 1) * res + res / 2
  const geoKeys = [
    1, 1, 0, 3,            // version, revision, number of keys
    1024, 0, 1, 2,         // GTModelTypeGeoKey = geographic
    1025, 0, 1, 1,         // GTRasterTypeGeoKey = PixelIsArea
    2048, 0, 1, 4326,      // GeographicTypeGeoKey = WGS 84
  ]
  const nodataText = nodata === null ? null : `${Number.isNaN(nodata) ? 'nan' : nodata}\0`

  const tags = [
    [256, TYPE.LONG,  [nx]],
    [257, TYPE.LONG,  [ny]],
    [258, TYPE.SHORT, [32]],
    [259, TYPE.SHORT, [1]],
    [262, TYPE.SHORT, [1]],
    [273, TYPE.LONG,  [0]],                // offset of the pixels, written later
    [277, TYPE.SHORT, [1]],
    [278, TYPE.LONG,  [ny]],
    [279, TYPE.LONG,  [pixels.byteLength]],
    [284, TYPE.SHORT, [1]],
    [339, TYPE.SHORT, [3]],                // SampleFormat = IEEE float
    [33550, TYPE.DOUBLE, [res, res, 0]],
    [33922, TYPE.DOUBLE, [0, 0, 0, west, north, 0]],
    [34735, TYPE.SHORT, geoKeys],
    ...(nodataText ? [[42113, TYPE.ASCII, nodataText]] : []),
  ]

  // Layout: header (8) | IFD | data of the long tags | pixels.
  const ifdSize = 2 + tags.length * 12 + 4
  let extraOffset = 8 + ifdSize
  const extra = []
  const entries = tags.map(([tag, type, val]) => {
    const count = type === TYPE.ASCII ? val.length : val.length
    const bytes = count * TYPE_SIZE[type]
    if (bytes <= 4) return { tag, type, count, val, inline: true }
    const offset = extraOffset
    extraOffset += bytes + (bytes % 2)       // even offset, as the standard requires
    extra.push({ offset, type, val })
    return { tag, type, count, val, offset }
  })
  const pixelOffset = extraOffset
  const total = pixelOffset + pixels.byteLength
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)

  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49)   // "II": little-endian
  dv.setUint16(2, 42, true)
  dv.setUint32(4, 8, true)

  const put = (offset, type, val) => {
    if (type === TYPE.ASCII) {
      for (let i = 0; i < val.length; i++) dv.setUint8(offset + i, val.charCodeAt(i))
      return
    }
    val.forEach((v, i) => {
      if (type === TYPE.SHORT) dv.setUint16(offset + i * 2, v, true)
      else if (type === TYPE.LONG) dv.setUint32(offset + i * 4, v, true)
      else dv.setFloat64(offset + i * 8, v, true)
    })
  }

  let p = 8
  dv.setUint16(p, entries.length, true); p += 2
  for (const e of entries) {
    const val = e.tag === 273 ? [pixelOffset] : e.val
    dv.setUint16(p, e.tag, true)
    dv.setUint16(p + 2, e.type, true)
    dv.setUint32(p + 4, e.count, true)
    if (e.inline) put(p + 8, e.type, val)
    else dv.setUint32(p + 8, e.offset, true)
    p += 12
  }
  dv.setUint32(p, 0, true)                     // no other IFD
  for (const x of extra) put(x.offset, x.type, x.val)
  new Uint8Array(buf, pixelOffset).set(new Uint8Array(pixels.buffer))
  return new Uint8Array(buf)
}

/**
 * Raster of a connectivity measure on a generated grid: one cell per node, at the
 * position of its centroid. null if the nodes are not a grid.
 */
export function connectivityRaster(data, metric) {
  if (data?.node_source !== 'grid' || !data.grid_bbox || !(data.grid_res > 0)) return null
  const res = data.grid_res
  const [lon0, lat0, lon1, lat1] = data.grid_bbox
  const nx = Math.max(1, Math.round((lon1 - lon0) / res))
  const ny = Math.max(1, Math.round((lat1 - lat0) / res))
  const values = Array.from({ length: ny }, () => new Array(nx).fill(0))
  for (const f of data.polygons_geojson?.features ?? []) {
    const pr = f.properties ?? {}
    if (!pr.reliable) continue
    const [cx, cy] = centroid(f.geometry)
    const c = Math.floor((cx - lon0) / res)
    const r = Math.floor((cy - lat0) / res)
    if (r >= 0 && r < ny && c >= 0 && c < nx) values[r][c] = Number(pr[metric]) || 0
  }
  return { values, lon_min: lon0 + res / 2, lat_min: lat0 + res / 2, res, nx, ny }
}

/** Centre of the bounding box of a geometry (grid cells are rectangles). */
function centroid(geometry) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const walk = a => {
    if (typeof a[0] === 'number') {
      x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0])
      y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1])
    } else a.forEach(walk)
  }
  walk(geometry?.coordinates ?? [])
  return [(x0 + x1) / 2, (y0 + y1) / 2]
}

/** Safe file name from the title of a layer. */
export function fileStem(title, fallback = 'layer') {
  const s = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return s || fallback
}
