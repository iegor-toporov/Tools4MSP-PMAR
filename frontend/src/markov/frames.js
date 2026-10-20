/**
 * Frame di un'analisi "Propagate forward" (processes/MarkovProcess.py) nel formato
 * raster delle analisi PMAR.
 *
 * Il backend manda, per ogni multiplo k di Δt, i valori sulle sole celle del dominio
 * (`cells`, indici riga * nx + colonna, riga 0 = sud): le particelle per cella
 * previste, partendo dalla loro distribuzione a t=0. Qui si ricostruisce il raster
 * completo che `PmarLayer`, la legenda e gli strumenti (istogramma, statistiche,
 * CSV…) già sanno usare, così un'analisi Propagate si comporta come una PMAR sul
 * frame mostrato.
 *
 * Modulo puro (niente React, niente Leaflet): testato in frames.test.js.
 */

export const frameCount = data => data?.frames?.length ?? 0

/** Frame valido; senza indicazione (null) l'ultimo, cioè il passo più lontano. */
export function clampFrame(data, k) {
  const n = frameCount(data)
  if (!n) return 0
  if (k === null || k === undefined || !Number.isFinite(k)) return n - 1
  return Math.max(0, Math.min(n - 1, Math.round(k)))
}

/** Giorno del frame k (k × Δt). */
export const frameDay = (data, k) => data?.frames?.[clampFrame(data, k)]?.day ?? 0

/**
 * Raster nel formato di un risultato PMAR (`raster_values[riga][colonna]`, riga 0 a
 * sud), con la stessa scala log per tutti i frame (`vmin`/`vmax` del backend).
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
