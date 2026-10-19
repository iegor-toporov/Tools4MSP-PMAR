/**
 * Frame di un'analisi Markov (processes/MarkovProcess.py) nel formato raster delle
 * analisi PMAR.
 *
 * Il backend manda, per ogni passo Δt, i valori sulle sole celle del dominio
 * (`cells`, indici riga * nx + colonna, riga 0 = sud): la previsione e, finché
 * l'orizzonte resta dentro la simulazione, il riferimento lagrangiano. Qui si
 * ricostruisce il raster completo che `PmarLayer`, la legenda e gli strumenti
 * (istogramma, statistiche, CSV…) già sanno usare, così un'analisi Markov si
 * comporta come una PMAR sul frame mostrato.
 *
 * Modulo puro (niente React, niente Leaflet): testato in frames.test.js.
 */

export const MarkovLayer = {
  FORECAST:   'forecast',     // catena di Markov
  SIMULATION: 'simulation',   // riferimento: le particelle della simulazione
  DIFFERENCE: 'difference',   // previsione − riferimento
}

export const frameCount = data => data?.frames?.length ?? 0

/** Frame valido; senza indicazione (null) l'ultimo, cioè l'orizzonte richiesto. */
export function clampFrame(data, k) {
  const n = frameCount(data)
  if (!n) return 0
  if (k === null || k === undefined || !Number.isFinite(k)) return n - 1
  return Math.max(0, Math.min(n - 1, Math.round(k)))
}

/** Il riferimento esiste solo finché l'orizzonte è dentro la simulazione. */
export function layerAvailable(data, k, layer) {
  if (layer === MarkovLayer.FORECAST) return true
  return !!data?.frames?.[clampFrame(data, k)]?.ref
}

/** Livello effettivamente mostrabile: oltre la simulazione si ripiega sulla previsione. */
export function effectiveLayer(data, k, layer) {
  return layerAvailable(data, k, layer) ? layer : MarkovLayer.FORECAST
}

/** Valori sulle celle del dominio per frame e livello. */
export function frameValues(data, k, layer) {
  const f = data.frames[clampFrame(data, k)]
  const lay = effectiveLayer(data, k, layer)
  if (lay === MarkovLayer.SIMULATION) return f.ref.values
  if (lay === MarkovLayer.DIFFERENCE) return f.values.map((v, i) => v - f.ref.values[i])
  return f.values
}

/**
 * Raster nel formato di un risultato PMAR (`raster_values[riga][colonna]`, riga 0 a
 * sud). La differenza usa una scala divergente simmetrica (`scale: 'diverging'`,
 * `dmax`); previsione e simulazione la stessa scala log, comune a tutti i frame.
 */
export function markovRaster(data, k, layer) {
  const { lon_min, lat_min, res, nx, ny } = data.grid
  const lay = effectiveLayer(data, k, layer)
  const vals = frameValues(data, k, lay)
  const raster = Array.from({ length: ny }, () => new Array(nx).fill(0))
  data.cells.forEach((c, i) => {
    const v = vals[i]
    if (v) raster[Math.floor(c / nx)][c % nx] = v
  })
  const diverging = lay === MarkovLayer.DIFFERENCE
  const dmax = data.diff_max > 0 ? data.diff_max : 1
  return {
    raster_values:  raster,
    raster_lon_min: lon_min,
    raster_lat_min: lat_min,
    raster_res:     res,
    raster_nx:      nx,
    raster_ny:      ny,
    bounds:         data.bounds,
    scale:          diverging ? 'diverging' : 'log',
    vmin:           diverging ? -dmax : data.vmin,
    vmax:           diverging ? dmax : data.vmax,
    dmax,
    layer:          lay,
    frame:          clampFrame(data, k),
  }
}

/**
 * Riassunto di un frame per la scheda: giorno, quota uscita dal dominio (previsione e
 * simulazione), errore. Le quote sono rispetto a quanto rilasciato fino a quel frame.
 */
export function frameSummary(data, k) {
  const f = data.frames[clampFrame(data, k)]
  const share = out => (f.released > 0 ? out / f.released : 0)
  return {
    k: f.k,
    day: f.day,
    validated: !!f.ref && f.k > 0,
    massOut: share(f.mass_out),
    refMassOut: f.ref ? share(f.ref.mass_out) : null,
    emax: f.ref && f.k > 0 ? f.ref.emax : null,
    mae: f.ref && f.k > 0 ? f.ref.mae : null,
    refMax: f.ref ? f.ref.ref_max : null,
  }
}

/** Indice del primo frame fuori dalla simulazione, o null se sono tutti validati. */
export function firstUnvalidatedFrame(data) {
  const i = (data?.frames ?? []).findIndex(f => !f.ref)
  return i < 0 ? null : i
}
