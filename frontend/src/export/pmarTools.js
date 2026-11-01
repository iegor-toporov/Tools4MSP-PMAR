/**
 * Export of the data of the PMAR heatmap tools (histogram, statistics, profile,
 * threshold, cells, comparison) as CSV with a metadata header.
 *
 * Each file starts with `# key: value` lines (analysis, scenario, indicator, selected
 * area…) and continues with a table. It is read with pandas
 * `read_csv(f, comment='#')` or R `read.csv(f, comment.char='#')`.
 *
 * Pure module (no React, no DOM): tested in pmarTools.test.js.
 */

const KM_PER_DEG = 111.32

/** Area of a cell of `res` degrees centred at latitude `lat` (spherical approximation). */
export function cellAreaKm2(lat, res) {
  return (res * KM_PER_DEG) ** 2 * Math.cos((lat * Math.PI) / 180)
}

/** Area of a lon/lat rectangle, in km². */
export function boxAreaKm2(latMin, latMax, lonMin, lonMax) {
  const latMid = (latMin + latMax) / 2
  return Math.abs((latMax - latMin) * (lonMax - lonMin) * KM_PER_DEG ** 2 * Math.cos((latMid * Math.PI) / 180))
}

/** Decimals of the cell ids: the same as the heatmap tooltip (PmarLayer). */
const idDecimals = res => Math.max(0, Math.ceil(-Math.log10(res)) + 1)

/** Stable id of a cell, `{lon}E_{lat}N`: the same as shown by the tooltip on the map. */
export function cellId(lon, lat, res) {
  const d = idDecimals(res)
  return `${lon.toFixed(d)}E_${lat.toFixed(d)}N`
}

/** Centre of the cell (row, column) of the raster `rd`. */
export function cellCenter(rd, row, col) {
  return { lat: rd.raster_lat_min + row * rd.raster_res, lon: rd.raster_lon_min + col * rd.raster_res }
}

/**
 * Quantile with linear interpolation between the two nearest values: the default
 * definition of numpy, pandas and R (type 7), so the numbers can be reproduced.
 * `sorted` must be in ascending order.
 */
export function quantile(sorted, p) {
  if (!sorted.length) return NaN
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** CSV field: quoted only if it contains commas, quotes or line breaks. */
function csvField(v) {
  const s = v === Infinity ? 'inf' : String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** `# key: value` lines; those with an empty value are skipped. */
function headerLines(pairs) {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `# ${k}: ${String(v).replace(/\n/g, ' ')}`)
}

/** Common header: tool, analysis, scenario, value, grid, date. */
export function metaHeader(tool, meta = {}, extra = []) {
  const sc = meta.scenario ?? {}
  const scenario = [sc.label, sc.start_time?.slice(0, 10),
                    sc.duration_days != null ? `${sc.duration_days} d` : null,
                    sc.pnum != null ? `${sc.pnum} particles` : null,
                    sc.seedings > 1 ? `${sc.seedings} seedings` : null].filter(Boolean).join(' · ')
  return headerLines([
    ['PMAR tool', tool],
    ['analysis', meta.title],
    ['scenario', scenario],
    ['source layer', meta.sourceLayer],
    ['value', meta.valueLabel],
    ['grid resolution', meta.res != null ? `${meta.res} deg` : null],
    ...extra,
    ['exported', meta.exportedAt ?? new Date().toISOString()],
  ])
}

/** Complete CSV: `#` header, column row, data rows. */
export function toCsv(header, columns, rows) {
  const lines = [...header, columns.join(',')]
  for (const r of rows) lines.push(r.map(csvField).join(','))
  return lines.join('\n') + '\n'
}

/** Metadata line that describes a selected rectangle. */
function boxLine(r) {
  const km2 = boxAreaKm2(r.snapLatMin, r.snapLatMax, r.snapLonMin, r.snapLonMax)
  return `lon ${r.snapLonMin.toFixed(4)}..${r.snapLonMax.toFixed(4)}, ` +
         `lat ${r.snapLatMin.toFixed(4)}..${r.snapLatMax.toFixed(4)} (~${km2.toFixed(1)} km2)`
}

// ── Istogramma ──────────────────────────────────────────────────────────────

/**
 * Histogram classes with their bounds. The first also collects the values below vmin
 * and the last those above vmax (as on the map): their outer bounds are 0 and inf.
 */
export function histogramBins(h) {
  return h.bins.map((count, i) => ({
    bin: i,
    lower: i === 0 ? 0 : 10 ** (h.logMin + i * h.step),
    upper: i === h.nBins - 1 ? Infinity : 10 ** (h.logMin + (i + 1) * h.step),
    count,
    fraction: h.total > 0 ? count / h.total : 0,
  }))
}

export function histogramCsv(result, meta) {
  const header = metaHeader('histogram', meta, [
    ['selection', boxLine(result)],
    ['cells with data', result.total],
    ['cells without data', result.noData],
    ['min / mean / max', `${result.valMin} / ${result.mean} / ${result.valMax}`],
    ['bins', `${result.nBins} log10-spaced bins between vmin ${10 ** result.logMin} and vmax ` +
             `${10 ** result.logMax}; the first and last bins also hold values outside that range`],
  ])
  const rows = histogramBins(result).map(b => [b.bin, b.lower, b.upper, b.count, b.fraction])
  return toCsv(header, ['bin', 'lower', 'upper', 'count', 'fraction'], rows)
}

// ── Statistiche ─────────────────────────────────────────────────────────────

/** Statistics of the cells with value > 0 in a rectangle (quantiles as in numpy). */
export function computeStats(rasterValues, colMin, colMax, rowMin, rowMax) {
  const vals = []
  for (let r = rowMin; r <= rowMax; r++)
    for (let c = colMin; c <= colMax; c++) {
      const v = rasterValues[r]?.[c]
      if (v > 0 && isFinite(v)) vals.push(v)
    }
  if (!vals.length) return null
  vals.sort((a, b) => a - b)
  const n    = vals.length
  const mean = vals.reduce((s, v) => s + v, 0) / n
  const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
  const q    = p => quantile(vals, p)
  return {
    n, mean, std, min: vals[0], max: vals[n - 1],
    median: q(0.5), q25: q(0.25), q75: q(0.75), q90: q(0.90), q95: q(0.95), q99: q(0.99),
  }
}

export const STATS_ORDER = ['n', 'mean', 'median', 'std', 'min', 'max', 'q25', 'q75', 'q90', 'q95', 'q99']

export function statsCsv(result, meta) {
  const header = metaHeader('statistics', meta, [
    ['selection', boxLine(result)],
    ['cells', 'cells with value > 0 inside the selection; std is the population std; ' +
              'quantiles by linear interpolation (numpy/pandas default)'],
  ])
  const rows = STATS_ORDER.map(k => [k, result.stats[k]])
  return toCsv(header, ['stat', 'value'], rows)
}

// ── Profilo ─────────────────────────────────────────────────────────────────

export function profileCsv(profile, meta) {
  const header = metaHeader('profile', meta, [
    ['from', `${profile.lonA.toFixed(5)}E ${profile.latA.toFixed(5)}N`],
    ['to', `${profile.lonB.toFixed(5)}E ${profile.latB.toFixed(5)}N`],
    ['length', `${profile.totalDist.toFixed(3)} km`],
    ['sampling', 'points evenly spaced along the line; each takes the value of the cell it falls in'],
  ])
  const rows = profile.pts.map((p, i) => [i, p.dist, p.lat, p.lon, p.cellId, p.value])
  return toCsv(header, ['sample', 'distance_km', 'lat', 'lon', 'cell_id', 'value'], rows)
}

// ── Soglia ──────────────────────────────────────────────────────────────────

/**
 * Exceedance curve: for `n` log-spaced thresholds between vmin and vmax, how many cells
 * are above the threshold, their real area (cos(lat)) and the percentage of cells.
 * `cells` = `[{ v, lat }]`, only cells with value > 0.
 */
export function exceedanceCurve(cells, vmin, vmax, res, n = 50) {
  const lo = Math.log10(Math.max(vmin > 0 ? vmin : 1e-6, 1e-12))
  const hi = Math.log10(Math.max(vmax > 0 ? vmax : 1, 1e-12))
  const total = cells.length
  return Array.from({ length: n }, (_, i) => {
    const threshold = 10 ** (lo + (n > 1 ? i / (n - 1) : 0) * (hi - lo))
    let above = 0, area = 0
    for (const c of cells) if (c.v >= threshold) { above++; area += cellAreaKm2(c.lat, res) }
    return { threshold, cellsAbove: above, areaKm2: area, pctCells: total ? (above / total) * 100 : 0 }
  })
}

export function thresholdCsv(result, meta, n = 50) {
  const curve = exceedanceCurve(result.cells, result.vmin, result.vmax, result.rasterRes, n)
  const header = metaHeader('threshold (exceedance curve)', meta, [
    ['selection', boxLine(result)],
    ['cells', `${result.cells.length} cells with value > 0 inside the selection`],
    ['thresholds', `${n} log10-spaced thresholds between vmin ${result.vmin} and vmax ${result.vmax}`],
    ['area', 'sum of the areas of the cells at or above the threshold, corrected for latitude'],
  ])
  const rows = curve.map(c => [c.threshold, c.cellsAbove, c.areaKm2, c.pctCells])
  return toCsv(header, ['threshold', 'cells_above', 'area_km2', 'pct_cells'], rows)
}

// ── Celle ───────────────────────────────────────────────────────────────────

/** All the cells of the rectangle, zeros included: a regular grid without holes. */
export function cellsCsv(rd, snap, meta) {
  const res = rd.raster_res
  const rows = []
  for (let r = snap.rowMin; r <= snap.rowMax; r++)
    for (let c = snap.colMin; c <= snap.colMax; c++) {
      const { lat, lon } = cellCenter(rd, r, c)
      const v = rd.raster_values[r]?.[c]
      rows.push([r, c, cellId(lon, lat, res), lat, lon, cellAreaKm2(lat, res),
                 Number.isFinite(v) && v > 0 ? v : 0])
    }
  const header = metaHeader('cells', meta, [
    ['selection', boxLine(snap)],
    ['grid', `${snap.rowMax - snap.rowMin + 1} rows x ${snap.colMax - snap.colMin + 1} columns ` +
             `(${rows.length} cells, zeros included); lat/lon are cell centres`],
  ])
  return toCsv(header, ['row', 'col', 'cell_id', 'lat', 'lon', 'cell_area_km2', 'value'], rows)
}

// ── Confronto ───────────────────────────────────────────────────────────────

/** Long format: one row per (area, class); the metadata of each area in the header. */
export function comparisonCsv(areas, names, meta) {
  const extra = areas.map((a, i) => [
    `area ${names[i] ?? i}`,
    `${boxLine(a)}; ${a.total} cells with data` + (a.meta?.title ? `; analysis: ${a.meta.title}` : ''),
  ])
  extra.push(['bins', 'same log10 bins as the histogram tool, from each area\'s analysis vmin/vmax; ' +
                      'first and last bins are open-ended'])
  const header = metaHeader('comparison', meta, extra)
  const rows = []
  areas.forEach((a, i) => histogramBins(a).forEach(b =>
    rows.push([names[i] ?? i, b.bin, b.lower, b.upper, b.count, b.fraction])))
  return toCsv(header, ['area', 'bin', 'lower', 'upper', 'count', 'fraction'], rows)
}
