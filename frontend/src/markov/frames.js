/**
 * Frames of a "Propagate forward" analysis (processes/MarkovProcess.py) in the raster
 * format of the PMAR analyses.
 *
 * For every multiple k of Δt, the backend sends the values on the domain cells only
 * (`cells`, indices row * nx + column, row 0 = south): the forecast particles per
 * cell, starting from their distribution at t=0. Here the complete raster is rebuilt,
 * which `PmarLayer`, the legend and the tools (histogram, statistics, CSV…) already
 * use, so a Propagate analysis behaves like a PMAR one on the frame shown.
 *
 * Pure module (no React, no Leaflet): tested in frames.test.js.
 */

export const frameCount = data => data?.frames?.length ?? 0

/** A valid frame; without one (null) the last, that is the farthest step. */
export function clampFrame(data, k) {
  const n = frameCount(data)
  if (!n) return 0
  if (k === null || k === undefined || !Number.isFinite(k)) return n - 1
  return Math.max(0, Math.min(n - 1, Math.round(k)))
}

/** Day of frame k (k × Δt). */
export const frameDay = (data, k) => data?.frames?.[clampFrame(data, k)]?.day ?? 0

/**
 * Raster in the format of a PMAR result (`raster_values[row][column]`, row 0 to the
 * south), with the same log scale for all frames (`vmin`/`vmax` from the backend).
 */
export function markovRaster(data, k) {
  const { lon_min, lat_min, res, nx, ny } = data.grid
  const frame = clampFrame(data, k)
  const vals = data.frames[frame].values
  const raster = Array.from({ length: ny }, () => new Array(nx).fill(0))
  data.cells.forEach((c, i) => {
    const v = vals[i]
    if (v) raster[Math.floor(c / nx)][c % nx] = v
  })
  return {
    raster_values:  raster,
    raster_lon_min: lon_min,
    raster_lat_min: lat_min,
    raster_res:     res,
    raster_nx:      nx,
    raster_ny:      ny,
    bounds:         data.bounds,
    scale:          'log',
    vmin:           data.vmin,
    vmax:           data.vmax,
    frame,
  }
}
